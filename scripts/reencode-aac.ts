// One-time migration: re-encode every already-saved song from Opus-in-MP4 to AAC so
// old playlists play inline on every phone (older iPhones have no Opus decoder).
//
// Idempotent: skips songs already stored as AAC. Re-uploads to the SAME storage path
// (upsert) with content-type audio/mp4, so downloadUrl / DB rows are unchanged.
//
//   npx tsx scripts/reencode-aac.ts          # dry run — report what would change
//   npx tsx scripts/reencode-aac.ts --apply  # actually re-encode + re-upload
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { CONFIG } from "../backend/src/config.js";
import { songStore } from "../backend/src/songStore.js";
import { transcodeToAacM4a } from "../backend/src/transcode.js";

const APPLY = process.argv.includes("--apply");

const client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket as unknown as never },
});
const bucket = CONFIG.supabaseBucket;

async function main() {
  const songs = await songStore.list();
  console.log(`${songs.length} songs in the archive. Mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);
  let converted = 0;
  let skipped = 0;
  let failed = 0;

  for (const song of songs) {
    const label = `${song.id} "${song.title}"`;
    try {
      const res = await fetch(song.downloadUrl, { headers: { "User-Agent": CONFIG.userAgent } });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const ct = res.headers.get("content-type") || "";
      if (!/opus/i.test(ct)) {
        console.log(`· skip   ${label} — already ${ct}`);
        skipped++;
        continue;
      }
      const original = Buffer.from(await res.arrayBuffer());
      if (!APPLY) {
        console.log(`→ would re-encode ${label} (${ct}, ${original.length} bytes)`);
        converted++;
        continue;
      }
      const aac = await transcodeToAacM4a(original);
      const up = await client.storage.from(bucket).upload(song.fileName, aac, {
        contentType: "audio/mp4",
        upsert: true,
      });
      if (up.error) throw new Error(`upload: ${up.error.message}`);
      console.log(`✓ re-encoded ${label} — ${original.length} → ${aac.length} bytes`);
      converted++;
    } catch (err) {
      console.error(`✗ FAILED   ${label} — ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${APPLY ? "re-encoded" : "would re-encode"}: ${converted}, skipped: ${skipped}, failed: ${failed}`);
  if (!APPLY && converted > 0) console.log("Re-run with --apply to perform the migration.");
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1); },
);
