import crypto from 'node:crypto';

// Single shared password for the people who record (the instance owner and team).
// Watching a video by its link never needs it. Sessions are a cookie holding an HMAC
// of the password, so changing the password logs everyone out.

const COOKIE = 'kadr_session';
const YEAR_S = 365 * 24 * 3600;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function createAuth(password) {
  const required = !!password;
  const token = required
    ? crypto.createHmac('sha256', password).update('kadr-session-v1').digest('hex')
    : null;
  const fails = new Map(); // ip -> { count, since }

  const isAdmin = (req) => required && safeEqual(parseCookies(req.headers.cookie)[COOKIE] || '', token);

  function cookie(req, value, maxAge) {
    const secure = req.secure ? '; Secure' : '';
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  }

  return {
    required,
    isAdmin,
    /** Blocks recording/library endpoints when a password is set and the user isn't logged in. */
    requireRecorder(req, res, next) {
      if (!required || isAdmin(req)) return next();
      res.status(401).json({ error: 'login_required' });
    },
    status(req, res) {
      res.json({ required, loggedIn: !required || isAdmin(req) });
    },
    login(req, res) {
      if (!required) return res.json({ ok: true });
      const ip = req.ip || 'unknown';
      const f = fails.get(ip);
      if (f && Date.now() - f.since > FAIL_WINDOW_MS) fails.delete(ip);
      if ((fails.get(ip)?.count || 0) >= MAX_FAILS) {
        return res.status(429).json({ error: 'too_many_attempts' });
      }
      if (!safeEqual(String(req.body?.password ?? ''), password)) {
        const cur = fails.get(ip) || { count: 0, since: Date.now() };
        cur.count++;
        fails.set(ip, cur);
        return res.status(401).json({ error: 'wrong_password' });
      }
      fails.delete(ip);
      res.setHeader('Set-Cookie', cookie(req, token, YEAR_S));
      res.json({ ok: true });
    },
    logout(req, res) {
      res.setHeader('Set-Cookie', cookie(req, '', 0));
      res.json({ ok: true });
    },
  };
}
