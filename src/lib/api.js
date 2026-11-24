// Anonymous ownership for the MVP: each browser gets a random key; the server lets
// only that key list, rename or delete its videos. Accounts can replace this later.
const KEY_STORAGE = 'kadr.ownerKey';

export function ownerKey() {
  let k = null;
  try {
    k = localStorage.getItem(KEY_STORAGE);
  } catch {}
  if (!k) {
    k = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    try {
      localStorage.setItem(KEY_STORAGE, k);
    } catch {}
  }
  return k;
}

async function req(path, { json, body, method = 'GET', headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'x-owner-key': ownerKey(),
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

export const api = {
  list: () => req('/api/videos'),
  get: (id) => req(`/api/videos/${id}`),
  create: (title, mimeType) => req('/api/videos', { method: 'POST', json: { title, mimeType } }),
  finish: (id, duration) => req(`/api/videos/${id}/finish`, { method: 'POST', json: { duration } }),
  rename: (id, title) => req(`/api/videos/${id}`, { method: 'PATCH', json: { title } }),
  remove: (id) => req(`/api/videos/${id}`, { method: 'DELETE' }),
  view: (id) => req(`/api/videos/${id}/view`, { method: 'POST' }),
};

/**
 * Uploads recorder chunks strictly in order while recording is in progress,
 * retrying with backoff so a flaky connection doesn't lose the video.
 */
export function createChunkUploader(videoId, { onProgress } = {}) {
  let seq = 0;
  let queued = 0;
  let sent = 0;
  let failed = null;
  let chain = Promise.resolve();

  async function send(blob, n) {
    for (let attempt = 0; ; attempt++) {
      try {
        await req(`/api/videos/${videoId}/chunks?seq=${n}`, { method: 'POST', body: blob });
        return;
      } catch (e) {
        if (attempt >= 6 || (e.status && e.status < 500 && e.status !== 409)) throw e;
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
      }
    }
  }

  return {
    push(blob) {
      if (!blob || blob.size === 0) return;
      const n = seq++;
      queued += blob.size;
      onProgress?.({ sent, queued });
      chain = chain.then(async () => {
        if (failed) return;
        try {
          await send(blob, n);
          sent += blob.size;
          onProgress?.({ sent, queued });
        } catch (e) {
          failed = e;
        }
      });
    },
    async drain() {
      await chain;
      if (failed) throw failed;
    },
  };
}
