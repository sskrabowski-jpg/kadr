import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from './app.js';
import { hasFfmpeg } from './media.js';

const OWNER = 'owner-key-1234567890';
const OTHER = 'other-key-1234567890';
const quiet = { info() {}, warn() {}, error() {} };

async function start(opts) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadr-'));
  const { app } = createApp({ dataDir, log: quiet, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (p, { key = OWNER, ...init } = {}) =>
    fetch(base + p, { ...init, headers: { 'x-owner-key': key, ...(init.headers || {}) } });
  return { base, api, close: () => { server.closeAllConnections(); server.close(); }, dataDir };
}

function sampleWebm() {
  const file = path.join(os.tmpdir(), `kadr-sample-${process.pid}.webm`);
  if (!fs.existsSync(file)) {
    const r = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus', file,
    ]);
    assert.equal(r.status, 0, String(r.stderr));
  }
  return fs.readFileSync(file);
}

async function upload(api, buf, { chunks = 4 } = {}) {
  const v = await (await api('/api/videos', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Демо', mimeType: 'video/webm' }),
  })).json();
  const size = Math.ceil(buf.length / chunks);
  for (let i = 0; i < chunks; i++) {
    const r = await api(`/api/videos/${v.id}/chunks?seq=${i}`, { method: 'POST', body: buf.subarray(i * size, (i + 1) * size) });
    assert.equal(r.status, 200);
  }
  return v;
}

async function waitReady(api, id) {
  for (let i = 0; i < 100; i++) {
    const v = await (await api(`/api/videos/${id}`)).json();
    if (v.status === 'ready' || v.status === 'failed') return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
}

test('record → finish → transcode → watch → rename → delete', { skip: !hasFfmpeg }, async () => {
  const s = await start();
  try {
    const buf = sampleWebm();
    const v = await upload(s.api, buf);
    assert.equal(v.title, 'Демо');

    // retried chunk is idempotent, gaps are rejected
    assert.equal((await s.api(`/api/videos/${v.id}/chunks?seq=1`, { method: 'POST', body: 'x' })).status, 200);
    assert.equal((await s.api(`/api/videos/${v.id}/chunks?seq=9`, { method: 'POST', body: 'x' })).status, 409);
    // only the owner may upload
    assert.equal((await s.api(`/api/videos/${v.id}/chunks?seq=4`, { key: OTHER, method: 'POST', body: 'x' })).status, 403);

    const fin = await (await s.api(`/api/videos/${v.id}/finish`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ duration: 3 }),
    })).json();
    assert.equal(fin.status, 'processing');

    const ready = await waitReady(s.api, v.id);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.videoUrl, `/media/${v.id}/video.mp4`);
    assert.ok(ready.thumbUrl);
    assert.ok(Math.abs(ready.duration - 3) < 0.5, `duration ${ready.duration}`);

    // range request works (needed for seeking)
    const part = await fetch(s.base + ready.videoUrl, { headers: { range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(s.base + ready.thumbUrl)).headers.get('content-type'), 'image/jpeg');

    // views: viewers count, owner doesn't
    await s.api(`/api/videos/${v.id}/view`, { key: OTHER, method: 'POST' });
    await s.api(`/api/videos/${v.id}/view`, { method: 'POST' });
    const pub = await (await s.api(`/api/videos/${v.id}`, { key: OTHER })).json();
    assert.equal(pub.views, 1);
    assert.equal(pub.isOwner, false);
    assert.equal(pub.owner_key, undefined);

    // library is per owner
    assert.equal((await (await s.api('/api/videos')).json()).length, 1);
    assert.equal((await (await s.api('/api/videos', { key: OTHER })).json()).length, 0);

    // rename: owner only
    const patch = (key) => s.api(`/api/videos/${v.id}`, {
      key, method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Новое' }),
    });
    assert.equal((await patch(OTHER)).status, 403);
    assert.equal((await (await patch(OWNER)).json()).title, 'Новое');

    // delete: owner only, files removed
    assert.equal((await s.api(`/api/videos/${v.id}`, { key: OTHER, method: 'DELETE' })).status, 403);
    assert.equal((await s.api(`/api/videos/${v.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await s.api(`/api/videos/${v.id}`)).status, 404);
    assert.equal(fs.existsSync(path.join(s.dataDir, 'videos', v.id)), false);
  } finally {
    s.close();
  }
});

test('without ffmpeg the raw recording is served', async () => {
  const s = await start({ useFfmpeg: false });
  try {
    const v = await upload(s.api, Buffer.from('fake-webm-bytes'), { chunks: 1 });
    await s.api(`/api/videos/${v.id}/finish`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ duration: 7 }),
    });
    const ready = await waitReady(s.api, v.id);
    assert.equal(ready.videoUrl, `/media/${v.id}/raw.webm`);
    assert.equal(ready.duration, 7);
    assert.equal(await (await fetch(s.base + ready.videoUrl)).text(), 'fake-webm-bytes');
  } finally {
    s.close();
  }
});

test('rejects bad ids, missing owner key and empty recordings', async () => {
  const s = await start({ useFfmpeg: false });
  try {
    assert.equal((await s.api('/api/videos/../../etc')).status, 404);
    assert.equal((await fetch(s.base + '/media/AAAAAAAAAAAA/secret.txt')).status, 404);
    assert.equal((await s.api('/api/videos', { key: 'short' })).status, 400);
    const v = await (await s.api('/api/videos', { method: 'POST' })).json();
    assert.equal(v.title, 'Без названия');
    assert.equal((await s.api(`/api/videos/${v.id}/finish`, { method: 'POST' })).status, 400);
  } finally {
    s.close();
  }
});

test('password mode: recording needs login, watching does not', async () => {
  const s = await start({ useFfmpeg: false, password: 'secret-pass', maxVideoBytes: 10 });
  try {
    const json = { 'content-type': 'application/json' };
    assert.deepEqual(await (await s.api('/api/auth')).json(), { required: true, loggedIn: false });
    assert.equal((await s.api('/api/videos')).status, 401);
    assert.equal((await s.api('/api/videos', { method: 'POST' })).status, 401);

    const bad = await s.api('/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'nope' }) });
    assert.equal(bad.status, 401);
    const ok = await s.api('/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'secret-pass' }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/);

    // logged in from any device (any owner key) = owner of everything
    const v = await (await s.api('/api/videos', { method: 'POST', headers: { cookie } })).json();
    assert.equal((await s.api(`/api/videos/${v.id}/chunks?seq=0`, { key: OTHER, method: 'POST', headers: { cookie }, body: '12345' })).status, 200);
    assert.equal((await s.api(`/api/videos/${v.id}/chunks?seq=1`, { method: 'POST', headers: { cookie }, body: '123456' })).status, 413);
    assert.equal((await (await s.api('/api/videos', { key: OTHER, headers: { cookie } })).json()).length, 1);

    // anonymous viewer: can read, can't manage
    const pub = await (await s.api(`/api/videos/${v.id}`, { key: OTHER })).json();
    assert.equal(pub.isOwner, false);
    assert.equal((await s.api(`/api/videos/${v.id}`, { key: OTHER, method: 'DELETE' })).status, 403);

    // brute force is throttled
    for (let i = 0; i < 10; i++) {
      await s.api('/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'x' }) });
    }
    const locked = await s.api('/api/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'secret-pass' }) });
    assert.equal(locked.status, 429);
  } finally {
    s.close();
  }
});
