// api/analytics.js
// Vercel Serverless Function — secure proxy to the Google Analytics 4 Data API.
// Read-only. Credentials stay server-side; the browser only calls /api/analytics and gets back
// clean, normalized website metrics. No external dependencies (Node's built-in crypto + fetch).
//
// TWO auth methods are supported (OAuth takes precedence when its vars are present):
//
//   A) OAuth2 user credentials  — use this when you DON'T have GA admin rights.
//      The Data API runs as a Google *user* who already has at least Viewer on the property
//      (e.g. your own Gmail). No service-account grant in GA is needed. The OAuth client can live
//      in ANY Google Cloud project you own — create a free one under your own Gmail, enable the
//      "Google Analytics Data API" there, make a "Desktop app" OAuth client, then run
//      `node scripts/ga-oauth.js <client_id> <client_secret>` once to mint a refresh token.
//      Set the OAuth consent screen to "In production" so the refresh token doesn't expire in 7 days.
//        GA_PROPERTY_ID          GA4 numeric property ID (the p######## number in the GA4 URL)
//        GA_OAUTH_CLIENT_ID       OAuth 2.0 client ID
//        GA_OAUTH_CLIENT_SECRET   OAuth 2.0 client secret
//        GA_OAUTH_REFRESH_TOKEN   refresh token from scripts/ga-oauth.js
//
//   B) Service account (JWT → OAuth) — use this when you DO have GA admin rights.
//      In GA4 → Admin → Property Access Management, add the service-account email as a Viewer,
//      and enable the "Google Analytics Data API" for the service account's project.
//        GA_PROPERTY_ID    GA4 numeric property ID
//        GA_CLIENT_EMAIL   service account client_email (…@….iam.gserviceaccount.com)
//        GA_PRIVATE_KEY    service account private_key (full PEM; literal \n are converted)
//
// Endpoint:
//   GET /api/analytics?period=month   -> totals, daily series, channels, top pages, landing pages
//   GET /api/analytics?period=all     -> last 365 days

const crypto = require('crypto');

function num(x){ const n = Number(x); return isFinite(n) ? n : 0; }
function b64url(buf){ return Buffer.from(buf).toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_'); }

function shortLabel(yyyymmdd){
  const s = String(yyyymmdd||''); if(s.length!==8) return s;
  try { const d = new Date(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8)); return d.getDate()+' '+d.toLocaleString('en',{ month:'short' }); }
  catch(e){ return s; }
}
function durationLabel(seconds){
  const s = Math.round(num(seconds)); const m = Math.floor(s/60); return m+'m '+(s%60)+'s';
}

// Mint (and warm-cache) an OAuth access token from the service account via a signed JWT.
let _tok = { token:null, exp:0 };
async function getAccessToken(clientEmail, privateKey){
  const now = Math.floor(Date.now()/1000);
  if(_tok.token && _tok.exp - 60 > now) return _tok.token;
  const header = b64url(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const signingInput = header + '.' + claim;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  const assertion = signingInput + '.' + b64url(signature);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(assertion)
  });
  const j = await r.json().catch(()=>({}));
  if(!r.ok || !j.access_token) throw new Error((j.error_description || j.error || 'Google auth failed').toString().split('\n')[0]);
  _tok = { token: j.access_token, exp: now + (num(j.expires_in)||3600) };
  return _tok.token;
}

// Exchange a stored OAuth user refresh token for a short-lived access token (and warm-cache it).
async function getRefreshedToken(clientId, clientSecret, refreshToken){
  const now = Math.floor(Date.now()/1000);
  if(_tok.token && _tok.exp - 60 > now) return _tok.token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token' +
      '&client_id=' + encodeURIComponent(clientId) +
      '&client_secret=' + encodeURIComponent(clientSecret) +
      '&refresh_token=' + encodeURIComponent(refreshToken)
  });
  const j = await r.json().catch(()=>({}));
  if(!r.ok || !j.access_token) throw new Error((j.error_description || j.error || 'Google OAuth refresh failed').toString().split('\n')[0]);
  _tok = { token: j.access_token, exp: now + (num(j.expires_in)||3600) };
  return _tok.token;
}

const dv = (row, i)=> (row && row.dimensionValues && row.dimensionValues[i] && row.dimensionValues[i].value) || '';
const mv = (row, i)=> num(row && row.metricValues && row.metricValues[i] && row.metricValues[i].value);

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  const propertyId = process.env.GA_PROPERTY_ID;
  const clientEmail = process.env.GA_CLIENT_EMAIL;
  let privateKey = process.env.GA_PRIVATE_KEY || '';
  privateKey = privateKey.replace(/\\n/g, '\n').replace(/^["']|["']$/g, '');
  // OAuth2 user credentials take precedence when present (no GA admin needed).
  const oauthClientId = process.env.GA_OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.GA_OAUTH_CLIENT_SECRET;
  const oauthRefresh = process.env.GA_OAUTH_REFRESH_TOKEN;
  const useOAuth = !!(oauthClientId && oauthClientSecret && oauthRefresh);
  const haveServiceAccount = !!(clientEmail && privateKey);
  const period = ((req.query && req.query.period) || 'month').toString();
  const startDate = period === 'all' ? '365daysAgo' : '30daysAgo';

  if(!propertyId || (!useOAuth && !haveServiceAccount)){
    res.status(200).json({ configured:false, ok:false, error:'Set GA_PROPERTY_ID plus either OAuth user vars (GA_OAUTH_CLIENT_ID, GA_OAUTH_CLIENT_SECRET, GA_OAUTH_REFRESH_TOKEN) or service-account vars (GA_CLIENT_EMAIL, GA_PRIVATE_KEY) in Vercel environment variables.' });
    return;
  }

  try {
    const token = useOAuth
      ? await getRefreshedToken(oauthClientId, oauthClientSecret, oauthRefresh)
      : await getAccessToken(clientEmail, privateKey);
    const range = [{ startDate, endDate: 'today' }];
    const requests = [
      { dateRanges: range, metrics: ['sessions','totalUsers','newUsers','bounceRate','averageSessionDuration','screenPageViewsPerSession','engagedSessions','conversions'].map(name=>({name})) },
      { dateRanges: range, dimensions:[{name:'date'}], metrics:[{name:'sessions'},{name:'bounceRate'}], orderBys:[{ dimension:{ dimensionName:'date' } }], limit: 400 },
      { dateRanges: range, dimensions:[{name:'sessionDefaultChannelGroup'}], metrics:[{name:'sessions'}], orderBys:[{ metric:{ metricName:'sessions' }, desc:true }], limit: 8 },
      { dateRanges: range, dimensions:[{name:'pageTitle'}], metrics:[{name:'screenPageViews'},{name:'sessions'}], orderBys:[{ metric:{ metricName:'screenPageViews' }, desc:true }], limit: 8 },
      { dateRanges: range, dimensions:[{name:'landingPage'}], metrics:[{name:'sessions'},{name:'bounceRate'},{name:'conversions'}], orderBys:[{ metric:{ metricName:'sessions' }, desc:true }], limit: 8 }
    ];
    const url = 'https://analyticsdata.googleapis.com/v1beta/properties/' + encodeURIComponent(propertyId) + ':batchRunReports';
    const r = await fetch(url, { method:'POST', headers:{ Authorization:'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ requests }) });
    const body = await r.json().catch(()=>({}));
    if(!r.ok){
      res.status(200).json({ configured:true, ok:false, status:r.status, error: (body && body.error && body.error.message) || ('GA4 error (status '+r.status+')') });
      return;
    }
    const rep = body.reports || [];
    const tRow = (rep[0] && rep[0].rows && rep[0].rows[0]) || null;
    const T = (i)=> tRow ? mv(tRow, i) : 0;
    const totals = {
      sessions: T(0), totalUsers: T(1), newUsers: T(2),
      bounceRate: +(T(3)*100).toFixed(1),
      avgSessionDuration: T(4), avgDurationLabel: durationLabel(T(4)),
      pagesPerSession: +T(5).toFixed(2),
      engagedSessions: T(6), conversions: Math.round(T(7))
    };
    const series = ((rep[1] && rep[1].rows) || []).map(row=>({ date: dv(row,0), label: shortLabel(dv(row,0)), sessions: mv(row,0), bounce: +(mv(row,1)*100).toFixed(1) }));
    const chRows = (rep[2] && rep[2].rows) || [];
    const chTotal = chRows.reduce((s,row)=>s+mv(row,0),0) || 1;
    const channels = chRows.map(row=>({ name: dv(row,0)||'(other)', sessions: mv(row,0), value: +(mv(row,0)/chTotal*100).toFixed(1) }));
    const topPages = ((rep[3] && rep[3].rows) || []).map(row=>({ page: dv(row,0)||'(not set)', views: mv(row,0), sessions: mv(row,1) }));
    const landingPages = ((rep[4] && rep[4].rows) || []).map(row=>{ const s=mv(row,0), c=Math.round(mv(row,2)); return { page: dv(row,0)||'(not set)', sessions: s, bounce: +(mv(row,1)*100).toFixed(1), conv: c, convRate: s? +(c/s*100).toFixed(1):0 }; });

    res.status(200).json({ configured:true, ok:true, fetchedAt:new Date().toISOString(), period, totals, series, channels, topPages, landingPages });
  } catch(e){
    res.status(200).json({ configured:true, ok:false, error: String(e && e.message ? e.message : e) });
  }
};

module.exports._test = { num, b64url, shortLabel, durationLabel, dv, mv, getRefreshedToken };
