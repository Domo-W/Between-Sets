// Participant store. Tracks everyone who has joined, plus the INTENT answer each
// gave for the CURRENT collecting round. At the buzzer one of the people who
// answered this round is chosen at random. Returns null if NOBODY has answered,
// so the show can skip generation instead of inventing a fake song.

interface Participant {
  id: string;
  name: string;
  answer: string | null; // this round's intent; null = hasn't answered yet
  sim: boolean; // a simulated/test player — real players win selection over these
}

export class Participants {
  private byId = new Map<string, Participant>();
  private seq = 0;
  private lastSelectedId: string | null = null; // avoid picking the same person twice in a row

  /** Register a participant; returns their stable id. `sim` marks test players. */
  join(name: string, sim = false): string {
    this.seq += 1;
    const id = `p${this.seq}`;
    this.byId.set(id, { id, name: name.trim() || `Guest ${this.seq}`, answer: null, sim });
    return id;
  }

  /** Record (or overwrite) a participant's answer for the current round. */
  setAnswer(participantId: string, text: string): void {
    const p = this.byId.get(participantId);
    if (!p) return;
    p.answer = text.trim();
  }

  /**
   * Round boundary: clear everyone's "what's it about" answer so the next round's
   * selection pool only includes players who answer THIS round. Participants — and
   * their stable ids + the anti-repeat history (lastSelectedId) — PERSIST across
   * rounds, so the spotlight rotates fairly and real players stay selectable without
   * having to re-join every round.
   */
  clearRound(): void {
    for (const p of this.byId.values()) p.answer = null;
  }

  /** Update a joined participant's display name / song subject (the "change my
   *  name" option). No-op if the id is unknown. */
  rename(participantId: string, name: string): void {
    const p = this.byId.get(participantId);
    if (!p) return;
    const n = name.trim();
    if (n) p.name = n;
  }

  /** Drop a participant entirely (on disconnect). */
  remove(participantId: string): void {
    this.byId.delete(participantId);
  }

  /** Blank slate: forget everyone (dashboard "Reset"). */
  reset(): void {
    this.byId.clear();
    this.lastSelectedId = null;
  }

  /** Total joined participants (crowd size). */
  count(): number {
    return this.byId.size;
  }

  /** A participant's display name (for broadcasting their intent to the stage). */
  nameOf(participantId: string): string | null {
    const p = this.byId.get(participantId);
    return p ? p.name : null;
  }

  /** All joined names, in join order (for the stage name cloud). */
  names(): string[] {
    return [...this.byId.values()].map((p) => p.name);
  }

  /**
   * Pick a random participant among everyone who has submitted an intent (intents
   * persist across rounds). Prefers someone other than the previous pick so a
   * small group gets variety. Falls back to a sample seed only if NOBODY has ever
   * answered, so dry-runs still resolve.
   */
  selectRandomAnswerer(): { name: string; answer: string } | null {
    const answered = [...this.byId.values()].filter(
      (p): p is Participant & { answer: string } => p.answer !== null && p.answer.length > 0,
    );
    if (answered.length === 0) return null; // nobody submitted — caller skips generation
    // Real (human) players win over simulated test players: if ANY real player
    // answered, pick from them — so a solo host surrounded by test players always
    // wins their own song. Sims are only selectable when no real player answered.
    const real = answered.filter((p) => !p.sim);
    const pool = real.length > 0 ? real : answered;
    // Avoid repeating the immediately-previous selection when there's a choice.
    const fresh = pool.length > 1 ? pool.filter((p) => p.id !== this.lastSelectedId) : pool;
    const choices = fresh.length > 0 ? fresh : pool;
    const pick = choices[Math.floor(Math.random() * choices.length)]!;
    this.lastSelectedId = pick.id;
    return { name: pick.name, answer: pick.answer };
  }
}
