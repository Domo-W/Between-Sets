// ============================================================
// Wire contract — the SINGLE SOURCE OF TRUTH for all client↔server messages.
// Owned by the lead; gameplay/frontend agents import these, do not redefine.
// See docs/client-api.md for the human-readable protocol + gameplay model.
// ============================================================
import type { LobbyState } from "./room.js";

export interface Seed {
  name: string;
  answer: string;
  genre: string;
  vibe?: string; // the crowd's winning Pick-the-Vibe mood (colors the song)
  bpm?: number; // tempo chosen for this song (set once so it's consistent everywhere)
}

export interface Song {
  id: string; // local round id, e.g. "song-1"
  title: string;
  name: string;
  genre: string;
  bpm: number;
  lyrics: string;
  streamUrl: string; // audiopipe progressive mp3 (playable ~13–20s in)
  finalUrl: string; // cdn m4a (filled on `complete`)
}

export interface SavedSong {
  id: string;
  title: string;
  name: string;
  genre: string;
  bpm: number;
  lyrics: string;
  createdAt: string;
  fileName: string;
  downloadUrl: string;
}

export interface GenreInfo {
  key: "A" | "B";
  name: string; // e.g. "NEW FUNK"
  short: string; // e.g. "FNK"
  color: string; // hex, e.g. "#00E5FF"
}

export type Side = "A" | "B";

// Phase of the round currently COLLECTING input (the next song). A song is
// always playing (or cold-start silent) while the next round collects.
//   naming     — host-gated "who's your song about?" window (rounds 2+): the crowd
//                names their subject; NO timer — the host advances when everyone's in.
//   gathering  — timed "what's <name>'s song about?" window; the answer feed builds.
//   collecting — tug-of-war genre vote window; the buzzer resolves it.
export type Phase = "idle" | "naming" | "gathering" | "collecting" | "generating" | "playing";

export interface ShowState {
  started: boolean;
  held: boolean;
  phase: Phase;
  round: number;
  genres: { A: GenreInfo; B: GenreInfo };
  genreSource: "auto" | "dj";
  seed?: Seed;
  error?: string;
}

// ---------------- client → server ----------------
export type ClientMsg =
  // phone / audience
  | { type: "join"; name: string; code?: string; hostToken?: string }
  | { type: "rename"; participantId: string; name: string } // "change my name" — update the song's subject in place
  | { type: "create_room" } // big screen → mint a lobby code
  | { type: "host_start"; hostToken?: string } // host phone → start the show
  | { type: "advance"; hostToken?: string } // host phone → end the (untimed) naming window, open the "what" gather
  | { type: "host_end"; hostToken?: string } // host phone → end the show
  | { type: "add_sim_players"; count?: number } // host phone (dev) → add fake players to test solo
  | { type: "answer"; participantId: string; text: string }
  | { type: "pull"; participantId: string; side: Side; impulse: number } // tug tap (batched client-side ~250ms)
  | { type: "vibe"; index: number } // phone's current Pick-the-Vibe selection (option index)
  | { type: "vibeCards"; cards: string[] } // dashboard: set the vibe-poll options
  // stage
  | { type: "playing"; id: string } // a song became the current track
  // dashboard control
  | { type: "start"; opener?: { prompt: string; genre: string } } // opener → generate song-1 from a DJ brief before round 1
  | { type: "config"; question?: string; genreA?: GenreInfo; genreB?: GenreInfo; collectSeconds?: number; genreOverride?: boolean }
  | { type: "skip" } // drop the queued/generating song, re-run the round
  | { type: "hold" } // keep current playing, pause advancing
  | { type: "resume" } // undo hold
  | { type: "reset" } // blank slate — back to the lobby
  | { type: "end" } // end the show — phones show the recap, stage shows the finale
  | { type: "endVote" } // force the collecting round to resolve now (testing)
  | { type: "forceNext" } // force the stage to transition to the next song now
  | { type: "playbackControl"; action: "play" | "pause" } // dashboard → stage
  | { type: "playbackState"; playing: boolean; canSkip: boolean; song?: Song; nextSong?: Song; position?: number; duration?: number }; // stage → server

// ---------------- server → clients ----------------
export type ServerMsg =
  | { type: "joined"; participantId: string; isHost?: boolean; hostToken?: string; code?: string | null }
  | { type: "join_rejected"; reason: string } // wrong/missing room code
  | { type: "host_granted"; hostToken: string } // promoted to host (e.g. prior host left)
  | { type: "room_state"; code: string | null; lobbyState: LobbyState; hostName: string | null; crowd: number }
  | { type: "name"; name: string } // a participant just joined — add to the name cloud
  | { type: "names"; names: string[] } // full snapshot (sent on connect; cleared on reset)
  | { type: "intent"; name: string; text: string } // an "I want to…" answer, for the gather-screen feed
  | { type: "vibe_options"; cards: string[] } // the DJ's Pick-the-Vibe options (phones render these)
  | { type: "vibe_tally"; counts: number[]; total: number } // live picks per option index
  // ~15Hz tug + crowd snapshot (the authoritative aggregate; clients render/integrate locally)
  | {
      type: "tug";
      phase: Phase;
      round: number;
      question: string;
      genres: { A: GenreInfo; B: GenreInfo };
      p: number; // rope position 0=A .. 1=B
      driveA: number; // decaying per-side drive (slosh/particles)
      driveB: number;
      membersA: number; // participants currently pulling each side
      membersB: number;
      timeRemaining: number; // seconds left in collecting (0 otherwise)
      timeTotal: number; // the full collect window in seconds (for a countdown bar)
      crowdSize: number;
      energy: number; // 0..1
      bpm: number;
    }
  // a collecting round resolved: winning genre + the selected participant
  | { type: "round_result"; winner: Side; genre: string; name: string; answer: string; roundIndex: number }
  | { type: "generating"; seed: Seed; roundIndex: number }
  | { type: "generation_failed"; id: string; message: string }
  | { type: "song_ready"; song: Song } // streamUrl playable
  | { type: "song_final"; id: string; finalUrl: string } // clean CDN url
  | { type: "song_saved"; song: SavedSong } // downloaded into the local archive
  | { type: "song_deleted"; id: string } // removed from the local archive (DJ pruned it)
  | { type: "song_cancelled"; id: string } // remove a skipped queued song
  | { type: "now_playing"; id: string }
  | { type: "show_reset" } // stop stage audio and return to the lobby
  | { type: "show_ended"; songs: SavedSong[] } // set complete — recap playlist of saved songs
  | { type: "force_next" } // tell the stage to transition to the queued song now
  | { type: "playback_control"; action: "play" | "pause" } // dashboard command for stage
  | { type: "playback_state"; playing: boolean; canSkip: boolean; song?: Song; nextSong?: Song; position?: number; duration?: number } // stage state for dashboard
  | ({ type: "show_state" } & ShowState); // authoritative backend flow state
