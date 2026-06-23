// middleware.mjs — HTTP Basic Auth gate for the whole dashboard (the page AND every /api route).
//
// Runs on Vercel before any request is processed. Credentials are read from server-side
// environment variables (never shipped to the browser); the browser shows its native login
// dialog. The user authenticates once and the browser re-attaches the credentials to every
// same-origin request automatically — so the live data fetches and the AI chat keep working.
//
// This file is intentionally `.mjs` (ES module) so it can `import` from @vercel/functions while
// the CommonJS api/*.js handlers keep working. Do NOT add "type":"module" to package.json — that
// would break those handlers.
//
// Configure in Vercel → Project → Settings → Environment Variables:
//   DASHBOARD_USER + DASHBOARD_PASSWORD      → one login (e.g. user "gsl", a strong password)
//   DASHBOARD_USERS = "alice:pw1,bob:pw2"    → multiple logins (optional; combined with the above)
//
// If NO credentials are configured, the gate stays OFF (site open) so you can never accidentally
// lock yourself out before the env vars are set.

import { next } from '@vercel/functions';

export const config = { matcher: '/(.*)' };

// Constant-time string compare to avoid leaking length/secrets via timing.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function loadCreds() {
  const creds = [];
  const list = (process.env.DASHBOARD_USERS || '').trim();
  if (list) {
    for (const pair of list.split(',')) {
      const i = pair.indexOf(':');
      if (i > 0) creds.push([pair.slice(0, i).trim(), pair.slice(i + 1)]);
    }
  }
  const u = process.env.DASHBOARD_USER;
  const p = process.env.DASHBOARD_PASSWORD;
  if (u && p) creds.push([u, p]);
  return creds;
}

export default function middleware(request) {
  const creds = loadCreds();
  if (!creds.length) return next(); // not configured → leave the site open

  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = atob(header.slice(6).trim()); } catch (e) { decoded = ''; }
    const i = decoded.indexOf(':');
    const user = i >= 0 ? decoded.slice(0, i) : decoded;
    const pass = i >= 0 ? decoded.slice(i + 1) : '';
    // Evaluate every credential pair (no early-out) so timing doesn't reveal which field matched.
    let ok = false;
    for (const [u, p] of creds) { if (safeEqual(user, u) && safeEqual(pass, p)) ok = true; }
    if (ok) return next();
  }

  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="GSL Marketing Mirror", charset="UTF-8"',
      'Content-Type': 'text/plain'
    }
  });
}
