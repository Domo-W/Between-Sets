# Multi-Room Sessionization (Jackbox Phase 2) — Design Spec

**Date:** 2026-06-15
**Status:** Approved design, pending implementation plan
**Builds on:** `2026-06-11-jackbox-entry-design.md` (Phase 1 — code-gated single room, START A SHOW, lobby + QR + host model — already shipped). This is the deferred **Phase 2: full multi-room backend sessionization**.

## Goal

Let **multiple independent parties run at the same time** on one server — the true Jackbox model. Each friend-group opens the stage page on their own screen, gets their own room code + QR, friends join on phones, and that party runs its own show (gather → vote → generate → crossfade → recap) fully isolated from every other party. No central operator.

## Confirmed requirements

| Decision | Choice |
|---|---|
| Play model | Separate parties, each its own screen + phones, isolated by room code (Jackbox). |
| Scale | A handful (2–10) concurrent parties. **One server, rooms in memory.** No distributed state. |
| Room creation | Opening `stage-live.html` creates a fresh room (code + QR). Self-serve, no operator. |
| Suno load | **Cap concurrent active parties** at a configurable `N` (default 5). Beyond → "at capacity." |
| Cross-party isolation | Structural — per-room state behind one object boundary (no global broadcast, no shared show state). |

## The core problem

Every stateful module is a **module-level singleton** today — one global show:

- `showMachine.ts` — `let started/phase/roundIndex/…` + module-load timers + the whole loop.
- `room.ts` — one `code`/`hostKey`/`hostToken`/`members`.
- `tug.ts`, `participants.ts`, `vibes.ts`, `sim.ts` — module `let` state.
- `bus.ts` — `broadcast()` sends to **every** connected socket.
- `server.ts` — routes all messages to the one show; seeds every fresh socket with the global show state on connect.

Multi-tenancy means making all of this **per-room**. The risk is not the approach (settled: object encapsulation) — it's *how we land it*. Cross-party bleed here = **the wrong song on the wrong screen**, which is catastrophic for a live product.

## Architecture (Approach A — Session-object encapsulation)

Two new objects:

### `Session` — one party
Owns all state that is singleton today, as instance fields:
- A `ShowMachine` instance + its `Tug`, `Participants`, `Vibes`, `Sim` instances.
- Room/host/code/lobby state (folds in today's `room.ts` per-room fields).
- This set's `setSongs` / recap.
- **Every timer it starts** (tug loop, gather/buzzer/startup-stall timeouts, names rebroadcast).
- Its own `broadcast(msg)` → sends only to this session's member sockets.
- `lastActivity` timestamp for reaping.

Exposes the operations the server calls today, scoped to itself: `startShow`, `onPlaying`, `handleAnswer`, `handlePull`, `applyConfig`, `skip/hold/resume/endVote`, `reset`, `endShow`, `currentShowState`, `currentRecap`, `currentPlayingSong`, etc.

### `SessionRegistry` — all parties on this server
- `Map<code, Session>`.
- `createSession()` → mint a unique code (existing unambiguous alphabet), enforce the **concurrent-party cap**, construct + store a `Session`. Returns the session or a `"at_capacity"` rejection. **The cap counts every live session in the registry** (a created room occupies a slot from `create_room` until it's reaped, even before anyone joins) — so an abandoned stage holds a slot only until the empty-lobby reaper frees it.
- `get(code)` → lookup (unknown → bad code).
- **Reaper** — one registry-level interval that closes ended/idle/empty sessions, calling `session.close()` (which clears every timer the session owns) and freeing the code.
- One registry per server process.

### Socket → Session binding
Each WS connection records `{ session, isHost }`. A socket belongs to **no session until it acts**:
- A stage socket → bound on `create_room`.
- A phone socket → bound on `join {code}`.
- Until bound, a socket may only send `create_room` / `join`; everything else is ignored.

Inbound messages resolve the binding and dispatch to that `Session`. `session.broadcast()` iterates only that session's sockets. **No global broadcast remains** — this is the structural guarantee against cross-party bleed.

### Per-file change map

| File | Today | After |
|---|---|---|
| `showMachine.ts` | module `let` + module timers + loop | `class ShowMachine` — instance fields, instance-owned timers |
| `room.ts` | one room/code/host/members | folded into `Session`; code minting + cap move to `SessionRegistry` |
| `tug.ts`, `participants.ts`, `vibes.ts`, `sim.ts` | module `let` | classes, one instance per session |
| `bus.ts` | global `broadcast()` | per-session `session.broadcast()`; module global removed |
| `server.ts` | routes to the one show; seeds on connect | routes by socket→session; seeds **post-join**, scoped |
| `stage-live.html` | joins global show | on load → `create_room`; render code + QR; **remember code** for reload |
| `phone-shell.jsx` | auto-adopts the open room | join by **code from QR** (`?code=ABCD`); drop the auto-adopt shortcut |

### Intentional exception: shared sanitizer learning
`sanitize.ts`'s `runtimeBlocked` set stays **process-global**. A word Suno rejects is rejected for everyone, so learning it once helps all parties. This is the one deliberate non-per-session piece.

## Data flow & lifecycle

**Create (stage):** `stage-live.html` loads → `create_room`. Registry checks cap → `room_rejected: "at_capacity"` (stage shows "Server's full — try again soon") or mints a code, builds a `Session`, binds the socket as stage. Stage renders code + QR (`/phone-live.html?code=ABCD`) and **stores the code in sessionStorage**.

**Join (phone):** open `?code=ABCD` → `join {code, name, hostToken?}`. Registry looks up by code (unknown → `join_rejected: "bad_code"`). Socket bound to that session; first joiner becomes host (existing per-connection + `hostToken` model). **Seeding happens here, post-join** — `room_state`/`show_state`/`names`/vibe options+tally/recap/current-song sent for *that session only*. (Today this seeding runs on raw connect for the one global show; it moves into the join handler.)

**Route & broadcast:** every inbound message resolves socket→session and dispatches to that `Session`. `session.broadcast()` reaches only its members.

**Reap (timer footgun):** each `Session` owns its timers as instance fields — **nothing starts at module load**. The reaper closes sessions that are ended+idle, empty past the lobby timeout, or stage-disconnected with no rejoin; `session.close()` clears every owned timer and frees the code. This makes "a leak per dead room" impossible.

**Generation:** one shared Suno client; each session runs its own generation jobs (its own epoch/gate logic, unchanged but per-instance). The concurrent-party cap bounds total Suno load — no separate queue at this scale.

## Migration sequencing (de-risk: one variable at a time)

**Phase 2a — "registry-of-one."** Introduce `Session` + `SessionRegistry` holding exactly **one** session. `server.ts` talks to `registry.only()`. Behavior identical to today. Convert `showMachine`/`tug`/`participants`/`vibes`/`sim`/`room` to classes; `bus` broadcast routed through the single session.
- **Gate:** all existing tests (adapted to construct instances) green + a single-room live smoke identical to today.

**Phase 2b — "many."** Stage `create_room` mints a session; phones join by code; routing by socket→session; **post-join seeding**; concurrent-party **cap**; idle/ended **reaper**; stage-remembers-code on reload; drop phone auto-adopt; QR carries the specific code.
- **Gate:** isolation + cap + reaper tests green + a **two-parties-at-once** live smoke.

This isolates the risky encapsulation (2a) from the risky multi-tenancy (2b).

## Edge cases

- **At capacity** → `room_rejected: "at_capacity"`; stage UX message.
- **Bad/expired code** → `join_rejected: "bad_code"` (existing phone UX).
- **Stage reload** → stage re-binds to the *same* session via its stored code instead of minting a new room; composes with the shipped audio-resume fix, now scoped per session.
- **Host leave/reclaim** → the shipped host-recovery logic runs inside each `Session` unchanged.
- **Code uniqueness/reuse** → registry guarantees a unique live code; a reaped room's code returns to the pool.
- **Reaping safety** → never reap a session with active members mid-show.

## Testing strategy

- **Unit (per class):** `Session`, `ShowMachine`, `Tug`, `Participants`, `Vibes` constructed fresh per test — removes the `beforeEach(reset())` global hacks (a testability win). The existing 40 tests adapt to instances (Phase 2a gate: all green).
- **Registry:** cap enforcement, unique-code minting, lookup-by-code, and **reaper clears every timer** (fake-timers: after reap, advancing the clock emits no further broadcasts — proves no leak).
- **Isolation (the multi-tenant guarantee):** two `Session`s side by side — an answer/vote/reset in A leaves B's participants/tug/phase untouched; `A.broadcast()` never reaches B's sockets.
- **Phase gates** as above (2a: adapted units + single-room smoke; 2b: isolation+cap+reaper + two-party smoke).

## Out of scope (YAGNI) — for *this* phase

These are deliberately excluded from the 2–10-party build. They are not dead ends — the `Session`/`Registry` boundary is chosen precisely so each can be added later by swapping an implementation behind an existing seam. The roadmap below says when and how.

- Horizontal scaling / Redis / cross-instance state.
- A shared Suno job queue.
- Per-room persistence/resumption across server restarts.
- Spectator/cross-room features, accounts, matchmaking.

## Scaling roadmap (when we're ready)

The dominant cost as we scale is **Suno** (per-song generation cost + API rate limits), not server capacity. Server headroom is cheap; Suno spend is the real gate. Each stage below is triggered by a concrete signal, changes one layer, and reuses the seams this design already establishes.

### Stage 0 — now: one server, in memory (2–10 parties)
`SessionRegistry` = an in-process `Map`. `session.broadcast()` = a loop over local sockets. Concurrent-party **cap** bounds Suno load. **Trigger to move on:** consistently bumping the cap / one instance’s CPU or memory under pressure, or Suno cost needing tighter control.

### Stage 1 — vertical scale + tuning (→ dozens)
Cheapest next step, **no architectural change**: bump the Render instance size, raise the party cap, and tune Suno concurrency/poll intervals. Add basic per-instance metrics (active rooms, concurrent generations, Suno spend/hour). **Seam used:** the cap is already a single configurable number. **Effort:** hours. **Trigger to move on:** one box can’t hold the room count, or you need >1 instance for availability.

### Stage 2 — externalize state + horizontal scale (→ hundreds+)
The big one. Two sub-pieces, both behind seams this design already has:
- **Registry → shared store.** Replace the in-memory `Map` with a Redis-backed `SessionRegistry` (room code → owning-instance + lobby metadata). Because all per-room state already lives behind the `Session`/`Registry` interface, this is an implementation swap, not a rewrite.
- **Broadcast → pub/sub.** A party’s sockets may land on different server instances behind a load balancer. Replace the local-socket loop in `session.broadcast()` with Redis (or NATS) pub/sub keyed by room code, so a message reaches that room’s members wherever they’re connected. Use sticky sessions (or route by room code) so a party’s stage + phones share an instance where possible, falling back to pub/sub.
- **Suno → shared queue + budget.** Now that many instances generate, introduce the deferred **global job queue** with a hard concurrency limit and a cost budget/circuit-breaker, so total Suno spend is controlled centrally rather than per-instance.

**Effort:** the largest single step (days–weeks). **Trigger to move on:** parties run long enough that a mid-show redeploy/restart is a real, recurring frustration.

### Stage 3 — durability (resilience across restarts)
Persist live room state (phase, round, seed, members) to the shared store so a `Session` can be **rehydrated** after a deploy/crash and phones/stage auto-reconnect to their room. Finished songs are already durable in Supabase; this adds *in-flight* show state. **Seam used:** `Session` already centralizes all the state that would need serializing. **Trigger to move on:** only if you pivot toward a public/social product.

### Stage 4 — product surface (only if it becomes a platform)
Accounts, matchmaking, public/joinable rooms, spectators, cross-room leaderboards. This is a **different product** from "friends in a room with a code" — pursue only on a deliberate strategy change, as its own spec.

### Guiding principle
Add a layer only when a **measured** signal demands it (cap pressure, instance saturation, Suno cost, restart pain). Each stage is a localized swap behind an existing interface, never a rewrite — that property is the main thing this Phase 2 design is buying you.
