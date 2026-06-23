// api/instagram.js
// Vercel Serverless Function — secure proxy to the Instagram Graph API
// (Facebook Login flow, host graph.facebook.com). Token stays server-side.
//
// Reuses the same System User token as the ads proxy, provided you regenerate it
// with these scopes added: instagram_basic, instagram_manage_insights, pages_read_engagement
// (keep ads_read so /api/meta keeps working).
//
// Env vars (Vercel → Settings → Environment Variables):
//   META_ACCESS_TOKEN   the System User token (now with the Instagram scopes above)
//   IG_USER_ID          your Instagram professional account ID (numeric, e.g. 17841xxxxxxxxxx)
//
// To find IG_USER_ID once: GET /<PAGE_ID>?fields=instagram_business_account  (returns the IG id),
// or the dashboard's ?resource=whoami helper below will list it from your Pages.
//
// Endpoints:
//   GET /api/instagram?resource=account   -> profile + best-effort daily insights + engagement totals
//   GET /api/instagram?resource=media     -> recent media with engagement
//   GET /api/instagram?resource=audience  -> follower demographics (country / age / gender), best-effort
//   GET /api/instagram?resource=whoami    -> helper: lists Pages + linked IG account IDs

const GRAPH = 'https://graph.facebook.com/v21.0';

function num(x){ const n = Number(x); return isFinite(n) ? n : 0; }
async function fetchJSON(url){ const r = await fetch(url); return r.json(); }

// Pull a named metric's daily series out of the insights response
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

// Pull a single aggregate out of a metric_type=total_value insights response.
function totalValueFor(insightsData, metricName){
  if(!Array.isArray(insightsData)) return 0;
  const m = insightsData.find(x => x && x.name === metricName);
  return num(m && m.total_value && m.total_value.value);
}

// Pull a demographic breakdown ([{name,value}]) out of a follower_demographics response.
function breakdownFor(insightsData, dimension){
  if(!Array.isArray(insightsData)) return [];
  const m = insightsData.find(x => x && x.name === 'follower_demographics');
  const tv = m && m.total_value;
  const bd = tv && tv.breakdowns && tv.breakdowns[0];
  const results = (bd && bd.results) || [];
  return results.map(r => ({
    name: (r.dimension_values && r.dimension_values[0]) || '',
    value: num(r.value)
  })).filter(x => x.name).sort((a,b)=>b.value-a.value);
}

function shortLabel(dateStr){
  try { const d = new Date(dateStr + 'T00:00:00'); return d.getDate() + ' ' + d.toLocaleString('en',{ month:'short' }); }
  catch(e){ return dateStr; }
}

// Normalize a media item; engagement = likes + comments (always present on the node)
function normalizeMedia(m){
  const likes = num(m.like_count), comments = num(m.comments_count);
  return {
    id: m.id,
    caption: (m.caption || '').slice(0, 140),
    type: m.media_type || '',                 // IMAGE | VIDEO | CAROUSEL_ALBUM
    productType: m.media_product_type || '',  // FEED | REELS | STORY | AD
    timestamp: m.timestamp || '',
    date: (m.timestamp || '').slice(0,10),
    permalink: m.permalink || '',
    thumbnail: m.thumbnail_url || m.media_url || '',
    likes, comments,
    engagement: likes + comments
  };
}

// Map IG product/media type to a friendly format bucket
function formatBucket(med){
  if(med.productType === 'REELS') return 'Reels';
  if(med.type === 'CAROUSEL_ALBUM') return 'Carousels';
  if(med.type === 'VIDEO') return 'Videos';
  return 'Static Posts';
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=240');
  const token = process.env.META_ACCESS_TOKEN;
  const igId = process.env.IG_USER_ID;
  const q = req.query || {};
  const resource = (q.resource || 'account').toString();

  if(!token){
    res.status(200).json({ configured:false, ok:false, error:'Set META_ACCESS_TOKEN (with Instagram scopes) in Vercel.' });
    return;
  }

  try {
    // Helper: discover the IG account id from the user's Pages (run once, then set IG_USER_ID)
    if(resource === 'whoami'){
      const pageIdHint = (req.query && req.query.page_id) ? req.query.page_id.toString() : null;

      // Also check token scopes so we can give a clear error if pages_show_list is missing
      const [data, scopeData] = await Promise.all([
        fetchJSON(GRAPH + '/me/accounts?fields=name,id,instagram_business_account{id,username,followers_count}&access_token=' + encodeURIComponent(token)),
        fetchJSON('https://graph.facebook.com/debug_token?input_token=' + encodeURIComponent(token) + '&access_token=' + encodeURIComponent(token))
      ]);
      if(data.error){ res.status(200).json({ configured:true, ok:false, error:data.error.message }); return; }
      const scopes = (scopeData && scopeData.data && scopeData.data.scopes) || [];
      const expiresAt = (scopeData && scopeData.data && scopeData.data.expires_at) ? new Date(scopeData.data.expires_at * 1000).toISOString() : null;
      const missingScopes = ['pages_show_list','pages_read_engagement'].filter(s => !scopes.includes(s));
      let pages = data.data || [];

      // If /me/accounts returned empty but caller supplied a known Facebook Page ID,
      // try resolving the IG account from that page directly.
      let pageHintResult = null;
      if(pages.length === 0 && pageIdHint){
        const pageData = await fetchJSON(GRAPH + '/' + pageIdHint + '?fields=id,name,instagram_business_account{id,username,followers_count}&access_token=' + encodeURIComponent(token));
        if(!pageData.error){
          pageHintResult = pageData;
          if(pageData.instagram_business_account){
            pages = [{ id: pageData.id, name: pageData.name, instagram_business_account: pageData.instagram_business_account }];
          }
        } else {
          pageHintResult = { error: pageData.error.message };
        }
      }

      res.status(200).json({
        configured: true, ok: true,
        pages,
        pageHintResult,
        tokenInfo: { scopes, expiresAt, missingScopes },
        diagnosis: pages.length === 0 && missingScopes.length > 0
          ? 'Token is missing scopes: ' + missingScopes.join(', ') + '. Regenerate the token and add these permissions.'
          : pages.length === 0
          ? 'Token has correct scopes but no Facebook Pages found. Make sure the token owner manages the Get Set Learn page.'
          : null
      });
      return;
    }

    if(!igId){
      res.status(200).json({ configured:false, ok:false, error:'Set IG_USER_ID in Vercel (use ?resource=whoami to find it).' });
      return;
    }

    if(resource === 'audience'){
      // follower_demographics needs metric_type=total_value + a breakdown; 100+ followers required.
      // City is the breakdown we surface in the dashboard (country kept as a fallback).
      let city = [], country = [], age = [], gender = [];
      const demo = (dim) => fetchJSON(GRAPH + '/' + igId + '/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=' + dim + '&access_token=' + encodeURIComponent(token));
      try { const d = await demo('city');    if(!d.error) city    = breakdownFor(d.data, 'city').slice(0,10); } catch(e){}
      try { const d = await demo('country'); if(!d.error) country = breakdownFor(d.data, 'country').slice(0,8); } catch(e){}
      try { const d = await demo('age');     if(!d.error) age     = breakdownFor(d.data, 'age'); } catch(e){}
      try { const d = await demo('gender');  if(!d.error) gender  = breakdownFor(d.data, 'gender'); } catch(e){}
      res.status(200).json({ configured:true, ok:true, fetchedAt:new Date().toISOString(), city, country, age, gender });
      return;
    }

    if(resource === 'media'){
      const fields = 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,thumbnail_url,media_url';
      const url = GRAPH + '/' + igId + '/media?fields=' + fields + '&limit=24&access_token=' + encodeURIComponent(token);
      const data = await fetchJSON(url);
      if(data.error){ res.status(200).json({ configured:true, ok:false, error:data.error.message, media:[] }); return; }
      const media = (data.data || []).map(normalizeMedia);
      // format-performance aggregation (real, from media)
      const buckets = {};
      media.forEach(m => { const b = formatBucket(m); (buckets[b] = buckets[b] || { name:b, posts:0, eng:0 }); buckets[b].posts++; buckets[b].eng += m.engagement; });
      const formats = Object.values(buckets).map(b => ({ name:b.name, posts:b.posts, avgEng: b.posts ? Math.round(b.eng / b.posts) : 0, totalEng: b.eng }));
      res.status(200).json({ configured:true, ok:true, fetchedAt:new Date().toISOString(), count:media.length, media, formats });
      return;
    }

    // default: account (profile + best-effort daily insights)
    const profUrl = GRAPH + '/' + igId + '?fields=username,name,followers_count,follows_count,media_count,profile_picture_url&access_token=' + encodeURIComponent(token);
    const profile = await fetchJSON(profUrl);
    if(profile.error){ res.status(200).json({ configured:true, ok:false, error:profile.error.message }); return; }

    // best-effort insights: daily window over last 30 days.
    // follower_count with period=day was deprecated in Graph API v17 — omit it to
    // prevent it from failing the entire batch request.
    const until = Math.floor(Date.now()/1000);
    const since = until - 30*24*60*60;
    let insights = { reach:[], impressions:[], profile_views:[], follower_count:[] };
    try {
      // Attempt 1: reach + impressions + profile_views
      const insUrl = GRAPH + '/' + igId + '/insights?metric=reach,impressions,profile_views&period=day&since=' + since + '&until=' + until + '&access_token=' + encodeURIComponent(token);
      const ins = await fetchJSON(insUrl);
      if(!ins.error && Array.isArray(ins.data)){
        insights = {
          reach: seriesFor(ins.data, 'reach'),
          impressions: seriesFor(ins.data, 'impressions'),
          profile_views: seriesFor(ins.data, 'profile_views'),
          follower_count: []
        };
      } else {
        // Attempt 2: profile_views may be unavailable on some account types — try reach + impressions
        const r2 = await fetchJSON(GRAPH + '/' + igId + '/insights?metric=reach,impressions&period=day&since=' + since + '&until=' + until + '&access_token=' + encodeURIComponent(token));
        if(!r2.error && Array.isArray(r2.data)){
          insights.reach = seriesFor(r2.data, 'reach');
          insights.impressions = seriesFor(r2.data, 'impressions');
        } else {
          // Attempt 3: reach only
          const r3 = await fetchJSON(GRAPH + '/' + igId + '/insights?metric=reach&period=day&since=' + since + '&until=' + until + '&access_token=' + encodeURIComponent(token));
          if(!r3.error && Array.isArray(r3.data)) insights.reach = seriesFor(r3.data, 'reach');
        }
      }
    } catch(e){ /* leave insights empty; frontend degrades */ }

    // Best-effort aggregate engagement metrics (metric_type=total_value over the 30d window).
    // NOTE: Meta deprecated the legacy `impressions` account metric (Graph v22, Apr 2025) — `views`
    // is the replacement, so we request it here as a total_value metric and surface it as "Views".
    let eng = {};
    try {
      const engMetrics = 'views,reach,accounts_engaged,total_interactions,likes,comments,saves,shares,replies,profile_links_taps';
      const e1 = await fetchJSON(GRAPH + '/' + igId + '/insights?metric=' + engMetrics + '&metric_type=total_value&period=day&since=' + since + '&until=' + until + '&access_token=' + encodeURIComponent(token));
      if(!e1.error && Array.isArray(e1.data)){
        eng = {
          views: totalValueFor(e1.data, 'views'),
          reachTotal: totalValueFor(e1.data, 'reach'),
          accountsEngaged: totalValueFor(e1.data, 'accounts_engaged'),
          totalInteractions: totalValueFor(e1.data, 'total_interactions'),
          likes: totalValueFor(e1.data, 'likes'),
          comments: totalValueFor(e1.data, 'comments'),
          saves: totalValueFor(e1.data, 'saves'),
          shares: totalValueFor(e1.data, 'shares'),
          replies: totalValueFor(e1.data, 'replies'),
          profileLinkTaps: totalValueFor(e1.data, 'profile_links_taps')
        };
      } else {
        // Fallback: views alone (some accounts reject the combined request)
        const v = await fetchJSON(GRAPH + '/' + igId + '/insights?metric=views&metric_type=total_value&period=day&since=' + since + '&until=' + until + '&access_token=' + encodeURIComponent(token));
        if(!v.error && Array.isArray(v.data)) eng.views = totalValueFor(v.data, 'views');
      }
    } catch(e){ /* leave eng empty */ }

    res.status(200).json({
      configured:true, ok:true, fetchedAt:new Date().toISOString(),
      profile: {
        username: profile.username || '', name: profile.name || '',
        followers: num(profile.followers_count), follows: num(profile.follows_count),
        mediaCount: num(profile.media_count), picture: profile.profile_picture_url || ''
      },
      insights,
      totals: {
        // Prefer the daily reach series; fall back to the total_value reach if the series is empty.
        reach: sumSeries(insights.reach) || eng.reachTotal || 0,
        views: eng.views || 0,                                  // replaces the deprecated "impressions"
        impressions: sumSeries(insights.impressions) || eng.views || 0,
        profileViews: sumSeries(insights.profile_views),
        followerGain: sumSeries(insights.follower_count),
        accountsEngaged: eng.accountsEngaged || 0,
        totalInteractions: eng.totalInteractions || 0,
        likes: eng.likes || 0,
        comments: eng.comments || 0,
        saves: eng.saves || 0,
        shares: eng.shares || 0,
        replies: eng.replies || 0,
        profileLinkTaps: eng.profileLinkTaps || 0
      }
    });
  } catch(e){
    res.status(200).json({ configured:true, ok:false, error:String(e && e.message ? e.message : e) });
  }
};

module.exports._test = { num, seriesFor, sumSeries, totalValueFor, breakdownFor, shortLabel, normalizeMedia, formatBucket };
