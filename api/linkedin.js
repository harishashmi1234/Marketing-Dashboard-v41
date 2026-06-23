// api/linkedin.js
// Vercel Serverless Function - secure proxy to the LinkedIn Community Management API.
// Token stays server-side. Reads YOUR OWN Company Page analytics.
//
// IMPORTANT: LinkedIn gates this behind app approval (Community Management API) plus an
// admin role on the Company Page. The code below is correct, but it only returns data once:
//   1. your LinkedIn developer app is approved for the Community Management API, and
//   2. LINKEDIN_ACCESS_TOKEN (a token with r_organization_social + rw_organization_admin) is set.
//
// Env vars (Vercel - Settings - Environment Variables):
//   LINKEDIN_ACCESS_TOKEN   OAuth token with org analytics scopes (expires ~60 days; refresh needed)
//   LINKEDIN_ORG_ID         your Company Page's numeric organization ID
//   LINKEDIN_API_VERSION    optional, default 202505 (format YYYYMM; bump if LinkedIn retires it)
//
// Endpoints:
//   GET /api/linkedin?resource=whoami     -> lists organizations your token administers (find ORG_ID)
//   GET /api/linkedin?resource=account    -> followers + impressions + engagement + page views
//   GET /api/linkedin?resource=followers  -> daily organic/paid follower gains (last ~30d)
//   GET /api/linkedin?resource=posts      -> recent posts (text + date)

const BASE = 'https://api.linkedin.com/rest';

function num(x){ const n = Number(x); return isFinite(n) ? n : 0; }

function headers(token, version){
  return {
    'Authorization': 'Bearer ' + token,
    'LinkedIn-Version': version,
    'X-Restli-Protocol-Version': '2.0.0'
  };
}
async function getJSON(url, h){ const r = await fetch(url, { headers:h }); const j = await r.json().catch(()=>({})); return { status:r.status, body:j }; }

function shortLabel(ms){ try { const d = new Date(Number(ms)); return d.getDate() + ' ' + d.toLocaleString('en',{ month:'short' }); } catch(e){ return ''; } }

// follower-gain time series -> [{date,label,organic,paid}]
function followerSeries(elements){
  return (elements || []).map(el => {
    const g = el.followerGains || {};
    const start = el.timeRange && el.timeRange.start;
    return { date: start, label: shortLabel(start), organic: num(g.organicFollowerGain), paid: num(g.paidFollowerGain) };
  }).filter(x => x.date);
}

// share statistics -> normalized engagement block
function shareStats(elements){
  const s = (elements && elements[0] && elements[0].totalShareStatistics) || {};
  const impressions = num(s.impressionCount), clicks = num(s.clickCount);
  const likes = num(s.likeCount), comments = num(s.commentCount), shares = num(s.shareCount);
  const engagementRate = s.engagement != null ? num(s.engagement) : (impressions ? (likes+comments+shares+clicks)/impressions : 0);
  return { impressions, clicks, likes, comments, shares, engagementRate,
    ctr: impressions ? clicks/impressions*100 : 0,
    interactions: likes + comments + shares };
}

// page statistics -> total page views (defensive about nesting)
function pageViews(elements){
  const t = (elements && elements[0] && elements[0].totalPageStatistics) || {};
  const v = t.views || {};
  // sum the *PageViews.pageViews leaves we can find
  let total = 0;
  Object.keys(v).forEach(k => { const leaf = v[k]; if(leaf && typeof leaf === 'object' && leaf.pageViews != null) total += num(leaf.pageViews); });
  if(!total && v.allPageViews && v.allPageViews.pageViews != null) total = num(v.allPageViews.pageViews);
  return total;
}

function normalizePosts(elements){
  return (elements || []).slice(0,12).map(p => ({
    id: p.id || '',
    text: ((p.commentary || (p.specificContent && JSON.stringify(p.specificContent)) || '') + '').slice(0,160),
    createdAt: (p.createdAt || (p.created && p.created.time) || ''),
    date: p.createdAt ? new Date(Number(p.createdAt)).toISOString().slice(0,10) : ''
  })).filter(p => p.id);
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=360');
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const orgId = process.env.LINKEDIN_ORG_ID;
  const version = process.env.LINKEDIN_API_VERSION || '202505';
  const q = req.query || {};
  const resource = (q.resource || 'account').toString();

  if(!token){
    res.status(200).json({ configured:false, ok:false, error:'Set LINKEDIN_ACCESS_TOKEN in Vercel (needs Community Management API approval + org analytics scopes).' });
    return;
  }
  const h = headers(token, version);

  try {
    if(resource === 'whoami'){
      const url = BASE + '/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED';
      const { status, body } = await getJSON(url, h);
      if(status >= 400){ res.status(200).json({ configured:true, ok:false, status, error:(body && body.message) || 'LinkedIn error', raw:body }); return; }
      const orgs = (body.elements || []).map(e => e.organizationalTarget || e.organization).filter(Boolean);
      res.status(200).json({ configured:true, ok:true, organizations:orgs, hint:'Use the number after urn:li:organization: as LINKEDIN_ORG_ID' });
      return;
    }

    if(!orgId){
      res.status(200).json({ configured:false, ok:false, error:'Set LINKEDIN_ORG_ID in Vercel (use ?resource=whoami to find it).' });
      return;
    }
    const orgUrn = 'urn:li:organization:' + orgId;
    const enc = encodeURIComponent(orgUrn);

    if(resource === 'followers'){
      const now = Date.now(); const start = now - 30*24*60*60*1000;
      const url = BASE + '/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=' + enc +
        '&timeIntervals.timeGranularityType=DAY&timeIntervals.timeRange.start=' + start + '&timeIntervals.timeRange.end=' + now;
      const { status, body } = await getJSON(url, h);
      if(status >= 400){ res.status(200).json({ configured:true, ok:false, status, error:(body && body.message) || 'LinkedIn error' }); return; }
      res.status(200).json({ configured:true, ok:true, fetchedAt:new Date().toISOString(), followerSeries: followerSeries(body.elements) });
      return;
    }

    if(resource === 'posts'){
      const url = BASE + '/posts?q=author&author=' + enc + '&count=12&sortBy=LAST_MODIFIED';
      const { status, body } = await getJSON(url, h);
      if(status >= 400){ res.status(200).json({ configured:true, ok:false, status, error:(body && body.message) || 'LinkedIn error', posts:[] }); return; }
      res.status(200).json({ configured:true, ok:true, fetchedAt:new Date().toISOString(), posts: normalizePosts(body.elements) });
      return;
    }

    // default: account (followers total + page views + share stats), each best-effort
    let followers = 0, views = 0, share = shareStats([]);
    try {
      const net = await getJSON(BASE + '/networkSizes/' + enc + '?edgeType=COMPANY_FOLLOWED_BY_MEMBER', h);
      if(net.status < 400) followers = num(net.body.firstDegreeSize);
    } catch(e){}
    try {
      const ps = await getJSON(BASE + '/organizationPageStatistics?q=organization&organization=' + enc, h);
      if(ps.status < 400) views = pageViews(ps.body.elements);
    } catch(e){}
    let shareErr = null;
    try {
      const ss = await getJSON(BASE + '/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=' + enc, h);
      if(ss.status < 400) share = shareStats(ss.body.elements); else shareErr = (ss.body && ss.body.message) || ('status ' + ss.status);
    } catch(e){ shareErr = String(e); }

    res.status(200).json({
      configured:true, ok:true, fetchedAt:new Date().toISOString(), org:orgId,
      totals: { followers, pageViews:views, impressions:share.impressions, clicks:share.clicks,
        likes:share.likes, comments:share.comments, shares:share.shares,
        interactions:share.interactions, engagementRate:share.engagementRate, ctr:share.ctr },
      note: shareErr ? ('Share statistics unavailable: ' + shareErr) : null
    });
  } catch(e){
    res.status(200).json({ configured:true, ok:false, error:String(e && e.message ? e.message : e) });
  }
};

module.exports._test = { num, followerSeries, shareStats, pageViews, normalizePosts, shortLabel };
