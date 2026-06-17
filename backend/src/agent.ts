import Anthropic from "@anthropic-ai/sdk";
import { CONFIG } from "./config.js";
import { genreBpm } from "./tempo.js";

const client = new Anthropic({ apiKey: CONFIG.anthropicApiKey });

export interface SongSeed {
  name: string; // who the song is about (named by the crowd; chanted in the lyrics)
  answer: string; // what the crowd says the song is about (the theme)
  genre: string; // the winning genre from the tug battle
  vibe?: string; // the crowd's winning Pick-the-Vibe mood (colors energy + style)
  bpm?: number; // the chosen tempo for THIS song (set once upstream so it's consistent)
}

export interface SongPrompt {
  title: string;
  lyrics: string; // [Verse]/[Chorus]/... with a name shout-out
  style: string; // genre + genre-aware BPM + production descriptors (Suno `style`)
}

// JSON-schema-constrained output (supported on opus-4-8 / sonnet-4-6 / haiku-4-5).
// Note: json_schema does not support minLength/maxLength — section count is steered
// via the prompt, not the schema.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "A short, punchy song title." },
    lyrics: {
      type: "string",
      description:
        "Full lyrics with [Verse]/[Chorus]/[Bridge] section tags. Must shout out the person's name and build on their answer.",
    },
    style: {
      type: "string",
      description: "Suno style string: genre + BPM + production descriptors.",
    },
  },
  required: ["title", "lyrics", "style"],
} as const;

const STRUCTURE_TEMPLATE = `[Intro]
<name chant>

[Chorus]
<short hook derived from the person's answer>

[Verse 1]
<specific imagery and action from the answer>

[Chorus]
<repeat the same custom hook>

[Verse 2]
<new intent-specific lines with direct name call-outs>

[Chorus]
<repeat the same custom hook>

[Outro]
<name chant and one final hook fragment>`;

const STRICT_SANITIZE =
  "- RETRY: a previous version was REJECTED by the music generator. Aggressively strip or replace ANY potentially-flagged content — profanity, slurs, sexual references, drugs, violence, hate, real public figures' names. Keep it 100% radio-clean and inoffensive while preserving the person's name and an upbeat party spirit.";

function systemPrompt(seed: SongSeed, bpm: number, strict: boolean): string {
  return [
    "You are the live lyricist for 'Between Sets', a party where the crowd's answers become AI songs in real time.",
    "Write a song ABOUT one person the crowd named, on the theme the crowd gave (their answer to 'what's the song about'), in a winning genre — chantable and crowd-igniting.",
    "",
    "FORMAT — replace every placeholder with original lyrics:",
    STRUCTURE_TEMPLATE,
    "",
    "Rules:",
    "- THE PERSON'S NAME IS MANDATORY and central: it is the [Intro], lands in the [Chorus], and is chanted repeatedly inside the verses as a direct call-out. Never omit, abbreviate, or anonymize it, even when transforming an unsafe theme.",
    "- Build the [Chorus] as a short, super-repetitive hook drawn directly from their answer. Keep it simple and shoutable.",
    "- Add sparse crowd ad-libs and call-and-response, but vary them from song to song.",
    "- Every song must use fresh, theme-specific wording. Do not add stock positivity or party slogans that were not present in what the crowd said the song's about.",
    "- Repeat the custom chorus hook on purpose, but do not repeat generic verse lines just to fill space.",
    "- Use these exact section tags: [Intro], [Chorus], [Verse 1], [Verse 2], [Outro] (repeat [Chorus] between verses). Aim for ~6–8 sections so the song runs long enough.",
    seed.vibe
      ? `- THE CROWD'S WINNING VIBE TONIGHT IS "${seed.vibe}". Steer the song's mood, energy, and word choice toward that vibe, and reflect it in the 'style' production descriptors — while staying true to what ${seed.name}'s song is about.`
      : "",
    `- The 'style' field MUST start with "${seed.genre}, ${bpm} BPM, 4/4" followed by genre-appropriate production descriptors${seed.vibe ? ` that match a "${seed.vibe}" mood` : ""}.`,
    "- Keep it crowd-friendly: no slurs, hate, explicit sexual content, or targeted insults. If an intent is unsafe, transform it into something fun and inclusive (still keep the name).",
    strict ? STRICT_SANITIZE : "",
    "Return ONLY the structured fields (title, lyrics, style).",
  ].filter(Boolean).join("\n");
}

function userPrompt(seed: SongSeed): string {
  const bpm = seed.bpm ?? genreBpm(seed.genre);
  return [
    `Song is about: ${seed.name}`,
    `What it's about: ${seed.answer}`,
    `Winning genre: ${seed.genre}`,
    seed.vibe ? `Crowd's winning vibe: ${seed.vibe}` : "",
    `Target tempo: ${bpm} BPM`,
    `Target sections: ${CONFIG.targetSections}`,
  ].filter(Boolean).join("\n");
}

/** Case-insensitive check that the name is sung in the lyrics. */
function nameAppears(lyrics: string, name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return true; // no name given → nothing to enforce
  return lyrics.toLowerCase().includes(n);
}

/** Deterministic fallback if the LLM call fails or is too slow. */
export function templatePrompt(seed: SongSeed): SongPrompt {
  const name = seed.name.trim() || "you";
  const bpm = seed.bpm ?? genreBpm(seed.genre);
  const chorus = `[Chorus]\n${name}, this one's for you\n${seed.answer}\nTurn it up, we're breaking through`;
  const sections = [
    `[Verse]\nSomebody said it, ${name} in the crowd`,
    `"${seed.answer}" — say it loud`,
    chorus,
    `[Verse]\nLights are flashing, the bass is alive\n${name}, this is your time to thrive`,
    chorus,
    `[Bridge]\nEvery voice, every hand in the air`,
    chorus,
  ];
  return {
    title: `${name}'s ${seed.genre} Anthem`,
    lyrics: sections.join("\n"),
    style: `${seed.genre}, ${bpm} BPM, 4/4, genre-authentic groove, punchy drums, bright${seed.vibe ? `, ${seed.vibe.toLowerCase()} mood` : ""}`,
  };
}

/** Ensure the crowd's winning vibe is reflected in the Suno style (mood term). */
function withVibeMood(style: string, vibe: string): string {
  const v = vibe.trim();
  if (!v) return style;
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Don't duplicate if the model already wove the vibe word into the style.
  if (new RegExp(`\\b${escaped}\\b`, "i").test(style)) return style;
  return `${style}, ${v.toLowerCase()} mood`;
}

function normalizedStyle(style: string, genre: string, bpm: number): string {
  const escapedGenre = genre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const descriptors = style
    .replace(new RegExp(`^\\s*${escapedGenre}\\s*,?\\s*`, "i"), "")
    .replace(/\b\d{2,3}\s*BPM\b/gi, "")
    .replace(/\b4\/4\b/gi, "")
    .replace(/^[\s,]+|[\s,]+$/g, "");
  return [genre, `${bpm} BPM`, "4/4", descriptors].filter(Boolean).join(", ");
}

// ============================================================
// SET OPENER — the FIRST track of the night, before any crowd input exists.
// A different system prompt: it welcomes the whole ROOM (no single person's
// name) from a freeform DJ brief, instead of chanting one participant's name.
// ============================================================

export interface OpenerSeed {
  prompt: string; // the DJ's freeform brief for the opener
  genre: string; // the genre the opener should be in
}

function openerSystemPrompt(genre: string, bpm: number, strict: boolean): string {
  return [
    "You are the lyricist for the SET OPENER of 'Between Sets', a live party where the crowd's answers become AI songs.",
    "This is the VERY FIRST track of the night — it plays before anyone has submitted anything, to set the energy and welcome the room.",
    "Turn the DJ's brief into a high-energy, chantable opener that hypes the WHOLE crowd.",
    "",
    "FORMAT — replace every placeholder with original lyrics (the [Intro] is a CROWD chant, not a person's name):",
    STRUCTURE_TEMPLATE,
    "",
    "Rules:",
    "- Address the WHOLE ROOM / crowd. Do NOT invent or sing a specific person's name — use 'we', 'tonight', 'the room', and call-and-response crowd shouts.",
    "- Build the [Chorus] as a short, super-repetitive, shoutable hook drawn from the DJ's brief.",
    "- Use fresh wording tied to the brief; don't pad with stock party slogans that aren't in the brief.",
    "- Use these exact section tags: [Intro], [Chorus], [Verse 1], [Verse 2], [Outro] (repeat [Chorus] between verses). Aim for ~6–8 sections so it runs long enough.",
    `- The 'style' field MUST start with "${genre}, ${bpm} BPM, 4/4" followed by genre-appropriate production descriptors.`,
    "- Keep it crowd-friendly: no slurs, hate, explicit sexual content, or targeted insults. If the brief is unsafe, transform it into something fun and inclusive.",
    strict ? STRICT_SANITIZE : "",
    "Return ONLY the structured fields (title, lyrics, style).",
  ].filter(Boolean).join("\n");
}

/** Deterministic fallback opener if the LLM call fails or is too slow. */
export function templateOpener(seed: OpenerSeed): SongPrompt {
  const genre = seed.genre || "House";
  const bpm = genreBpm(genre);
  const brief = seed.prompt.trim() || "Welcome to the show";
  const chorus = `[Chorus]\nWelcome to the show, the night is ours\nHands up, ${brief}\nEverybody move, we're taking off`;
  const sections = [
    `[Intro]\nHey! Hey! THE SHOW! (let's go!)`,
    chorus,
    `[Verse 1]\nLights down low, the room is full\n${brief} — feel the pull`,
    chorus,
    `[Verse 2]\nNo names yet, just one big sound\nEverybody jumping, shake the ground`,
    chorus,
    `[Outro]\nTHE SHOW! THE SHOW! (one time!)`,
  ];
  return {
    title: "THE SHOW — Opener",
    lyrics: sections.join("\n"),
    style: `${genre}, ${bpm} BPM, 4/4, genre-authentic groove, punchy drums, bright, set-opener energy`,
  };
}

/** Craft a Suno prompt for the DJ's set opener. Falls back to a template on failure. */
export async function craftOpenerPrompt(seed: OpenerSeed, opts?: { strict?: boolean }): Promise<SongPrompt> {
  const genre = seed.genre || "House";
  const bpm = genreBpm(genre);
  try {
    const res = await client.messages.create({
      model: CONFIG.agentModel,
      max_tokens: 2048,
      system: openerSystemPrompt(genre, bpm, opts?.strict ?? false),
      output_config: {
        format: { type: "json_schema", schema: SCHEMA },
        effort: "low",
      },
      messages: [
        {
          role: "user",
          content: [
            `DJ opener brief: ${seed.prompt}`,
            `Genre: ${genre}`,
            `Target tempo: ${bpm} BPM`,
            `Target sections: ${CONFIG.targetSections}`,
          ].join("\n"),
        },
      ],
    } as any);

    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("opener: no text block");
    const parsed = JSON.parse(text.text) as SongPrompt;
    if (!parsed.lyrics || !parsed.style) throw new Error("opener: incomplete output");
    parsed.style = normalizedStyle(parsed.style, genre, bpm);
    return parsed;
  } catch (err) {
    console.error("opener: falling back to template —", (err as Error).message);
    return templateOpener(seed);
  }
}

/** Craft a Suno prompt from the seed. Falls back to a template on any failure.
 *  `strict` aggressively sanitizes (used to retry after a Suno content rejection). */
export async function craftSongPrompt(seed: SongSeed, opts?: { strict?: boolean }): Promise<SongPrompt> {
  const bpm = seed.bpm ?? genreBpm(seed.genre);
  try {
    const res = await client.messages.create({
      model: CONFIG.agentModel,
      max_tokens: 2048,
      system: systemPrompt(seed, bpm, opts?.strict ?? false),
      // output_config.format constrains the response to our JSON schema.
      output_config: {
        format: { type: "json_schema", schema: SCHEMA },
        effort: "low", // short creative task; keep it snappy
      },
      messages: [{ role: "user", content: userPrompt(seed) }],
    } as any);

    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("agent: no text block");
    const parsed = JSON.parse(text.text) as SongPrompt;
    if (!parsed.lyrics || !parsed.style) throw new Error("agent: incomplete output");
    // Hard guarantee: the participant's name MUST appear in the lyrics. If the
    // model somehow dropped it, fall back to the template (which always sings it).
    if (!nameAppears(parsed.lyrics, seed.name)) {
      throw new Error(`agent: name "${seed.name}" missing from lyrics`);
    }
    parsed.style = normalizedStyle(parsed.style, seed.genre, bpm);
    if (seed.vibe) parsed.style = withVibeMood(parsed.style, seed.vibe);
    return parsed;
  } catch (err) {
    console.error("agent: falling back to template —", (err as Error).message);
    return templatePrompt(seed);
  }
}
