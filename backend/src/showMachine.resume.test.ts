import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Keep generation inert so the auto-advance path doesn't hit the real APIs.
const { craftSongPrompt } = vi.hoisted(() => ({
  craftSongPrompt: vi.fn(async (..._a: unknown[]) => ({ title: "T", lyrics: "la la", style: "pop 120bpm" })),
}));
vi.mock("./agent.js", () => ({
  craftSongPrompt,
  craftOpenerPrompt: vi.fn(async () => ({ title: "T", lyrics: "la la", style: "pop 120bpm" })),
}));
vi.mock("./suno.js", () => ({
  generateSong: vi.fn(async (_p: unknown, cb: { onPlayable?: (u: string, s: string) => void } = {}) => {
    cb.onPlayable?.("http://test/stream.m4a", "streaming");
    return { finalUrl: "http://test/final.m4a", msToComplete: 1 };
  }),
}));
vi.mock("./songStore.js", () => ({
  songStore: {
    save: vi.fn(async (song: Record<string, unknown>) => ({ ...song, fileName: "t.m4a", downloadUrl: "http://test/final.m4a" })),
    list: vi.fn(async () => []),
  },
}));

// showMachine starts intervals at construction — construct under fake timers.
vi.useFakeTimers();

import { ShowMachine } from "./showMachine.js";
import { Tug } from "./tug.js";
import { Participants } from "./participants.js";
import { Vibes } from "./vibes.js";
import { Room } from "./room.js";
import { Sim } from "./sim.js";

function makeShow() {
  const sent: any[] = [];
  const broadcast = (m: any) => sent.push(m);
  const tug = new Tug(), participants = new Participants(), vibes = new Vibes();
  const room = new Room(broadcast);
  const sim = new Sim({ broadcast, participants, room, tug });
  const show = new ShowMachine({ broadcast, room, sim, participants, vibes, tug });
  return { show, sent, tug, participants, vibes, room, sim };
}

describe("live-track re-seed (stage reload recovery)", () => {
  let show: ShowMachine;
  beforeEach(() => {
    show = makeShow().show;
    vi.clearAllTimers();
  });
  afterEach(() => {
    show.stop();
  });

  it("exposes no live track in the idle lobby", () => {
    expect(show.currentPlayingSong()).toBe(null);
  });

  it("exposes the opener as the live track once the show starts (so a reloaded stage can resume audio)", () => {
    show.startShow();
    const live = show.currentPlayingSong();
    expect(live).not.toBe(null);
    expect(live!.streamUrl).toContain("opener");
  });

  it("clears the live track on reset", () => {
    show.startShow();
    expect(show.currentPlayingSong()).not.toBe(null);
    show.reset();
    expect(show.currentPlayingSong()).toBe(null);
  });

  it("clears the live track when the show ends (recap takes over)", async () => {
    show.startShow();
    expect(show.currentPlayingSong()).not.toBe(null);
    await show.endShow();
    expect(show.currentPlayingSong()).toBe(null);
  });
});

describe("empty-round auto-advance (Jackbox-style: never hard-stop)", () => {
  let show: ShowMachine;
  beforeEach(() => {
    show = makeShow().show;
    vi.clearAllTimers();
    craftSongPrompt.mockClear();
  });
  afterEach(() => {
    show.stop();
  });

  it("auto-advances with a house seed after the grace window when nobody submits", async () => {
    show.startShow();
    show.onPlaying("song-test-1"); // opens round 1 gathering (no participants joined)
    // Drive gather → vote → buzzer (grace re-open) → vote → buzzer (auto-advance).
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // The house seed reached the generation pipeline instead of looping the battle.
    expect(craftSongPrompt).toHaveBeenCalled();
  });
});

describe("host-gated naming window (rounds 2+)", () => {
  let show: ShowMachine;
  beforeEach(() => {
    show = makeShow().show;
    vi.clearAllTimers();
  });
  afterEach(() => {
    show.stop();
  });

  it("round 1 goes straight to the 'what' gather (the lobby was the naming step)", () => {
    show.startShow();
    show.onPlaying("song-opener"); // opener track → round 1
    expect(show.currentShowState().phase).toBe("gathering");
    expect(show.currentShowState().round).toBe(1);
  });

  it("a round's track → host-gated 'naming' (no timer); advance() opens the next 'what' gather", () => {
    show.startShow();
    show.onPlaying("song-opener"); // → round 1 gathering
    show.onPlaying("song-round1"); // round 1 track now playing → naming window for round 2
    expect(show.currentShowState().phase).toBe("naming");
    expect(show.currentShowState().round).toBe(1); // round bumps on advance, not in naming

    // No timer: time passing must NOT leave the naming window.
    vi.advanceTimersByTime(5 * 60_000);
    expect(show.currentShowState().phase).toBe("naming");

    // Host "everyone's in" → opens the timed "what's it about" gather for round 2.
    show.advance();
    expect(show.currentShowState().phase).toBe("gathering");
    expect(show.currentShowState().round).toBe(2);
  });

  it("advance() is a no-op outside the naming window", () => {
    show.startShow();
    show.onPlaying("song-opener"); // round 1 gathering
    show.advance(); // not naming → ignored
    expect(show.currentShowState().phase).toBe("gathering");
    expect(show.currentShowState().round).toBe(1);
  });
});
