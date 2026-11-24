import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const hasFfmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-2000)}`)),
    );
  });
}

export async function probeDuration(file) {
  const out = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ]);
  const d = parseFloat(out.trim());
  return Number.isFinite(d) ? d : null;
}

/**
 * MediaRecorder output is a WebM without duration/cues, so it cannot be seeked and
 * Safari can't play it. Transcode to H.264/AAC MP4 with the index at the front.
 */
export async function transcodeToMp4(input, output) {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ]);
}

export async function makeThumbnail(input, output, duration) {
  const at = duration && duration > 2 ? 1 : 0;
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(at), '-i', input,
    '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4',
    output,
  ]);
}

/** Runs jobs one at a time so a burst of uploads doesn't spawn N encoders. */
export function createQueue() {
  let tail = Promise.resolve();
  return (job) => {
    const p = tail.then(job);
    tail = p.catch(() => {});
    return p;
  };
}

export function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export { path };
