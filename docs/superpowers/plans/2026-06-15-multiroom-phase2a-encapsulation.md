# Multi-Room Phase 2a — Session Encapsulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert every module-level singleton (`tug`, `participants`, `vibes`, `room`, `sim`, `showMachine`, `bus`) into a class, wrapped in a single `Session` held by a `SessionRegistry` of exactly one — with behavior byte-for-byte identical to today.

**Architecture:** Bottom-up dependency injection. Leaf state modules (`Tug`, `Participants`, `Vibes`) become plain classes. `Room`, `Sim`, `ShowMachine` take an injected per-session `broadcast(msg)` and their sibling instances via constructor. A `Session` constructs the whole graph and owns a scoped `broadcast`; a `SessionRegistry` holds one `Session`. `server.ts` calls `registry.only().<method>()` instead of module functions. No wire-protocol or behavior change — this is the de-risking step before multi-tenancy (Phase 2b).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node, `tsx`, Vitest, `ws`.

**Reference spec:** `docs/superpowers/specs/2026-06-15-jackbox-multiroom-sessionization-design.md` (Phase 2a section).

---

## Guiding rules for every task

- **TDD-by-preservation:** the existing 40 tests are the safety net. After each conversion, the module's existing test file is adapted to construct the new class and must stay green. Do not change behavior.
- **ESM imports:** always import with `.js` specifiers (e.g. `from "./tug.js"`), matching the codebase.
- **No behavior change:** identical broadcasts, identical timing, identical state transitions. If a test needs more than a mechanical edit (construct-an-instance), you changed behavior — stop and revert.
- **Commit after each green task.**
- **Run the full suite** (`npx vitest run`) before every commit, not just the task's test.

## File structure (what each unit owns after Phase 2a)

| File | Responsibility after 2a |
|---|---|
| `backend/src/tug.ts` | `class Tug` — one tug-of-war's pull/decay/snapshot state |
| `backend/src/participants.ts` | `class Participants` — one room's joined people + intents + selection |
| `backend/src/vibes.ts` | `class Vibes` — one room's vibe poll (cards, picks, tally) |
| `backend/src/room.ts` | `class Room` — one room's code/host/lobby/members (takes injected `broadcast`) |
| `backend/src/sim.ts` | `class Sim` — one room's simulated players (takes `broadcast`, `Participants`, `Room`, `Tug`) |
| `backend/src/showMachine.ts` | `class ShowMachine` — one show loop + **instance-owned timers** (takes `broadcast` + sibling instances) |
| `backend/src/session.ts` | **NEW** `class Session` — constructs the whole graph, owns the scoped `broadcast`, `close()` clears all timers |
| `backend/src/sessionRegistry.ts` | **NEW** `class SessionRegistry` — holds one `Session`, exposes `only()` |
| `backend/src/bus.ts` | Keep `ServerMsg` type export; the global `broadcast`/`setSender` is replaced by per-session broadcast (see Task 9) |
| `backend/src/server.ts` | Routes WS messages to `registry.only()`; constructs the registry with a sender |

---

## Task 1: `Tug` class

**Files:**
- Modify: `backend/src/tug.ts`
- Test: `backend/src/tug.test.ts`

`tug.ts` is a pure leaf (no imports of bus/siblings). Convert the module `let` state (the `p`, drive, members maps, etc.) into instance fields of `class Tug`, and the exported functions (`reset`, `applyPull`, `tick`, `snapshot`, `winner`) into methods. Keep `TugSnapshot` and `Side` as-is. No `broadcast` needed.

- [ ] **Step 1: Convert to a class.** Wrap all module-level `let`/`const` mutable state as private instance fields initialized in the constructor (or field initializers). Turn each `export function foo()` into a public method `foo()`. Keep `export interface TugSnapshot`. Remove the module-level state and the bottom-of-file `tug.reset(...)` / loop calls if any (there are none in tug.ts). Export `class Tug`.

```ts
// tug.ts (shape)
import type { Side } from "./types.js";

export interface TugSnapshot { /* unchanged */ }

export class Tug {
  private p = 0.5;
  // ...every former module `let` becomes a field here...
  reset(_genreA?: unknown, _genreB?: unknown): void { /* former body */ }
  applyPull(participantId: string, side: Side, impulse: number): void { /* former body */ }
  tick(): void { /* former body */ }
  snapshot(): TugSnapshot { /* former body */ }
  winner(): Side { return this.p <= 0.5 ? "A" : "B"; }
}
```

- [ ] **Step 2: Adapt `tug.test.ts`.** Replace `import * as tug from "./tug.js"` with `import { Tug } from "./tug.js"`, and in each test (or a `beforeEach`) construct `const tug = new Tug();`. Calls become `tug.applyPull(...)`, `tug.snapshot()`, etc. (mechanical — method names are identical).

- [ ] **Step 3: Run the tug tests.**

Run: `npx vitest run backend/src/tug.test.ts`
Expected: PASS (same assertions as before).

- [ ] **Step 4: Typecheck + full suite.**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: tsc clean; other test files still fail to compile only if they import `tug` as a namespace — they don't yet (only `sim`/`showMachine` do, converted later). If a non-tug test breaks, you changed behavior — revert.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/tug.ts backend/src/tug.test.ts
git commit -m "refactor: Tug singleton → class (no behavior change)"
```

---

## Task 2: `Participants` class

**Files:**
- Modify: `backend/src/participants.ts`
- Test: none today (no participants.test.ts) — add a tiny one to lock selection behavior.
- Create: `backend/src/participants.test.ts`

Pure leaf (no bus/sibling imports). Convert the `byId` map, `seq`, `lastSelectedId` to instance fields; methods: `join`, `setAnswer`, `clearRound`, `remove`, `reset`, `count`, `nameOf`, `names`, `selectRandomAnswerer`.

- [ ] **Step 1: Convert to a class.**

```ts
// participants.ts (shape)
interface Participant { id: string; name: string; answer: string | null; sim: boolean; }

export class Participants {
  private byId = new Map<string, Participant>();
  private seq = 0;
  private lastSelectedId: string | null = null;
  join(name: string, sim = false): string { /* former body, using this.seq/this.byId */ }
  setAnswer(participantId: string, text: string): void { /* former body */ }
  clearRound(): void {}
  remove(participantId: string): void { /* former body */ }
  reset(): void { this.byId.clear(); this.lastSelectedId = null; }
  count(): number { return this.byId.size; }
  nameOf(participantId: string): string | null { /* former body */ }
  names(): string[] { /* former body */ }
  selectRandomAnswerer(): { name: string; answer: string } | null { /* former body */ }
}
```

- [ ] **Step 2: Write a focused test that locks the selection contract.**

```ts
// participants.test.ts
import { describe, it, expect } from "vitest";
import { Participants } from "./participants.js";

describe("Participants.selectRandomAnswerer", () => {
  it("returns null when nobody answered", () => {
    const p = new Participants();
    p.join("Maya");
    expect(p.selectRandomAnswerer()).toBe(null);
  });
  it("prefers real players over sim players", () => {
    const p = new Participants();
    const real = p.join("Maya", false);
    const bot = p.join("Bot", true);
    p.setAnswer(real, "dance");
    p.setAnswer(bot, "sim wants");
    const pick = p.selectRandomAnswerer();
    expect(pick?.name).toBe("Maya"); // real wins over sim
  });
  it("two fresh instances are fully isolated", () => {
    const a = new Participants(); const b = new Participants();
    a.join("A"); a.setAnswer("p1", "x");
    expect(b.count()).toBe(0);
    expect(b.selectRandomAnswerer()).toBe(null);
  });
});
```

- [ ] **Step 3: Run it.**

Run: `npx vitest run backend/src/participants.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck + full suite.**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: tsc clean (showMachine/sim still import `* as participants` — fix in their tasks; they won't compile yet only if converted out of order, so keep this order). If `showMachine.ts` fails to compile here, that's expected ONLY if you started its task — otherwise it still uses the namespace import which no longer exists. **Resolution:** keep `participants.ts` ALSO exporting a temporary default singleton during the transition is NOT allowed (no behavior duplication). Instead, do Tasks 1–6 as one continuous branch and only run the full suite green at Task 6+. Run `npx tsc --noEmit` per task to catch type breaks, and expect transient namespace-import errors in `sim.ts`/`showMachine.ts` until their tasks land.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/participants.ts backend/src/participants.test.ts
git commit -m "refactor: Participants singleton → class + selection tests"
```

> **Transition note (applies to Tasks 1–6):** `sim.ts` and `showMachine.ts` import the leaf modules as namespaces (`import * as tug`). While converting bottom-up, those two files will have type errors until their own tasks convert them to construct instances. That is expected mid-refactor. The **full suite green** gate is at **Task 6** (ShowMachine) and **Task 10** (final). Per-task, the gate is: the converted module's own tests pass + `tsc` shows only the expected transient namespace errors in not-yet-converted consumers.

---

## Task 3: `Vibes` class

**Files:**
- Modify: `backend/src/vibes.ts`
- Create: `backend/src/vibes.test.ts`

Pure leaf. Convert state (cards, per-socket picks map) to fields; methods: `setCards`, `getCards`, `recordPick`, `removeSocket`, `tally`, `winner`, `reset`.

- [ ] **Step 1: Convert to a class.**

```ts
// vibes.ts (shape)
export class Vibes {
  private cards: string[] = [];
  private picks = new Map<number, number>(); // socketId → card index
  setCards(next: string[]): void { /* former body */ }
  getCards(): string[] { /* former body */ }
  recordPick(socketId: number, index: number): void { /* former body */ }
  removeSocket(socketId: number): void { /* former body */ }
  tally(): { counts: number[]; total: number } { /* former body */ }
  winner(): string | null { /* former body */ }
  reset(): void { /* former body */ }
}
```

- [ ] **Step 2: Write a focused test.**

```ts
// vibes.test.ts
import { describe, it, expect } from "vitest";
import { Vibes } from "./vibes.js";

describe("Vibes", () => {
  it("tallies picks and reports the winner card", () => {
    const v = new Vibes();
    v.setCards(["Chill", "Hype"]);
    v.recordPick(1, 1); v.recordPick(2, 1); v.recordPick(3, 0);
    expect(v.tally()).toEqual({ counts: [1, 2], total: 3 });
    expect(v.winner()).toBe("Hype");
  });
  it("two instances are isolated", () => {
    const a = new Vibes(); const b = new Vibes();
    a.setCards(["X"]); a.recordPick(1, 0);
    expect(b.getCards()).toEqual([]);
    expect(b.tally()).toEqual({ counts: [], total: 0 });
  });
});
```

- [ ] **Step 3: Run it.** `npx vitest run backend/src/vibes.test.ts` → PASS.
- [ ] **Step 4: Typecheck.** `npx tsc --noEmit -p tsconfig.json` → only the expected transient namespace errors in `showMachine.ts`/`server.ts`.
- [ ] **Step 5: Commit.**

```bash
git add backend/src/vibes.ts backend/src/vibes.test.ts
git commit -m "refactor: Vibes singleton → class + tests"
```

---

## Task 4: `Room` class (injected `broadcast`)

**Files:**
- Modify: `backend/src/room.ts`
- Test: `backend/src/room.test.ts`

`room.ts` calls `broadcast(...)` (its `broadcastState`). Inject a `broadcast` function via the constructor. Convert `code`/`lobbyState`/`hostKey`/`hostToken`/`members`/`emptyTimer` to fields. Methods unchanged in name: `snapshot`, `createRoom`, `close`, `tryJoin`, `isHost`, `authorizeHost`, `addSimMember`, `markLive`, `markEnded`, `leave`. **The `emptyTimer` becomes an instance field** so `close()` clears it (Task 7 `Session.close()` relies on this).

- [ ] **Step 1: Convert to a class with injected broadcast.**

```ts
// room.ts (shape)
import { randomBytes } from "node:crypto";
import type { ServerMsg } from "./bus.js";

export type LobbyState = "closed" | "open" | "live" | "ended";

export class Room {
  private code: string | null = null;
  private lobbyState: LobbyState = "closed";
  private hostKey: string | null = null;
  private hostToken: string | null = null;
  private readonly members: Array<{ key: string; name: string }> = [];
  private emptyTimer: NodeJS.Timeout | null = null;

  constructor(private readonly broadcast: (msg: ServerMsg) => void) {}

  // every former `export function` becomes a method; former `broadcastState()`
  // calls `this.broadcast({ type: "room_state", ...this.snapshot() })`.
  // every former module-level helper (genCode, hostName, armEmptyTimer,
  // disarmEmptyTimer) becomes a private method.
  snapshot() { /* ... */ }
  createRoom() { /* ... */ }
  close(): void { this.disarmEmptyTimer(); /* ...reset fields... */ this.broadcastState(); }
  tryJoin(/* same args */) { /* ... */ }
  isHost(connKey: string): boolean { /* ... */ }
  authorizeHost(connKey: string, token: string | undefined): boolean { /* ... */ }
  addSimMember(key: string, name: string): void { /* ... */ }
  markLive(): void { /* ... */ }
  markEnded(): void { /* ... */ }
  leave(connKey: string) { /* ... */ }
  private broadcastState(): void { this.broadcast({ type: "room_state", ...this.snapshot() }); }
}
```

- [ ] **Step 2: Adapt `room.test.ts`.** The current tests call `room.createRoom()` etc. on the namespace. Replace with a `beforeEach` that builds `const room = new Room(() => {});` (a no-op broadcast captures nothing) — OR capture messages: `const sent: ServerMsg[] = []; const room = new Room(m => sent.push(m));` if a test asserts on broadcasts (none do today). Keep every assertion identical.

```ts
// room.test.ts (top)
import { Room } from "./room.js";
let room: Room;
beforeEach(() => { room = new Room(() => {}); });
// ...all existing tests, now using the local `room` instance...
```

Note: the empty-lobby watchdog tests use fake timers — they still work because `emptyTimer` is now a field but the timing logic is unchanged.

- [ ] **Step 3: Run room tests.** `npx vitest run backend/src/room.test.ts` → PASS (all existing cases, including the host-recovery and watchdog tests).
- [ ] **Step 4: Typecheck.** `npx tsc --noEmit -p tsconfig.json` → only expected transient errors in `sim.ts`/`showMachine.ts`/`server.ts`.
- [ ] **Step 5: Commit.**

```bash
git add backend/src/room.ts backend/src/room.test.ts
git commit -m "refactor: Room singleton → class with injected broadcast"
```

---

## Task 5: `Sim` class (DI: broadcast, Participants, Room, Tug)

**Files:**
- Modify: `backend/src/sim.ts`

`sim.ts` imports `broadcast`, `participants`, `room`, `tug`. Inject all four. Convert state to fields; methods: `count`, `add`, `rejoinForRound`, `postIntentsToGather`, `voteTick`, `reset`.

- [ ] **Step 1: Convert to a class with injected deps.**

```ts
// sim.ts (shape)
import type { ServerMsg } from "./bus.js";
import type { Participants } from "./participants.js";
import type { Room } from "./room.js";
import type { Tug } from "./tug.js";

export class Sim {
  // former module `let` state → fields
  constructor(private readonly deps: {
    broadcast: (msg: ServerMsg) => void;
    participants: Participants;
    room: Room;
    tug: Tug;
  }) {}
  count(): number { /* former body, using this.deps.* */ }
  add(n: number): number { /* ... */ }
  rejoinForRound(): void { /* ... */ }
  postIntentsToGather(): void { /* ... */ }
  voteTick(): void { /* ... */ }
  reset(): void { /* ... */ }
}
```
Replace every `broadcast(...)` with `this.deps.broadcast(...)`, every `participants.foo()` with `this.deps.participants.foo()`, etc.

- [ ] **Step 2: Typecheck.** `npx tsc --noEmit -p tsconfig.json` → only expected transient errors in `showMachine.ts`/`server.ts` (which still import `* as sim`). No sim test exists; correctness is covered via showMachine + smoke.
- [ ] **Step 3: Commit.**

```bash
git add backend/src/sim.ts
git commit -m "refactor: Sim singleton → class with injected deps"
```

---

## Task 6: `ShowMachine` class (DI: broadcast + all siblings, instance-owned timers)

**Files:**
- Modify: `backend/src/showMachine.ts`
- Test: `backend/src/showMachine.watchdog.test.ts`, `backend/src/showMachine.resume.test.ts`

The big one. `showMachine.ts` imports `broadcast`, `room`, `sim`, `participants`, `vibes`, `tug`. Convert the entire module to `class ShowMachine`:
- Every module `let` (started, generating, held, roundIndex, phase, epochs, timers, genres, setSongs, currentSong, emptyRounds, etc.) → instance field.
- Every `export function` (the full public list) → public method.
- Every module-level helper (`beginGathering`, `beginVoting`, `extendCollecting`, `startTugLoop`, `broadcastTug`, `onBuzzer`, `resolveAndGenerate`, `generateNext`, `playFallbackSong`, `playOpenerTrack`, `pickGenrePair`, etc.) → private method.
- **All timers (`startStallTimer`, `gatherTimer`, `buzzerTimer`, `tugLoop`, and the `setInterval` names-rebroadcast at module load) → instance fields.** The module-load side effects (`tug.reset(...)`, `startTugLoop()`, the 4s `setInterval`) move into the constructor / a `start()` method so they belong to the instance and can be stopped.
- Add a **`stop()`** method that clears every timer field (used by `Session.close()`).
- Constructor injects deps:

```ts
// showMachine.ts (shape)
import type { ServerMsg } from "./bus.js";
import type { Room } from "./room.js";
import type { Sim } from "./sim.js";
import type { Participants } from "./participants.js";
import type { Vibes } from "./vibes.js";
import type { Tug } from "./tug.js";
import { sanitizeIntent } from "./sanitize.js"; // unchanged (shared global)

export class ShowMachine {
  private started = false;
  private phase: Phase = "idle";
  // ...every former module `let` → field...
  private startStallTimer: NodeJS.Timeout | null = null;
  private gatherTimer: NodeJS.Timeout | null = null;
  private buzzerTimer: NodeJS.Timeout | null = null;
  private tugLoop: NodeJS.Timeout | null = null;
  private namesTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: {
    broadcast: (msg: ServerMsg) => void;
    room: Room; sim: Sim; participants: Participants; vibes: Vibes; tug: Tug;
  }) {
    this.deps.tug.reset(this.genreA, this.genreB);
    this.startTugLoop();
    this.namesTimer = setInterval(
      () => this.deps.broadcast({ type: "names", names: this.deps.participants.names() }),
      4000,
    );
  }

  // public methods: currentShowState, currentRecap, currentPlayingSong,
  // currentSetSongs, reset, endShow, startShow, onPlaying, applyConfig,
  // skip, hold, resume, endVote, handlePull, handleAnswer
  // private methods: the rest. All `broadcast(...)` → this.deps.broadcast(...),
  // all `tug.` → this.deps.tug., `participants.` → this.deps.participants., etc.

  stop(): void {
    for (const t of [this.startStallTimer, this.gatherTimer, this.buzzerTimer, this.tugLoop, this.namesTimer]) {
      if (t) clearTimeout(t as NodeJS.Timeout), clearInterval(t as NodeJS.Timeout);
    }
    this.startStallTimer = this.gatherTimer = this.buzzerTimer = this.tugLoop = this.namesTimer = null;
  }
}
```

Generation still calls `craftSongPrompt`/`generateSong`/`songStore` (unchanged module imports — they are stateless services, not per-room).

- [ ] **Step 1: Convert the module to the class** following the shape above. Keep every method body identical except the `this.deps.*` / `this.*` rewrites. Move module-load side effects into the constructor and the `namesTimer`/`tugLoop` into fields. Add `stop()`.

- [ ] **Step 2: Adapt the two showMachine test files.** They currently `await import("./showMachine.js")` and call `show.startShow()` etc. with module-level `vi.mock` of `./agent.js`/`./suno.js`/`./songStore.js`. Replace with constructing a `ShowMachine` and its real sibling instances + a captured broadcast:

```ts
// showMachine.resume.test.ts / .watchdog.test.ts (setup)
import { ShowMachine } from "./showMachine.js";
import { Tug } from "./tug.js";
import { Participants } from "./participants.js";
import { Vibes } from "./vibes.js";
import { Room } from "./room.js";
import { Sim } from "./sim.js";
// keep the existing vi.mock("./agent.js"|"./suno.js"|"./songStore.js") blocks

function makeShow() {
  const sent: any[] = [];
  const broadcast = (m: any) => sent.push(m);
  const tug = new Tug(), participants = new Participants(), vibes = new Vibes();
  const room = new Room(broadcast);
  const sim = new Sim({ broadcast, participants, room, tug });
  const show = new ShowMachine({ broadcast, room, sim, participants, vibes, tug });
  return { show, sent, stop: () => show.stop() };
}
```
In each test, replace `show.reset()` in `beforeEach` with a fresh `makeShow()`; call `show.startShow()`, `show.onPlaying(...)`, `show.currentShowState()`, `show.currentPlayingSong()` on the instance. After each test, call the returned `stop()` to clear the instance timers (prevents fake-timer leakage between tests). The assertions stay identical.

- [ ] **Step 3: Run the showMachine tests.**

Run: `npx vitest run backend/src/showMachine.resume.test.ts backend/src/showMachine.watchdog.test.ts`
Expected: PASS — same assertions (watchdog auto-reset, no-reset-after-playing, live-track re-seed, empty-round auto-advance).

- [ ] **Step 4: Typecheck.** `npx tsc --noEmit -p tsconfig.json` → only `server.ts` errors remain (it still imports the old namespaces — fixed in Task 9).
- [ ] **Step 5: Commit.**

```bash
git add backend/src/showMachine.ts backend/src/showMachine.resume.test.ts backend/src/showMachine.watchdog.test.ts
git commit -m "refactor: ShowMachine singleton → class with instance-owned timers"
```

---

## Task 7: `Session` class

**Files:**
- Create: `backend/src/session.ts`
- Create: `backend/src/session.test.ts`

A `Session` constructs the full graph for one room, owns the scoped `broadcast`, and exposes `close()`.

- [ ] **Step 1: Create the Session.**

```ts
// session.ts
import type WebSocket from "ws";
import type { ServerMsg } from "./bus.js";
import { Tug } from "./tug.js";
import { Participants } from "./participants.js";
import { Vibes } from "./vibes.js";
import { Room } from "./room.js";
import { Sim } from "./sim.js";
import { ShowMachine } from "./showMachine.js";

export class Session {
  readonly sockets = new Set<WebSocket>();
  readonly tug = new Tug();
  readonly participants = new Participants();
  readonly vibes = new Vibes();
  readonly room: Room;
  readonly sim: Sim;
  readonly show: ShowMachine;
  lastActivity = Date.now();

  constructor() {
    const broadcast = (msg: ServerMsg) => this.broadcast(msg);
    this.room = new Room(broadcast);
    this.sim = new Sim({ broadcast, participants: this.participants, room: this.room, tug: this.tug });
    this.show = new ShowMachine({
      broadcast, room: this.room, sim: this.sim,
      participants: this.participants, vibes: this.vibes, tug: this.tug,
    });
  }

  broadcast(msg: ServerMsg): void {
    const raw = JSON.stringify(msg);
    for (const ws of this.sockets) {
      // OPEN === 1; avoid importing the WS enum here
      if ((ws as unknown as { readyState: number }).readyState === 1) ws.send(raw);
    }
  }

  addSocket(ws: WebSocket): void { this.sockets.add(ws); this.lastActivity = Date.now(); }
  removeSocket(ws: WebSocket): void { this.sockets.delete(ws); }

  close(): void {
    this.show.stop();      // clears all show timers (gather/buzzer/stall/tug/names)
    this.room.close();     // clears the empty-lobby timer
    this.sockets.clear();
  }
}
```

- [ ] **Step 2: Write the isolation + teardown test (the multi-tenant guarantee).**

```ts
// session.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { Session } from "./session.js";

vi.mock("./agent.js", () => ({
  craftSongPrompt: vi.fn(async () => ({ title: "T", lyrics: "la", style: "pop" })),
  craftOpenerPrompt: vi.fn(async () => ({ title: "T", lyrics: "la", style: "pop" })),
}));
vi.mock("./suno.js", () => ({
  generateSong: vi.fn(async (_p: unknown, cb: any = {}) => { cb.onPlayable?.("http://x/s.m4a", "streaming"); return { finalUrl: "http://x/f.m4a", msToComplete: 1 }; }),
}));
vi.mock("./songStore.js", () => ({ songStore: { save: vi.fn(async (s: any) => ({ ...s, fileName: "t.m4a", downloadUrl: "http://x/f.m4a" })), list: vi.fn(async () => []) } }));

describe("Session isolation", () => {
  it("an answer in session A does not appear in session B", () => {
    const a = new Session(); const b = new Session();
    const id = a.participants.join("Maya");
    a.participants.setAnswer(id, "dance");
    expect(a.participants.count()).toBe(1);
    expect(b.participants.count()).toBe(0);
    expect(b.participants.selectRandomAnswerer()).toBe(null);
    a.close(); b.close();
  });

  it("broadcast reaches only that session's sockets", () => {
    const a = new Session(); const b = new Session();
    const aMsgs: string[] = []; const bMsgs: string[] = [];
    const mk = (sink: string[]) => ({ readyState: 1, send: (s: string) => sink.push(s) }) as any;
    a.addSocket(mk(aMsgs)); b.addSocket(mk(bMsgs));
    a.broadcast({ type: "names", names: ["x"] } as any);
    expect(aMsgs.length).toBe(1);
    expect(bMsgs.length).toBe(0);
    a.close(); b.close();
  });

  it("close() clears timers — no broadcasts after close under fake timers", () => {
    vi.useFakeTimers();
    const s = new Session();
    const sent: string[] = [];
    s.addSocket({ readyState: 1, send: (x: string) => sent.push(x) } as any);
    s.close();
    const before = sent.length;
    vi.advanceTimersByTime(60_000); // names interval would have fired ~15×
    expect(sent.length).toBe(before);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 3: Run it.** `npx vitest run backend/src/session.test.ts` → PASS.
- [ ] **Step 4: Typecheck.** `npx tsc --noEmit -p tsconfig.json` → only `server.ts` errors remain.
- [ ] **Step 5: Commit.**

```bash
git add backend/src/session.ts backend/src/session.test.ts
git commit -m "feat: Session class — graph construction, scoped broadcast, timer teardown"
```

---

## Task 8: `SessionRegistry` (registry-of-one)

**Files:**
- Create: `backend/src/sessionRegistry.ts`
- Create: `backend/src/sessionRegistry.test.ts`

For Phase 2a the registry holds exactly one session, created lazily. (Phase 2b extends this to many + cap + reaper — out of scope here.)

- [ ] **Step 1: Create the registry.**

```ts
// sessionRegistry.ts
import { Session } from "./session.js";

export class SessionRegistry {
  private theOne: Session | null = null;
  /** Phase 2a: a single shared session, created on first use. */
  only(): Session {
    if (!this.theOne) this.theOne = new Session();
    return this.theOne;
  }
  closeAll(): void { this.theOne?.close(); this.theOne = null; }
}
```

- [ ] **Step 2: Write a test.**

```ts
// sessionRegistry.test.ts
import { describe, it, expect, vi } from "vitest";
import { SessionRegistry } from "./sessionRegistry.js";
vi.mock("./agent.js", () => ({ craftSongPrompt: vi.fn(), craftOpenerPrompt: vi.fn() }));
vi.mock("./suno.js", () => ({ generateSong: vi.fn() }));
vi.mock("./songStore.js", () => ({ songStore: { save: vi.fn(), list: vi.fn(async () => []) } }));

describe("SessionRegistry (registry-of-one)", () => {
  it("only() returns a stable single session", () => {
    const r = new SessionRegistry();
    expect(r.only()).toBe(r.only());
    r.closeAll();
  });
  it("closeAll() lets a fresh session be created next", () => {
    const r = new SessionRegistry();
    const first = r.only(); r.closeAll();
    expect(r.only()).not.toBe(first);
    r.closeAll();
  });
});
```

- [ ] **Step 3: Run it.** `npx vitest run backend/src/sessionRegistry.test.ts` → PASS.
- [ ] **Step 4: Commit.**

```bash
git add backend/src/sessionRegistry.ts backend/src/sessionRegistry.test.ts
git commit -m "feat: SessionRegistry holding one session (Phase 2a)"
```

---

## Task 9: Wire `server.ts` to the registry; retire global `bus`

**Files:**
- Modify: `backend/src/server.ts`
- Modify: `backend/src/bus.ts`

`bus.ts` keeps only the `ServerMsg` type (and `ClientMsg` if defined there). The global `broadcast`/`setSender` are removed — all broadcasting now goes through `session.broadcast()`. `server.ts` constructs a `SessionRegistry`, and every handler uses `registry.only()`.

- [ ] **Step 1: Trim `bus.ts` to types only.** Keep `export type ServerMsg = ...` (and any `ClientMsg`). Delete `let sender`, `setSender`, `broadcast`. (If `ServerMsg`/`ClientMsg` live elsewhere, leave them; just remove the global sender/broadcast.)

- [ ] **Step 2: Rewrite `server.ts` wiring.** At top: `const registry = new SessionRegistry();`. Replace every module call with a session call:

```ts
// connection setup
const session = registry.only();          // Phase 2a: the single session
session.addSocket(ws);
const connKey = String(++wsSeq);

// seed this socket (Phase 2a keeps connect-time seeding; Phase 2b moves it post-join)
ws.send(JSON.stringify({ type: "names", names: session.participants.names() }));
ws.send(JSON.stringify(playbackState));
ws.send(JSON.stringify({ type: "show_state", ...session.show.currentShowState() }));
ws.send(JSON.stringify({ type: "room_state", ...session.room.snapshot() }));
ws.send(JSON.stringify({ type: "vibe_options", cards: session.vibes.getCards() }));
ws.send(JSON.stringify(vibeTallyMsg(session)));
const recap = session.show.currentRecap();
if (recap) ws.send(JSON.stringify({ type: "show_ended", songs: recap }));
const liveSong = session.show.currentPlayingSong();
if (liveSong) ws.send(JSON.stringify({ type: "song_ready", song: liveSong }));
```

Map every `case` to the session (identical logic, just `session.<unit>.<method>`):

| WS case | Old call | New call |
|---|---|---|
| `join` | `room.tryJoin`, `join(name)` | `session.room.tryJoin(...)`, `session.participants.join(name)` |
| `answer` | `handleAnswer(...)` | `session.show.handleAnswer(...)` |
| `pull` | `handlePull(...)` | `session.show.handlePull(...)` |
| `vibe` | `vibes.recordPick`, `broadcast(vibeTallyMsg())` | `session.vibes.recordPick`, `session.broadcast(vibeTallyMsg(session))` |
| `vibeCards` | `vibes.setCards`, broadcast | `session.vibes.setCards`, `session.broadcast(...)` |
| `playing` | `onPlaying(id)` | `session.show.onPlaying(id)` |
| `start` | `startShow(opener)` | `session.show.startShow(opener)` |
| `create_room` | `room.createRoom()` | `session.room.createRoom()` |
| `host_start` | `room.authorizeHost`, `room.markLive`, `startShow()` | `session.room.*`, `session.show.startShow()` |
| `host_end` | `room.markEnded`, `endShow()` | `session.room.markEnded()`, `session.show.endShow()` |
| `add_sim_players` | `room.isHost`, `sim.add(n)` | `session.room.isHost`, `session.sim.add(n)` |
| `config` | `applyConfig(msg)` | `session.show.applyConfig(msg)` |
| `skip`/`hold`/`resume`/`endVote` | module fns | `session.show.skip()` etc. |
| `reset` | `reset()` | `session.show.reset()` |
| `end` | `endShow()` | `session.show.endShow()` |
| `forceNext` | `broadcast({type:"force_next"})` | `session.broadcast({type:"force_next"})` |
| `playbackControl` | `broadcast(...)` | `session.broadcast(...)` |
| `playbackState` | set `playbackState`, `broadcast(...)` | set `playbackState`, `session.broadcast(...)` |

On `ws.close`: `session.removeSocket(ws); const id = wsParticipant.get(ws); if (id) session.participants.remove(id); const promo = session.room.leave(connKey); ...` (host-promotion logic unchanged, now on `session.room`).

`vibeTallyMsg` becomes `vibeTallyMsg(session)` returning `{ type: "vibe_tally", ...session.vibes.tally() }`.

The `setInterval(() => broadcast({type:"names", ...}))` that lived in `showMachine` now lives in the `Session` (Task 6 moved it). Remove any duplicate in `server.ts` if present (there isn't one).

- [ ] **Step 3: Typecheck the whole project.**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: **clean** (all namespace imports gone).

- [ ] **Step 4: Run the full suite.**

Run: `npx vitest run`
Expected: **all green** (40 original + new participants/vibes/session/registry tests).

- [ ] **Step 5: Commit.**

```bash
git add backend/src/server.ts backend/src/bus.ts
git commit -m "refactor: route server through SessionRegistry; retire global bus broadcast"
```

---

## Task 10: Single-room live smoke + final gate

**Files:** none (verification only).

- [ ] **Step 1: Boot the server.**

Run: `npm start` (in a scratch shell)
Expected: starts without error; logs the stage/dashboard URLs.

- [ ] **Step 2: Manual single-room smoke** (identical-behavior check):
  - Open `http://localhost:<port>/stage-live.html` → lobby with code + QR.
  - Join a phone (or second browser) via the code → name appears in the cloud.
  - Host start → opener plays → gather → vote → a song generates and crossfades.
  - Hit `reset` from the dashboard → returns to blank lobby (verify no console timer leaks).
  - Confirm the recap on end shows this set's song(s).

- [ ] **Step 3: Confirm no orphaned timers.** After a `reset`, watch the server logs for ~30s: there must be no continued `[show]` round/gather activity (proves `show.stop()`/`reset()` cleared timers).

- [ ] **Step 4: Final full suite + typecheck.**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: clean + all green.

- [ ] **Step 5: Tag the phase.**

```bash
git tag multiroom-phase2a
git commit --allow-empty -m "chore: Phase 2a (Session encapsulation) complete — behavior identical, ready for 2b"
```

---

## Self-review notes (author)

- **Spec coverage:** Phase 2a section of the spec → Tasks 1–10 cover every singleton (`tug`/`participants`/`vibes`/`room`/`sim`/`showMachine`/`bus`/`server`), the `Session`/`Registry` objects, instance-owned timers + teardown, and the gate (adapted units green + single-room smoke). Phase 2b items (create_room→many, post-join seeding, cap, reaper, QR-code, drop auto-adopt) are explicitly deferred to a separate plan.
- **Type consistency:** the injected dependency object shape `{ broadcast, room, sim, participants, vibes, tug }` is identical in `ShowMachine` (Task 6) and `Session` (Task 7); `Sim` takes `{ broadcast, participants, room, tug }` in Task 5 and is constructed that way in Task 7; `stop()` (ShowMachine) and `close()` (Session/Room) names are used consistently in Tasks 6–9.
- **Ordering caveat documented:** the transient namespace-import type errors during bottom-up conversion are called out in the Task 2 transition note; full-green gate is Task 9/10.
