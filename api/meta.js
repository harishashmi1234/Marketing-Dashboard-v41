// api/meta.js
// Vercel Serverless Function — secure proxy to the Meta Marketing (Graph) API.
//
// The access token is read from a server-side environment variable and is NEVER
// sent to the browser. The frontend only ever calls /api/meta and receives clean
// numbers back. Configure these in Vercel → Project → Settings → Environment Variables:
//   META_ACCESS_TOKEN     (a long-lived token with ads_read permission)
//   META_AD_ACCOUNT_ID    (numeric, e.g. 556917763746521 — with or without the act_ prefix)
//
// Endpoints:
//   GET /api/meta?resource=campaigns&date_preset=last_30d
//   GET /api/meta?resource=trend&date_preset=last_30d
//   GET /api/meta?resource=account&date_preset=last_30d

const GRAPH_VERSION = 'v21.0';
const GRAPH = 'https://graph.facebook.com/' + GRAPH_VERSION;

/* ---------- pure helpers (unit-tested) ---------- */
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }

function extractAction(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) {
    const a = actions.find((x) => x && x.action_type === t);
    if (a) return num(a.value);
  }
  return 0;
}

function classifyVertical(name) {
  const n = (name || '').toLowerCase();
  // VEX / robotics always belongs to STEM — even when the name also says "GSL"
  // (e.g. "GSL VEX website visits"). Keep this check before the GSL bucket.
  if (n.includes('vex') || n.includes('robot')) return 'STEM';
  if (n.includes('hbi')) return 'HBI';
  // GSL vertical: Future Skills campaigns plus the DAU and TMA programs.
  if (n.includes('future skill') || n.includes('futureskill') || /\bdau\b/.test(n) || /\btma\b/.test(n) || /\bgsl\b/.test(n)) return 'GSL';
  if (n.includes('young pioneer') || n.includes('ypl') || /\byp\b/.test(n)) return 'YP';
  if (n.includes('bootcamp') || n.includes('imaginex') || n.includes('videogenx') || n.includes('vibecodex') || n.includes('dronex') || n.includes('studyx')) return 'Bootcamps';
  if (n.includes('filmmaking') || n.includes('aiq') || /\bai\b/.test(n)) return 'AI';
  if (n.includes('instagram post') || n.includes('boost') || n.includes('reel') || n.includes('engagement') || n.includes('follower')) return 'Social';
  return 'STEM';
}

// All live data comes from Meta Ads; detect Google/LinkedIn only if the campaign name says so.
function classifyPlatform(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('google') || n.includes('gads') || /\bsem\b/.test(n) || n.includes('search ads')) return 'Google Ads';
  if (n.includes('linkedin')) return 'LinkedIn';
  return 'Meta';
}

// Normalize every campaign to one of five standard marketing goals so the Performance tab
// can categorize and filter consistently: Followers, Engagement, Leads, Traffic, Awareness.
function campaignGoal(objective, vertical, name) {
  const o = (objective || '').toUpperCase();
  const n = (name || '').toLowerCase();
  // Follower-growth campaigns (page likes / explicit "followers" in the name)
  if (n.includes('follower') || o.includes('PAGE_LIKES') || o.includes('LIKE_PAGE')) return 'Followers';
  // Social boosts / post engagement (also catches Instagram-post boosts → Social Boost category)
  if (vertical === 'Social' || o.includes('ENGAGEMENT') || o.includes('POST_ENGAGEMENT') ||
      o.includes('VIDEO') || /\bboost\b|engagement|reel|\bpost\b/.test(n)) return 'Engagement';
  // Lead generation and conversions/sales both report against the Leads goal here
  if (o.includes('LEAD') || o.includes('SALES') || o.includes('CONVERSION')) return 'Leads';
  // Brand awareness / reach
  if (o.includes('AWARENESS') || o.includes('REACH') || o.includes('BRAND')) return 'Awareness';
  // Traffic / link clicks / app installs
  if (o.includes('TRAFFIC') || o.includes('LINK_CLICK') || o.includes('APP')) return 'Traffic';
  return 'Traffic';
}

// The fixed goal vocabulary, exported so the frontend filter can show exactly these.
const GOAL_OPTIONS = ['Followers', 'Engagement', 'Leads', 'Traffic', 'Awareness'];

const STATUS_MAP = {
  ACTIVE: 'Active', PAUSED: 'Paused', CAMPAIGN_PAUSED: 'Paused', ADSET_PAUSED: 'Paused',
  ARCHIVED: 'Completed', DELETED: 'Completed', IN_PROCESS: 'Pending', WITH_ISSUES: 'Pending',
  PENDING_REVIEW: 'Pending', DISAPPROVED: 'Blocked'
};
function mapStatus(s) { return STATUS_MAP[s] || (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : 'Paused'); }

function normalizeCampaign(c) {
  const ins = (c.insights && c.insights.data && c.insights.data[0]) || {};
  const actions = ins.actions || [];
  const leads = extractAction(actions, ['lead', 'leadgen.other', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']);
  const linkClicks = extractAction(actions, ['link_click']);
  const lpv = extractAction(actions, ['landing_page_view', 'omni_landing_page_view']);
  const purchases = extractAction(actions, ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase']);
  const pageEng = extractAction(actions, ['page_engagement', 'post_engagement']);
  const roasArr = ins.purchase_roas || [];
  const roas = roasArr.length ? num(roasArr[0].value) : 0;
  const spend = num(ins.spend);
  // Budget fields are returned in the currency minor unit (paise for INR) -> /100 for rupees.
  const dailyBudget = c.daily_budget ? num(c.daily_budget) / 100 : 0;
  const lifetimeBudget = c.lifetime_budget ? num(c.lifetime_budget) / 100 : 0;
  return {
    id: c.id,
    name: c.name,
    objective: c.objective || '',
    goal: campaignGoal(c.objective, classifyVertical(c.name), c.name),
    platform: classifyPlatform(c.name),
    status: mapStatus(c.effective_status || c.status),
    rawStatus: c.effective_status || c.status || '',
    vertical: classifyVertical(c.name),
    // ISO timestamps from Meta; '' when the campaign has no scheduled start/end.
    startTime: c.start_time || '',
    stopTime: c.stop_time || '',
    spend,
    impressions: num(ins.impressions),
    reach: num(ins.reach),
    clicks: num(ins.clicks),
    cpc: num(ins.cpc),
    cpm: num(ins.cpm),
    ctr: num(ins.ctr),
    frequency: num(ins.frequency),
    leads,
    linkClicks,
    landingPageViews: lpv,
    purchases,
    pageEngagement: pageEng,
    roas,
    cpl: leads ? spend / leads : 0,
    dailyBudget,
    lifetimeBudget
  };
}

function shortLabel(dateStr) {
  // "2026-06-05" -> "5 Jun"
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.getDate() + ' ' + d.toLocaleString('en', { month: 'short' });
  } catch (e) { return dateStr; }
}

function normalizeTrend(rows) {
  return (rows || []).map((r) => {
    const leads = extractAction(r.actions, ['lead', 'leadgen.other', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']);
    return {
      date: r.date_start,
      label: shortLabel(r.date_start),
      spend: num(r.spend),
      impressions: num(r.impressions),
      clicks: num(r.clicks),
      reach: num(r.reach),
      leads,
      cpl: leads ? num(r.spend) / leads : 0
    };
  });
}

/* ---------- handler ---------- */
async function fetchJSON(url) {
  const r = await fetch(url);
  const j = await r.json();
  return j;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  const token = process.env.META_ACCESS_TOKEN;
  const accountRaw = process.env.META_AD_ACCOUNT_ID;
  const q = (req.query) || {};
  const resource = (q.resource || 'campaigns').toString();
  const datePreset = (q.date_preset || 'last_30d').toString();

  if (!token || !accountRaw) {
    res.status(200).json({
      configured: false, ok: false,
      error: 'Set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in Vercel environment variables.',
      campaigns: [], trend: []
    });
    return;
  }
  const acct = accountRaw.toString().replace(/^act_/, '');

  try {
    if (resource === 'trend') {
      const fields = 'spend,impressions,clicks,reach,actions';
      const url = GRAPH + '/act_' + acct + '/insights?fields=' + fields +
        '&time_increment=1&date_preset=' + encodeURIComponent(datePreset) +
        '&limit=500&access_token=' + encodeURIComponent(token);
      const data = await fetchJSON(url);
      if (data.error) { res.status(200).json({ configured: true, ok: false, error: data.error.message, trend: [] }); return; }
      res.status(200).json({ configured: true, ok: true, account: acct, datePreset, fetchedAt: new Date().toISOString(), trend: normalizeTrend(data.data) });
      return;
    }

    if (resource === 'account') {
      const fields = 'spend,impressions,reach,clicks,cpc,cpm,ctr,frequency,actions,purchase_roas';
      const url = GRAPH + '/act_' + acct + '/insights?fields=' + fields +
        '&date_preset=' + encodeURIComponent(datePreset) + '&access_token=' + encodeURIComponent(token);
      const data = await fetchJSON(url);
      if (data.error) { res.status(200).json({ configured: true, ok: false, error: data.error.message }); return; }
      const row = (data.data && data.data[0]) || {};
      const actions = row.actions || [];
      res.status(200).json({
        configured: true, ok: true, account: acct, datePreset, fetchedAt: new Date().toISOString(),
        totals: {
          spend: num(row.spend), impressions: num(row.impressions), reach: num(row.reach),
          clicks: num(row.clicks), cpc: num(row.cpc), cpm: num(row.cpm), ctr: num(row.ctr),
          leads: extractAction(actions, ['lead', 'leadgen.other', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']),
          linkClicks: extractAction(actions, ['link_click'])
        }
      });
      return;
    }

    // default: campaigns (with nested insights, one round-trip)
    const insightsBlock = 'insights.date_preset(' + datePreset + '){spend,impressions,reach,clicks,cpc,cpm,ctr,frequency,actions,action_values,purchase_roas}';
    const fields = ['name', 'objective', 'status', 'effective_status', 'start_time', 'stop_time', 'daily_budget', 'lifetime_budget', insightsBlock].join(',');
    const url = GRAPH + '/act_' + acct + '/campaigns?fields=' + encodeURIComponent(fields) +
      '&limit=200&access_token=' + encodeURIComponent(token);
    const data = await fetchJSON(url);
    if (data.error) {
      res.status(200).json({ configured: true, ok: false, error: data.error.message, campaigns: [] });
      return;
    }
    const campaigns = (data.data || []).map(normalizeCampaign);
    res.status(200).json({ configured: true, ok: true, account: acct, datePreset, fetchedAt: new Date().toISOString(), campaigns });
  } catch (e) {
    res.status(200).json({ configured: true, ok: false, error: String(e && e.message ? e.message : e), campaigns: [], trend: [] });
  }
};

// Exported for unit testing
module.exports._test = { num, extractAction, classifyVertical, classifyPlatform, campaignGoal, mapStatus, normalizeCampaign, normalizeTrend, shortLabel };
