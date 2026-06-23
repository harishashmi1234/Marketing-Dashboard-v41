// api/facebook.js
// Vercel Serverless Function — secure proxy to the Facebook Page (Graph) API.
// Token stays server-side. Reads YOUR OWN Facebook Page insights (read-only).
//
// Reuses the same System User / Meta token as the ads + Instagram proxies, provided it has
// these scopes: pages_read_engagement, read_insights, pages_show_list (keep ads_read + the
// Instagram scopes). Page insights generally require a PAGE access token — this proxy fetches
// the page token automatically from /me/accounts, or you can set FB_PAGE_TOKEN directly.
//
// Env vars (Vercel → Settings → Environment Variables):
//   META_ACCESS_TOKEN   the System User token (with the page scopes above)
//   FB_PAGE_ID          your Facebook Page's numeric ID
//   FB_PAGE_TOKEN       optional — a long-lived Page access token (skips the /me/accounts lookup)
//
// Endpoints:
//   GET /api/facebook?resource=account   -> page profile + 30d insight totals + trend
//   GET /api/facebook?resource=posts     -> recent posts with reactions/comments/shares
//   GET /api/facebook?resource=audience  -> follower demographics (country / age-gender), best-effort
//   GET /api/facebook?resource=whoami    -> lists Pages the token manages (find FB_PAGE_ID)

const GRAPH = 'https://graph.facebook.com/v21.0';

function num(x){ const n = Number(x); return isFinite(n) ? n : 0; }
function enc(s){ return encodeURIComponent(s); }
async function fetchJSON(url){ const r = await fetch(url); return r.json(); }

function shortLabel(dateStr){
  try { const d = new Date(dateStr + 'T00:00:00'); return d.getDate() + ' ' + d.toLocaleString('en',{ month:'short' }); }
  catch(e){ return dateStr; }
}

// Pull a named day-series metric out of a /insights response → [{date,label,value}]
function seriesFor(insightsData, metricName){
  if(!Array.isArray(insightsData)) return [];
  const m = insightsData.find(x => x && x.name === metricName);
  if(!m || !Array.isArray(m.values)) return [];
  return m.values.map(v => ({
    date: (v.end_time || '').slice(0,10),
    label: shortLabel((v.end_time || '').slice(0,10)),
    value: num(v.value)
  }));
}
function sumSeries(s){ return s.reduce((a,b)=>a + (b.value||0), 0); }
function lastValue(s){ return s.length ? s[s.length-1].value : 0; }

// Resolve a Page access token: explicit env → /me/accounts lookup → fall back to user token.
async function resolvePageToken(userToken, pageId){
  if(process.env.FB_PAGE_TOKEN) return process.env.FB_PAGE_TOKEN;
  try {
    const d = await fetchJSON(GRAPH + '/me/accounts?fields=id,access_token&limit=200&access_token=' + enc(userToken));
    if(d && Array.isArray(d.data)){
      const p = d.data.find(x => String(x.id) === String(pageId));
      if(p && p.access_token) return p.access_token;
    }
  } catch(e){ /* fall through */ }
  return userToken;
}

function normalizePost(p){
  const reactions = num(p.reactions && p.reactions.summary && p.reactions.summary.total_count);
  const comments = num(p.comments && p.comments.summary && p.comments.summary.total_count);
  const shares = num(p.shares && p.shares.count);
  return {
    id: p.id,
    message: (p.message || p.story || '').slice(0, 160),
    date: (p.created_time || '').slice(0,10),
    permalink: p.permalink_url || '',
    picture: p.full_picture || '',
    reactions, comments, shares,
    engagement: reactions + comments + shares
  };
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 's-maxage=150, stale-while-revalidate=300');
  const userToken = process.env.META_ACCESS_TOKEN;
  const pageId = process.env.FB_PAGE_ID;
  const q = req.query || {};
  const resource = (q.resource || 'account').toString();

  if(!userToken){
    res.status(200).json({ configured:false, ok:false, error:'Set META_ACCESS_TOKEN (with Facebook Page scopes) in Vercel.' });
    return;
  }

  try {
    // Helper: list Pages this token manages, so you can find FB_PAGE_ID.
    if(resource === 'whoami'){
      const data = await fetchJSON(GRAPH + '/me/accounts?fields=id,name,fan_count,followers_count&limit=200&access_token=' + enc(userToken));
      if(data.error){ res.status(200).json({ configured:true, ok:false, error:data.error.message }); return; }
      res.status(200).json({ configured:true, ok:true, pages:data.data || [], hint:'Set the chosen page id as FB_PAGE_ID.' });
      return;
    }

    if(!pageId){
      res.status(200).json({ configured:false, ok:false, error:'Set FB_PAGE_ID in Vercel (use ?resource=whoami to find it).' });
      return;
    }

    const pageToken = await resolvePageToken(userToken, pageId);

    if(resource === 'posts'){
      const fields = 'id,message,story,created_time,permalink_url,full_picture,shares,reactions.summary(true),comments.summary(true)';
      const data = await fetchJSON(GRAPH + '/' + pageId + '/posts?fields=' + enc(fields) + '&limit=12&access_token=' + enc(pageToken));
      if(data.error){ res.status(200).json({ configured:true, ok:false, error:data.error.message, posts:[] }); return; }
      const posts = (data.data || []).map(normalizePost);
      res.status(200).json({ configured:true, ok:true, fetchedAt:new Date().toISOString(), count:posts.length, posts });
      return;
    }

    if(resource === 'audience'){
      // Follower demographics are heavily deprecated on newer pages — best-effort, degrade to empty.
      // We surface city (page_fans_city) in the dashboard; country/genderAge kept as fallbacks.
      let city = [], country = [], genderAge = [];
      try {
        const d = await fetchJSON(GRAPH + '/' + pageId + '/insights?metric=page_fans_city,page_fans_country,page_fans_gender_age&period=lifetime&access_token=' + enc(pageToken));
        if(!d.error && Array.isArray(d.data)){
          const ci = d.data.find(x => x.name === 'page_fans_city');
          const c = d.data.find(x => x.name === 'page_fans_country');
          const ga = d.data.find(x => x.name === 'page_fans_gender_age');
          const ciVal = (ci && ci.values && ci.values[0] && ci.values[0].value) || {};
          const cVal = (c && c.values && c.values[0] && c.values[0].value) || {};
          const gaVal = (ga && ga.values && ga.values[0] && ga.values[0].value) || {};
          city = Object.keys(ciVal).map(k => ({ name:k, value:num(ciVal[k]) })).sort((a,b)=>b.value-a.value).slice(0,10);
          country = Object.keys(cVal).map(k => ({ name:k, value:num(cVal[k]) })).sort((a,b)=>b.value-a.value).slice(0,8);
          genderAge = Object.keys(gaVal).map(k => ({ name:k, value:num(gaVal[k]) })).sort((a,b)=>b.value-a.value).slice(0,12);
        }
      } catch(e){ /* leave empty */ }
      res.status(200).json({ configured:true, ok:true, fetchedAt:new Date().toISOString(), city, country, genderAge });
      return;
    }

    // default: account — profile + 30d insight totals + a reach/engagement trend.
    const prof = await fetchJSON(GRAPH + '/' + pageId + '?fields=name,fan_count,followers_count,link,picture.type(large)&access_token=' + enc(pageToken));
    if(prof.error){ res.status(200).json({ configured:true, ok:false, error:prof.error.message }); return; }

    const until = Math.floor(Date.now()/1000);
    const since = until - 30*24*60*60;
    const base = GRAPH + '/' + pageId + '/insights?period=day&since=' + since + '&until=' + until + '&access_token=' + enc(pageToken);
    let ins = { impressions:[], reach:[], engagements:[], fanAdds:[], fanRemoves:[], views:[], videoViews:[] };
    try {
      // Attempt 1: full core set.
      const full = 'page_impressions,page_impressions_unique,page_post_engagements,page_fan_adds,page_fan_removes,page_views_total,page_video_views';
      let d = await fetchJSON(base + '&metric=' + full);
      if(d.error || !Array.isArray(d.data)){
        // Attempt 2: a leaner, broadly-supported subset.
        d = await fetchJSON(base + '&metric=page_impressions,page_impressions_unique,page_post_engagements');
      }
      if(!d.error && Array.isArray(d.data)){
        ins = {
          impressions: seriesFor(d.data, 'page_impressions'),
          reach:       seriesFor(d.data, 'page_impressions_unique'),
          engagements: seriesFor(d.data, 'page_post_engagements'),
          fanAdds:     seriesFor(d.data, 'page_fan_adds'),
          fanRemoves:  seriesFor(d.data, 'page_fan_removes'),
          views:       seriesFor(d.data, 'page_views_total'),
          videoViews:  seriesFor(d.data, 'page_video_views')
        };
      }
    } catch(e){ /* leave empty; frontend degrades */ }

    // Build a combined daily trend for charting (reach + engagement).
    const trend = (ins.reach.length ? ins.reach : ins.impressions).map((r, i) => ({
      date: r.date, label: r.label,
      reach: num(r.value),
      impressions: ins.impressions[i] ? num(ins.impressions[i].value) : 0,
      engagement: ins.engagements[i] ? num(ins.engagements[i].value) : 0
    }));

    res.status(200).json({
      configured:true, ok:true, fetchedAt:new Date().toISOString(),
      profile: {
        name: prof.name || '',
        followers: num(prof.followers_count || prof.fan_count),
        likes: num(prof.fan_count),
        link: prof.link || '',
        picture: (prof.picture && prof.picture.data && prof.picture.data.url) || ''
      },
      totals: {
        impressions: sumSeries(ins.impressions),
        reach: sumSeries(ins.reach),
        engagements: sumSeries(ins.engagements),
        fanAdds: sumSeries(ins.fanAdds),
        fanRemoves: sumSeries(ins.fanRemoves),
        netFans: sumSeries(ins.fanAdds) - sumSeries(ins.fanRemoves),
        views: sumSeries(ins.views),
        videoViews: sumSeries(ins.videoViews),
        engagementRate: sumSeries(ins.reach) ? +(sumSeries(ins.engagements) / sumSeries(ins.reach) * 100).toFixed(2) : 0
      },
      trend
    });
  } catch(e){
    res.status(200).json({ configured:true, ok:false, error:String(e && e.message ? e.message : e) });
  }
};

module.exports._test = { num, seriesFor, sumSeries, lastValue, shortLabel, normalizePost };
