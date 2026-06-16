import { describe, it, expect, vi } from "vitest";
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
    vi.advanceTimersByTime(60_000); // the 4s names interval would have fired ~15× if not cleared
    expect(sent.length).toBe(before);
    vi.useRealTimers();
  });
});
