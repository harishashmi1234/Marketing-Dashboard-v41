// api/jira.js
// Vercel Serverless Function — secure proxy to the Jira Cloud REST API (v3).
//
// The API token is read from server-side environment variables and is NEVER sent to
// the browser. The Design board only ever calls /api/jira and receives clean task
// objects back. This integration is READ-ONLY — it never creates, edits, or transitions
// issues. Manage tasks in Jira; the dashboard mirrors them within ~2 minutes.
//
// Configure in Vercel → Project → Settings → Environment Variables:
//   JIRA_BASE_URL     your site, e.g. https://getsetlearninfo.atlassian.net
//   JIRA_EMAIL        the Atlassian account email that owns the API token
//   JIRA_API_TOKEN    an API token from https://id.atlassian.com/manage-profile/security/api-tokens
//   JIRA_PROJECT_KEY  optional, default "DES" (the Design project)
//   JIRA_JQL          optional, full JQL override (takes precedence over JIRA_PROJECT_KEY)
//
// Endpoints:
//   GET /api/jira?resource=tasks    -> normalized task list for the Design board
//   GET /api/jira?resource=whoami   -> verifies auth, returns the token owner's account

const API = '/rest/api/3';

/* ---------- pure helpers (unit-tested) ---------- */
// Jira statuses are arbitrary per project, so map by the stable statusCategory key
// (new / indeterminate / done) and let an explicit "blocked" name win.
function mapStatus(status) {
  const name = ((status && status.name) || '').toLowerCase();
  const cat = ((status && status.statusCategory && status.statusCategory.key) || '').toLowerCase();
  if (name.includes('block')) return 'Blocked';
  if (cat === 'done') return 'Done';
  if (cat === 'indeterminate') return 'In Progress';
  if (cat === 'new') return 'To Do';
  if (name.includes('progress') || name.includes('review') || name.includes('doing')) return 'In Progress';
  if (name.includes('done') || name.includes('complete') || name.includes('closed') || name.includes('resolved')) return 'Done';
  return 'To Do';
}

// Board priorities are High / Medium / Low; Jira adds Highest/Lowest/etc.
function mapPriority(priority) {
  const n = ((priority && priority.name) || '').toLowerCase();
  if (n.includes('high') || n.includes('critical') || n.includes('urgent') || n.includes('blocker')) return 'High';
  if (n.includes('low') || n.includes('minor') || n.includes('trivial')) return 'Low';
  return 'Medium';
}

// Tag each issue to a dashboard vertical from its summary (same buckets as the Meta proxy).
function classifyVertical(name) {
  const n = (name || '').toLowerCase();
  // VEX / robotics always STEM — even when the name also says "GSL".
  if (n.includes('vex') || n.includes('robot')) return 'STEM';
  if (n.includes('hbi') || n.includes('harvard business')) return 'HBI';
  // GSL vertical: Future Skills, DAU and TMA programs.
  if (n.includes('future skill') || n.includes('futureskill') || /\bdau\b/.test(n) || /\btma\b/.test(n) || /\bgsl\b/.test(n)) return 'GSL';
  if (n.includes('young pioneer') || n.includes('ypl') || /\byp\b/.test(n)) return 'YP';
  if (n.includes('bootcamp') || n.includes('drone') || n.includes('imaginex') || n.includes('videogenx') || n.includes('vibecodex') || n.includes('studyx')) return 'Bootcamps';
  if (n.includes('aiq') || n.includes('filmmaking') || /\bai\b/.test(n)) return 'AI';
  if (n.includes('instagram') || n.includes('reel') || n.includes('carousel') || n.includes('social') || /\big\b/.test(n)) return 'Social';
  return 'STEM';
}

function normalizeIssue(issue, baseUrl) {
  const f = issue.fields || {};
  return {
    id: issue.key,                       // human key (DES-35) — also the stable board id
    key: issue.key,
    task: f.summary || '(untitled)',
    status: mapStatus(f.status),
    rawStatus: (f.status && f.status.name) || '',
    owner: (f.assignee && f.assignee.displayName) || 'Unassigned',
    due: f.duedate || '',
    priority: mapPriority(f.priority),
    rawPriority: (f.priority && f.priority.name) || '',
    vertical: classifyVertical(f.summary),
    issuetype: (f.issuetype && f.issuetype.name) || '',
    updated: f.updated || '',
    url: (baseUrl ? baseUrl.replace(/\/+$/, '') : '') + '/browse/' + issue.key
  };
}

function buildJql() {
  const custom = process.env.JIRA_JQL;
  if (custom && custom.trim()) return custom.trim();
  const key = (process.env.JIRA_PROJECT_KEY || 'DES').trim();
  return 'project = "' + key + '" ORDER BY created DESC';
}

/* ---------- handler ---------- */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=240');

  const baseUrl = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const q = req.query || {};
  const resource = (q.resource || 'tasks').toString();

  if (!baseUrl || !email || !token) {
    res.status(200).json({
      configured: false, ok: false,
      error: 'Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in Vercel environment variables.',
      tasks: []
    });
    return;
  }

  const auth = 'Basic ' + Buffer.from(email + ':' + token).toString('base64');
  const headers = { Authorization: auth, Accept: 'application/json' };

  try {
    if (resource === 'whoami') {
      const r = await fetch(baseUrl + API + '/myself', { headers });
      const body = await r.json().catch(() => ({}));
      if (r.status >= 400) { res.status(200).json({ configured: true, ok: false, status: r.status, error: (body && body.message) || 'Jira auth failed' }); return; }
      res.status(200).json({ configured: true, ok: true, account: { displayName: body.displayName, email: body.emailAddress, accountId: body.accountId } });
      return;
    }

    // default: tasks — page through the enhanced search endpoint (token-based pagination).
    const jql = buildJql();
    const fields = 'summary,status,assignee,duedate,priority,issuetype,updated';
    const issues = [];
    let nextPageToken = '';
    for (let page = 0; page < 5; page++) {                 // hard cap: 5 pages (500 issues)
      const url = baseUrl + API + '/search/jql?jql=' + encodeURIComponent(jql) +
        '&fields=' + encodeURIComponent(fields) + '&maxResults=100' +
        (nextPageToken ? '&nextPageToken=' + encodeURIComponent(nextPageToken) : '');
      const r = await fetch(url, { headers });
      const body = await r.json().catch(() => ({}));
      if (r.status >= 400) {
        const msg = (body && (body.errorMessages && body.errorMessages[0])) || (body && body.message) || ('Jira error (status ' + r.status + ')');
        res.status(200).json({ configured: true, ok: false, status: r.status, error: msg, tasks: [] });
        return;
      }
      (body.issues || []).forEach((it) => issues.push(normalizeIssue(it, baseUrl)));
      nextPageToken = body.nextPageToken || '';
      if (!nextPageToken || body.isLast) break;
    }

    res.status(200).json({
      configured: true, ok: true,
      project: process.env.JIRA_PROJECT_KEY || (process.env.JIRA_JQL ? 'custom' : 'DES'),
      site: baseUrl,
      fetchedAt: new Date().toISOString(),
      tasks: issues
    });
  } catch (e) {
    res.status(200).json({ configured: true, ok: false, error: String(e && e.message ? e.message : e), tasks: [] });
  }
};

// Exported for unit testing
module.exports._test = { mapStatus, mapPriority, classifyVertical, normalizeIssue, buildJql };
