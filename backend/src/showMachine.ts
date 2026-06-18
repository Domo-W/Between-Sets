import { CONFIG } from "./config.js";
import { craftSongPrompt, craftOpenerPrompt } from "./agent.js";
import { generateSong } from "./suno.js";
import { songStore } from "./songStore.js";
import { genreBpm, pickGenreBpm } from "./tempo.js";
import { sanitizeIntent } from "./sanitize.js";
import type { GenreInfo, Phase, SavedSong, Seed, ShowState, Side, Song } from "./types.js";
import type { ServerMsg } from "./types.js";
import type { Room } from "./room.js";
import type { Sim } from "./sim.js";
import type { Participants } from "./participants.js";
import type { Vibes } from "./vibes.js";
import type { Tug } from "./tug.js";

// The real Between Sets flow, built on the generate-one-ahead spine.
//
// A song is always playing (or cold-start silent) while the NEXT round COLLECTS
// audience input. At the collecting buzzer the winning genre + a selected
// participant become a Seed → the EXISTING pipeline (craftSongPrompt →
// generateSong) produces the next song. The pipeline gate releases the moment a
// song is PLAYABLE (onPlayable), never at complete, so the next round can begin.

// ---------------- config / defaults ----------------
const genre = (key: Side, name: string, short: string): GenreInfo => ({
  key,
  name,
  short,
  color: key === "A" ? "#00E5FF" : "#FF1A8C",
});
// The full battle roster — every genre must have a tempo in tempo.ts so Suno
// gets a sensible BPM. Each round picks TWO at random for the vote.
const GENRE_POOL: Array<{ name: string; short: string }> = [
  { name: "Soca", short: "SOC" },
  { name: "Afrobeats", short: "AFR" },
  { name: "Dancehall", short: "DHL" },
  { name: "Reggae", short: "REG" },
  { name: "Tropical House", short: "TRP" },
  { name: "Pop", short: "POP" },
  { name: "Country", short: "CTY" },
  { name: "Pop Rock", short: "RCK" },
  { name: "Hip-Hop", short: "HIP" },
  { name: "Techno", short: "TEC" },
  { name: "Soul", short: "SOL" },
  { name: "Dubstep", short: "DUB" },
  { name: "Folk", short: "FLK" },
  { name: "Gospel", short: "GSP" },
  { name: "Miami Bass", short: "MIA" },
];

// On-brand default themes the house uses when the crowd stays silent, so the
// generated lyrics still read like a real "what's the song about" answer instead
// of going blank.
const HOUSE_INTENTS = [
  "the best night of our lives",
  "owning the dancefloor",
  "being totally unstoppable tonight",
  "everyone losing it at once",
  "a night nobody will forget",
];

// Stale-show watchdog: if Start ran but no stage ever reports a track playing
// (stage closed, autoplay blocked, song_ready missed), the show would sit in
// "gathering · round 0" forever — and a later Start silently no-ops on the
// `started` guard. Self-heal back to the lobby instead.
const STARTUP_STALL_MS = 3 * 60_000;

// Jackbox-style "the show never hard-stops": if a buzzer fires with no intents,
// re-open the vote ONCE (a slow crowd gets a second window) and then auto-advance
// with a house seed rather than looping the battle forever. Counts empty buzzers
// within the current round; reset when a round resolves or a new one begins.
const EMPTY_ROUND_GRACE = 1;

const SNAPSHOT_HZ = 15;

// The fixed opener track the stage plays the instant the show starts — no
// generation, no "crafting your song" tease. Served statically from
// frontend/assets so it resolves on both localhost and the Render host.
const OPENER_URL = "/assets/opener.m4a";

export class ShowMachine {
  // ---------------- config / defaults ----------------
  private question = "What's your song about?";
  // Remember the genres used in the last few rounds so we don't keep re-running the
  // same matchups. We pick from genres NOT seen recently when we can.
  private recentGenres: string[] = [];
  private genreA: GenreInfo = genre("A", GENRE_POOL[0]!.name, GENRE_POOL[0]!.short);
  private genreB: GenreInfo = genre("B", GENRE_POOL[1]!.name, GENRE_POOL[1]!.short);
  private gatherSeconds = CONFIG.gatherSeconds;
  private collectSeconds = CONFIG.collectSeconds;

  // ---------------- runtime state ----------------
  private started = false;
  private generating = false;
  private held = false;
  private roundIndex = 0;
  private phase: Phase = "idle";
  private generationEpoch = 0;
  private generationJobSequence = 0;
  private activeGenerationJobId: number | null = null;
  private latestGeneration: { jobId: number; songId: string } | null = null;
  private cancelledGenerationJobs = new Set<number>();
  private songSequence = 0;
  private currentBpm = CONFIG.defaultBpm;
  private lastPlayingId = "";
  // The track currently broadcast as the live song (opener, generated, or fallback).
  // Kept so a stage that reloads mid-show can be re-seeded with it and resume audio
  // instead of sitting silent on whatever phase show_state reports. Cleared on
  // reset/end (the lobby/recap has no live track).
  private currentSong: Song | null = null;
  private activeSeed: Seed | undefined;
  private generationError: string | undefined;
  private genreSource: "auto" | "dj" = "auto";
  private autoGenrePairIndex = 0;
  private pendingGenreOverride: { A: GenreInfo; B: GenreInfo } | null = null;
  // When the show has ended, the recap points at that set's song array so a track
  // that was already streaming can still join the recap after its final file saves.
  // Cleared on reset and when a new collecting round begins (the set is live again).
  private endedRecap: SavedSong[] | null = null;
  // The songs generated DURING the current set (since start/reset). The end-of-set
  // recap shows only these — not every track ever archived across past sets.
  private setSongs: SavedSong[] = [];
  private songBpms = new Map<string, number>();

  private emptyRounds = 0;

  private collectEndsAt = 0; // epoch ms when the current collecting window buzzes
  private gatherEndsAt = 0; // epoch ms when the name-cloud window opens voting

  // ---------------- instance-owned timers ----------------
  private startStallTimer: NodeJS.Timeout | null = null;
  private gatherTimer: NodeJS.Timeout | null = null; // name-cloud window → opens voting
  private buzzerTimer: NodeJS.Timeout | null = null;
  private tugLoop: NodeJS.Timeout | null = null; // decay + ~15Hz snapshot broadcast
  private namesTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      broadcast: (msg: ServerMsg) => void;
      room: Room;
      sim: Sim;
      participants: Participants;
      vibes: Vibes;
      tug: Tug;
    },
  ) {
    // Initialize the tug with default genres at construction so any pulls that
    // arrive BEFORE `start` still accumulate into round 1 (cold start uses real
    // input too).
    this.deps.tug.reset(this.genreA, this.genreB);
    // Broadcast state continuously from boot — even in idle/lobby — so the stage
    // can show the "scan to join" lobby (crowd count, phase) before the DJ starts.
    this.startTugLoop();
    // Periodically re-broadcast the name list so a freshly-loaded stage seeds its
    // name cloud even if it missed the connect-time snapshot. The client reconciles
    // idempotently (adds missing, removes gone) so this never causes a flicker.
    this.namesTimer = setInterval(
      () => this.deps.broadcast({ type: "names", names: this.deps.participants.names() }),
      4000,
    );
  }

  private pickGenrePair(): { A: GenreInfo; B: GenreInfo } {
    const fresh = GENRE_POOL.filter((g) => !this.recentGenres.includes(g.name));
    const pool = fresh.length >= 2 ? fresh : GENRE_POOL.slice();
    const a = pool[Math.floor(Math.random() * pool.length)]!;
    let b = a;
    let guard = 0;
    while (b.name === a.name && guard++ < 30) b = pool[Math.floor(Math.random() * pool.length)]!;
    if (b.name === a.name) {
      const others = GENRE_POOL.filter((g) => g.name !== a.name);
      b = others[Math.floor(Math.random() * others.length)]!;
    }
    this.recentGenres.push(a.name, b.name);
    while (this.recentGenres.length > 8) this.recentGenres.shift(); // ~4 rounds of memory
    return { A: genre("A", a.name, a.short), B: genre("B", b.name, b.short) };
  }

  // ---------------- public message handlers ----------------

  currentShowState(): ShowState {
    return {
      started: this.started,
      held: this.held,
      phase: this.phase,
      round: this.roundIndex,
      genres: { A: this.genreA, B: this.genreB },
      genreSource: this.genreSource,
      seed: this.activeSeed,
      error: this.generationError,
    };
  }

  /** The recap playlist if the show has ended (else null) — to seed late scanners. */
  currentRecap(): SavedSong[] | null {
    return this.endedRecap;
  }

  /** The live track right now (else null) — to re-seed a stage that reloads mid-show
   *  so it resumes audio instead of sitting silent on the genre battle. */
  currentPlayingSong(): Song | null {
    if (!this.currentSong) return null;
    // Prefer the seekable final file once it has arrived (the stream URL can expire).
    return { ...this.currentSong, streamUrl: this.currentSong.finalUrl || this.currentSong.streamUrl };
  }

  /** Songs generated during the CURRENT set (cleared on reset/start) — the
   *  dashboard's Session Setlist, distinct from the full cross-set archive. */
  currentSetSongs(): SavedSong[] {
    return this.setSongs.slice();
  }

  private broadcastShowState(): void {
    this.deps.broadcast({ type: "show_state", ...this.currentShowState() });
  }

  /** Reset everything to a blank lobby state (dashboard "Reset"). */
  reset(): void {
    this.started = false;
    this.held = false;
    this.generating = false;
    this.generationEpoch += 1;
    this.activeGenerationJobId = null;
    this.latestGeneration = null;
    this.cancelledGenerationJobs.clear();
    this.roundIndex = 0;
    this.phase = "idle";
    this.currentBpm = CONFIG.defaultBpm;
    this.lastPlayingId = "";
    this.currentSong = null;
    this.emptyRounds = 0;
    this.activeSeed = undefined;
    this.generationError = undefined;
    this.genreSource = "auto";
    this.autoGenrePairIndex = 0;
    this.pendingGenreOverride = null;
    this.endedRecap = null;
    this.setSongs = [];
    this.genreA = genre("A", GENRE_POOL[0]!.name, GENRE_POOL[0]!.short);
    this.genreB = genre("B", GENRE_POOL[1]!.name, GENRE_POOL[1]!.short);
    this.recentGenres = [];
    if (this.startStallTimer) {
      clearTimeout(this.startStallTimer);
      this.startStallTimer = null;
    }
    if (this.gatherTimer) {
      clearTimeout(this.gatherTimer);
      this.gatherTimer = null;
    }
    if (this.buzzerTimer) {
      clearTimeout(this.buzzerTimer);
      this.buzzerTimer = null;
    }
    if (this.tugLoop) {
      // Stop the 15Hz snapshot loop — no rounds run in the idle lobby. It restarts
      // (startTugLoop) when the next show's gather/naming window opens.
      clearInterval(this.tugLoop);
      this.tugLoop = null;
    }
    this.deps.tug.reset(this.genreA, this.genreB);
    this.deps.room.close();
    this.deps.sim.reset();
    this.deps.participants.reset();
    this.deps.vibes.reset();
    console.log("[show] reset → blank lobby");
    this.deps.broadcast({ type: "show_reset" });
    this.deps.broadcast({ type: "names", names: [] }); // clear the stage name cloud
    this.deps.broadcast({ type: "vibe_options", cards: [] }); // clear the vibe poll
    this.deps.broadcast({ type: "vibe_tally", counts: [], total: 0 });
    this.broadcastShowState();
    this.broadcastTug();
  }

  /**
   * Dashboard pressed "End show". Stop advancing and broadcast the recap: the set
   * the crowd made tonight (the locally saved songs). Phones flip to ScreenRecap;
   * the stage shows the finale. The pipeline gate / generationEpoch is left as-is
   * (a later `reset` fully clears state for the next show).
   */
  async endShow(): Promise<void> {
    this.started = false;
    this.held = false;
    this.phase = "idle";
    this.currentSong = null; // recap takes over; a reconnecting stage shows the finale, not a live track
    if (this.startStallTimer) {
      clearTimeout(this.startStallTimer);
      this.startStallTimer = null;
    }
    if (this.gatherTimer) {
      clearTimeout(this.gatherTimer);
      this.gatherTimer = null;
    }
    if (this.buzzerTimer) {
      clearTimeout(this.buzzerTimer);
      this.buzzerTimer = null;
    }
    // Only THIS set's songs — not every track ever archived across past sets.
    this.endedRecap = this.setSongs; // keep receiving any in-flight track from this set
    const songs = this.endedRecap.slice();
    console.log(`[show] ended — broadcasting recap (${songs.length} tracks from this set)`);
    this.deps.broadcast({ type: "show_ended", songs });
    this.broadcastShowState(); // started=false → dashboard re-enables "Start Show"
    this.broadcastTug();
  }

  /**
   * Broadcast the fixed opener track as the first "song" so the stage plays it
   * from silence immediately. There is NO generation step, so phones never hit the
   * loading/"generating" screen — they sit on the NAME screen while it plays. The
   * stage's onPlaying (fired by AudioEngine.makeCurrent) then opens round 1
   * collecting for song-2, exactly like the steady-state loop.
   */
  private playOpenerTrack(): void {
    const id = `song-opener-${Date.now()}`;
    const song: Song = {
      id,
      title: "In Between — Opener",
      name: "BETWEEN SETS",
      genre: "",
      bpm: this.currentBpm,
      lyrics: "",
      streamUrl: OPENER_URL,
      finalUrl: OPENER_URL,
    };
    this.songBpms.set(id, this.currentBpm);
    this.currentSong = song;
    console.log(`[show] opener → playing fixed track ${OPENER_URL}`);
    this.deps.broadcast({ type: "song_ready", song });
  }

  /** Dashboard pressed Start. Play the fixed opener, then COLLECT round 1. */
  startShow(_opener?: { prompt: string; genre: string }): void {
    if (this.started) return;
    this.started = true;
    this.roundIndex = 0;
    this.held = false;
    this.setSongs = []; // a fresh set — the recap reflects only what's made from here
    this.endedRecap = null;
    // Stay on the name-cloud view from the start (phase "gathering", not "playing")
    // so there's no lobby→battle→lobby flicker. The fixed opener plays from silence;
    // its onPlaying opens the real 15s gather window (round 1), then voting.
    this.phase = "gathering";
    console.log("[show] starting — fixed opener track, then gather → vote");
    if (this.startStallTimer) clearTimeout(this.startStallTimer);
    this.startStallTimer = setTimeout(() => {
      this.startStallTimer = null;
      if (this.started && this.lastPlayingId === "") {
        console.warn("[show] no stage reported playing within stall window — auto-resetting zombie show");
        this.reset();
      }
    }, STARTUP_STALL_MS);
    this.playOpenerTrack();
    this.broadcastShowState();
  }

  /**
   * The stage reports a song became the current track. Broadcast now_playing and
   * (unless held) start the NEXT collecting round so the next song generates one
   * ahead. This is the round boundary where we reset tug + answers.
   */
  onPlaying(id: string): void {
    // If the show isn't running (e.g. after reset/end), ignore stray "playing"
    // reports from a stage still looping audio — otherwise the round keeps
    // advancing and generating forever (zombie loop).
    if (!this.started) return;
    if (id === this.lastPlayingId) return;
    this.lastPlayingId = id;
    if (this.startStallTimer) {
      clearTimeout(this.startStallTimer);
      this.startStallTimer = null;
    }
    this.currentBpm = this.songBpms.get(id) ?? this.currentBpm;
    this.deps.broadcast({ type: "now_playing", id });
    console.log(`[show] now playing ${id}`);
    this.broadcastShowState();
    if (this.held) {
      console.log("[show] held — not advancing to next round");
      return;
    }
    // Round boundary. The OPENER (roundIndex 0) flows straight into round 1's "what"
    // gather — the lobby served as round 1's naming step. After a real round's track,
    // open the host-gated "who's your song about?" naming window for the NEXT round.
    if (this.roundIndex === 0) this.beginGathering();
    else this.beginNaming();
  }

  /** config: set the question, the two genres, and the collect window. */
  applyConfig(msg: {
    question?: string;
    genreA?: GenreInfo;
    genreB?: GenreInfo;
    collectSeconds?: number;
    genreOverride?: boolean;
  }): void {
    if (typeof msg.question === "string") this.question = msg.question;
    if (msg.genreA || msg.genreB) {
      this.pendingGenreOverride = {
        A: msg.genreA ? { ...msg.genreA, key: "A" } : { ...this.genreA, key: "A" },
        B: msg.genreB ? { ...msg.genreB, key: "B" } : { ...this.genreB, key: "B" },
      };
    }
    if (typeof msg.collectSeconds === "number" && msg.collectSeconds > 0) {
      this.collectSeconds = msg.collectSeconds;
    }
    console.log(
      `[show] config: question="${this.question}" override=${this.pendingGenreOverride ? `${this.pendingGenreOverride.A.name}/${this.pendingGenreOverride.B.name}` : "none"} collect=${this.collectSeconds}s`,
    );
  }

  /** skip: drop the queued/generating song and re-run the current round. */
  skip(): void {
    console.log("[show] skip — re-running current round generation");
    if (this.latestGeneration) {
      this.cancelledGenerationJobs.add(this.latestGeneration.jobId);
      this.deps.broadcast({ type: "song_cancelled", id: this.latestGeneration.songId });
    }
    this.activeGenerationJobId = null;
    this.generating = false; // release the gate so generateNext can fire again
    this.generationError = undefined;
    // Re-resolve from whatever input we currently have for this round.
    this.resolveAndGenerate();
  }

  /** hold: keep the current song playing, pause advancing to the next round. */
  hold(): void {
    this.held = true;
    console.log("[show] hold — advancing paused");
    this.broadcastShowState();
  }

  /** resume: undo hold. If we're idling between rounds, advance now. */
  resume(): void {
    if (!this.held) return;
    this.held = false;
    console.log("[show] resume — advancing re-enabled");
    this.broadcastShowState();
    if (this.started && this.phase === "playing") this.beginGathering();
  }

  /** endVote: force the current collecting round to resolve NOW (testing). */
  endVote(): void {
    if (this.phase !== "collecting") {
      console.log("[show] endVote ignored — not collecting");
      this.broadcastShowState();
      return;
    }
    if (this.buzzerTimer) {
      clearTimeout(this.buzzerTimer);
      this.buzzerTimer = null;
    }
    console.log("[show] endVote — forcing buzzer");
    this.onBuzzer();
  }

  // ---------------- collecting ----------------

  /**
   * Host-gated NAMING window (phase "naming") for the NEXT round — "who's your song
   * about?". No timer: the crowd (re)names their subject and the host calls advance()
   * when everyone's in. This is the round-2+ boundary where we clear EVERYONE so the
   * name cloud reflects who's in for the upcoming round. (Round 1 has no naming
   * window — the lobby served that role; see onPlaying.)
   */
  private beginNaming(): void {
    // Players PERSIST across rounds (stable ids → fair anti-repeat + reliable answer
    // recording). Clear only the per-round "what's it about" answer; keep everyone in
    // the room. Players can change their name or new people can join during this window.
    this.deps.participants.clearRound();
    this.deps.sim.reseedForRound(); // sims keep their id; just give them a fresh answer
    this.deps.broadcast({ type: "names", names: this.deps.participants.names() }); // refresh the cloud
    this.phase = "naming";
    this.endedRecap = null; // back to live (not recap) the moment a new round opens
    this.activeSeed = undefined;
    this.generationError = undefined;
    // No COUNTDOWN in the naming window (it waits for the host's advance()), but keep
    // the tug heartbeat running so the stage/phone learn the phase and flip their view.
    if (this.gatherTimer) { clearTimeout(this.gatherTimer); this.gatherTimer = null; }
    if (this.buzzerTimer) { clearTimeout(this.buzzerTimer); this.buzzerTimer = null; }
    this.startTugLoop();
    console.log(`[show] naming (host-gated) — waiting for host to open round ${this.roundIndex + 1}`);
    this.broadcastShowState();
  }

  /**
   * Host pressed "everyone's in" during the naming window → open the timed
   * "what's your song about?" gather for the next round. No-op outside naming.
   */
  advance(): void {
    if (this.phase !== "naming") {
      console.log("[show] advance ignored — not in the naming window");
      return;
    }
    this.beginGathering();
  }

  /**
   * Open the timed "what's your song about?" gather (phase "gathering"): the answer
   * feed builds, no voting yet. After `gatherSeconds` the tug-of-war vote opens
   * (beginVoting). Genre pick + tug reset happen here; participants are NOT reset
   * (round 1 carries the lobby joins, rounds 2+ carry the names from beginNaming).
   */
  private beginGathering(): void {
    this.roundIndex += 1;
    this.emptyRounds = 0; // a fresh round gets its own grace window before auto-advancing
    if (this.pendingGenreOverride) {
      this.genreA = { ...this.pendingGenreOverride.A };
      this.genreB = { ...this.pendingGenreOverride.B };
      this.pendingGenreOverride = null;
      this.genreSource = "dj";
    } else {
      const pair = this.pickGenrePair(); // two random genres, avoiding recent repeats
      this.genreA = pair.A;
      this.genreB = pair.B;
      this.genreSource = "auto";
    }
    this.deps.tug.reset(this.genreA, this.genreB); // fresh tug for this round's genres
    this.phase = "gathering";
    this.endedRecap = null; // a new round means the set is live again, not in recap
    this.activeSeed = undefined;
    this.generationError = undefined;

    // No buzzer yet — just run the "what's it about" window, then open voting.
    this.gatherEndsAt = Date.now() + this.gatherSeconds * 1000;
    if (this.buzzerTimer) { clearTimeout(this.buzzerTimer); this.buzzerTimer = null; }
    if (this.gatherTimer) clearTimeout(this.gatherTimer);
    this.gatherTimer = setTimeout(() => this.beginVoting(), this.gatherSeconds * 1000);

    this.startTugLoop();
    // Now that gather is live (stage has flipped to the answer screen), trickle any
    // sim players' intents onto the feed like real people typing.
    this.deps.sim.postIntentsToGather();
    console.log(`[show] gathering ("what's it about") round ${this.roundIndex} for ${this.gatherSeconds}s`);
    this.broadcastShowState();
  }

  /** Open the tug-of-war genre vote window (phase "collecting"); the buzzer at the
   *  end resolves the winning genre + selected participant. */
  private beginVoting(): void {
    this.gatherTimer = null;
    this.phase = "collecting";
    this.collectEndsAt = Date.now() + this.collectSeconds * 1000;

    if (this.buzzerTimer) clearTimeout(this.buzzerTimer);
    this.buzzerTimer = setTimeout(() => this.onBuzzer(), this.collectSeconds * 1000);

    this.startTugLoop();
    console.log(`[show] voting (tug-of-war) round ${this.roundIndex} for ${this.collectSeconds}s`);
    this.broadcastShowState();
  }

  /** Re-open the current round's vote window (no round bump) — used when a buzzer
   *  fires with no submissions, so the show waits for the crowd without churning. */
  private extendCollecting(): void {
    this.phase = "collecting";
    this.collectEndsAt = Date.now() + this.collectSeconds * 1000;
    if (this.buzzerTimer) clearTimeout(this.buzzerTimer);
    this.buzzerTimer = setTimeout(() => this.onBuzzer(), this.collectSeconds * 1000);
    this.startTugLoop();
    this.broadcastShowState();
  }

  private startTugLoop(): void {
    if (this.tugLoop) return;
    this.tugLoop = setInterval(() => {
      if (this.phase === "collecting") this.deps.sim.voteTick(); // simulated players vote in the tug
      this.deps.tug.tick();
      this.broadcastTug();
    }, Math.round(1000 / SNAPSHOT_HZ));
  }

  private broadcastTug(): void {
    const s = this.deps.tug.snapshot();
    // The countdown carried in the snapshot matches the current phase: the gather
    // window (name cloud) counts down to voting; the vote window counts down to the
    // buzzer. Both feed the same timeRemaining/timeTotal fields.
    let timeRemaining = 0;
    let timeTotal = 0; // naming/idle/etc carry no countdown (only gather + vote do)
    if (this.phase === "collecting") {
      timeRemaining = Math.max(0, (this.collectEndsAt - Date.now()) / 1000);
      timeTotal = this.collectSeconds;
    } else if (this.phase === "gathering") {
      timeRemaining = Math.max(0, (this.gatherEndsAt - Date.now()) / 1000);
      timeTotal = this.gatherSeconds;
    }
    this.deps.broadcast({
      type: "tug",
      phase: this.phase,
      round: this.roundIndex,
      question: this.question,
      genres: { A: this.genreA, B: this.genreB },
      p: s.p,
      driveA: s.driveA,
      driveB: s.driveB,
      membersA: s.membersA,
      membersB: s.membersB,
      timeRemaining,
      timeTotal,
      crowdSize: this.deps.participants.count(),
      energy: s.energy,
      bpm: this.currentBpm,
    });
  }

  private onBuzzer(): void {
    this.buzzerTimer = null;
    console.log(`[show] buzzer for round ${this.roundIndex}`);
    this.resolveAndGenerate();
  }

  // ---------------- resolve → generate ----------------

  /** Resolve the tug winner + selected participant, then run the pipeline. */
  private resolveAndGenerate(): void {
    const picked = this.deps.participants.selectRandomAnswerer();
    if (!picked) {
      this.emptyRounds += 1;
      if (this.emptyRounds <= EMPTY_ROUND_GRACE) {
        // Nobody submitted yet — re-open the SAME round's vote window once (no round
        // bump / genre churn) so a slow crowd gets a second chance to type.
        console.log(`[show] round ${this.roundIndex} → no submissions; re-opening (grace ${this.emptyRounds}/${EMPTY_ROUND_GRACE})`);
        this.extendCollecting();
        return;
      }
      // Still silent after the grace window — keep the show moving with a house seed
      // (genre already decided by the tug) instead of stalling on the battle forever.
      const houseSide: Side = this.deps.tug.winner();
      const houseGenre = houseSide === "A" ? this.genreA.name : this.genreB.name;
      const houseAnswer = HOUSE_INTENTS[Math.floor(Math.random() * HOUSE_INTENTS.length)]!;
      const houseSeed: Seed = { name: "THE CROWD", answer: houseAnswer, genre: houseGenre, vibe: this.deps.vibes.winner() ?? undefined };
      this.deps.broadcast({ type: "round_result", winner: houseSide, genre: houseGenre, name: houseSeed.name, answer: houseSeed.answer, roundIndex: this.roundIndex });
      console.log(`[show] round ${this.roundIndex} → silent after grace; auto-advancing with house seed (${houseGenre})`);
      this.activeSeed = houseSeed;
      this.generationError = undefined;
      void this.generateNext(houseSeed);
      return;
    }
    this.emptyRounds = 0;
    const winnerSide: Side = this.deps.tug.winner();
    const genreName = winnerSide === "A" ? this.genreA.name : this.genreB.name;
    const { name, answer } = picked;
    const vibe = this.deps.vibes.winner() ?? undefined; // the crowd's winning Pick-the-Vibe mood

    this.deps.broadcast({ type: "round_result", winner: winnerSide, genre: genreName, name, answer, roundIndex: this.roundIndex });
    console.log(`[show] round ${this.roundIndex} → ${winnerSide} (${genreName})${vibe ? ` · vibe ${vibe}` : ""} — selected ${name}`);

    const seed: Seed = { name, answer, genre: genreName, vibe };
    this.activeSeed = seed;
    this.generationError = undefined;
    void this.generateNext(seed);
  }

  /**
   * Craft + generate one song. The pipeline gate (`generating`) releases as soon
   * as the song is PLAYABLE (streaming) — NOT when it fully completes — so the
   * next round can start while `complete` polling continues in the background.
   */
  private async generateNext(seed: Seed, opts?: { opener?: boolean }): Promise<void> {
    if (this.generating) {
      console.log("[show] generateNext skipped — already generating");
      return;
    }
    this.generating = true;
    this.phase = "generating";
    this.activeSeed = seed;
    this.generationError = undefined;
    const epoch = this.generationEpoch;
    const jobId = ++this.generationJobSequence;
    const id = `song-${Date.now()}-${++this.songSequence}`;
    const generationSetSongs = this.setSongs;
    this.activeGenerationJobId = jobId;
    this.latestGeneration = { jobId, songId: id };
    const bpm = pickGenreBpm(seed.genre); // a fresh tempo inside the genre's window
    seed.bpm = bpm; // thread it into the agent so the prompt + style use the same value
    this.songBpms.set(id, bpm);
    this.broadcastShowState();
    let playableSent = false;

    const isCurrentJob = () =>
      epoch === this.generationEpoch && !this.cancelledGenerationJobs.has(jobId);

    const releaseGate = () => {
      if (this.activeGenerationJobId === jobId && this.generating) {
        this.activeGenerationJobId = null;
        this.generating = false;
        // The current song is now playable/queued; treat the stage as "playing"
        // for our phase-tracking until the stage confirms via onPlaying.
        this.phase = "playing";
        if (playableSent) this.activeSeed = undefined;
        this.broadcastShowState();
      }
    };

    const failGeneration = (err: unknown) => {
      if (!isCurrentJob() || playableSent) return;
      this.generationError = (err as Error).message || "Song generation failed.";
      this.deps.broadcast({ type: "generation_failed", id, message: this.generationError });
    };

    const song: Song = {
      id,
      title: "",
      name: seed.name,
      genre: seed.genre,
      bpm,
      lyrics: "",
      streamUrl: "",
      finalUrl: "",
    };

    const onPlayable = (url: string) => {
      if (!isCurrentJob()) return;
      playableSent = true;
      song.streamUrl = url;
      this.currentSong = song; // live ref — onComplete fills finalUrl so reloads get the seekable file
      console.log(`[show] ${id}: playable (streaming) → sending to stage; gate released`);
      this.deps.broadcast({ type: "song_ready", song: { ...song } });
      releaseGate(); // next round may begin now
    };

    const onComplete = async (result: { finalUrl: string; msToComplete: number }) => {
      if (!isCurrentJob()) return;
      song.finalUrl = result.finalUrl;
      this.deps.broadcast({ type: "song_final", id, finalUrl: result.finalUrl });
      console.log(`[show] ${id}: complete in ${(result.msToComplete / 1000).toFixed(1)}s`);
      try {
        const saved = await songStore.save(song, result.finalUrl);
        generationSetSongs.push(saved);
        this.deps.broadcast({ type: "song_saved", song: saved });
        if (this.endedRecap === generationSetSongs) {
          const songs = this.endedRecap.slice();
          this.deps.broadcast({ type: "show_ended", songs });
          console.log(`[show] ${id}: added to ended recap (${songs.length} tracks)`);
        }
        console.log(`[show] ${id}: saved as ${saved.fileName}`);
      } catch (err) {
        console.error(`[show] ${id}: save failed —`, (err as Error).message);
      }
    };

    // Craft lyrics + generate. If Suno REJECTS before the song is playable (e.g. a
    // flagged word slipped through), re-craft with an aggressive sanitize and retry
    // ONCE before giving up.
    const runAttempt = async (strict: boolean): Promise<void> => {
      const prompt = opts?.opener
        ? await craftOpenerPrompt({ prompt: seed.answer, genre: seed.genre }, { strict })
        : await craftSongPrompt(seed, { strict });
      console.log(`[show] ${id}: ${strict ? "sanitized retry — " : ""}style → ${prompt.style}`);
      song.title = prompt.title;
      song.lyrics = prompt.lyrics;
      return generateSong(prompt, { onPlayable })
        .then(onComplete)
        .catch((err) => {
          if (!isCurrentJob() || playableSent) return;
          if (!strict) {
            console.warn(`[show] ${id}: Suno rejected — re-crafting (sanitized) + retrying once: ${(err as Error).message}`);
            return runAttempt(true);
          }
          throw err;
        });
    };

    try {
      this.deps.broadcast({ type: "generating", seed, roundIndex: this.roundIndex });
      console.log(`[show] ${id}: crafting ${opts?.opener ? "OPENER" : "lyrics"} for ${seed.name} / ${seed.genre}`);
      await runAttempt(false);
    } catch (err) {
      console.error(`[show] ${id}: generation failed —`, (err as Error).message);
      failGeneration(err);
      // Both attempts failed — keep the show moving with a previous-set track
      // instead of looping the current one forever (unless this job was superseded).
      if (isCurrentJob() && !playableSent && !opts?.opener) await this.playFallbackSong();
    } finally {
      releaseGate(); // safety: release if it errored before playable
    }
  }

  /**
   * Generation failed after retries — crossfade in a previously-archived song
   * (preferring one from a PAST set) so the round advances and the stage isn't
   * stuck on the "cooking" hold. No-op (current track keeps looping) if the
   * archive is empty.
   */
  private async playFallbackSong(): Promise<void> {
    try {
      const archive = await songStore.list();
      const setIds = new Set(this.setSongs.map((s) => s.id));
      const previous = archive.filter((s) => !setIds.has(s.id));
      const pool = previous.length ? previous : archive;
      if (!pool.length) {
        console.warn("[show] generation failed and no archived song to fall back to — current track loops");
        return;
      }
      const pick = pool[Math.floor(Math.random() * pool.length)]!;
      const fallback: Song = {
        id: `fallback-${Date.now()}-${++this.songSequence}`,
        title: pick.title,
        name: pick.name,
        genre: pick.genre,
        bpm: pick.bpm,
        lyrics: pick.lyrics ?? "",
        streamUrl: pick.downloadUrl,
        finalUrl: pick.downloadUrl,
      };
      this.songBpms.set(fallback.id, pick.bpm);
      this.currentSong = fallback;
      console.log(`[show] generation failed — falling back to archived track "${pick.title}" by ${pick.name}`);
      this.deps.broadcast({ type: "song_ready", song: fallback });
    } catch (err) {
      console.error("[show] fallback song failed:", (err as Error).message);
    }
  }

  // ---------------- audience input passthrough ----------------

  handlePull(participantId: string, side: Side, impulse: number): void {
    this.deps.tug.applyPull(participantId, side, impulse);
  }

  handleAnswer(participantId: string, text: string): void {
    // Scrub the typed intent at the source: a slur/curse here would otherwise be
    // projected on the stage, stored as the seed, and built into the lyrics — one
    // bad word could fail the whole generation. Clean it once, here.
    const clean = sanitizeIntent(text || "");
    this.deps.participants.setAnswer(participantId, clean);
    // Surface intents on the stage's gather screen as they come in, so the crowd
    // sees "what everyone wants tonight" populate live before the vote opens.
    const t = clean.trim();
    if (t && (this.phase === "gathering" || this.phase === "collecting")) {
      this.deps.broadcast({ type: "intent", name: this.deps.participants.nameOf(participantId) || "", text: t });
    }
  }

  // ---------------- teardown ----------------

  stop(): void {
    if (this.startStallTimer) clearTimeout(this.startStallTimer);
    if (this.gatherTimer) clearTimeout(this.gatherTimer);
    if (this.buzzerTimer) clearTimeout(this.buzzerTimer);
    if (this.tugLoop) clearInterval(this.tugLoop);
    if (this.namesTimer) clearInterval(this.namesTimer);
    this.startStallTimer = this.gatherTimer = this.buzzerTimer = this.tugLoop = this.namesTimer = null;
  }
}
