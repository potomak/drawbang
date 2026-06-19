import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Server-side H.264 MP4 encoder for the Instagram-shareable sidecar
// (`public/tiles/<id>-large.mp4`). Input is the already-rendered
// `-large.gif` — the share-gif already paints the full chrome (derived
// plinth bg, palette swatch top-left, Draw! wordmark bottom-right), so
// we don't have to re-implement any chrome rendering here. ffmpeg just
// transcodes the rendered GIF into a 6-second 1080×1080 H.264 / yuv420p
// MP4 that Instagram's feed-post path accepts.
//
// Architecture-locked binary: infra/aws/build-lambda.mjs copies
// @ffmpeg-installer/linux-arm64's binary into dist-lambda next to
// lambda.js, so on Lambda it ends up at /var/task/ffmpeg. In dev /
// scripts we resolve the same npm package directly via createRequire,
// using process.cwd() so the lookup works in both ESM (tsx) and CJS
// (esbuild bundle) sources — referencing import.meta.url breaks under
// esbuild's CJS output (it stubs import.meta to {}).

function resolveFfmpegPath(): string {
  if (process.env.DRAWBANG_FFMPEG_PATH) return process.env.DRAWBANG_FFMPEG_PATH;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return "/var/task/ffmpeg";
  try {
    const r = createRequire(join(process.cwd(), "noop.js"));
    return r.resolve("@ffmpeg-installer/linux-arm64/ffmpeg");
  } catch {
    return "ffmpeg";
  }
}

const FFMPEG_PATH = resolveFfmpegPath();

// -stream_loop -1 + -t 6 emits a 6-second clip regardless of source
// loop length — Instagram's feed-post minimum is 3 s, so 6 s sits
// comfortably above it. scale=1080:1080:flags=neighbor keeps pixel-art
// edges crisp on the 1.125× upscale instead of softening them with
// bilinear. -an drops audio entirely (Instagram tolerates silent video).
function ffmpegArgs(input: string, output: string): string[] {
  return [
    "-hide_banner",
    "-nostats",
    "-loglevel", "error",
    "-stream_loop", "-1",
    "-i", input,
    "-t", "6",
    "-vf", "scale=1080:1080:flags=neighbor,fps=30,format=yuv420p",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-movflags", "+faststart",
    "-an",
    "-y", output,
  ];
}

export async function encodeShareMp4(gif: Uint8Array): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "drawbang-mp4-"));
  const input = join(dir, "in.gif");
  const output = join(dir, "out.mp4");
  try {
    await writeFile(input, gif);
    await runFfmpeg(ffmpegArgs(input, output));
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exit ${code}: ${stderr.trim()}`));
    });
  });
}
