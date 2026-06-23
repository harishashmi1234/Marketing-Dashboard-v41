// api/meta-creatives.js
// Vercel Serverless Function — secure proxy to the Meta Ad Creatives API for the Campaigns tab.
//
// This is a NEW, self-contained endpoint. It does NOT touch api/meta.js (which keeps powering the
// Performance tab). It reuses the same META_ACCESS_TOKEN / META_AD_ACCOUNT_ID env vars — no new
// Meta credentials are required.
//
// Two modes:
//   GET /api/meta-creatives?campaign_id=<id>          (default)  -> full creative gallery for one campaign
//        { configured, ok, campaignId, creatives:[ { id, name, type, thumbnail, image, videoSource, metrics } ], fetchedAt }
//   GET /api/meta-creatives?resource=thumbnails                  -> one representative image per campaign
//        { configured, ok, thumbnails:{ "<campaign_id>": "<url>" }, fetchedAt }
//
// Image quality: we resolve full-resolution image URLs via the Ad Images edge (image_hash -> url),
// including hashes hidden inside object_story_spec and asset_feed_spec (dynamic / Advantage+ ads),
// and pick the largest available video poster — instead of Meta's tiny default thumbnail_url.
//
// Per-creative performance: each ad's insights are fetched and aggregated onto its creative so the
// gallery can show how every creative is performing individually.

const GRAPH_VERSION = 'v21.0';
const GRAPH = 'https://graph.facebook.com/' + GRAPH_VERSION;

const LEAD_TYPES = ['lead', 'leadgen.other', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];

function norm(s) { return (s == null ? '' : String(s)).trim(); }
function num(x) { const n = Number(x); return isFinite(n) ? n : 0; }
function extractAction(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) { const a = actions.find((x) => x && x.action_type === t); if (a) return num(a.value); }
  return 0;
}

async function fetchJSON(url) {
  const r = await fetch(url);
  return r.json();
}

// Pull a usable thumbnail / image out of a creative's varied shapes.
function pickThumbnail(cr) {
  if (!cr) return '';
  if (cr.thumbnail_url) return cr.thumbnail_url;
  if (cr.image_url) return cr.image_url;
  const spec = cr.object_story_spec || {};
  if (spec.link_data && spec.link_data.picture) return spec.link_data.picture;
  if (spec.video_data && spec.video_data.image_url) return spec.video_data.image_url;
  const afs = cr.asset_feed_spec || {};
  if (Array.isArray(afs.images) && afs.images[0] && afs.images[0].url) return afs.images[0].url;
  return '';
}

// Gather EVERY image hash referenced by a creative (top-level, object_story_spec, asset_feed_spec).
function collectImageHashes(cr) {
  const out = [];
  if (!cr) return out;
  if (cr.image_hash) out.push(cr.image_hash);
  const spec = cr.object_story_spec || {};
  if (spec.link_data && spec.link_data.image_hash) out.push(spec.link_data.image_hash);
  if (spec.video_data && spec.video_data.image_hash) out.push(spec.video_data.image_hash);
  const afs = cr.asset_feed_spec || {};
  if (Array.isArray(afs.images)) afs.images.forEach((im) => { if (im && im.hash) out.push(im.hash); });
  return out;
}

// Gather every video id referenced by a creative.
function collectVideoIds(cr) {
  const out = [];
  if (!cr) return out;
  if (cr.video_id) out.push(cr.video_id);
  const spec = cr.object_story_spec || {};
  if (spec.video_data && spec.video_data.video_id) out.push(spec.video_data.video_id);
  const afs = cr.asset_feed_spec || {};
  if (Array.isArray(afs.videos)) afs.videos.forEach((v) => { if (v && v.video_id) out.push(v.video_id); });
  return out;
}

// Normalize one raw creative object into our clean shape. videoIds / imageHashes are collected so
// the caller can resolve playable sources and full-resolution images in batched Graph calls.
function normalizeCreative(cr, videoIds, imageHashes) {
  const hashes = collectImageHashes(cr);
  const vids = collectVideoIds(cr);
  hashes.forEach((h) => imageHashes.add(h));
  vids.forEach((v) => videoIds.add(v));
  const isVideo = vids.length > 0 || norm(cr.object_type).toUpperCase() === 'VIDEO';
  return {
    id: cr.id,
    name: cr.name || cr.title || '(untitled creative)',
    type: isVideo ? 'video' : 'image',
    thumbnail: pickThumbnail(cr),       // medium preview (large thumbnail when available)
    image: cr.image_url || '',          // upgraded to full-resolution below when a hash/post resolves
    primaryHash: hashes[0] || '',
    storyId: cr.effective_object_story_id || cr.object_story_id || '', // social / boosted-post ads
    videoId: vids[0] || '',
    videoSource: '',                    // filled in later from the batched video lookup
    metrics: null                       // filled in from aggregated ad insights
  };
}

// Resolve image_hash -> full-resolution url via the Ad Images edge, in one batched call.
async function resolveImageUrls(token, acct, hashes) {
  const out = {};
  if (!hashes.length) return out;
  try {
    const url = GRAPH + '/act_' + acct + '/adimages?fields=hash,url,permalink_url&hashes=' +
      encodeURIComponent(JSON.stringify(hashes)) + '&access_token=' + encodeURIComponent(token);
    const data = await fetchJSON(url);
    for (const img of (data && data.data) || []) {
      if (img && img.hash) out[img.hash] = img.url || img.permalink_url || '';
    }
  } catch (e) { /* non-fatal */ }
  return out;
}

// Pick the largest poster frame from a video's thumbnails list.
function bestVideoPoster(v) {
  if (!v) return '';
  const list = (v.thumbnails && v.thumbnails.data) || [];
  let best = '', bestW = -1;
  for (const t of list) { const w = num(t.width); if (t.uri && w > bestW) { best = t.uri; bestW = w; } }
  return best || v.picture || '';
}

// Resolve video_id -> { source, poster } via one batched call (source for playback, big poster frame).
async function resolveVideos(token, ids) {
  const out = {};
  if (!ids.length) return out;
  try {
    const url = GRAPH + '/?ids=' + encodeURIComponent(ids.join(',')) +
      '&fields=' + encodeURIComponent('source,picture,thumbnails') + '&access_token=' + encodeURIComponent(token);
    const data = await fetchJSON(url);
    if (data && !data.error) {
      for (const id of Object.keys(data)) out[id] = { source: data[id].source || '', poster: bestVideoPoster(data[id]) };
    }
  } catch (e) { /* non-fatal */ }
  return out;
}

// Resolve a post's high-resolution image (full_picture) for social / boosted-post ad creatives,
// which reference an existing Page/IG post by id instead of an uploaded image asset.
// Individual fetches (not a single ?ids= batch) so one bad/inaccessible id can't fail the rest.
async function resolvePostImages(token, ids) {
  const out = {};
  const uniq = Array.from(new Set((ids || []).filter(Boolean)));
  await Promise.all(uniq.map(async (id) => {
    try {
      const url = GRAPH + '/' + encodeURIComponent(id) + '?fields=' +
        encodeURIComponent('full_picture,picture') + '&access_token=' + encodeURIComponent(token);
      const p = await fetchJSON(url);
      if (p && !p.error) out[id] = p.full_picture || p.picture || '';
    } catch (e) { /* non-fatal */ }
  }));
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  const token = process.env.META_ACCESS_TOKEN;
  const accountRaw = process.env.META_AD_ACCOUNT_ID;
  const q = (req.query) || {};
  const resource = norm(q.resource) || 'creatives';
  const campaignId = norm(q.campaign_id);

  if (!token || !accountRaw) {
    res.status(200).json({ configured: false, ok: false, error: 'META_ACCESS_TOKEN / META_AD_ACCOUNT_ID not set.', creatives: [], thumbnails: {} });
    return;
  }
  const acct = accountRaw.toString().replace(/^act_/, '');

  try {
    /* ---- Mode B: one representative HIGH-RES thumbnail per campaign (for the card grid) ---- */
    if (resource === 'thumbnails') {
      const picked = {}; // campaignId -> { url, hash, story } for the first usable creative found
      let url = GRAPH + '/act_' + acct + '/ads?fields=' +
        encodeURIComponent('campaign_id,creative{image_url,image_hash,thumbnail_url,effective_object_story_id,object_story_id,object_story_spec,asset_feed_spec}') +
        '&thumbnail_width=600&thumbnail_height=600&limit=300&access_token=' + encodeURIComponent(token);
      for (let page = 0; page < 8 && url; page++) {
        const data = await fetchJSON(url);
        if (data.error) { res.status(200).json({ configured: true, ok: false, error: data.error.message, thumbnails: {} }); return; }
        for (const ad of (data.data || [])) {
          const cid = ad.campaign_id;
          if (!cid || picked[cid]) continue;
          const cr = ad.creative || {};
          const hashes = collectImageHashes(cr);
          const story = cr.effective_object_story_id || cr.object_story_id || '';
          const directUrl = cr.image_url || pickThumbnail(cr);
          if (!hashes[0] && !directUrl && !story) continue; // nothing usable — let a later ad fill this campaign
          picked[cid] = { url: directUrl, hash: hashes[0] || '', story };
        }
        url = (data.paging && data.paging.next) || '';
      }
      // Upgrade hashes to full-resolution URLs, and resolve post full_picture for social/boosted ads.
      const hashList = Array.from(new Set(Object.values(picked).map((p) => p.hash).filter(Boolean)));
      const storyList = Object.values(picked).filter((p) => !p.hash).map((p) => p.story).filter(Boolean);
      const [imgUrls, postImgs] = await Promise.all([
        resolveImageUrls(token, acct, hashList),
        resolvePostImages(token, storyList)
      ]);
      const thumbnails = {};
      for (const cid of Object.keys(picked)) {
        const p = picked[cid];
        const best = (p.hash && imgUrls[p.hash]) || (p.story && postImgs[p.story]) || p.url || '';
        if (best) thumbnails[cid] = best;
      }
      res.status(200).json({ configured: true, ok: true, fetchedAt: new Date().toISOString(), count: Object.keys(thumbnails).length, thumbnails });
      return;
    }

    /* ---- Mode A (default): full creative gallery + per-creative performance for one campaign ---- */
    if (!campaignId) {
      res.status(200).json({ configured: true, ok: false, error: 'Missing campaign_id.', creatives: [] });
      return;
    }

    const creativeFields = 'creative{id,name,title,thumbnail_url,image_url,image_hash,object_type,video_id,effective_object_story_id,object_story_id,object_story_spec,asset_feed_spec}';
    const insightsBlock = 'insights.date_preset(maximum){spend,impressions,reach,clicks,ctr,actions}';
    const url = GRAPH + '/' + encodeURIComponent(campaignId) + '/ads?fields=' +
      encodeURIComponent('name,' + creativeFields + ',' + insightsBlock) +
      '&thumbnail_width=1080&thumbnail_height=1080&limit=200&access_token=' + encodeURIComponent(token);
    const data = await fetchJSON(url);
    if (data.error) {
      res.status(200).json({ configured: true, ok: false, campaignId, error: data.error.message, creatives: [] });
      return;
    }

    // De-duplicate creatives across ads and aggregate ad insights onto each creative.
    const byId = new Map();
    const metricsById = {};
    const videoIds = new Set();
    const imageHashes = new Set();
    for (const ad of (data.data || [])) {
      const cr = ad.creative;
      if (!cr || !cr.id) continue;
      if (!byId.has(cr.id)) byId.set(cr.id, normalizeCreative(cr, videoIds, imageHashes));
      const ins = ad.insights && ad.insights.data && ad.insights.data[0];
      if (ins) {
        const m = metricsById[cr.id] || (metricsById[cr.id] = { spend: 0, impressions: 0, reach: 0, clicks: 0, leads: 0 });
        m.spend += num(ins.spend); m.impressions += num(ins.impressions);
        m.reach += num(ins.reach); m.clicks += num(ins.clicks);
        m.leads += extractAction(ins.actions, LEAD_TYPES);
      }
    }
    const creatives = Array.from(byId.values());

    // Resolve full-resolution images + playable video sources in parallel batched calls.
    const [imgUrls, videos] = await Promise.all([
      resolveImageUrls(token, acct, Array.from(imageHashes)),
      resolveVideos(token, Array.from(videoIds))
    ]);
    // For creatives without an uploaded image asset (social / boosted posts), get the post's full_picture.
    const storyIds = creatives.filter((c) => !(c.primaryHash && imgUrls[c.primaryHash])).map((c) => c.storyId);
    const postImgs = await resolvePostImages(token, storyIds);

    for (const c of creatives) {
      // Priority: full-res Ad Images url > post full_picture (social ads) > creative image_url > thumbnail.
      let best = (c.primaryHash && imgUrls[c.primaryHash]) || '';
      if (!best && c.storyId && postImgs[c.storyId]) best = postImgs[c.storyId];
      if (!best) best = c.image || c.thumbnail;
      c.image = best;
      if (c.videoId && videos[c.videoId]) {
        c.videoSource = videos[c.videoId].source || '';
        const poster = videos[c.videoId].poster || (c.storyId && postImgs[c.storyId]) || '';
        if (poster) { c.thumbnail = poster; if (!c.image) c.image = poster; }
      }
      if (!c.thumbnail) c.thumbnail = c.image;
      const m = metricsById[c.id];
      c.metrics = m ? { spend: m.spend, impressions: m.impressions, reach: m.reach, clicks: m.clicks, leads: m.leads, ctr: m.impressions ? (m.clicks / m.impressions) * 100 : 0 } : null;
      delete c.primaryHash; delete c.storyId;
    }

    res.status(200).json({ configured: true, ok: true, campaignId, fetchedAt: new Date().toISOString(), count: creatives.length, creatives });
  } catch (e) {
    res.status(200).json({ configured: true, ok: false, campaignId, error: String(e && e.message ? e.message : e), creatives: [], thumbnails: {} });
  }
};

// Exported for unit testing
module.exports._test = { norm, num, extractAction, pickThumbnail, collectImageHashes, collectVideoIds, bestVideoPoster, normalizeCreative };
