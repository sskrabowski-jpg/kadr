import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { hasFfmpeg } from './media.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 3000;
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));

const { app } = createApp({
  dataDir,
  distDir: process.env.NODE_ENV === 'production' ? path.join(root, 'dist') : null,
  password: process.env.KADR_PASSWORD || '',
  maxVideoBytes: (Number(process.env.MAX_VIDEO_MB) || 2048) * 1024 ** 2,
});

app.listen(port, () => {
  console.log(`Kadr API on http://localhost:${port}  (data: ${dataDir})`);
  if (!process.env.KADR_PASSWORD) console.warn('KADR_PASSWORD is not set: anyone who opens the site can record.');
  if (!hasFfmpeg) console.warn('ffmpeg not found: videos will be served as recorded (WebM, no thumbnails).');
});
