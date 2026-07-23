import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Suno removed `audio_url` from the GET /v0/audio/{id} status response (it now
// returns status + metadata only). The finished audio is reached via a minted
// playback URL (POST /v0/audio/{id}/playback-token → { url }), which self-authorizes
// via `?t=<token>` so it plays in a browser <audio> AND our server can fetch it to
// re-host. These tests lock in that flow so we never silently depend on `audio_url`.

let generateSong: typeof import("./suno.js").generateSong;

const CLIP_ID = "clip-abc";
const TOKEN_URL = `https://api.suno.com/v0/audio/${CLIP_ID}/stream?t=v1.tok`;

beforeAll(async () => {
  process.env.SUNO_API_KEY ||= "test-suno-key";
  process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";
  ({ generateSong } = await import("./suno.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Build a fetch mock that walks `statuses` one poll at a time. No `audio_url`
 *  anywhere — exactly like the current live API. */
function stubSuno(statuses: string[]) {
  let poll = 0;
  const tokenCalls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

      if (method === "POST" && url.endsWith("/playback-token")) {
        tokenCalls.push(url);
        return json({ url: TOKEN_URL, expires_at: "2026-07-23T23:00:00Z" });
      }
      if (method === "POST" && url.endsWith("/v0/audio")) {
        return json({ id: CLIP_ID, status: "submitted", created_at: "2026-07-23T00:00:00Z" });
      }
      if (method === "GET" && url.includes(`/v0/audio/${CLIP_ID}`)) {
        const status = statuses[Math.min(poll, statuses.length - 1)];
        poll += 1;
        return json({ id: CLIP_ID, status, title: "t", created_at: "2026-07-23T00:00:00Z", error: null, metadata: {} });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return { tokenCalls: () => tokenCalls };
}

const opts = { lyrics: "[Verse]\nhi", style: "reggae", title: "Test" };

describe("generateSong (playback-token flow)", () => {
  it("mints a playback URL and returns it as playable + final when the clip completes", async () => {
    const { tokenCalls } = stubSuno(["complete"]);
    const seen: Array<{ url: string; status: string }> = [];

    const result = await generateSong(opts, {
      onPlayable: (url, status) => seen.push({ url, status }),
    });

    expect(tokenCalls()).toHaveLength(1); // token minted exactly once
    expect(seen).toEqual([{ url: TOKEN_URL, status: "complete" }]);
    expect(result.playableUrl).toBe(TOKEN_URL);
    expect(result.finalUrl).toBe(TOKEN_URL); // what songStore.save() re-hosts from
  });

  it("fires onPlayable at 'streaming' and does not re-mint at 'complete'", async () => {
    vi.useFakeTimers();
    const { tokenCalls } = stubSuno(["streaming", "complete"]);
    const seen: Array<{ url: string; status: string }> = [];

    const p = generateSong(opts, { onPlayable: (url, status) => seen.push({ url, status }) });
    await vi.advanceTimersByTimeAsync(5000); // let the poll loop tick past its delay
    const result = await p;

    expect(seen).toEqual([{ url: TOKEN_URL, status: "streaming" }]); // once, at streaming
    expect(tokenCalls()).toHaveLength(1);
    expect(result.finalUrl).toBe(TOKEN_URL);
  });
});
