// api/sheets.js
// Vercel Serverless Function — secure proxy to your social-media calendar spreadsheet.
// Read-only. Secrets stay server-side; the browser only ever calls /api/sheets and gets back
// clean, normalized post rows. Manage the calendar in the spreadsheet; the dashboard mirrors it
// live (polled every ~60s). Three source options, auto-detected (Microsoft → Google → CSV):
//
//   A) Microsoft Graph (SharePoint / OneDrive Excel) — register an Azure AD app with the
//      application permission Files.Read.All (admin-consented), then set:
//        MS_TENANT_ID     your Microsoft 365 tenant ID (or domain)
//        MS_CLIENT_ID     the app registration's Application (client) ID
//        MS_CLIENT_SECRET a client secret for that app
//        MS_SHARE_URL     the file's sharing link (what you'd paste in a browser)
//        MS_SHEET_NAME    optional worksheet/tab name (default: first visible sheet)
//        (or skip MS_SHARE_URL and set MS_DRIVE_ID + MS_ITEM_ID directly)
//   B) Google Sheets API key  — share the sheet "Anyone with the link → Viewer", then set:
//        GOOGLE_SHEETS_ID        the spreadsheet ID (the long string in its URL)
//        GOOGLE_SHEETS_API_KEY   an API key from console.cloud.google.com (Sheets API enabled)
//        GOOGLE_SHEETS_RANGE     optional, default "A1:Z2000" (or a tab name like "Calendar")
//   C) Published CSV  — File → Share → Publish to web → CSV, then set:
//        GOOGLE_SHEETS_CSV_URL   the published .../pub?output=csv URL
//
// The first row must be headers. Recognized headers (case-insensitive, flexible aliases):
//   date · title/post · platform/channel · status · vertical/category · owner/assignee ·
//   caption/copy/notes · paid/type · link/url · time. Every other column is passed through
//   and shown in the post's detail view, so nothing in your sheet is lost.
//
// Endpoint:
//   GET /api/sheets   -> { configured, ok, posts:[...], headers:[...], fetchedAt }

/* ---------- pure helpers (unit-tested) ---------- */
function norm(s){ return (s == null ? '' : String(s)).trim(); }
function lc(s){ return norm(s).toLowerCase(); }

// RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, commas and newlines in cells.
function parseCSV(text){
  const rows = []; let row = [], field = '', i = 0, inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while(i < s.length){
    const c = s[i];
    if(inQuotes){
      if(c === '"'){ if(s[i+1] === '"'){ field += '"'; i += 2; continue; } inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if(c === '"'){ inQuotes = true; i++; continue; }
    if(c === ','){ row.push(field); field = ''; i++; continue; }
    if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  row.push(field); rows.push(row);
  // drop a trailing empty row
  if(rows.length && rows[rows.length-1].length === 1 && rows[rows.length-1][0] === '') rows.pop();
  return rows;
}

// Find the index of the first header matching any alias (case-insensitive, substring-tolerant).
function findCol(headers, aliases){
  const H = headers.map(lc);
  for(const a of aliases){
    const exact = H.indexOf(a);
    if(exact >= 0) return exact;
  }
  for(let i=0;i<H.length;i++){ if(aliases.some(a => H[i].includes(a))) return i; }
  return -1;
}

const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
function pad(n){ return (n<10?'0':'') + n; }

// Tolerant date parser → "YYYY-MM-DD" (or '' if unparseable). Assumes DD/MM for ambiguous
// slash dates (Indian convention) unless the first part is clearly a month (>12).
function parseDate(input){
  let s = norm(input);
  if(!s) return '';
  s = s.split(/\s+(?:at\s+)?\d{1,2}:\d{2}/)[0].trim(); // drop a trailing time
  let m;
  if((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
  if((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))){
    let a = +m[1], b = +m[2]; let y = +m[3]; if(y < 100) y += 2000;
    let day, mon;
    if(a > 12){ day = a; mon = b; } else if(b > 12){ mon = a; day = b; } else { day = a; mon = b; } // default DD/MM
    if(mon < 1 || mon > 12 || day < 1 || day > 31) return '';
    return y + '-' + pad(mon) + '-' + pad(day);
  }
  // "10 Jun 2026" / "10 June" / "10-Jun" / "Jun 10, 2026" / "June 10"
  const dM = s.match(/(\d{1,2})\s*(?:st|nd|rd|th)?[\s\-./]+([A-Za-z]{3,})/);
  const Md = s.match(/([A-Za-z]{3,})[\s\-./]+(\d{1,2})/);
  const yM = s.match(/\b(\d{4})\b/);
  if(dM && MONTHS[lc(dM[2]).slice(0,3)] != null){
    const y = yM ? +yM[1] : new Date().getFullYear();
    return y + '-' + pad(MONTHS[lc(dM[2]).slice(0,3)]+1) + '-' + pad(+dM[1]);
  }
  if(Md && MONTHS[lc(Md[1]).slice(0,3)] != null){
    const y = yM ? +yM[1] : new Date().getFullYear();
    return y + '-' + pad(MONTHS[lc(Md[1]).slice(0,3)]+1) + '-' + pad(+Md[2]);
  }
  const d = new Date(s);
  if(!isNaN(d.getTime())) return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
  return '';
}

const PLATFORM_ALIASES = {
  Instagram:['instagram','insta','ig'], Facebook:['facebook','fb','meta page'],
  LinkedIn:['linkedin','li'], YouTube:['youtube','yt'], Meta:['meta','facebook ads'], Google:['google','gads']
};
function canonPlatform(v){
  const x = lc(v); if(!x) return '';
  for(const k of Object.keys(PLATFORM_ALIASES)){ if(PLATFORM_ALIASES[k].some(a => x.includes(a))) return k; }
  return norm(v);
}

// Map an arbitrary sheet status into the board's Draft/Scheduled/Published buckets.
function mapStatus(v){
  const x = lc(v);
  if(/(publish|posted|live|done|complete|sent)/.test(x)) return 'Published';
  if(/(schedul|ready|approv|queue|planned|confirm)/.test(x)) return 'Scheduled';
  return 'Draft';
}
function isPaid(v){ const x = lc(v); return /(paid|boost|promot|ad\b|sponsor)/.test(x); }

// Find the header row — many calendars have a banner/title row above the real headers.
// The header row is the first (within the top 10) that has a "date"-like column plus at
// least one of title/post/status/platform.
function findHeaderRow(values){
  const max = Math.min(values.length, 10);
  for(let i=0;i<max;i++){
    const row = (values[i]||[]).map(norm);
    const hasDate = findCol(row, ['date','post date','publish date','scheduled date','day']) >= 0;
    const hasOther = findCol(row, ['title','post','status','platform','channel']) >= 0;
    if(hasDate && hasOther) return i;
  }
  return 0;
}

function normalizeRows(values){
  if(!Array.isArray(values) || values.length < 2) return { headers: (values && values[0]) || [], posts: [] };
  const hr = findHeaderRow(values);
  const headers = (values[hr]||[]).map(norm);
  const col = {
    date: findCol(headers, ['date','post date','publish date','scheduled date','publish','day']),
    title: findCol(headers, ['title','post title','post','topic','content title','name','idea']),
    platform: findCol(headers, ['platform','channel','network','social']),
    status: findCol(headers, ['status','stage','state']),
    vertical: findCol(headers, ['vertical','category','brand','product','pillar']),
    owner: findCol(headers, ['owner','assignee','created by','designer','responsible','by']),
    caption: findCol(headers, ['caption','copy','notes','description','content','message']),
    paid: findCol(headers, ['paid','type','promotion']),
    link: findCol(headers, ['link','url','asset','drive','creative']),
    time: findCol(headers, ['time','slot','post time'])
  };
  const at = (arr, i) => (i >= 0 && i < arr.length) ? norm(arr[i]) : '';

  const posts = [];
  for(let r = hr + 1; r < values.length; r++){
    const cells = values[r] || [];
    if(!cells.some(c => norm(c))) continue;                 // skip blank rows
    const date = parseDate(at(cells, col.date));
    const title = at(cells, col.title) || at(cells, col.caption) || '(untitled)';
    // pass-through of every column, so the detail view can show the full row
    const raw = {};
    headers.forEach((h, i) => { if(h) raw[h] = at(cells, i); });
    const rawStatus = at(cells, col.status);
    posts.push({
      id: 'sheet-' + r,
      row: r + 1,
      title,
      date,
      time: at(cells, col.time),
      platform: canonPlatform(at(cells, col.platform)),
      status: mapStatus(rawStatus),
      rawStatus: rawStatus || '',
      vertical: at(cells, col.vertical) || '',
      owner: at(cells, col.owner) || '',
      caption: at(cells, col.caption) || '',
      paid: isPaid(at(cells, col.paid)),
      link: at(cells, col.link) || '',
      raw
    });
  }
  return { headers, posts };
}

async function fetchJSON(url){ const r = await fetch(url); return { status: r.status, body: await r.json().catch(()=>({})) }; }

/* ---------- Microsoft Graph (SharePoint / OneDrive Excel) ---------- */
// Encode a sharing URL into a Graph share ID (the documented "u!" base64url scheme).
function encodeShareId(url){
  const b64 = Buffer.from(url, 'utf8').toString('base64');
  return 'u!' + b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

async function graphToken(tenant, clientId, clientSecret){
  const body = 'client_id=' + encodeURIComponent(clientId) +
    '&client_secret=' + encodeURIComponent(clientSecret) +
    '&scope=' + encodeURIComponent('https://graph.microsoft.com/.default') +
    '&grant_type=client_credentials';
  const r = await fetch('https://login.microsoftonline.com/' + encodeURIComponent(tenant) + '/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok || !j.access_token){
    throw new Error(String(j.error_description || j.error || 'Microsoft Graph auth failed').split('\n')[0]);
  }
  return j.access_token;
}

// Resolve { driveId, itemId } from either explicit ids or a sharing URL.
async function graphResolveItem(token, cfg){
  const h = { Authorization: 'Bearer ' + token };
  if(cfg.driveId && cfg.itemId) return { driveId: cfg.driveId, itemId: cfg.itemId };
  const r = await fetch('https://graph.microsoft.com/v1.0/shares/' + encodeShareId(cfg.shareUrl) + '/driveItem?$select=id,parentReference', { headers: h });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error((j.error && j.error.message) || 'Could not resolve the shared file');
  return { driveId: j.parentReference && j.parentReference.driveId, itemId: j.id };
}

// Read a worksheet's used range as a 2D array of display strings (handles dates as shown).
async function graphReadValues(token, driveId, itemId, sheetName){
  const h = { Authorization: 'Bearer ' + token };
  const base = 'https://graph.microsoft.com/v1.0/drives/' + driveId + '/items/' + itemId + '/workbook';
  let name = sheetName;
  if(!name){
    const wr = await fetch(base + '/worksheets?$select=name,position,visibility', { headers: h });
    const wj = await wr.json().catch(() => ({}));
    if(!wr.ok) throw new Error((wj.error && wj.error.message) || 'Could not list worksheets');
    const sheets = (wj.value || []).filter(s => (s.visibility || 'Visible') === 'Visible').sort((a,b) => a.position - b.position);
    if(!sheets.length) throw new Error('Workbook has no visible worksheets');
    name = sheets[0].name;
  }
  const ur = await fetch(base + "/worksheets('" + encodeURIComponent(name) + "')/usedRange?$select=text,values", { headers: h });
  const uj = await ur.json().catch(() => ({}));
  if(!ur.ok) throw new Error((uj.error && uj.error.message) || 'Could not read the worksheet');
  // Prefer formatted text (dates show as displayed); fall back to raw values.
  const text = uj.text, values = uj.values;
  if(Array.isArray(text) && text.length) return { values: text, sheet: name };
  return { values: Array.isArray(values) ? values.map(row => row.map(c => c == null ? '' : String(c))) : [], sheet: name };
}

/* ---------- handler ---------- */
module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  // Microsoft Graph (SharePoint / OneDrive Excel)
  const ms = {
    tenant: process.env.MS_TENANT_ID, clientId: process.env.MS_CLIENT_ID, clientSecret: process.env.MS_CLIENT_SECRET,
    shareUrl: process.env.MS_SHARE_URL, driveId: process.env.MS_DRIVE_ID, itemId: process.env.MS_ITEM_ID, sheet: process.env.MS_SHEET_NAME
  };
  const msConfigured = ms.tenant && ms.clientId && ms.clientSecret && (ms.shareUrl || (ms.driveId && ms.itemId));

  // Google Sheets (API key or published CSV)
  const csvUrl = process.env.GOOGLE_SHEETS_CSV_URL;
  const sheetId = process.env.GOOGLE_SHEETS_ID;
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  const range = process.env.GOOGLE_SHEETS_RANGE || 'A1:Z2000';
  const googleConfigured = csvUrl || (sheetId && apiKey);

  if(!msConfigured && !googleConfigured){
    res.status(200).json({
      configured: false, ok: false,
      error: 'Set Microsoft Graph (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_SHARE_URL) for a SharePoint/OneDrive Excel file, or Google Sheets (GOOGLE_SHEETS_ID + GOOGLE_SHEETS_API_KEY, or GOOGLE_SHEETS_CSV_URL), in Vercel environment variables.',
      posts: []
    });
    return;
  }

  try {
    let values, source, sheetUsed = null;

    if(msConfigured){
      source = 'microsoft';
      const token = await graphToken(ms.tenant, ms.clientId, ms.clientSecret);
      const { driveId, itemId } = await graphResolveItem(token, ms);
      if(!driveId || !itemId) throw new Error('Resolved the share but could not get the drive/item id.');
      const out = await graphReadValues(token, driveId, itemId, ms.sheet);
      values = out.values; sheetUsed = out.sheet;
    } else if(sheetId && apiKey){
      source = 'google';
      const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(sheetId) +
        '/values/' + encodeURIComponent(range) + '?valueRenderOption=FORMATTED_VALUE&key=' + encodeURIComponent(apiKey);
      const { status, body } = await fetchJSON(url);
      if(status >= 400){
        res.status(200).json({ configured: true, ok: false, source, status, error: (body && body.error && body.error.message) || 'Google Sheets error', posts: [] });
        return;
      }
      values = body.values || [];
    } else {
      source = 'csv';
      const r = await fetch(csvUrl);
      if(r.status >= 400){ res.status(200).json({ configured: true, ok: false, source, status: r.status, error: 'Could not fetch the published CSV (status ' + r.status + ').', posts: [] }); return; }
      values = parseCSV(await r.text());
    }

    const { headers, posts } = normalizeRows(values);
    res.status(200).json({ configured: true, ok: true, source, sheet: sheetUsed, fetchedAt: new Date().toISOString(), count: posts.length, headers, posts });
  } catch(e){
    res.status(200).json({ configured: true, ok: false, source: msConfigured ? 'microsoft' : (sheetId ? 'google' : 'csv'), error: String(e && e.message ? e.message : e), posts: [] });
  }
};

// Exported for unit testing
module.exports._test = { parseCSV, findCol, parseDate, canonPlatform, mapStatus, isPaid, normalizeRows, encodeShareId };
