// api/leads.js
// Vercel Serverless Function — best-effort proxy to Meta Lead Ads "individual lead records".
//
// This is a NEW, self-contained endpoint for the Leads tab. The Leads tab's METRICS (counts, CPL,
// trends, by campaign/program) come live from /api/meta and need no extra permission. THIS endpoint
// adds the actual lead-form submissions (name / email / phone per lead), which Meta gates behind the
// `leads_retrieval` + `pages_manage_ads` permissions + a Page access token where you're an admin. It degrades gracefully:
// if that isn't available, it returns { available:false, reason } and the tab still shows all metrics.
//
// Env vars (reuses the existing Meta/Facebook ones — nothing new required):
//   META_ACCESS_TOKEN   the system-user token (also used by /api/meta, /api/facebook)
//   FB_PAGE_ID          optional — the Page whose lead forms to read (else first Page on the token)
//   FB_PAGE_TOKEN       optional — a long-lived Page token (else fetched from /me/accounts)
//
// Endpoint:
//   GET /api/leads   -> { configured, available, count, leads:[{ name,email,phone,campaign,form,createdTime,fields }], forms, reason }

const GRAPH_VERSION = 'v21.0';
const GRAPH = 'https://graph.facebook.com/' + GRAPH_VERSION;

function norm(s) { return (s == null ? '' : String(s)).trim(); }
async function fetchJSON(url) { const r = await fetch(url); return r.json().catch(() => ({})); }

/* ---------- Leads sheet source (CSV / Google Sheet) — needs NO Meta lead permission ---------- */
// RFC-4180-ish CSV parser (quoted fields, escaped quotes, commas/newlines in cells).
function parseCSV(text) {
  const rows = []; let row = [], field = '', i = 0, inQuotes = false;
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) { if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQuotes = false; i++; continue; } field += c; i++; continue; }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  row.push(field); rows.push(row);
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}
function findCol(H, aliases) {
  for (const a of aliases) { const i = H.indexOf(a); if (i >= 0) return i; }
  for (let i = 0; i < H.length; i++) { if (aliases.some((a) => H[i].includes(a))) return i; }
  return -1;
}
// Turn a 2D sheet (row 0 = headers) into lead records. Every column becomes a field; the date and
// campaign columns are recognized for the "Received" + "Campaign" columns and aren't duplicated.
function leadsFromValues(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const headers = (values[0] || []).map((h) => norm(h));
  const H = headers.map((h) => h.toLowerCase());
  const dateCol = findCol(H, ['date of lead capture', 'date', 'created', 'timestamp', 'captured', 'received']);
  const nameCol = findCol(H, ['full name', 'name']);
  const emailCol = findCol(H, ['email', 'e-mail']);
  const phoneCol = findCol(H, ['contact', 'phone', 'mobile', 'number']);
  const campCol = findCol(H, ['campaign']);
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r] || [];
    if (!row.some((c) => norm(c))) continue;
    const at = (i) => (i >= 0 && i < row.length) ? norm(row[i]) : '';
    const fields = [];
    headers.forEach((h, i) => { if (i === dateCol || i === campCol || !h) return; fields.push({ key: h, label: h, value: at(i) }); });
    out.push({ id: 'csv-' + r, name: at(nameCol), email: at(emailCol), phone: at(phoneCol), city: '', campaign: at(campCol), form: '', createdTime: at(dateCol), fields });
  }
  out.sort((a, b) => (new Date(b.createdTime) - new Date(a.createdTime)) || 0);
  return out;
}

// Resolve a Page id + Page access token. Tries, in order: explicit FB_PAGE_TOKEN+FB_PAGE_ID;
// minting a Page token directly from FB_PAGE_ID (works for System-User tokens, where /me/accounts
// is often empty); then enumerating /me/accounts.
async function resolvePage(userToken, wantId, presetToken) {
  if (presetToken && wantId) return { id: wantId, token: presetToken, name: '', via: 'env_page_token' };

  if (wantId) {
    // Ask the Page for its own access_token using the user/system token (needs a Page role + page scopes).
    const p = await fetchJSON(GRAPH + '/' + encodeURIComponent(wantId) + '?fields=id,name,access_token&access_token=' + encodeURIComponent(userToken));
    if (!p.error && p.access_token) return { id: p.id || wantId, token: p.access_token, name: p.name || '', via: 'minted_from_page_id' };
    if (!p.error && presetToken) return { id: wantId, token: presetToken, name: p.name || '', via: 'env_page_token' };
  }

  const data = await fetchJSON(GRAPH + '/me/accounts?fields=id,name,access_token&limit=100&access_token=' + encodeURIComponent(userToken));
  if (data.error) throw new Error(data.error.message);
  const pages = data.data || [];
  if (!pages.length) return null;
  const chosen = (wantId && pages.find((p) => String(p.id) === String(wantId))) || pages[0];
  return { id: chosen.id, token: presetToken || chosen.access_token, name: chosen.name || '', via: presetToken ? 'env_page_token' : 'me_accounts' };
}

// Return the scopes granted on a token (via debug_token) — used by ?debug=1 to see if leads_retrieval is present.
async function tokenScopes(inputToken, appToken) {
  try {
    const d = await fetchJSON(GRAPH + '/debug_token?input_token=' + encodeURIComponent(inputToken) + '&access_token=' + encodeURIComponent(appToken));
    const scopes = (d && d.data && d.data.scopes) || [];
    return { scopes, hasLeadsRetrieval: scopes.indexOf('leads_retrieval') >= 0, type: (d && d.data && d.data.type) || '' };
  } catch (e) { return { scopes: [], hasLeadsRetrieval: false, type: '', error: String(e) }; }
}

// Prettify a raw field key into a readable label when the form doesn't give one.
function prettyKey(k) {
  return String(k || '').replace(/[_?]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
}

// Flatten Lead Ads field_data into an ORDERED [{key,label,value}] list (every custom question is kept),
// plus friendly name/email/phone for the summary columns. labelMap maps a form's field key -> question label.
function normalizeLead(l, formName, labelMap) {
  const o = {};
  const fields = [];
  (l.field_data || []).forEach((f) => {
    const key = f.name || '';
    const value = (f.values && f.values.join(', ')) || '';
    o[key.toLowerCase()] = value;
    const label = (labelMap && (labelMap[key] || labelMap[key.toLowerCase()])) || prettyKey(key);
    fields.push({ key, label, value });
  });
  const name = o['full_name'] || [o['first_name'], o['last_name']].filter(Boolean).join(' ') || o['name'] || '';
  return {
    id: l.id || '',
    name: name,
    email: o['email'] || '',
    phone: o['phone_number'] || o['phone'] || o['work_phone_number'] || '',
    city: o['city'] || o['town'] || '',
    campaign: l.campaign_name || '',
    adName: l.ad_name || '',
    form: formName || '',
    createdTime: l.created_time || '',
    fields: fields
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  const token = process.env.META_ACCESS_TOKEN;
  const pageId = process.env.FB_PAGE_ID;
  const pageToken = process.env.FB_PAGE_TOKEN;
  const q = req.query || {};
  const debug = String(q.debug || '') === '1' || String(q.debug || '') === 'true';

  // ── Source 1 (preferred when set): a leads sheet — needs NO Meta lead permission at all. ──
  const leadsCsvUrl = process.env.LEADS_CSV_URL;
  const leadsSheetId = process.env.LEADS_SHEET_ID;
  const leadsApiKey = process.env.LEADS_API_KEY;
  const leadsRange = process.env.LEADS_SHEET_RANGE || 'A1:Z5000';
  if (leadsCsvUrl || (leadsSheetId && leadsApiKey)) {
    try {
      let values;
      if (leadsCsvUrl) {
        const r = await fetch(leadsCsvUrl);
        if (r.status >= 400) { res.status(200).json({ configured: true, available: false, source: 'sheet', reason: 'Could not fetch LEADS_CSV_URL (status ' + r.status + '). Use a Google Sheet "Publish to web → CSV" link.', leads: [], forms: [] }); return; }
        values = parseCSV(await r.text());
      } else {
        const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(leadsSheetId) + '/values/' + encodeURIComponent(leadsRange) + '?valueRenderOption=FORMATTED_VALUE&key=' + encodeURIComponent(leadsApiKey);
        const j = await fetchJSON(url);
        if (j.error) { res.status(200).json({ configured: true, available: false, source: 'sheet', reason: (j.error && j.error.message) || 'Google Sheets error', leads: [], forms: [] }); return; }
        values = j.values || [];
      }
      const leads = leadsFromValues(values);
      res.status(200).json({ configured: true, available: true, source: 'sheet', fetchedAt: new Date().toISOString(), count: leads.length, leads: leads.slice(0, 1000), forms: [] });
      return;
    } catch (e) { res.status(200).json({ configured: true, available: false, source: 'sheet', reason: String(e && e.message ? e.message : e), leads: [], forms: [] }); return; }
  }

  if (!token) {
    res.status(200).json({ configured: false, available: false, error: 'Set LEADS_CSV_URL (a leads Google Sheet) — or META_ACCESS_TOKEN with Lead-Ad permissions.', leads: [], forms: [] });
    return;
  }

  try {
    const page = await resolvePage(token, pageId, pageToken);

    // Diagnostics: GET /api/leads?debug=1 shows how the Page resolved + the token's actual scopes.
    if (debug) {
      const diag = { hasPageIdEnv: !!pageId, hasPageTokenEnv: !!pageToken, page: page ? { id: page.id, name: page.name, via: page.via } : null };
      if (page) {
        diag.tokenScopes = await tokenScopes(page.token, token);
        const fd = await fetchJSON(GRAPH + '/' + encodeURIComponent(page.id) + '/leadgen_forms?fields=id,name,leads_count&limit=25&access_token=' + encodeURIComponent(page.token));
        diag.leadgenFormsError = fd.error ? fd.error : null;
        diag.forms = (fd.data || []).map((f) => ({ id: f.id, name: f.name, count: f.leads_count || 0 }));
      } else {
        diag.userTokenScopes = await tokenScopes(token, token);
      }
      res.status(200).json({ configured: true, debug: diag });
      return;
    }

    if (!page) {
      const hint = pageId
        ? 'Could not get a Page token for FB_PAGE_ID=' + pageId + '. Make sure your account is an admin of that Page and META_ACCESS_TOKEN includes pages_show_list + pages_read_engagement + leads_retrieval (or set FB_PAGE_TOKEN to a Page token directly).'
        : 'No Facebook Page on this token. Set FB_PAGE_ID to the GSL Page ID and regenerate META_ACCESS_TOKEN with pages_show_list + pages_read_engagement + leads_retrieval (you must be a Page admin), or set FB_PAGE_TOKEN.';
      res.status(200).json({ configured: true, available: false, reason: hint, leads: [], forms: [] });
      return;
    }

    // List the Page's lead-gen forms (including their questions so we can show real field labels).
    const formsData = await fetchJSON(GRAPH + '/' + encodeURIComponent(page.id) + '/leadgen_forms?fields=id,name,status,leads_count,questions&limit=100&access_token=' + encodeURIComponent(page.token));
    if (formsData.error) {
      const m = formsData.error.message || 'Could not list lead forms';
      const perm = /permission|leads_retrieval|\(#10\)|\(#200\)/i.test(m);
      res.status(200).json({ configured: true, available: false,
        reason: 'Meta: ' + m + (perm ? ' — regenerate the token adding the permission Meta names above (lead forms need pages_manage_ads + leads_retrieval; keep ads_read, pages_show_list, pages_read_engagement), and ensure you have Ads/Leads access on the Page. /api/leads?debug=1 shows current scopes.' : ''),
        leads: [], forms: [] });
      return;
    }
    const forms = (formsData.data || []);
    if (!forms.length) {
      res.status(200).json({ configured: true, available: true, count: 0, leads: [], forms: [], reason: 'No Lead Ad forms found on this Page yet.' });
      return;
    }

    // Pull recent leads from the most relevant forms (cap the number of forms to stay within time).
    const pickForms = forms.slice(0, 12);
    const all = [];
    let firstErr = null;
    for (const f of pickForms) {
      // Map this form's field keys -> human question labels (e.g. "Which city is your school based in?").
      const labelMap = {};
      (f.questions || []).forEach((qn) => { if (qn && qn.key) labelMap[qn.key] = qn.label || qn.name || qn.key; });
      const ld = await fetchJSON(GRAPH + '/' + encodeURIComponent(f.id) + '/leads?fields=' +
        encodeURIComponent('created_time,campaign_name,ad_name,field_data') + '&limit=200&access_token=' + encodeURIComponent(page.token));
      if (ld.error) { if (!firstErr) firstErr = ld.error.message; continue; }
      for (const l of (ld.data || [])) all.push(normalizeLead(l, f.name, labelMap));
    }

    if (!all.length && firstErr) {
      const perm = /permission|leads_retrieval|\(#10\)|\(#200\)/i.test(firstErr);
      res.status(200).json({ configured: true, available: false,
        reason: 'Meta: ' + firstErr + (perm ? ' — the token needs pages_manage_ads + leads_retrieval (and Leads access on the Page). /api/leads?debug=1 shows current scopes.' : ''),
        leads: [], forms: forms.map((f) => ({ name: f.name, count: f.leads_count || 0 })) });
      return;
    }

    all.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
    res.status(200).json({
      configured: true, available: true, fetchedAt: new Date().toISOString(),
      count: all.length, leads: all.slice(0, 200),
      forms: forms.map((f) => ({ name: f.name, status: f.status || '', count: f.leads_count || 0 }))
    });
  } catch (e) {
    res.status(200).json({ configured: true, available: false, reason: String(e && e.message ? e.message : e), leads: [], forms: [] });
  }
};

module.exports._test = { norm, normalizeLead, parseCSV, leadsFromValues };
