// api/graph.js
// Vercel Serverless Function — secure proxy to the "campaign brief index" sheet.
//
// This is a NEW, self-contained integration used only by the Campaigns tab. It reads a simple
// two-column sheet (campaign_id | brief_url) and returns a { campaign_id -> brief_url } map. The
// Campaigns tab joins this with the live Meta campaign list (by Campaign ID) to show an
// "Open Brief →" button per campaign. (The brief_url is only ever *linked* — never read here — so
// the briefs can be Word docs on SharePoint/OneDrive, Google Docs, or any URL.)
//
// THREE sources, auto-detected in this order (configure ONE in your environment variables /
// Vercel → Settings → Environment Variables, or .env.local for local `node server.js` dev):
//
//   A) Google Sheet "Publish to web → CSV"  — EASIEST, no credentials, no app needed:
//        BRIEFS_CSV_URL        the published .../pub?output=csv URL
//
//   B) Google Sheets API key  — share the sheet "Anyone with the link → Viewer", then:
//        BRIEFS_SHEET_ID       the spreadsheet ID (the long string in its URL)
//        BRIEFS_API_KEY        a Google API key (Sheets API enabled)
//        BRIEFS_SHEET_RANGE    optional, default "A1:Z2000" (or a tab name)
//
//   C) SharePoint / OneDrive Excel via Microsoft Graph  (needs an Azure AD app):
//        GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, SHAREPOINT_SITE_ID,
//        EXCEL_FILE_ID, EXCEL_SHEET_NAME (default Sheet1)
//
// The sheet's first row must be headers. Recognized (case-insensitive, flexible): campaign_id, brief_url.
//
// Endpoint:
//   GET /api/graph?resource=briefs   -> { configured, ok, source, briefs:{ "<campaign_id>": "<url>" }, count, fetchedAt }

/* ---------- pure helpers (unit-tested) ---------- */
function norm(s) { return (s == null ? '' : String(s)).trim(); }
function lc(s) { return norm(s).toLowerCase(); }

// Find the index of the first header matching any alias (case-insensitive, substring-tolerant).
function findCol(headers, aliases) {
  const H = (headers || []).map(lc);
  for (const a of aliases) {
    const exact = H.indexOf(a);
    if (exact >= 0) return exact;
  }
  for (let i = 0; i < H.length; i++) { if (aliases.some((a) => H[i].includes(a))) return i; }
  return -1;
}

// Force a value into an absolute URL. A non-absolute href would be resolved against the dashboard's
// own origin and (via the SPA rewrite) just reload the dashboard — so we repair common cases here.
function absUrl(u) {
  const s = norm(u);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;          // already absolute
  if (/^\/\//.test(s)) return 'https:' + s;        // protocol-relative
  if (/^www\./i.test(s)) return 'https://' + s;    // www.example.com/...
  if (/^[a-z0-9.-]+\.[a-z]{2,}([/:?#]|$)/i.test(s)) return 'https://' + s; // host.tld/path with no scheme
  return s;                                         // can't safely fix (e.g. a server-relative path)
}

// Turn the sheet's 2D value array into { briefs:{id->url}, targets:{id->text} }.
// Row 0 is the header row. Tolerant to column order and header spelling.
function briefsFromValues(values) {
  if (!Array.isArray(values) || values.length < 2) return { briefs: {}, targets: {} };
  const headers = (values[0] || []).map(norm);
  let idCol = findCol(headers, ['campaign_id', 'campaign id', 'campaignid', 'id']);
  let urlCol = findCol(headers, ['brief_url', 'brief url', 'briefurl', 'brief', 'url', 'link']);
  const targetCol = findCol(headers, ['target', 'targets', 'goal', 'kpi', 'objective']);
  // Fall back to positional (col 0 = id, col 1 = url) if headers are unrecognized.
  if (idCol < 0) idCol = 0;
  if (urlCol < 0) urlCol = 1;
  const briefs = {}, targets = {};
  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    const id = norm(row[idCol]);
    if (!id) continue;
    const url = absUrl(row[urlCol]);
    if (url) briefs[id] = url;
    if (targetCol >= 0) { const t = norm(row[targetCol]); if (t) targets[id] = t; }
  }
  return { briefs, targets };
}

// RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, commas and newlines in cells.
function parseCSV(text) {
  const rows = []; let row = [], field = '', i = 0, inQuotes = false;
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  row.push(field); rows.push(row);
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

/* ---------- Microsoft Graph (SharePoint Excel) — only used for source C ---------- */
async function graphToken(tenant, clientId, clientSecret) {
  const body = 'client_id=' + encodeURIComponent(clientId) +
    '&client_secret=' + encodeURIComponent(clientSecret) +
    '&scope=' + encodeURIComponent('https://graph.microsoft.com/.default') +
    '&grant_type=client_credentials';
  const r = await fetch('https://login.microsoftonline.com/' + encodeURIComponent(tenant) + '/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(String(j.error_description || j.error || 'Microsoft Graph auth failed').split('\n')[0]);
  }
  return j.access_token;
}

async function graphReadSheet(token, siteId, fileId, sheetName) {
  const h = { Authorization: 'Bearer ' + token };
  const base = 'https://graph.microsoft.com/v1.0/sites/' + encodeURIComponent(siteId) +
    '/drive/items/' + encodeURIComponent(fileId) + '/workbook';
  const url = base + "/worksheets('" + encodeURIComponent(sheetName) + "')/usedRange?$select=text,values";
  const r = await fetch(url, { headers: h });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Could not read the SharePoint worksheet');
  const text = j.text, values = j.values;
  if (Array.isArray(text) && text.length) return text;
  return Array.isArray(values) ? values.map((row) => row.map((c) => (c == null ? '' : String(c)))) : [];
}

let _tokenCache = { token: null, exp: 0 };
async function cachedToken(tenant, clientId, clientSecret) {
  const now = Date.now();
  if (_tokenCache.token && now < _tokenCache.exp) return _tokenCache.token;
  const token = await graphToken(tenant, clientId, clientSecret);
  _tokenCache = { token, exp: now + 50 * 60 * 1000 };
  return token;
}

/* ---------- handler ---------- */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  // Source A — published Google Sheet CSV (no credentials)
  const csvUrl = process.env.BRIEFS_CSV_URL;
  // Source B — Google Sheets API key
  const sheetId = process.env.BRIEFS_SHEET_ID;
  const apiKey = process.env.BRIEFS_API_KEY;
  const range = process.env.BRIEFS_SHEET_RANGE || 'A1:Z2000';
  // Source C — SharePoint / OneDrive Excel via Microsoft Graph
  const ms = {
    tenant: process.env.GRAPH_TENANT_ID, clientId: process.env.GRAPH_CLIENT_ID, clientSecret: process.env.GRAPH_CLIENT_SECRET,
    siteId: process.env.SHAREPOINT_SITE_ID, fileId: process.env.EXCEL_FILE_ID, sheet: process.env.EXCEL_SHEET_NAME || 'Sheet1'
  };

  const csvConfigured = !!csvUrl;
  const googleConfigured = sheetId && apiKey;
  const msConfigured = ms.tenant && ms.clientId && ms.clientSecret && ms.siteId && ms.fileId;

  if (!csvConfigured && !googleConfigured && !msConfigured) {
    res.status(200).json({
      configured: false, ok: false,
      error: 'Set BRIEFS_CSV_URL (easiest — a published Google Sheet CSV), or BRIEFS_SHEET_ID + BRIEFS_API_KEY, or the SharePoint Graph vars, to link campaign briefs.',
      briefs: {}
    });
    return;
  }

  try {
    let values, source;

    if (csvConfigured) {
      source = 'csv';
      const r = await fetch(csvUrl);
      if (r.status >= 400) { res.status(200).json({ configured: true, ok: false, source, error: 'Could not fetch the published CSV (status ' + r.status + ').', briefs: {} }); return; }
      values = parseCSV(await r.text());
    } else if (googleConfigured) {
      source = 'google';
      const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(sheetId) +
        '/values/' + encodeURIComponent(range) + '?valueRenderOption=FORMATTED_VALUE&key=' + encodeURIComponent(apiKey);
      const r = await fetch(url);
      const j = await r.json().catch(() => ({}));
      if (r.status >= 400) { res.status(200).json({ configured: true, ok: false, source, error: (j.error && j.error.message) || 'Google Sheets error', briefs: {} }); return; }
      values = j.values || [];
    } else {
      source = 'microsoft';
      const token = await cachedToken(ms.tenant, ms.clientId, ms.clientSecret);
      values = await graphReadSheet(token, ms.siteId, ms.fileId, ms.sheet);
    }

    const { briefs, targets } = briefsFromValues(values);
    res.status(200).json({ configured: true, ok: true, source, fetchedAt: new Date().toISOString(), count: Object.keys(briefs).length, briefs, targets });
  } catch (e) {
    res.status(200).json({ configured: true, ok: false, error: String(e && e.message ? e.message : e), briefs: {}, targets: {} });
  }
};

// Exported for unit testing
module.exports._test = { norm, lc, findCol, absUrl, briefsFromValues, parseCSV };
