// backend/src/room.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Room } from "./room.js";

let room: Room;

describe("room code minting", () => {
  beforeEach(() => { room = new Room(() => {}); });

  it("opens a room with a 4-char code from the unambiguous alphabet", () => {
    const res = room.createRoom();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(room.snapshot().lobbyState).toBe("open");
  });

  it("never includes ambiguous characters I, L, O, 0, 1", () => {
    for (let i = 0; i < 300; i++) {
      room = new Room(() => {});
      const res = room.createRoom();
      if (res.ok) expect(res.code).not.toMatch(/[ILO01]/);
    }
  });

  it("rejects a second createRoom while one is open (busy)", () => {
    room.createRoom();
    const res = room.createRoom();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("busy");
  });
});

describe("room join + host assignment", () => {
  beforeEach(() => { room = new Room(() => {}); });

  it("accepts a codeless join when no room is open (legacy DJ/loadtest flow)", () => {
    const res = room.tryJoin("c1", "Maya", undefined, undefined);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.isHost).toBe(false);
  });

  it("rejects a join with the wrong code while a room is open", () => {
    const open = room.createRoom();
    const wrong = open.ok ? open.code + "X" : "ZZZZ";
    const res = room.tryJoin("c1", "Maya", wrong, undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_code");
  });

  it("accepts a correct code case-insensitively and makes the first joiner host", () => {
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    const res = room.tryJoin("c1", "Maya", c.toLowerCase(), undefined);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.isHost).toBe(true);
      expect(typeof res.hostToken).toBe("string");
    }
    expect(room.snapshot().hostName).toBe("Maya");
    expect(room.snapshot().crowd).toBe(1);
  });

  it("makes only the first joiner host; later joiners are not", () => {
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    room.tryJoin("c1", "Maya", c, undefined);
    const res = room.tryJoin("c2", "Theo", c, undefined);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.isHost).toBe(false);
    expect(room.snapshot().crowd).toBe(2);
  });

  it("lets the host reclaim via a valid hostToken (e.g. after reconnect)", () => {
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    const first = room.tryJoin("c1", "Maya", c, undefined);
    const token = first.ok ? first.hostToken : undefined;
    const again = room.tryJoin("c9", "Maya", c, token); // new connection key
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.isHost).toBe(true);
  });

  it("does not add a duplicate member when the same connection re-joins each round", () => {
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    room.tryJoin("c1", "Maya", c, undefined);
    room.tryJoin("c1", "Maya", c, undefined);
    expect(room.snapshot().crowd).toBe(1);
  });
});

describe("room host authorization + lifecycle", () => {
  beforeEach(() => { room = new Room(() => {}); });

  it("authorizes host-only actions by connection key", () => {
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    room.tryJoin("host", "Maya", c, undefined);
    room.tryJoin("guest", "Theo", c, undefined);
    expect(room.isHost("host")).toBe(true);
    expect(room.isHost("guest")).toBe(false);
  });

  it("markLive moves an open lobby to live; markEnded to ended", () => {
    room.createRoom();
    room.markLive();
    expect(room.snapshot().lobbyState).toBe("live");
    room.markEnded();
    expect(room.snapshot().lobbyState).toBe("ended");
  });

  it("promotes the earliest remaining member when the host leaves an open lobby", () => {
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    room.tryJoin("host", "Maya", c, undefined);
    room.tryJoin("g1", "Theo", c, undefined);
    room.tryJoin("g2", "Priya", c, undefined);
    const res = room.leave("host");
    expect(res.hostChanged).toBe(true);
    if (res.hostChanged) {
      expect(res.newHostKey).toBe("g1");
      expect(typeof res.newHostToken).toBe("string");
    }
    expect(room.snapshot().hostName).toBe("Theo");
  });

  it("does not promote on a non-host leave", () => {
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    room.tryJoin("host", "Maya", c, undefined);
    room.tryJoin("g1", "Theo", c, undefined);
    const res = room.leave("g1");
    expect(res.hostChanged).toBe(false);
    expect(room.snapshot().hostName).toBe("Maya");
  });

  it("does not promote during a live show when the host leaves", () => {
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    room.tryJoin("host", "Maya", c, undefined);
    room.tryJoin("g1", "Theo", c, undefined);
    room.markLive();
    const res = room.leave("host");
    expect(res.hostChanged).toBe(false);
  });

  it("clears stale hostKey when host leaves during live show — isHost returns false", () => {
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    room.tryJoin("host", "Maya", c, undefined);
    room.tryJoin("g1", "Theo", c, undefined);
    room.markLive();
    room.leave("host");
    expect(room.isHost("host")).toBe(false);
  });

  it("lets the host reclaim via token after dropping during a LIVE show (reload)", () => {
    // Repro of the stuck-show incident: host reloads mid-show. leave() must keep
    // the hostToken alive so the reconnecting host reclaims end/reset controls.
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    const first = room.tryJoin("host", "Maya", c, undefined);
    const token = first.ok ? first.hostToken : undefined;
    room.tryJoin("g1", "Theo", c, undefined);
    room.markLive();
    room.leave("host"); // host's socket drops on reload
    expect(room.snapshot().hostName).toBe(null); // no live host for the moment
    const rejoin = room.tryJoin("host-reconnect", "Maya", c, token);
    expect(rejoin.ok).toBe(true);
    if (rejoin.ok) expect(rejoin.isHost).toBe(true);
    expect(room.isHost("host-reconnect")).toBe(true);
  });

  it("lets the next phone take the empty host seat during a LIVE show if the host is gone", () => {
    // Host closed the tab for good mid-show. The next phone to (re)join becomes
    // host so the show is never left without end/reset controls.
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    room.tryJoin("host", "Maya", c, undefined);
    room.tryJoin("g1", "Theo", c, undefined);
    room.markLive();
    room.leave("host");
    const res = room.tryJoin("g1-reconnect", "Theo", c, undefined); // no host token
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.isHost).toBe(true);
      expect(typeof res.hostToken).toBe("string");
    }
    expect(room.isHost("g1-reconnect")).toBe(true);
  });

  it("a promoted host can reclaim via the newHostToken returned by leave()", () => {
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    room.tryJoin("orig-host", "Maya", c, undefined);
    room.tryJoin("next-host", "Theo", c, undefined);
    const leaveRes = room.leave("orig-host");
    expect(leaveRes.hostChanged).toBe(true);
    if (!leaveRes.hostChanged) return;
    const token = leaveRes.newHostToken ?? undefined;
    // next-host reconnects with a fresh connection key but uses the promoted token
    const rejoin = room.tryJoin("next-host-reconnect", "Theo", c, token);
    expect(rejoin.ok).toBe(true);
    if (rejoin.ok) expect(rejoin.isHost).toBe(true);
  });

  it("tryJoin in the ended state returns ok:true, isHost:false and ignores any token", () => {
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    room.tryJoin("host", "Maya", c, undefined);
    room.markLive();
    room.markEnded();
    // Even passing a previously valid token should not grant host
    const res = room.tryJoin("late-comer", "Sam", c, "some-stale-token");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.isHost).toBe(false);
  });
});

describe("empty-lobby watchdog", () => {
  beforeEach(() => { vi.useFakeTimers(); room = new Room(() => {}); });
  afterEach(() => vi.useRealTimers());

  it("auto-closes an open lobby that nobody joins within the idle window", () => {
    room.createRoom();
    vi.advanceTimersByTime(10 * 60_000 + 1000);
    expect(room.snapshot().lobbyState).toBe("closed");
  });

  it("does not auto-close while at least one member is present", () => {
    const open = room.createRoom();
    const c = open.ok ? open.code : "";
    room.tryJoin("c1", "Maya", c, undefined);
    vi.advanceTimersByTime(30 * 60_000);
    expect(room.snapshot().lobbyState).toBe("open");
  });
});
