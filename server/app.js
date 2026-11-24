import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, toPublic } from './db.js';
import { createAuth } from './auth.js';
import {
  hasFfmpeg, transcodeToMp4, makeThumbnail, probeDuration, createQueue, rmDir, fileSize,
} from './media.js';

const ID_RE = /^[A-Za-z0-9]{12}$/;
const MEDIA_FILES = new Set(['video.mp4', 'raw.webm', 'raw.mp4', 'thumb.jpg']);
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function newId() {
  const bytes = crypto.randomBytes(12);
  let id = '';
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id.padEnd(12, 'x');
}

function ownerKeyOf(req) {
  const k = req.get('x-owner-key');
  return typeof k === 'string' && k.length >= 16 && k.length <= 128 ? k : null;
}

export function createApp({
  dataDir,
  distDir,
  useFfmpeg = hasFfmpeg,
  log = console,
  password = '',
  maxVideoBytes = 2 * 1024 ** 3,
} = {}) {
  const db = openDb(dataDir);
  const auth = createAuth(password);
  const videosDir = path.join(dataDir, 'videos');
  fs.mkdirSync(videosDir, { recursive: true });
  const enqueue = createQueue();

  const q = {
    get: db.prepare('SELECT * FROM videos WHERE id = ?'),
    listByOwner: db.prepare('SELECT * FROM videos WHERE owner_key = ? ORDER BY created_at DESC'),
    listAll: db.prepare('SELECT * FROM videos ORDER BY created_at DESC'),
    insert: db.prepare('INSERT INTO videos (id, owner_key, title, mime_type) VALUES (?, ?, ?, ?)'),
    appendChunk: db.prepare(
      "UPDATE videos SET next_seq = next_seq + 1, size_bytes = size_bytes + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND next_seq = ?",
    ),
    setStatus: db.prepare(
      "UPDATE videos SET status = ?, file_name = ?, has_thumb = ?, duration = ?, size_bytes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    ),
    rename: db.prepare("UPDATE videos SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"),
    view: db.prepare('UPDATE videos SET views = views + 1 WHERE id = ?'),
    del: db.prepare('DELETE FROM videos WHERE id = ?'),
  };

  const dirOf = (id) => path.join(videosDir, id);
  const rawName = (row) => (row.mime_type?.includes('mp4') ? 'raw.mp4' : 'raw.webm');

  async function processVideo(id, clientDuration) {
    const row = q.get.get(id);
    if (!row) return;
    const dir = dirOf(id);
    const raw = path.join(dir, rawName(row));
    if (!useFfmpeg) {
      q.setStatus.run('ready', rawName(row), 0, clientDuration ?? null, fileSize(raw), id);
      return;
    }
    try {
      const out = path.join(dir, 'video.mp4');
      await transcodeToMp4(raw, out);
      const duration = (await probeDuration(out)) ?? clientDuration ?? null;
      let thumb = 0;
      try {
        await makeThumbnail(out, path.join(dir, 'thumb.jpg'), duration);
        thumb = 1;
      } catch (e) {
        log.warn(`[${id}] thumbnail failed: ${e.message}`);
      }
      if (!q.get.get(id)) return rmDir(dir); // deleted while processing
      q.setStatus.run('ready', 'video.mp4', thumb, duration, fileSize(out), id);
      fs.rmSync(raw, { force: true });
      log.info(`[${id}] ready (${duration?.toFixed(1)}s)`);
    } catch (e) {
      log.error(`[${id}] processing failed: ${e.message}`);
      // Fall back to the original recording so the link still works.
      if (q.get.get(id)) q.setStatus.run('ready', rawName(row), 0, clientDuration ?? null, fileSize(raw), id);
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, uniquelocal'); // behind Caddy/nginx

  const loadVideo = (req, res, next) => {
    if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const row = q.get.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    req.video = row;
    req.isOwner = auth.isAdmin(req) || ownerKeyOf(req) === row.owner_key;
    next();
  };
  const requireOwner = (req, res, next) =>
    req.isOwner ? next() : res.status(403).json({ error: 'forbidden' });

  app.get('/api/health', (_req, res) => res.json({ ok: true, ffmpeg: useFfmpeg }));

  app.get('/api/auth', auth.status);
  app.post('/api/login', express.json(), auth.login);
  app.post('/api/logout', auth.logout);

  app.get('/api/videos', auth.requireRecorder, (req, res) => {
    const rows = auth.isAdmin(req) ? q.listAll.all() : q.listByOwner.all(ownerKeyOf(req) ?? '');
    if (!auth.isAdmin(req) && !ownerKeyOf(req)) return res.status(400).json({ error: 'owner_key_required' });
    res.json(rows.map((r) => toPublic(r, { isOwner: true })));
  });

  app.post('/api/videos', auth.requireRecorder, express.json(), (req, res) => {
    const key = ownerKeyOf(req);
    if (!key) return res.status(400).json({ error: 'owner_key_required' });
    const title = String(req.body?.title || '').trim().slice(0, 200) || 'Без названия';
    const mime = String(req.body?.mimeType || 'video/webm').slice(0, 100);
    const id = newId();
    fs.mkdirSync(dirOf(id), { recursive: true });
    q.insert.run(id, key, title, mime);
    res.status(201).json(toPublic(q.get.get(id), { isOwner: true }));
  });

  app.get('/api/videos/:id', loadVideo, (req, res) => {
    res.json(toPublic(req.video, { isOwner: req.isOwner }));
  });

  // Chunks arrive while recording, so the link works seconds after "Stop".
  app.post(
    '/api/videos/:id/chunks',
    loadVideo,
    requireOwner,
    express.raw({ type: () => true, limit: '64mb' }),
    (req, res) => {
      const v = req.video;
      if (v.status !== 'recording') return res.status(409).json({ error: 'not_recording' });
      const seq = Number(req.query.seq);
      if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'bad_seq' });
      if (seq < v.next_seq) return res.json({ ok: true, duplicate: true }); // retried chunk
      if (seq > v.next_seq) return res.status(409).json({ error: 'out_of_order', expected: v.next_seq });
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (v.size_bytes + body.length > maxVideoBytes) return res.status(413).json({ error: 'too_large' });
      fs.appendFileSync(path.join(dirOf(v.id), rawName(v)), body);
      q.appendChunk.run(body.length, v.id, seq);
      res.json({ ok: true, next: seq + 1 });
    },
  );

  app.post('/api/videos/:id/finish', loadVideo, requireOwner, express.json(), (req, res) => {
    const v = req.video;
    if (v.status !== 'recording') return res.json(toPublic(v, { isOwner: true }));
    if (v.size_bytes === 0) return res.status(400).json({ error: 'empty_recording' });
    const d = Number(req.body?.duration);
    const clientDuration = Number.isFinite(d) && d > 0 ? d : null;
    q.setStatus.run('processing', null, 0, clientDuration, v.size_bytes, v.id);
    enqueue(() => processVideo(v.id, clientDuration));
    res.json(toPublic(q.get.get(v.id), { isOwner: true }));
  });

  app.patch('/api/videos/:id', loadVideo, requireOwner, express.json(), (req, res) => {
    const title = String(req.body?.title ?? '').trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: 'title_required' });
    q.rename.run(title, req.video.id);
    res.json(toPublic(q.get.get(req.video.id), { isOwner: true }));
  });

  app.delete('/api/videos/:id', loadVideo, requireOwner, (req, res) => {
    q.del.run(req.video.id);
    if (req.video.status !== 'processing') rmDir(dirOf(req.video.id));
    res.status(204).end();
  });

  app.post('/api/videos/:id/view', loadVideo, (req, res) => {
    if (!req.isOwner && req.video.status === 'ready') q.view.run(req.video.id);
    res.status(204).end();
  });

  // Range requests are handled by sendFile, so the player can seek.
  app.get('/media/:id/:file', (req, res) => {
    const { id, file } = req.params;
    if (!ID_RE.test(id) || !MEDIA_FILES.has(file)) return res.status(404).end();
    const row = q.get.get(id);
    if (!row || (file !== 'thumb.jpg' && file !== row.file_name)) return res.status(404).end();
    res.sendFile(path.join(dirOf(id), file), { maxAge: '1h' }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  if (distDir && fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false }));
    app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }

  return { app, db };
}
