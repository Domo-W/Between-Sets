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
