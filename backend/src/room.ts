// backend/src/room.ts
import { randomBytes } from "node:crypto";
import type { ServerMsg } from "./types.js";

export type LobbyState = "closed" | "open" | "live" | "ended";

// 4-letter join code, Jackbox-style. Alphabet excludes I, L, O, 0, 1 so a code
// read off a projector is never mistyped. Members are tracked by an opaque
// connection key (the server passes its per-socket id) in JOIN ORDER, so host
// promotion can pick the earliest remaining phone. Host is bound to the
// connection, not the participantId (which the phone discards every round).
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const EMPTY_LOBBY_MS = 10 * 60_000;

export class Room {
  private code: string | null = null;
  private lobbyState: LobbyState = "closed";
  private hostKey: string | null = null;
  private hostToken: string | null = null;
  private members: Array<{ key: string; name: string }> = [];
  private emptyTimer: NodeJS.Timeout | null = null;

  constructor(private readonly broadcast: (msg: ServerMsg) => void) {}

  private genCode(): string {
    let out = "";
    for (let i = 0; i < 4; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return out;
  }

  private genToken(): string {
    return randomBytes(32).toString("base64url");
  }

  private hostName(): string | null {
    const h = this.members.find((m) => m.key === this.hostKey);
    return h ? h.name : null;
  }

  private armEmptyTimer(): void {
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = setTimeout(() => {
      this.emptyTimer = null;
      if (this.lobbyState === "open" && this.members.length === 0) {
        console.warn("[room] empty lobby idle — auto-closing");
        this.close();
      }
    }, EMPTY_LOBBY_MS);
  }

  private disarmEmptyTimer(): void {
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
  }

  private broadcastState(): void {
    this.broadcast({ type: "room_state", ...this.snapshot() });
  }

  public snapshot(): {
    code: string | null;
    lobbyState: LobbyState;
    hostName: string | null;
    crowd: number;
  } {
    return { code: this.code, lobbyState: this.lobbyState, hostName: this.hostName(), crowd: this.members.length };
  }

  public createRoom(): { ok: true; code: string } | { ok: false; reason: "busy" } {
    if (this.lobbyState === "open" || this.lobbyState === "live") return { ok: false, reason: "busy" };
    this.code = this.genCode();
    this.lobbyState = "open";
    this.hostKey = null;
    this.hostToken = null;
    this.members.length = 0;
    this.armEmptyTimer();
    this.broadcastState();
    return { ok: true, code: this.code };
  }

  public close(): void {
    this.disarmEmptyTimer();
    this.code = null;
    this.lobbyState = "closed";
    this.hostKey = null;
    this.hostToken = null;
    this.members.length = 0;
    this.broadcastState();
  }

  public tryJoin(
    connKey: string,
    name: string,
    joinCode: string | undefined,
    token: string | undefined,
  ):
    | { ok: true; isHost: boolean; hostToken?: string }
    | { ok: false; reason: "bad_code" } {
    // No room open → accept without a code (DJ-console flow, loadtest, democrowd
    // with no --code). These joins are not lobby members and never become host.
    if (this.lobbyState === "closed" || this.lobbyState === "ended") {
      return { ok: true, isHost: false };
    }
    if (!joinCode || joinCode.trim().toUpperCase() !== this.code) {
      return { ok: false, reason: "bad_code" };
    }
    const existing = this.members.find((m) => m.key === connKey);
    if (existing) existing.name = name;
    else {
      this.members.push({ key: connKey, name });
      this.disarmEmptyTimer();
    }

    if (token && token === this.hostToken) {
      this.hostKey = connKey;
      this.broadcastState();
      return { ok: true, isHost: true, hostToken: this.hostToken };
    }
    // Take an empty host seat — in an OPEN lobby (the normal first-joiner case) or
    // during a LIVE show whose host vanished (everyone reloaded mid-show): the next
    // phone to (re)connect becomes host so end/reset controls are never orphaned.
    if (this.hostKey === null && (this.lobbyState === "open" || this.lobbyState === "live")) {
      this.hostKey = connKey;
      this.hostToken = this.genToken();
      this.broadcastState();
      return { ok: true, isHost: true, hostToken: this.hostToken };
    }
    this.broadcastState();
    return { ok: true, isHost: false };
  }

  public isHost(connKey: string): boolean {
    return connKey === this.hostKey;
  }

  /** Authorize a host action by connection OR by the host token. If the token
   *  matches but the connKey differs (the host reconnected with a new socket),
   *  reclaim host onto this connection so future checks pass too. Makes host_start
   *  / host_end robust to the connection dropping and reconnecting mid-show. */
  public authorizeHost(connKey: string, token: string | undefined): boolean {
    if (connKey === this.hostKey) return true;
    if (token && this.hostToken && token === this.hostToken) {
      this.hostKey = connKey;
      return true;
    }
    return false;
  }

  /** Add a simulated player as a room member so it counts toward the crowd. Never
   *  becomes host. Caller (sim.ts) broadcasts room_state once after a batch. */
  public addSimMember(key: string, name: string): void {
    if (!this.members.find((m) => m.key === key)) {
      this.members.push({ key, name });
      this.disarmEmptyTimer();
    }
  }

  public markLive(): void {
    if (this.lobbyState === "open") {
      this.lobbyState = "live";
      this.broadcastState();
    }
  }

  public markEnded(): void {
    if (this.lobbyState === "live" || this.lobbyState === "open") {
      this.lobbyState = "ended";
      this.broadcastState();
    }
  }

  public leave(connKey: string):
    | { hostChanged: false }
    | { hostChanged: true; newHostKey: string | null; newHostToken: string | null } {
    const idx = this.members.findIndex((m) => m.key === connKey);
    if (idx >= 0) this.members.splice(idx, 1);
    // Re-arm the empty timer if the lobby is now empty
    if (this.members.length === 0 && this.lobbyState === "open") this.armEmptyTimer();
    // Promote only in an OPEN lobby — during a live show the host's start button is
    // already spent, and silent re-assignment would just churn. The DJ console and
    // the watchdog still own end/reset.
    if (connKey === this.hostKey && this.lobbyState === "open") {
      this.hostKey = this.members.length > 0 ? this.members[0]!.key : null;
      this.hostToken = this.members.length > 0 ? this.genToken() : null;
      this.broadcastState();
      return { hostChanged: true, newHostKey: this.hostKey, newHostToken: this.hostToken };
    }
    // Host left during live/ended — clear the dead socket but KEEP hostToken so the
    // host can reclaim it on reload (phones persist it in sessionStorage). If they
    // don't come back, the next phone to (re)join takes the empty host seat via
    // tryJoin, so the show is never left without end/reset controls.
    if (connKey === this.hostKey) {
      this.hostKey = null;
      this.broadcastState();
      return { hostChanged: false };
    }
    if (idx >= 0) this.broadcastState();
    return { hostChanged: false };
  }
}
