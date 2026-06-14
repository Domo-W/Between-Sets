// Supabase-backed song archive: audio in a Storage bucket, metadata in a `songs`
// table. Used when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set (durable
// across host redeploys, unlike local disk). Same SongStore interface as local.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { CONFIG } from "./config.js";
import type { SavedSong, Song } from "./types.js";
import {
  SAFE_ID,
  safeFilePart,
  audioExtension,
  audioContentType,
  type DownloadTarget,
  type SongStore,
} from "./songFiles.js";
import { shouldTranscodeToAac, transcodeToAacM4a } from "./transcode.js";

const TABLE = "songs";

interface SongRow {
  id: string;
  title: string;
  name: string;
  genre: string;
  bpm: number;
  lyrics: string;
  created_at: string;
  file_name: string;
  download_url: string;
}

function rowToSaved(r: SongRow): SavedSong {
  return {
    id: r.id,
    title: r.title,
    name: r.name,
    genre: r.genre,
    bpm: r.bpm,
    lyrics: r.lyrics,
    createdAt: r.created_at,
    fileName: r.file_name,
    downloadUrl: r.download_url,
  };
}

export class SupabaseSongStore implements SongStore {
  private readonly client: SupabaseClient;
  private readonly bucket: string;

  constructor() {
    this.client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Node <22 has no global WebSocket; supabase-js's realtime client throws on
      // construction without one. We don't use realtime (only Storage + Postgrest),
      // but the client still initializes it — so hand it the `ws` implementation.
      realtime: { transport: WebSocket as unknown as never },
    });
    this.bucket = CONFIG.supabaseBucket;
  }

  async save(song: Song, sourceUrl: string): Promise<SavedSong> {
    const response = await fetch(sourceUrl, { headers: { "User-Agent": CONFIG.userAgent } });
    if (!response.ok) {
      throw new Error(`audio download ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const contentType = response.headers.get("content-type");
    let bytes: Buffer = Buffer.from(await response.arrayBuffer());
    let ext = audioExtension(sourceUrl, contentType);
    let uploadType = contentType || audioContentType(ext);
    // Suno ships Opus-in-MP4, which older phones can't play inline. Transcode to AAC
    // so the recap plays on every device. Best-effort: if ffmpeg fails, store the
    // original so the song is never lost (it still downloads + plays on most devices).
    if (shouldTranscodeToAac(contentType)) {
      try {
        bytes = await transcodeToAacM4a(bytes);
        ext = ".m4a";
        uploadType = "audio/mp4";
        console.log(`[songs] ${song.id}: transcoded Opus → AAC (${bytes.length} bytes)`);
      } catch (err) {
        console.warn(`[songs] ${song.id}: transcode failed, storing original — ${(err as Error).message}`);
      }
    }
    const fileName = `${song.id}-${safeFilePart(song.title)}${ext}`;

    const upload = await this.client.storage.from(this.bucket).upload(fileName, bytes, {
      contentType: uploadType,
      upsert: true,
    });
    if (upload.error) throw new Error(`storage upload: ${upload.error.message}`);

    const { data: pub } = this.client.storage.from(this.bucket).getPublicUrl(fileName);
    const downloadUrl = pub.publicUrl;

    const saved: SavedSong = {
      id: song.id,
      title: song.title,
      name: song.name,
      genre: song.genre,
      bpm: song.bpm,
      lyrics: song.lyrics,
      createdAt: new Date().toISOString(),
      fileName,
      downloadUrl,
    };

    const row: SongRow = {
      id: saved.id,
      title: saved.title,
      name: saved.name,
      genre: saved.genre,
      bpm: saved.bpm,
      lyrics: saved.lyrics,
      created_at: saved.createdAt,
      file_name: saved.fileName,
      download_url: saved.downloadUrl,
    };
    const insert = await this.client.from(TABLE).upsert(row, { onConflict: "id" });
    if (insert.error) throw new Error(`db upsert: ${insert.error.message}`);
    return saved;
  }

  async list(): Promise<SavedSong[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(`db list: ${error.message}`);
    return (data as SongRow[] | null ?? []).map(rowToSaved);
  }

  async delete(id: string): Promise<boolean> {
    if (!SAFE_ID.test(id)) return false;
    const { data, error } = await this.client
      .from(TABLE)
      .select("file_name")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`db get: ${error.message}`);
    if (!data) return false;
    if (data.file_name) {
      await this.client.storage.from(this.bucket).remove([data.file_name]);
    }
    const del = await this.client.from(TABLE).delete().eq("id", id);
    if (del.error) throw new Error(`db delete: ${del.error.message}`);
    return true;
  }

  async fileFor(id: string): Promise<DownloadTarget | null> {
    if (!SAFE_ID.test(id)) return null;
    const { data, error } = await this.client.from(TABLE).select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`db get: ${error.message}`);
    if (!data) return null;
    const song = rowToSaved(data as SongRow);
    return { song, url: song.downloadUrl };
  }
}
