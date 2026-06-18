import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import express from "express";
import archiver from "archiver";
import QRCode from "qrcode";
import { WebSocketServer, WebSocket } from "ws";
import { CONFIG } from "./config.js";
import { SessionRegistry } from "./sessionRegistry.js";
import type { Session } from "./session.js";
import { songStore } from "./songStore.js";
import type { ClientMsg, ServerMsg, SavedSong } from "./types.js";

const registry = new SessionRegistry();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "../../frontend");

// First non-internal IPv4 address — the LAN IP phones on the same WiFi use.
function lanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "localhost";
}
const LOCAL_JOIN_URL = `http://${lanIp()}:${CONFIG.port}/phone-live.html`;

// The public URL phones scan to join. On a host (Render) it comes from the request
// (or PUBLIC_URL); locally it falls back to the LAN IP for same-WiFi phones.
function publicJoinUrl(req: express.Request): string {
  const env = process.env.PUBLIC_URL?.trim();
  if (env) return `${env.replace(/\/+$/, "")}/phone-live.html`;
  const host = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0]!.trim();
  if (host) {
    const proto = (req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0]!.trim();
    return `${proto}://${host}/phone-live.html`;
  }
  return LOCAL_JOIN_URL;
}

const app = express();
app.set("trust proxy", true); // Render & most PaaS sit behind a proxy → trust x-forwarded-*
app.get("/health", (_req, res) => res.json({ ok: true }));
// Join info + a QR for it so phones can scan to join.
app.get("/api/info", (req, res) => res.json({ joinUrl: publicJoinUrl(req), lanIp: lanIp(), port: CONFIG.port }));
app.get("/api/songs", async (_req, res) => {
  try {
    res.json({ songs: await songStore.list() });
  } catch (err) {
    console.error("[songs] list failed:", (err as Error).message);
    res.status(500).json({ error: "Could not list locally saved songs." });
  }
});
// Only the CURRENT set's songs (the dashboard Session Setlist) — cleared on
// reset/start, so a new set starts with an empty list.
app.get("/api/session-songs", (_req, res) => res.json({ songs: registry.only().show.currentSetSongs() }));
// A persistent playlist for ONE set, so a "save the playlist" link/QR still works
// after the show ends (and after later sessions). The setId is the epoch-ms time
// of the set's first song; we cluster the archive the same way the dashboard does
// (25-min gap) and return the matching set's songs, oldest-first.
// Group the archive into "sets" — songs within 25 min of each other belong to the
// same night — and return the one containing the given set id (its first song's epoch).
async function findSetSongs(setId: number): Promise<SavedSong[] | null> {
  const all = await songStore.list();
  const sorted = [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const GAP = 25 * 60 * 1000;
  const sets: SavedSong[][] = [];
  let cur: SavedSong[] | null = null;
  let last = 0;
  for (const s of sorted) {
    const t = Date.parse(s.createdAt);
    if (!cur || t - last > GAP) { cur = []; sets.push(cur); }
    cur.push(s);
    last = t;
  }
  return sets.find((g) => g.some((s) => Date.parse(s.createdAt) === setId)) ?? null;
}

app.get("/api/playlist/:setId", async (req, res) => {
  try {
    const set = await findSetSongs(Number(req.params.setId));
    res.json({ songs: set ?? [] });
  } catch (err) {
    console.error("[playlist] failed:", (err as Error).message);
    res.status(500).json({ error: "Could not load the playlist." });
  }
});

// Download the whole set as ONE .zip — the only reliable "save all" on mobile,
// where browsers allow just one file per tap. Streams each track (local file or
// remote Supabase URL) into the archive so nothing buffers the whole set at once.
app.get("/api/playlist/:setId/zip", async (req, res) => {
  try {
    const setId = Number(req.params.setId);
    const set = await findSetSongs(setId);
    if (!set || set.length === 0) {
      res.status(404).json({ error: "Set not found." });
      return;
    }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="between-sets-${setId}.zip"`);
    const archive = archiver("zip", { store: true }); // audio is already compressed
    archive.on("warning", (err) => console.warn("[zip] warning:", err.message));
    archive.on("error", (err) => {
      console.error("[zip] failed:", err.message);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    archive.pipe(res);
    const used = new Set<string>();
    let n = 0;
    for (const song of set) {
      const target = await songStore.fileFor(song.id);
      if (!target) continue;
      // de-dupe names within the zip; prefix track order for a tidy listing
      let name = `${String(++n).padStart(2, "0")} ${song.fileName}`;
      while (used.has(name)) name = `${name.replace(/\.[^.]+$/, "")}_.${song.fileName.split(".").pop()}`;
      used.add(name);
      if (target.filePath) {
        archive.file(target.filePath, { name });
      } else if (target.url) {
        const resp = await fetch(target.url);
        if (resp.ok && resp.body) {
          const buf = Buffer.from(await resp.arrayBuffer());
          archive.append(buf, { name });
        }
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error("[zip] failed:", (err as Error).message);
    if (!res.headersSent) res.status(500).json({ error: "Could not build the set download." });
  }
});
app.get("/api/songs/:id/download", async (req, res) => {
  try {
    const saved = await songStore.fileFor(req.params.id);
    if (!saved) {
      res.status(404).json({ error: "Song not found." });
      return;
    }
    if (saved.url) {
      res.redirect(saved.url); // Supabase Storage public URL
    } else if (saved.filePath) {
      res.download(saved.filePath, saved.song.fileName); // local file
    } else {
      res.status(404).json({ error: "Song file not found." });
    }
  } catch (err) {
    console.error("[songs] download failed:", (err as Error).message);
    res.status(500).json({ error: "Could not download the saved song." });
  }
});
app.delete("/api/songs/:id", async (req, res) => {
  try {
    const removed = await songStore.delete(req.params.id);
    if (!removed) {
      res.status(404).json({ error: "Song not found." });
      return;
    }
    registry.only().broadcast({ type: "song_deleted", id: req.params.id });
    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    console.error("[songs] delete failed:", (err as Error).message);
    res.status(500).json({ error: "Could not delete the saved song." });
  }
});
app.get("/qr", async (req, res) => {
  try {
    let url = publicJoinUrl(req);
    const set = typeof req.query.set === "string" ? req.query.set : "";
    if (set) {
      // "save the playlist" QR → the persistent recap for this set.
      url += (url.includes("?") ? "&" : "?") + "set=" + encodeURIComponent(set);
    } else {
      const c = registry.only().room.snapshot().code;
      if (c) url += (url.includes("?") ? "&" : "?") + "code=" + encodeURIComponent(c);
    }
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#0A0A0F", light: "#FFFFFF" } });
    res.type("image/svg+xml").send(svg);
  } catch {
    res.status(500).send("qr error");
  }
});
app.use(express.static(frontendDir));

const server = createServer(app);
const wss = new WebSocketServer({ server });
let playbackState: Extract<ServerMsg, { type: "playback_state" }> = {
  type: "playback_state",
  playing: false,
  canSkip: false,
};

// Track which participantId each socket owns, for crowdSize + disconnect cleanup.
const wsParticipant = new WeakMap<WebSocket, string>();
let wsSeq = 0; // stable per-socket id for the vibe tally (distinct phones per option)
// connKey (stringified per-socket id) → ws, so a host promotion can target the
// newly-crowned phone with host_granted. WeakMap can't iterate, so use a Map and
// clean it up on close.
const wsByKey = new Map<string, WebSocket>();
const MIN_PLAYERS = 2; // a show needs at least this many in the room to start

// Tally helpers shared by the vibe message + disconnect paths.
function vibeTallyMsg(session: Session): ServerMsg {
  const t = session.vibes.tally();
  return { type: "vibe_tally", counts: t.counts, total: t.total };
}

wss.on("connection", (ws) => {
  const session = registry.only();
  session.addSocket(ws);
  const socketId = ++wsSeq;
  const connKey = String(socketId);
  wsByKey.set(connKey, ws);
  console.log("[ws] client connected");
  // Seed the new client (e.g. a freshly-loaded stage) with the current names.
  ws.send(JSON.stringify({ type: "names", names: session.participants.names() } as ServerMsg));
  ws.send(JSON.stringify(playbackState));
  ws.send(JSON.stringify({ type: "show_state", ...session.show.currentShowState() } as ServerMsg));
  ws.send(JSON.stringify({ type: "room_state", ...session.room.snapshot() } as ServerMsg));
  // Seed the current vibe poll (options + live tally) so a fresh phone renders it.
  ws.send(JSON.stringify({ type: "vibe_options", cards: session.vibes.getCards() } as ServerMsg));
  ws.send(JSON.stringify(vibeTallyMsg(session)));
  // If the set has already ended, seed this fresh connection with the recap so a
  // phone scanning the end-of-set QR lands on the playlist, not the lobby.
  const recap = session.show.currentRecap();
  if (recap) ws.send(JSON.stringify({ type: "show_ended", songs: recap } as ServerMsg));
  // If a track is live right now, re-seed this connection with it so a stage that
  // reloaded mid-show resumes audio (and starts reporting `playing` so rounds
  // advance again) instead of sitting silent on whatever phase show_state reports.
  const liveSong = session.show.currentPlayingSong();
  if (liveSong) ws.send(JSON.stringify({ type: "song_ready", song: liveSong } as ServerMsg));

  ws.on("message", (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "join": {
        const res = session.room.tryJoin(connKey, msg.name, msg.code, msg.hostToken);
        if (!res.ok) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "join_rejected", reason: res.reason } as ServerMsg));
          }
          break;
        }
        const id = session.participants.join(msg.name);
        wsParticipant.set(ws, id);
        const reply: ServerMsg = {
          type: "joined",
          participantId: id,
          isHost: res.isHost,
          hostToken: res.hostToken,
          code: session.room.snapshot().code,
        };
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
        const nm = (msg.name || "").trim();
        if (nm) session.broadcast({ type: "name", name: nm });
        break;
      }
      case "answer":
        session.show.handleAnswer(msg.participantId, msg.text);
        break;
      case "pull":
        session.show.handlePull(msg.participantId, msg.side, msg.impulse);
        break;
      case "vibe":
        session.vibes.recordPick(socketId, msg.index);
        session.broadcast(vibeTallyMsg(session));
        break;
      case "vibeCards":
        session.vibes.setCards(msg.cards);
        session.broadcast({ type: "vibe_options", cards: session.vibes.getCards() });
        session.broadcast(vibeTallyMsg(session));
        break;
      case "playing":
        session.show.onPlaying(msg.id);
        break;
      case "start":
        session.show.startShow(msg.opener);
        break;
      case "create_room": {
        const r = session.room.createRoom();
        if (!r.ok && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "join_rejected", reason: "busy" } as ServerMsg));
        }
        break;
      }
      case "host_start": {
        const s = session.room.snapshot();
        // A show needs at least MIN_PLAYERS in the room (host + ≥1 other). The
        // phone hides START below this, but enforce it server-side too.
        if (session.room.authorizeHost(connKey, msg.hostToken) && s.lobbyState === "open" && s.crowd >= MIN_PLAYERS) {
          session.room.markLive();
          session.show.startShow();
        }
        break;
      }
      case "advance": {
        // Host "everyone's in" → close the untimed naming window, open the "what" gather.
        if (session.room.authorizeHost(connKey, msg.hostToken)) session.show.advance();
        break;
      }
      case "rename": {
        // "Change my name" — rename ONLY the participant this connection owns. The
        // client-supplied msg.participantId is NOT trusted (IDOR: a phone could
        // otherwise rename anyone, and the name lands in lyrics + on the big screen).
        const nm = (msg.name || "").trim();
        const ownId = wsParticipant.get(ws);
        if (nm && ownId) {
          session.participants.rename(ownId, nm);
          session.broadcast({ type: "names", names: session.participants.names() });
        }
        break;
      }
      case "host_end": {
        if (session.room.authorizeHost(connKey, msg.hostToken)) {
          session.room.markEnded();
          void session.show.endShow();
        }
        break;
      }
      case "add_sim_players": {
        // Dev/test: the host fills the room with fake players so a solo tester can
        // hit the 2-player minimum and run a believable show alone.
        if (session.room.isHost(connKey)) {
          const n = Math.min(Math.max(1, msg.count ?? 4), 12);
          session.sim.add(n);
        }
        break;
      }
      case "config":
        session.show.applyConfig(msg);
        break;
      case "skip":
        session.show.skip();
        break;
      case "hold":
        session.show.hold();
        break;
      case "resume":
        session.show.resume();
        break;
      case "reset":
        session.show.reset();
        break;
      case "end":
        void session.show.endShow();
        break;
      case "endVote":
        session.show.endVote();
        break;
      case "forceNext":
        session.broadcast({ type: "force_next" });
        break;
      case "playbackControl":
        session.broadcast({ type: "playback_control", action: msg.action });
        break;
      case "playbackState":
        playbackState = {
          type: "playback_state",
          playing: msg.playing,
          canSkip: msg.canSkip,
          song: msg.song,
          nextSong: msg.nextSong,
          position: msg.position,
          duration: msg.duration,
        };
        session.broadcast(playbackState);
        break;
      default:
        break;
    }
  });

  ws.on("close", () => {
    session.removeSocket(ws);
    const id = wsParticipant.get(ws);
    if (id) {
      session.participants.remove(id);
      wsParticipant.delete(ws);
    }
    const promo = session.room.leave(connKey);
    if (promo.hostChanged && promo.newHostKey) {
      const newHostWs = wsByKey.get(promo.newHostKey);
      if (newHostWs && newHostWs.readyState === WebSocket.OPEN && promo.newHostToken) {
        newHostWs.send(JSON.stringify({ type: "host_granted", hostToken: promo.newHostToken } as ServerMsg));
      }
    }
    wsByKey.delete(connKey);
    session.vibes.removeSocket(socketId);
    session.broadcast(vibeTallyMsg(session));
    console.log("[ws] client disconnected");
  });
});

server.listen(CONFIG.port, () => {
  console.log(`[server] stage:     http://localhost:${CONFIG.port}/stage-live.html`);
  console.log(`[server] dashboard: http://localhost:${CONFIG.port}/dash-live.html`);
  console.log(`[server] JOIN (phones on same WiFi): ${LOCAL_JOIN_URL}`);
  console.log(`[server] (on a host, the join URL/QR use the request host or PUBLIC_URL)`);
  console.log(`[server] collectSeconds=${CONFIG.collectSeconds} fadeSeconds=${CONFIG.fadeSeconds} model=${CONFIG.agentModel}`);
});
