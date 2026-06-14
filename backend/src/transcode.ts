// Suno's final audio_url is Opus-in-MP4 (codec=opus). It plays on desktop Chrome
// (the stage) and recent iOS, but OLDER iPhones / browsers have no Opus decoder, so
// the recap's inline <audio> silently fails for them (download still works — it's
// just bytes). We transcode to AAC — the universally-supported m4a codec — on save
// so every device, however old, can play the playlist inline.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

/** True when the source is Opus (what Suno returns) and should be re-encoded to AAC. */
export function shouldTranscodeToAac(contentType: string | null | undefined): boolean {
  return !!contentType && /opus/i.test(contentType);
}

/** Re-encode arbitrary input audio bytes to AAC in an MP4/m4a container. `+faststart`
 *  moves the moov atom to the front so mobile browsers can begin playback before the
 *  whole file downloads. Throws if ffmpeg is unavailable or the encode fails. */
export async function transcodeToAacM4a(input: Buffer): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("ffmpeg binary not available (ffmpeg-static)");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bs-transcode-"));
  const inPath = path.join(dir, "in");
  const outPath = path.join(dir, "out.m4a");
  try {
    await fs.writeFile(inPath, input);
    await runFfmpeg([
      "-y",
      "-i", inPath,
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      outPath,
    ]);
    const out = await fs.readFile(outPath);
    if (!out.length) throw new Error("ffmpeg produced an empty file");
    return out;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
    });
  });
}
