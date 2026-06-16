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
