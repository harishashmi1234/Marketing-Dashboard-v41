// Minimal local dev server — no extra dependencies.
// Reads .env.local, serves /public, and routes /api/* to the serverless handlers.
// Usage: node server.js        (then open http://localhost:3000)

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── Load .env.local into process.env ─────────────────────────────────────────
const envFile = path.join(__dirname, '.env.local');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) return;
    const eq = clean.indexOf('=');
    if (eq < 0) return;
    const key = clean.slice(0, eq).trim();
    const val = clean.slice(eq + 1).trim();
    if (key && val) process.env[key] = val;
  });
  console.log('Loaded .env.local');
} else {
  console.warn('.env.local not found — API calls will return "not configured"');
}

// ── MIME types for static files ───────────────────────────────────────────────
const MIME = {
  '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg',
  '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff2':'font/woff2'
};

const PORT = process.env.PORT || 3000;

// ── Route table: /api/<name> → ./api/<name>.js ────────────────────────────────
const API_HANDLERS = {};
['meta','meta-creatives','graph','leads','instagram','facebook','linkedin','jira','sheets','analytics','chat'].forEach(name => {
  const file = path.join(__dirname, 'api', name + '.js');
  if (fs.existsSync(file)) {
    delete require.cache[require.resolve(file)]; // always fresh
    API_HANDLERS['/api/' + name] = require(file);
  }
});

// ── Minimal req/res shim so the handlers think they're in Vercel ──────────────
function makeReq(nodeReq, query) {
  return { method: nodeReq.method, headers: nodeReq.headers, query };
}

function makeRes(nodeRes) {
  let headersSent = false;
  const resObj = {
    _status: 200,
    _headers: {},
    status(code) { resObj._status = code; return resObj; },
    setHeader(k, v) { resObj._headers[k] = v; return resObj; },
    json(obj) {
      if (headersSent) return;
      headersSent = true;
      const body = JSON.stringify(obj);
      nodeRes.writeHead(resObj._status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        ...resObj._headers
      });
      nodeRes.end(body);
    }
  };
  return resObj;
}

// ── Parse query string ────────────────────────────────────────────────────────
function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  const q = {};
  url.slice(idx + 1).split('&').forEach(part => {
    const [k, v] = part.split('=');
    if (k) q[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  return q;
}

// ── Basic Auth gate (local-dev parity with middleware.mjs on Vercel) ──────────
// Reads DASHBOARD_USER/DASHBOARD_PASSWORD and/or DASHBOARD_USERS="a:1,b:2" from .env.local.
// If none are set, the gate stays OFF so local dev is never blocked.
function authCreds() {
  const creds = [];
  const list = (process.env.DASHBOARD_USERS || '').trim();
  if (list) list.split(',').forEach(pair => {
    const i = pair.indexOf(':');
    if (i > 0) creds.push([pair.slice(0, i).trim(), pair.slice(i + 1)]);
  });
  if (process.env.DASHBOARD_USER && process.env.DASHBOARD_PASSWORD) {
    creds.push([process.env.DASHBOARD_USER, process.env.DASHBOARD_PASSWORD]);
  }
  return creds;
}
function checkAuth(req) {
  const creds = authCreds();
  if (!creds.length) return true; // not configured → open
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'); } catch (e) { decoded = ''; }
  const i = decoded.indexOf(':');
  const user = i >= 0 ? decoded.slice(0, i) : decoded;
  const pass = i >= 0 ? decoded.slice(i + 1) : '';
  return creds.some(([u, p]) => u === user && p === pass);
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0].replace(/\/+$/, '') || '/';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS' });
    res.end(); return;
  }

  // Require login if credentials are configured
  if (!checkAuth(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GSL Marketing Mirror", charset="UTF-8"', 'Content-Type': 'text/plain' });
    res.end('Authentication required.'); return;
  }

  // API routes
  const apiBase = ['/api/meta-creatives','/api/meta','/api/graph','/api/leads','/api/instagram','/api/facebook','/api/linkedin','/api/jira','/api/sheets','/api/analytics','/api/chat'].find(r => urlPath === r || urlPath.startsWith(r + '?'));
  if (apiBase) {
    const handler = API_HANDLERS[apiBase];
    if (!handler) { res.writeHead(404); res.end('Not found'); return; }
    // Collect a JSON body for POST routes (e.g. /api/chat); Vercel does this automatically.
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => {
      const fakeReq = makeReq(req, parseQuery(req.url));
      if (raw) { try { fakeReq.body = JSON.parse(raw); } catch { fakeReq.body = raw; } }
      const fakeRes = makeRes(res);
      Promise.resolve().then(() => handler(fakeReq, fakeRes)).catch(err => {
        console.error(apiBase, err);
        fakeRes.status(500).json({ ok:false, error: String(err.message || err) });
      });
    });
    return;
  }

  // Static files from /public
  let filePath = path.join(__dirname, 'public', urlPath === '/' ? 'index.html' : urlPath);
  if (!fs.existsSync(filePath)) filePath = path.join(__dirname, 'public', 'index.html');

  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  GSL Marketing Mirror — dev server ready`);
  console.log(`  Open: http://localhost:${PORT}\n`);
});
