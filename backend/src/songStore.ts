import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import type { SavedSong, Song } from "./types.js";
import {
  SAFE_ID,
  safeFilePart,
  audioExtension,
  type DownloadTarget,
  type SongStore,
} from "./songFiles.js";
import { shouldTranscodeToAac, transcodeToAacM4a } from "./transcode.js";
import { SupabaseSongStore } from "./supabaseSongStore.js";

// Local-disk archive: audio file + a JSON metadata sidecar per song. The fallback
// when Supabase is not configured (note: ephemeral on hosts like Render).
export class LocalSongStore implements SongStore {
  constructor(private readonly rootDir = CONFIG.songsDir) {}

  async save(song: Song, sourceUrl: string): Promise<SavedSong> {
    const response = await fetch(sourceUrl, { headers: { "User-Agent": CONFIG.userAgent } });
    if (!response.ok) {
      throw new Error(`audio download ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    await fs.mkdir(this.rootDir, { recursive: true });
    const contentType = response.headers.get("content-type");
    let bytes: Buffer = Buffer.from(await response.arrayBuffer());
    let extension = audioExtension(sourceUrl, contentType);
    // Match the Supabase path: Suno's Opus-in-MP4 won't play inline on older phones,
    // so re-encode to AAC. Best-effort — keep the original if ffmpeg is unavailable.
    if (shouldTranscodeToAac(contentType)) {
      try {
        bytes = await transcodeToAacM4a(bytes);
        extension = ".m4a";
        console.log(`[songs] ${song.id}: transcoded Opus → AAC (${bytes.length} bytes)`);
      } catch (err) {
        console.warn(`[songs] ${song.id}: transcode failed, storing original — ${(err as Error).message}`);
      }
    }
    const fileName = `${song.id}-${safeFilePart(song.title)}${extension}`;
    const filePath = path.join(this.rootDir, fileName);
    const tempPath = `${filePath}.partial`;
    await fs.writeFile(tempPath, bytes);
    await fs.rename(tempPath, filePath);

    const saved: SavedSong = {
      id: song.id,
      title: song.title,
      name: song.name,
      genre: song.genre,
      bpm: song.bpm,
      lyrics: song.lyrics,
      createdAt: new Date().toISOString(),
      fileName,
      downloadUrl: `/api/songs/${encodeURIComponent(song.id)}/download`,
    };
    await fs.writeFile(
      path.join(this.rootDir, `${song.id}.json`),
      `${JSON.stringify(saved, null, 2)}\n`,
      "utf8",
    );
    return saved;
  }

  async list(): Promise<SavedSong[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const songs = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          try {
            return JSON.parse(await fs.readFile(path.join(this.rootDir, entry), "utf8")) as SavedSong;
          } catch (err) {
            console.warn(`[songs] ignoring unreadable metadata ${entry}:`, (err as Error).message);
            return null;
          }
        }),
    );
    return songs
      .filter((song): song is SavedSong => song !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Remove a saved song's audio file and metadata sidecar. Returns true if it existed. */
  async delete(id: string): Promise<boolean> {
    if (!SAFE_ID.test(id)) return false;
    const metaPath = path.join(this.rootDir, `${id}.json`);
    let song: SavedSong | null = null;
    try {
      song = JSON.parse(await fs.readFile(metaPath, "utf8")) as SavedSong;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    if (song?.fileName) {
      await fs.rm(path.join(this.rootDir, path.basename(song.fileName)), { force: true });
    }
    await fs.rm(metaPath, { force: true });
    return true;
  }

  async fileFor(id: string): Promise<DownloadTarget | null> {
    if (!SAFE_ID.test(id)) return null;
    try {
      const song = JSON.parse(
        await fs.readFile(path.join(this.rootDir, `${id}.json`), "utf8"),
      ) as SavedSong;
      const filePath = path.join(this.rootDir, path.basename(song.fileName));
      await fs.access(filePath);
      return { song, filePath };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}

// Use Supabase when configured (durable), else local disk. Same interface either way.
const useSupabase = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseServiceKey);
export const songStore: SongStore = useSupabase ? new SupabaseSongStore() : new LocalSongStore();
console.log(`[songs] archive: ${useSupabase ? `Supabase (bucket "${CONFIG.supabaseBucket}")` : "local disk"}`);
