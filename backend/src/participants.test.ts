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
    const id = a.join("A"); a.setAnswer(id, "x");
    expect(b.count()).toBe(0);
    expect(b.selectRandomAnswerer()).toBe(null);
  });
});

describe("Participants per-round behavior (persist players, clear answers)", () => {
  it("clearRound clears answers but KEEPS participants + their ids", () => {
    const p = new Participants();
    const a = p.join("Alice"), b = p.join("Bob");
    p.setAnswer(a, "x"); p.setAnswer(b, "y");
    p.clearRound();
    expect(p.count()).toBe(2);              // players persist across the round boundary
    expect(p.selectRandomAnswerer()).toBe(null); // but nobody has answered THIS round yet
    p.setAnswer(a, "x2"); p.setAnswer(b, "y2");
    expect(p.selectRandomAnswerer()).not.toBe(null);
  });

  it("only selects players who answered THIS round (others must re-answer)", () => {
    const p = new Participants();
    const a = p.join("Alice"), b = p.join("Bob");
    p.setAnswer(a, "x"); p.setAnswer(b, "y");
    p.selectRandomAnswerer();
    p.clearRound();
    p.setAnswer(a, "x2");                    // only Alice re-answers this round
    expect(p.selectRandomAnswerer()?.name).toBe("Alice");
  });

  it("rotates the spotlight across rounds — anti-repeat survives clearRound", () => {
    const p = new Participants();
    const a = p.join("Alice"), b = p.join("Bob");
    // Run several rounds; with stable ids + persisted lastSelectedId the winner
    // must alternate (never the same person twice in a row).
    let prev = "";
    for (let round = 0; round < 6; round++) {
      p.clearRound();
      p.setAnswer(a, "x"); p.setAnswer(b, "y");
      const pick = p.selectRandomAnswerer()!;
      expect(pick.name).not.toBe(prev);     // never the immediate-previous winner
      prev = pick.name;
    }
  });

  it("rename updates a joined player's name in place (keeps their id/answer)", () => {
    const p = new Participants();
    const a = p.join("Alice");
    p.setAnswer(a, "x");
    p.rename(a, "Alicia");
    expect(p.nameOf(a)).toBe("Alicia");
    expect(p.selectRandomAnswerer()?.name).toBe("Alicia");
  });
});
