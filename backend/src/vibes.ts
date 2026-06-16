// ============================================================
// vibes.ts — the live "Pick the Vibe" poll.
// The DJ authors up to 4 vibe cards (the options); each phone reports the
// option index it currently has selected. We keep ONE pick per socket
// (re-picking overwrites, disconnect removes) so the tally = distinct phones
// per option. Index 0..3 is the stable key, NOT the card text (robust to edits).
// ============================================================

export class Vibes {
  private cards: string[] = []; // current poll options (labels), index 0..3
  private pickBySocket = new Map<number, number>(); // socketId -> chosen option index

  /** DJ pushed new vibe cards → set the options and reset the tally. */
  setCards(next: string[]): void {
    this.cards = (next || []).slice(0, 4).map((c) => String(c ?? "").trim());
    this.pickBySocket.clear();
  }

  /** The current poll options (non-empty labels only). */
  getCards(): string[] {
    return this.cards.filter((c) => c.length > 0);
  }

  /** A phone selected an option this round. Ignored if out of range / no poll. */
  recordPick(socketId: number, index: number): void {
    const live = this.getCards();
    if (live.length === 0) return;
    if (!Number.isInteger(index) || index < 0 || index >= live.length) return;
    this.pickBySocket.set(socketId, index);
  }

  /** Drop a phone's pick (on disconnect). */
  removeSocket(socketId: number): void {
    this.pickBySocket.delete(socketId);
  }

  /** Counts per option index + total — distinct phones per option. */
  tally(): { counts: number[]; total: number } {
    const live = this.getCards();
    const counts = live.map(() => 0);
    let total = 0;
    for (const idx of this.pickBySocket.values()) {
      if (idx >= 0 && idx < counts.length) {
        counts[idx] = (counts[idx] ?? 0) + 1;
        total += 1;
      }
    }
    return { counts, total };
  }

  /** The most-picked option label (the crowd's chosen vibe), or null if no votes. */
  winner(): string | null {
    const live = this.getCards();
    if (live.length === 0) return null;
    const { counts, total } = this.tally();
    if (total === 0) return null;
    let best = 0;
    for (let i = 1; i < counts.length; i += 1) {
      if ((counts[i] ?? 0) > (counts[best] ?? 0)) best = i;
    }
    return live[best] ?? null;
  }

  /** Blank slate (show reset). */
  reset(): void {
    this.cards = [];
    this.pickBySocket.clear();
  }
}
