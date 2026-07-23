import { CONFIG } from "./config.js";
import {
  parseBlockedWord,
  noteBlockedWord,
  sanitizeStyle,
  sanitizeLyrics,
  sanitizeTitle,
} from "./sanitize.js";

// How many times to deterministically strip a Suno-named offending word and
// re-submit before giving up (and letting the caller's LLM re-craft take over).
const MAX_WORD_STRIPS = 3;

export interface GenOpts {
  lyrics: string;
  style: string;
  title: string;
  voiceId?: string;
  instrumental?: boolean;
}

export interface SunoStatus {
  id: string;
  status: "submitted" | "queued" | "streaming" | "complete" | "error" | string;
  error: string | null;
}

async function sunoFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const res = await fetch(`${CONFIG.sunoBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CONFIG.sunoApiKey}`,
      "Content-Type": "application/json",
      // Cloudflare 1010 blocks default Node/undici UA — must send a real one.
      "User-Agent": CONFIG.userAgent,
      ...(init.headers ?? {}),
    },
  });
  // retry transient 429/5xx with backoff
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await delay(400 * 2 ** attempt);
    return sunoFetch(path, init, attempt + 1);
  }
  return res;
}

async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return "";
  }
}

/** Submit a Custom-mode generation; returns the clip id. */
export async function submitGeneration(opts: GenOpts): Promise<string> {
  const body: Record<string, unknown> = { style: opts.style, title: opts.title };
  if (opts.instrumental) body.instrumental = true;
  else body.lyrics = opts.lyrics;
  if (opts.voiceId) body.voice_id = opts.voiceId;

  const res = await sunoFetch("/v0/audio", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Suno generate ${res.status}: ${await safeBody(res)}`);
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error(`Suno generate: no id in response`);
  return data.id;
}

/** One status poll. The status response carries status + metadata only — NOT a
 *  playable/downloadable URL (Suno dropped `audio_url`). Reach the audio via
 *  `mintPlaybackUrl` once status is "streaming" or "complete". */
export async function getStatus(id: string): Promise<SunoStatus> {
  const res = await sunoFetch(`/v0/audio/${id}`);
  if (!res.ok) throw new Error(`Suno poll ${res.status}: ${await safeBody(res)}`);
  const d = (await res.json()) as { id: string; status: string; error?: string | null };
  return { id: d.id, status: d.status, error: d.error ?? null };
}

/**
 * Mint a short-lived, clip-scoped playback URL. The returned URL embeds its own
 * token (`?t=<token>`), so it plays directly in a browser `<audio>` WITHOUT the API
 * key AND our server can fetch the same URL to re-host the audio — no Authorization
 * header needed either way. This replaces the old `audio_url` field, which Suno
 * removed from the status response. Valid once the clip is servable (streaming/complete).
 */
export async function mintPlaybackUrl(id: string): Promise<string> {
  const res = await sunoFetch(`/v0/audio/${id}/playback-token`, { method: "POST" });
  if (!res.ok) throw new Error(`Suno playback-token ${res.status}: ${await safeBody(res)}`);
  const d = (await res.json()) as { url?: string };
  if (!d.url) throw new Error(`Suno playback-token: no url in response`);
  return d.url;
}

export interface GenerateResult {
  playableUrl: string; // first usable audio_url (streaming or complete)
  finalUrl: string; // complete CDN url
  msToPlayable: number;
  msToComplete: number;
}

/**
 * Submit + poll. Calls onPlayable as soon as an audio_url appears (so the engine
 * can pre-buffer/start), then resolves when status === "complete".
 */
export async function generateSong(
  opts: GenOpts,
  cb: { onPlayable?: (url: string, status: string) => void; signal?: AbortSignal } = {},
): Promise<GenerateResult> {
  const t0 = Date.now();
  // Deterministic first line of defense: scrub known offenders (profanity, slurs,
  // Suno false-positive artist/producer tags) before the request ever goes out.
  let attempt: GenOpts = {
    ...opts,
    style: sanitizeStyle(opts.style),
    lyrics: sanitizeLyrics(opts.lyrics),
    title: sanitizeTitle(opts.title),
  };

  for (let strips = 0; ; strips++) {
    try {
      return await submitAndPoll(attempt, cb, t0);
    } catch (err) {
      // If Suno NAMED the offending word, strip it everywhere and re-submit — far
      // faster + more reliable than an LLM re-craft. Generic rejections (no word
      // named) bubble up to the caller's strict re-craft fallback.
      const word = parseBlockedWord((err as Error).message);
      if (!word || strips >= MAX_WORD_STRIPS) throw err;
      noteBlockedWord(word);
      console.warn(`[suno] rejected on "${word}" — stripping it and resubmitting (strip ${strips + 1}/${MAX_WORD_STRIPS})`);
      attempt = {
        ...attempt,
        style: sanitizeStyle(attempt.style),
        lyrics: sanitizeLyrics(attempt.lyrics),
        title: sanitizeTitle(attempt.title),
      };
    }
  }
}

/** One submit + poll-to-complete cycle. */
async function submitAndPoll(
  opts: GenOpts,
  cb: { onPlayable?: (url: string, status: string) => void; signal?: AbortSignal },
  t0: number,
): Promise<GenerateResult> {
  const id = await submitGeneration(opts);
  let playableUrl = "";
  let msToPlayable = 0;

  while (true) {
    if (cb.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (Date.now() - t0 > CONFIG.maxGenWaitMs) throw new Error(`Suno timed out for ${id}`);

    const s = await getStatus(id);
    if (s.status === "error") throw new Error(`Suno error for ${id}: ${s.error ?? "unknown"}`);

    // Audio is servable at "streaming" (live progressive) and "complete" (final file).
    // Mint the playback URL the first time we see either, so the stage can start
    // immediately; the same clip-scoped URL is what the server re-hosts durably.
    if ((s.status === "streaming" || s.status === "complete") && !playableUrl) {
      playableUrl = await mintPlaybackUrl(id);
      msToPlayable = Date.now() - t0;
      cb.onPlayable?.(playableUrl, s.status);
    }
    if (s.status === "complete") {
      return {
        playableUrl,
        finalUrl: playableUrl, // self-authorizing /stream URL; songStore.save re-hosts it
        msToPlayable: msToPlayable || Date.now() - t0,
        msToComplete: Date.now() - t0,
      };
    }
    await delay(CONFIG.pollIntervalMs);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
