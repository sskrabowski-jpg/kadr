import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'kadr.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS videos (
      id          TEXT PRIMARY KEY,
      owner_key   TEXT NOT NULL,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'recording', -- recording | processing | ready | failed
      mime_type   TEXT,
      file_name   TEXT,                              -- playable file inside the video dir
      has_thumb   INTEGER NOT NULL DEFAULT 0,
      duration    REAL,
      size_bytes  INTEGER NOT NULL DEFAULT 0,
      next_seq    INTEGER NOT NULL DEFAULT 0,
      views       INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS videos_owner ON videos(owner_key, created_at DESC);
  `);
  return db;
}

/** Public shape of a video row (never exposes owner_key). */
export function toPublic(row, { isOwner = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    duration: row.duration,
    sizeBytes: row.size_bytes,
    views: row.views,
    createdAt: row.created_at,
    videoUrl: row.file_name ? `/media/${row.id}/${row.file_name}` : null,
    thumbUrl: row.has_thumb ? `/media/${row.id}/thumb.jpg` : null,
    isOwner,
  };
}
