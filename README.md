# GSL Marketing Mirror — live Meta Ads + Instagram + LinkedIn

A marketing dashboard for Get Set Learn. Three live integrations, each via a secure serverless
function that holds its token **server-side** (the browser only ever calls `/api/...`). When a
backend isn't configured, that page falls back to sample data, so nothing ever breaks.

| Page | Source | Status |
|------|--------|--------|
| Performance | **Meta Ads** | Works once token + ad account ID are set (no approval needed) |
| Social → Instagram | **Instagram** | Code ready; needs Facebook Page access + IG_USER_ID |
| Social → Facebook | **Facebook Page** | Code ready; same Meta token + FB_PAGE_ID (page scopes) |
| Social → LinkedIn | **LinkedIn** | Code ready; needs LinkedIn's Community Management API approval + token |
| Design (Task Board) | **Jira** | Works once email + API token are set (no approval needed). Read-only mirror of a Jira project. |
| Content Calendar | **SharePoint Excel / Google Sheets** | Read-only live mirror of your calendar spreadsheet via Microsoft Graph (SharePoint/OneDrive Excel), the Google Sheets API, or a published CSV. |
| Website | **Google Analytics 4** | Live sessions/users/bounce/conversions, channels, top & landing pages via a GA4 service account. |

The three are NOT equal in effort: Meta is easy, Instagram needs a Page-access grant, LinkedIn
needs LinkedIn to approve your developer app. Details below.

## File structure (must be at the repo root)

```
your-repo/
├── public/
│   └── index.html        <- dashboard (served at /)
├── api/
│   ├── meta.js            <- Meta Ads proxy   (/api/meta)
│   ├── instagram.js       <- Instagram proxy  (/api/instagram)
│   └── linkedin.js        <- LinkedIn proxy   (/api/linkedin)
├── vercel.json
├── package.json
├── .env.example
└── .gitignore
```

No wrapper folder. With this layout, Vercel's **Root Directory stays blank**.

## How to use this file

1. **Unzip** it. Inside you'll see `public/`, `api/`, and the loose files above.
2. In your GitHub repo, make sure the **top level** shows `public` and `api` directly (not inside another folder). Upload by dragging the `public` folder, the `api` folder, and the loose files into the repo root.
3. In Vercel: **Settings -> Root Directory = blank**.
4. Add environment variables (below) for whichever integrations you're enabling.
5. **Redeploy** (Deployments -> latest -> "..." -> Redeploy). Env changes only apply to new deployments.

## Environment variables (Vercel -> Settings -> Environment Variables)

| Name | For | Value |
|------|-----|-------|
| `META_ACCESS_TOKEN` | Meta + Instagram | System User token (scopes below) |
| `META_AD_ACCOUNT_ID` | Meta | `556917763746521` |
| `IG_USER_ID` | Instagram | your Instagram professional account ID |
| `FB_PAGE_ID` | Facebook | your Facebook Page's numeric ID |
| `FB_PAGE_TOKEN` | Facebook | optional long-lived Page token (else fetched via /me/accounts) |
| `LINKEDIN_ACCESS_TOKEN` | LinkedIn | OAuth token w/ org analytics scopes |
| `LINKEDIN_ORG_ID` | LinkedIn | your Company Page's numeric org ID |
| `LINKEDIN_API_VERSION` | LinkedIn | optional, default `202505` |
| `JIRA_BASE_URL` | Jira | `https://getsetlearninfo.atlassian.net` |
| `JIRA_EMAIL` | Jira | the Atlassian login email that owns the API token |
| `JIRA_API_TOKEN` | Jira | API token from id.atlassian.com (not your password) |
| `JIRA_PROJECT_KEY` | Jira | optional, default `DES` (the Design project) |
| `JIRA_JQL` | Jira | optional, full JQL override of `JIRA_PROJECT_KEY` |
| `MS_TENANT_ID` | Calendar (MS) | Microsoft 365 tenant ID hosting the Excel file |
| `MS_CLIENT_ID` | Calendar (MS) | Azure AD app registration's client ID |
| `MS_CLIENT_SECRET` | Calendar (MS) | a client secret for that app |
| `MS_SHARE_URL` | Calendar (MS) | the Excel file's sharing link (or use MS_DRIVE_ID + MS_ITEM_ID) |
| `MS_SHEET_NAME` | Calendar (MS) | optional worksheet/tab name (default: first visible sheet) |
| `GOOGLE_SHEETS_ID` | Sheets | the spreadsheet ID from the sheet's URL |
| `GOOGLE_SHEETS_API_KEY` | Sheets | a Google API key (Sheets API enabled) |
| `GOOGLE_SHEETS_RANGE` | Sheets | optional, default `A1:Z2000` (or a tab name) |
| `GOOGLE_SHEETS_CSV_URL` | Sheets | alternative to the two above: a "Publish to web → CSV" URL |
| `GA_PROPERTY_ID` | Analytics | your GA4 numeric property ID (needed by both auth methods below) |
| `GA_OAUTH_CLIENT_ID` | Analytics (OAuth) | OAuth 2.0 client ID — use when you lack GA admin (see 6A) |
| `GA_OAUTH_CLIENT_SECRET` | Analytics (OAuth) | OAuth 2.0 client secret |
| `GA_OAUTH_REFRESH_TOKEN` | Analytics (OAuth) | refresh token from `scripts/ga-oauth.js` |
| `GA_CLIENT_EMAIL` | Analytics (service acct) | the service account's `client_email` — use when you have GA admin (see 6B) |
| `GA_PRIVATE_KEY` | Analytics (service acct) | the service account's `private_key` (full PEM, quoted) |
| `GROQ_API_KEY` | AI Assistant | free Groq key (see 7) — powers the in-dashboard chat (recommended) |
| `GROQ_MODEL` | AI Assistant | optional, default `llama-3.3-70b-versatile` |
| `GEMINI_API_KEY` | AI Assistant | alternative: free Google AI Studio key (see 7) |
| `GEMINI_MODEL` | AI Assistant | optional, default `gemini-2.0-flash` |
| `CHAT_PROVIDER` | AI Assistant | optional, force `groq` or `gemini` (default: whichever key is set, Groq first) |
| `DASHBOARD_USER` | Login | username for the access gate (see 8) — paired with `DASHBOARD_PASSWORD` |
| `DASHBOARD_PASSWORD` | Login | password for the access gate |
| `DASHBOARD_USERS` | Login | optional, multiple logins as `user1:pass1,user2:pass2` (combined with the single pair) |

---

## 1) Meta Ads (easiest — start here)

1. Generate a Meta **System User token** with `ads_read` (Business Settings -> System Users).
2. Set `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID` in Vercel, redeploy.
3. Verify: `https://<your-site>/api/meta` returns JSON; Performance page shows green "Live from Meta".

Reading your own ad account needs no App Review.

## 2) Instagram

Prerequisites: a Business/Creator Instagram **linked to a Facebook Page**, and your account must have access to that Page.

1. Regenerate `META_ACCESS_TOKEN` adding `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement` (keep `ads_read`). One token serves both Meta and Instagram.
2. Deploy, then open `https://<your-site>/api/instagram?resource=whoami` to find your Instagram account ID. Set it as `IG_USER_ID` and redeploy.
3. Verify: `https://<your-site>/api/instagram?resource=account` returns your profile; Social page shows purple "Live from Instagram".

Note: reading your own account needs only **Standard Access** (add the account to your app + Business Verification), not the full App Review. If `whoami` returns no Pages, your account lacks access to the Facebook Page — ask a GSL Page admin to add you to the Page.

The Social page shows live Instagram metrics: followers, reach, impressions, profile views, accounts engaged, interactions, likes, comments, saves, shares, link taps, engagement rate, format performance, and audience demographics (country / age / gender, where the account qualifies).

## 2b) Facebook Page

Same Meta token — just add the Page scopes and a Page ID.

1. Regenerate `META_ACCESS_TOKEN` adding `pages_read_engagement`, `read_insights`, `pages_show_list` (keep the other scopes).
2. Open `https://<your-site>/api/facebook?resource=whoami` to list the Pages your token manages; copy the chosen Page's `id` into `FB_PAGE_ID` and redeploy.
3. Verify: `https://<your-site>/api/facebook?resource=account` returns the page; the Social → Facebook tab shows a blue "Live from Facebook" badge.

Live Facebook metrics: followers, page likes, reach, impressions, engagements, engagement rate, new/net followers, page views, video views, a 30-day reach+engagement trend, recent posts (reactions/comments/shares), and fan demographics where Facebook still exposes them. Page insights need a **Page** access token — the proxy fetches it automatically from `/me/accounts`, or set `FB_PAGE_TOKEN` to skip that lookup.

## 3) LinkedIn (most involved — approval required)

LinkedIn is the strictest platform. Company Page analytics require the **Community Management API**, which LinkedIn must approve.

1. **Admin role**: you (or your token's user) must be an Admin of GSL's LinkedIn Company Page.
2. **Developer app + approval**: at linkedin.com/developers create an app linked to the GSL Company Page, then apply for **Community Management API** access (Development Tier, then Standard Tier with a screen recording). This is a review by LinkedIn and can take time.
3. **Token**: complete LinkedIn OAuth to get an access token with `r_organization_social` and `rw_organization_admin`. LinkedIn tokens expire (~60 days) and must be refreshed — there is no permanent token.
4. Set `LINKEDIN_ACCESS_TOKEN` in Vercel, deploy, then open `https://<your-site>/api/linkedin?resource=whoami` to list the organizations your token administers. Copy the number after `urn:li:organization:` into `LINKEDIN_ORG_ID` and redeploy.
5. Verify: `https://<your-site>/api/linkedin?resource=account` returns followers/impressions; Social page shows a "Live from LinkedIn" option (a platform switcher appears when both Instagram and LinkedIn are connected).

If `account` returns a 403 or "unavailable", your app likely isn't approved for that endpoint yet, or the token is missing a scope.

## 4) Jira (Design Task Board — easy, no approval needed)

The **Design → Task Board** mirrors a live Jira project. It is **read-only**: manage tasks in
Jira and the board reflects them within ~2 minutes. When Jira isn't configured, the board falls
back to the editable local sample tasks.

1. Create an **API token** at https://id.atlassian.com/manage-profile/security/api-tokens (this is
   tied to your Atlassian account; it is not your password).
2. Set `JIRA_BASE_URL` (e.g. `https://getsetlearninfo.atlassian.net`), `JIRA_EMAIL` (the account
   that owns the token), and `JIRA_API_TOKEN` in Vercel, then redeploy.
3. By default it pulls the **`DES` (Design)** project. To use another project set `JIRA_PROJECT_KEY`
   (e.g. `SMC`), or set `JIRA_JQL` for full control (e.g. `project = DES AND statusCategory != Done`).
4. Verify: `https://<your-site>/api/jira?resource=whoami` returns your account; the Design board
   shows a blue "Live from Jira" badge and the cards link to the issues.

How fields map onto the board:

- **Status** → columns by Jira status category: *To Do* (new), *In Progress* (indeterminate),
  *Done* (done). Any status named "Blocked" lands in the Blocked column.
- **Priority** → Highest/High → High, Medium → Medium, Low/Lowest → Low.
- **Assignee** → owner; **Due date** → due (overdue items flag red); the **summary** is auto-tagged
  to a vertical (HBI / STEM / YP / Bootcamps / AI / Social).

## 5) Content Calendar (live from your calendar spreadsheet)

The **Content Calendar** mirrors your social-media calendar spreadsheet **live** (polled ~60s). It is
**read-only**: edit the spreadsheet and the calendar updates. Click any date to see that day's posts;
click a post to see **every column** from its row. When no source is configured, the calendar falls
back to the editable local sample posts. The proxy auto-detects the source in this order:
**Microsoft Graph → Google Sheets API → published CSV.**

### A) Google Sheet — CSV export, NO API key (current setup)

The simplest path. Works for any sheet shared "Anyone with the link: Viewer".

1. Share the sheet: **Share → General access → Anyone with the link → Viewer**.
2. In Vercel set `GOOGLE_SHEETS_CSV_URL` to the sheet's export URL:
   `https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv` (the `<SHEET_ID>` is the long
   string in the sheet URL between `/d/` and `/edit`). For a tab other than the first, append
   `&gid=<tab gid>`. Redeploy.
3. Verify: `https://<your-site>/api/sheets` returns JSON with your rows; the calendar shows a green
   "Live from Google Sheets" badge.

A **banner/title row above the real header row is fine** — the proxy auto-detects the header row (the
first one with a Date column plus a Title/Status/Platform column).

### B) Google Sheets API key

Use this if you need a **specific named tab** or a tighter range. Enable the **Google Sheets API** at
console.cloud.google.com, create an **API key**, then set `GOOGLE_SHEETS_ID` and
`GOOGLE_SHEETS_API_KEY`; optionally `GOOGLE_SHEETS_RANGE` (default `A1:Z2000`, or a tab name).

### C) Microsoft Graph — SharePoint / OneDrive Excel

Use this if the calendar is an Excel file on SharePoint/OneDrive (a `...sharepoint.com/:x:/...` link).
Register an Azure AD app (*Entra ID → App registrations*), add a client secret, grant the application
permission **`Files.Read.All`** with **admin consent** (by a Microsoft 365 admin of the tenant hosting
the file), then set `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, and `MS_SHARE_URL` (optionally
`MS_SHEET_NAME`, or `MS_DRIVE_ID` + `MS_ITEM_ID`).

**Spreadsheet format (all sources):** the header row is auto-detected. Recognized columns (case-insensitive,
flexible): **date, title/post, platform/channel, status, vertical/category, owner/assignee,
caption/copy/notes, paid/type, link/url, time**. Dates can be `2026-06-10`, `10/06/2026`, `10-Jun`,
`June 10, 2026`, etc. (ambiguous `dd/mm` is read day-first). Every other column is passed through and
shown in the post's detail view, so nothing in your sheet is lost.

## 6) Google Analytics 4 (Website page)

The **Website** page shows live GA4 data (read-only), fetched server-side. When GA isn't configured
the page falls back to sample numbers. There are **two ways to authenticate** — pick **6A** if you
do **not** have GA Administrator rights (the common case), or **6B** if you do. `api/analytics.js`
prefers OAuth whenever the `GA_OAUTH_*` vars are present, otherwise it uses the service account.

You always need `GA_PROPERTY_ID` — the GA4 **numeric** property ID (not the `G-XXXX` measurement ID).
A Viewer can read it from the report URL — it's the `p########` number in
`analytics.google.com/analytics/web/#/p123456789/...` — or from Admin → Property Settings.

### 6A) OAuth user credentials — when you DON'T have GA admin (recommended)

This signs in as a **Google user who already has at least Viewer on the property** (e.g. your own
Gmail). Nothing has to be added inside GA, so you don't need Administrator access. The OAuth client
lives in **any Google Cloud project you own** — a free personal one is fine; it does **not** have to
be the property's project or the company project.

1. **Create your own Cloud project:** sign in to [console.cloud.google.com](https://console.cloud.google.com)
   with the Google account that has Viewer on the property → create a new project.
2. **Enable the API:** in that project, enable the **Google Analytics Data API**.
3. **OAuth consent screen:** *APIs & Services → OAuth consent screen* → User type **External** →
   fill the required fields → **Publish app → "In production"**. This matters: in "Testing" mode the
   refresh token silently **expires after 7 days**; "In production" makes it long-lived. (Your own
   one-time sign-in will show an "unverified app" warning — click **Advanced → Continue**.)
4. **Create the client:** *Credentials → Create credentials → OAuth client ID → Application type
   "Desktop app"*. Copy the **client ID** and **client secret**.
5. **Mint the refresh token:** from the repo root run
   `node scripts/ga-oauth.js <CLIENT_ID> <CLIENT_SECRET>`, open the printed URL, sign in with the
   account that has Viewer access, approve, and copy the `GA_OAUTH_REFRESH_TOKEN` it prints.
6. In Vercel set `GA_PROPERTY_ID`, `GA_OAUTH_CLIENT_ID`, `GA_OAUTH_CLIENT_SECRET`,
   `GA_OAUTH_REFRESH_TOKEN`, then **redeploy**.

### 6B) Service account — when you DO have GA admin

1. **Service account:** in [console.cloud.google.com](https://console.cloud.google.com) → *IAM & Admin
   → Service Accounts* → create one → *Keys → Add key → JSON*. Download the JSON.
2. **Enable the API:** in the same project, enable the **Google Analytics Data API**.
3. **Grant access:** in **GA4 → Admin → Property access management**, add the service account's
   `client_email` as a **Viewer**. (This step needs the Administrator role — if you can't do it, use 6A.)
4. In Vercel set `GA_PROPERTY_ID`, `GA_CLIENT_EMAIL` (`client_email` from the JSON), and
   `GA_PRIVATE_KEY` (`private_key` from the JSON — paste the whole PEM in quotes; `\n` escapes are
   handled automatically). Redeploy.

### Verify (either method)

`https://<your-site>/api/analytics` returns JSON with `"ok": true`; the Website page shows an orange
"Live from Google Analytics" badge. A response of `invalid_grant`/`account not found` means the
service-account path is misconfigured (switch to 6A); a `403 PERMISSION_DENIED` means the acting
identity isn't a Viewer on that property.

Live metrics: sessions, new users, bounce rate, avg session duration, pages/session, engaged
sessions, conversions, a daily sessions trend, channel breakdown, top pages, and landing-page
performance. The **SEO & search visibility** panel stays sample — that data comes from Search
Console, not GA — and is labeled as such.

---

## 7) AI Assistant (chat — free, grounded in your live data)

A floating chat button (bottom-right of every page) lets the team ask questions in plain
English about whatever the dashboard is currently showing — e.g. "which campaign has the best
CPL?", "summarise this month's spend", "where should I shift budget?". The assistant is
**read-only** and never modifies anything.

How it stays secure and free:
- The browser sends the user's question plus a **compact snapshot of the data already on screen**
  (Meta Ads campaigns/trend, Instagram/Facebook/LinkedIn totals, GA4, Jira, calendar) to
  `/api/chat`. No marketing tokens are involved in the chat path.
- `api/chat.js` is a serverless proxy (same pattern as the other integrations): it holds the LLM
  key server-side and the **key is never exposed to the browser**.
- Two free providers are supported. It auto-selects whichever key is present (Groq first); set
  `CHAT_PROVIDER` to force one.

### Provider A — Groq (recommended, most reliable free tier)
1. Get a free key at https://console.groq.com/keys (no credit card).
2. In Vercel set `GROQ_API_KEY` (optionally `GROQ_MODEL`, default `llama-3.3-70b-versatile`), redeploy.

### Provider B — Google Gemini
1. Get a free key at https://aistudio.google.com/app/apikey.
2. In Vercel set `GEMINI_API_KEY` (optionally `GEMINI_MODEL`, default `gemini-2.0-flash`), redeploy.
   - **Note:** if Gemini returns `quota exceeded … limit: 0`, your Google project is not eligible
     for the free tier (common in some regions / on projects with billing attached). Use Groq instead.

Then open the dashboard and click the ✨ button. If no key is set, the chat replies with a clear
"not configured" message instead of breaking. The model only sees the snapshot you send it; it
cannot reach your ad accounts directly.

---

## 8) Login / access control (restrict who can open the dashboard)

A single login gate protects **everything** — the dashboard page *and* every `/api/*` data
endpoint — so the data can't be reached without credentials. It uses HTTP Basic Auth via a
Vercel Routing Middleware (`middleware.mjs`): the browser shows its native login dialog, the
user signs in once, and the browser re-attaches the credentials to every request (so the live
data and the AI chat keep working).

How it stays secure and free:
- Credentials live **only** in server-side env vars — never shipped to the browser.
- Runs on Vercel's free middleware tier; no database, no third-party login service.
- Served over HTTPS, so credentials are encrypted in transit. Passwords are compared in
  constant time.

Setup:
1. In Vercel → Settings → Environment Variables, set **`DASHBOARD_USER`** and
   **`DASHBOARD_PASSWORD`** (use a long, random password).
2. For more than one login, also set **`DASHBOARD_USERS`** = `alice:pw1,bob:pw2` (it combines
   with the single pair above).
3. Redeploy. The gate is now live.

Notes:
- **No-lockout safety:** if none of these vars are set, the gate stays **off** (site open) — so
  you can't accidentally lock yourself out before configuring it. Set the vars to turn it on.
- This adds one dependency (`@vercel/functions`, already in `package.json`); Vercel installs it
  automatically on deploy. Don't add `"type":"module"` to `package.json` — the gate file is
  `middleware.mjs` precisely so the CommonJS `api/*.js` handlers keep working.
- Basic Auth has no "log out" button; to switch users, close the browser (or use a private
  window). To revoke access, change the password env var and redeploy.
- The same gate runs in local dev (`node server.js`) when the vars are present in `.env.local`.

---

## Local development

```bash
cp .env.example .env.local   # paste your real values
vercel dev
```

## Notes

- **Read-only:** all integrations only read; they cannot post, spend, or modify anything (Jira tasks are managed in Jira; the calendar is managed in Google Sheets).
- **Data freshness:** insights are near-real-time (aggregated with a short delay). Performance polls ~90s, Instagram ~120s, LinkedIn ~180s.
- **What's never "live":** competitor benchmarking and content-category breakdowns aren't provided by these APIs, so they remain planning aids.
- **Security:** never commit real tokens; if one leaks, revoke and regenerate, then update Vercel and redeploy.
