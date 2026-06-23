#!/usr/bin/env node
// scripts/ga-oauth.js
// One-time helper to mint a Google Analytics 4 OAuth **refresh token** for api/analytics.js.
// Zero dependencies — uses Node's built-in http/url + global fetch (Node >= 18).
//
// Use this when you do NOT have GA admin rights but your own Google account has at least
// Viewer access on the GA4 property. The Data API will then run as that user.
//
// Prerequisites (one time, in a Google Cloud project YOU own — a free personal one is fine):
//   1. Enable the "Google Analytics Data API".
//   2. OAuth consent screen: User type "External", then PUBLISH it to "In production"
//      (otherwise the refresh token silently expires after 7 days).
//   3. Create credentials → OAuth client ID → Application type "Desktop app". Copy the
//      client ID and client secret.
//
// Run:
//   node scripts/ga-oauth.js <CLIENT_ID> <CLIENT_SECRET>
//   (or set GA_OAUTH_CLIENT_ID / GA_OAUTH_CLIENT_SECRET and run with no args)
//
// Then open the printed URL, sign in with the account that has Viewer on the property,
// approve "View your Google Analytics data" (click Advanced → Continue past the
// "unverified app" warning — it is your own app), and the script prints the refresh token.

const http = require('http');
const { URL } = require('url');

const PORT = 5179;
const REDIRECT_URI = 'http://localhost:' + PORT;
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

const clientId = process.argv[2] || process.env.GA_OAUTH_CLIENT_ID;
const clientSecret = process.argv[3] || process.env.GA_OAUTH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('\nUsage: node scripts/ga-oauth.js <CLIENT_ID> <CLIENT_SECRET>');
  console.error('   or: set GA_OAUTH_CLIENT_ID and GA_OAUTH_CLIENT_SECRET, then run with no args.\n');
  process.exit(1);
}

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + [
  'client_id=' + encodeURIComponent(clientId),
  'redirect_uri=' + encodeURIComponent(REDIRECT_URI),
  'response_type=code',
  'scope=' + encodeURIComponent(SCOPE),
  'access_type=offline',
  'prompt=consent'
].join('&');

async function exchangeCode(code) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: [
      'code=' + encodeURIComponent(code),
      'client_id=' + encodeURIComponent(clientId),
      'client_secret=' + encodeURIComponent(clientSecret),
      'redirect_uri=' + encodeURIComponent(REDIRECT_URI),
      'grant_type=authorization_code'
    ].join('&')
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error_description || j.error || ('HTTP ' + r.status)).toString());
  return j;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT_URI);
  if (u.pathname !== '/') { res.writeHead(404); res.end('Not found'); return; }
  const err = u.searchParams.get('error');
  const code = u.searchParams.get('code');
  if (err) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Authorization failed: ' + err + '</h2>You can close this tab.');
    console.error('\n✗ Authorization failed:', err, '\n');
    server.close(); process.exit(1);
    return;
  }
  if (!code) { res.writeHead(400); res.end('Missing ?code'); return; }
  try {
    const tok = await exchangeCode(code);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Done — refresh token captured.</h2>You can close this tab and return to the terminal.');
    if (!tok.refresh_token) {
      console.error('\n✗ No refresh_token returned. Revoke the app at https://myaccount.google.com/permissions');
      console.error('  and run again (the consent screen must grant offline access with prompt=consent).\n');
      server.close(); process.exit(1);
      return;
    }
    console.log('\n✓ Success. Add these to your Vercel environment variables:\n');
    console.log('GA_OAUTH_CLIENT_ID=' + clientId);
    console.log('GA_OAUTH_CLIENT_SECRET=' + clientSecret);
    console.log('GA_OAUTH_REFRESH_TOKEN=' + tok.refresh_token);
    console.log('\n(Keep GA_PROPERTY_ID set to your GA4 numeric property ID.)\n');
    server.close(); process.exit(0);
  } catch (e) {
    res.writeHead(500); res.end('Token exchange failed: ' + e.message);
    console.error('\n✗ Token exchange failed:', e.message, '\n');
    server.close(); process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\nWaiting for Google sign-in on ' + REDIRECT_URI + ' ...');
  console.log('\n1) Open this URL in your browser (sign in with the account that has GA Viewer access):\n');
  console.log('   ' + authUrl + '\n');
  console.log('2) Approve access. This script will capture the token automatically.\n');
});
