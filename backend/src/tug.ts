import type { Side } from "./types.js";

// Per-round tug-of-war aggregation.
//
// - `p` is the ROPE POSITION (0 = all the way to A, 1 = all the way to B). It is
//   CUMULATIVE within a round: each pull nudges it toward that side and it STAYS
//   there. winner() reads `p` (who is ahead), not the decaying drives.
// - `driveA`/`driveB` are DECAYING per-side energy (slosh/particles for the viz).
//   They fade between pulls via the decay tick.
// - `energy` is the recent pull RATE across both sides, normalized 0..1.
// - `membersA`/`membersB` are the distinct pullers per side THIS round.

const DECAY_PER_SEC = 1.6; // exponential decay rate for drive
const PULL_GAIN = 0.06; // how far one unit of impulse moves the rope
const DRIVE_GAIN = 1.0; // impulse → drive contribution
const ENERGY_WINDOW_MS = 2000; // window for "recent pull rate"
const ENERGY_FULL_RATE = 8; // pulls/sec across the crowd that reads as energy 1.0

export interface TugSnapshot {
  p: number;
  driveA: number;
  driveB: number;
  membersA: number;
  membersB: number;
  energy: number;
}

export class Tug {
  private p = 0.5; // rope position 0..1
  private driveA = 0;
  private driveB = 0;
  private membersA = new Set<string>();
  private membersB = new Set<string>();
  private pullTimes: number[] = [];
  private lastTick = Date.now();

  /** Begin a fresh round. Genres are passed for symmetry with the show flow. */
  reset(_genreA?: unknown, _genreB?: unknown): void {
    this.p = 0.5;
    this.driveA = 0;
    this.driveB = 0;
    this.membersA.clear();
    this.membersB.clear();
    this.pullTimes = [];
    this.lastTick = Date.now();
  }

  /** Apply one (batched) pull from a participant toward a side. */
  applyPull(participantId: string, side: Side, impulse: number): void {
    const amt = Math.max(0, Number.isFinite(impulse) ? impulse : 0);
    if (amt === 0) return;
    if (side === "A") {
      this.driveA += amt * DRIVE_GAIN;
      this.p = clamp01(this.p - amt * PULL_GAIN);
      this.membersA.add(participantId);
    } else {
      this.driveB += amt * DRIVE_GAIN;
      this.p = clamp01(this.p + amt * PULL_GAIN);
      this.membersB.add(participantId);
    }
    this.pullTimes.push(Date.now());
  }

  /** Decay tick — call on an interval. Fades drives and trims the energy window. */
  tick(): void {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (dt > 0) {
      const factor = Math.exp(-DECAY_PER_SEC * dt);
      this.driveA *= factor;
      this.driveB *= factor;
    }
    const cutoff = now - ENERGY_WINDOW_MS;
    this.pullTimes = this.pullTimes.filter((t) => t >= cutoff);
  }

  snapshot(): TugSnapshot {
    return {
      p: this.p,
      driveA: this.driveA,
      driveB: this.driveB,
      membersA: this.membersA.size,
      membersB: this.membersB.size,
      energy: this.energy(),
    };
  }

  /** Winning side = whichever the rope is closer to. Tie → A (deterministic). */
  winner(): Side {
    return this.p <= 0.5 ? "A" : "B";
  }

  private energy(): number {
    const now = Date.now();
    const cutoff = now - ENERGY_WINDOW_MS;
    const recent = this.pullTimes.filter((t) => t >= cutoff).length;
    const rate = recent / (ENERGY_WINDOW_MS / 1000); // pulls per second
    return clamp01(rate / ENERGY_FULL_RATE);
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
