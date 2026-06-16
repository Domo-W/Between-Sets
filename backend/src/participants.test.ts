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
