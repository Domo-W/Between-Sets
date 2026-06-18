// Simulated players — a dev/test aid so a solo host can fill the room, hit the
// 2-player minimum, and run a believable show alone. Sims are real room members
// (so they count toward the crowd) AND real participants each round (name in the
// cloud + an "I want to…" intent in the selection pool), and they vote in the
// tug-of-war. Names + intents are drawn WITHOUT repeats until the pool is
// exhausted, so repeated solo tests don't feel stale.

import type { ServerMsg } from "./types.js";
import type { Participants } from "./participants.js";
import type { Room } from "./room.js";
import type { Tug } from "./tug.js";

const NAMES = [
  "Maya", "Theo", "Priya", "Marcus", "Lena", "Andre", "Sofia", "Jules", "Nico", "Tash",
  "Omar", "Bex", "Caleb", "Imani", "Rafa", "Zoe", "Dante", "Mila", "Khalil", "June",
  "Esme", "Tobi", "Carmen", "Felix", "Nadia", "Leo", "Aisha", "Mateo", "Ruby", "Sage",
  "Kofi", "Yara", "Devon", "Anika", "Bruno", "Cleo", "Idris", "Noor", "Remy", "Suki",
];

const INTENTS = [
  "I want to lose my mind", "I want to text my ex", "I want to fall in love twice",
  "I want to start a mosh pit", "I want one perfect night", "I want to forget about Monday",
  "I want the bass to fix my life", "I want my friends to scream this chorus",
  "I want to feel like the main character", "I want to dance until my shoes break",
  "I want to be somebody else tonight", "I want a song my mum can't hear",
  "I want to cry on the dance floor", "I want to fall for a stranger", "I want to glow in the dark",
  "I want to run away with everyone here", "I want to make this Tuesday legendary",
  "I want to be unforgettable", "I want to kiss someone reckless", "I want the night to never end",
  "I want to be loud for once", "I want to feel 17 again", "I want to dance like nobody's filming",
  "I want to set the room on fire",
];

interface SimPlayer { key: string; name: string; pid: string | null; bias: number; intent: string }

// Draw without repeats until the bag empties, then refill — so a solo tester
// running several sessions doesn't keep seeing the same names/prompts.
function draw(bag: string[], source: string[]): string {
  if (bag.length === 0) {
    // Fisher–Yates-ish shuffle without Math.random bias concerns (plain is fine here).
    const copy = source.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = copy[i]!; copy[i] = copy[j]!; copy[j] = t;
    }
    bag.push(...copy);
  }
  return bag.pop()!;
}

export class Sim {
  private sims: SimPlayer[] = [];
  private seq = 0;
  private nameBag: string[] = [];
  private intentBag: string[] = [];

  constructor(private readonly deps: {
    broadcast: (msg: ServerMsg) => void;
    participants: Participants;
    room: Room;
    tug: Tug;
  }) {}

  private freshName(): string { return draw(this.nameBag, NAMES); }
  private freshIntent(): string { return draw(this.intentBag, INTENTS); }

  /** How many sims are currently in the room. */
  count(): number {
    return this.sims.length;
  }

  /** Add `n` simulated players: room members + participants (name + intent), and
   *  put their names on the stage cloud. Returns the new count. */
  add(n: number): number {
    for (let i = 0; i < n; i++) {
      const name = this.freshName();
      const key = `sim-${++this.seq}`;
      const pid = this.deps.participants.join(name, true);
      const intent = this.freshIntent();
      this.deps.participants.setAnswer(pid, intent);
      this.deps.room.addSimMember(key, name);
      this.sims.push({ key, name, pid, bias: 0.35 + Math.random() * 0.3, intent });
      this.deps.broadcast({ type: "name", name });
    }
    this.deps.broadcast({ type: "room_state", ...this.deps.room.snapshot() });
    return this.sims.length;
  }

  /** Round boundary: give each (persisted) sim a FRESH intent so they stay in the
   *  selection pool with varied lines. No re-join — sims keep their participant id
   *  across rounds now (only the per-round answer is cleared), so we just re-answer. */
  reseedForRound(): void {
    for (const s of this.sims) {
      if (s.pid == null) continue;
      s.intent = this.freshIntent();
      this.deps.participants.setAnswer(s.pid, s.intent);
    }
  }

  /** Post the sims' intents onto the stage's gather feed, staggered like real
   *  people typing — called once gather is live so they don't get cleared by the
   *  new-round wipe. Mirrors what real phones do via handleAnswer. */
  postIntentsToGather(): void {
    for (const s of this.sims) {
      const name = s.name;
      const text = s.intent;
      setTimeout(() => this.deps.broadcast({ type: "intent", name, text }), 800 + Math.random() * 6000);
    }
  }

  /** One tug-of-war vote tick for the sims (called during the collecting phase). */
  voteTick(): void {
    for (const s of this.sims) {
      if (s.pid) this.deps.tug.applyPull(s.pid, Math.random() < s.bias ? "A" : "B", 0.6);
    }
  }

  /** Forget all sims (on show reset). */
  reset(): void {
    this.sims = [];
    this.seq = 0;
    this.nameBag = [];
    this.intentBag = [];
  }
}
