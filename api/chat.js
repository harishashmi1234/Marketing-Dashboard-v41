// api/chat.js
// Vercel Serverless Function — secure proxy to a free LLM for the dashboard AI assistant.
//
// Supports two free providers. The API key is read from a server-side environment variable
// and is NEVER sent to the browser. The frontend posts the user's question plus a compact
// snapshot of the data it has already loaded on screen; this function wraps it into a prompt
// and returns the reply.
//
// Provider selection (first one whose key is present wins; override with CHAT_PROVIDER):
//   • Groq    — set GROQ_API_KEY   (free key: https://console.groq.com/keys)   [recommended]
//               optional GROQ_MODEL   (default "llama-3.3-70b-versatile")
//   • Gemini  — set GEMINI_API_KEY (free key: https://aistudio.google.com/app/apikey)
//               optional GEMINI_MODEL (default "gemini-2.0-flash")
//   Force one explicitly:  CHAT_PROVIDER = "groq" | "gemini"
//
// Request  (POST application/json):
//   { "messages": [ { "role": "user"|"assistant", "content": "..." }, ... ],
//     "context":  { ...compact dashboard snapshot... } }
// Response:
//   { ok: true, reply: "...", provider, model }   or   { ok: false, error: "..." }

const GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT =
  'You are the GSL Marketing Mirror AI assistant — a sharp, concise marketing analyst embedded ' +
  'inside a live marketing dashboard. You help the team understand and act on their real-time data ' +
  'across Meta Ads, Instagram, Facebook, LinkedIn, Google Analytics, the social content calendar, ' +
  'and Jira design tasks.\n\n' +
  'You are given a JSON snapshot of exactly what the user is currently seeing on the dashboard. ' +
  'Base every numeric claim on that snapshot — never invent figures. If a number is not present, ' +
  'say so plainly. Money is Indian Rupees (₹); large values may be shown in K / L (lakh) / Cr (crore). ' +
  'Common metrics: spend, impressions, reach, clicks, CTR, CPC, CPM, leads, CPL (cost per lead), ROAS.\n\n' +
  'Style: lead with the answer, then a tight reason. Use short bullet points and call out the ' +
  'specific campaign / platform / metric names from the data. When asked to analyse, surface what ' +
  'is over- or under-performing, likely causes, and one or two concrete next actions. Keep replies ' +
  'compact unless the user asks for depth. Use plain text and simple markdown only.';

/* ---------- helpers ---------- */
function clip(str, max) {
  str = String(str == null ? '' : str);
  return str.length > max ? str.slice(0, max) + '…[truncated]' : str;
}

// Keep the context payload bounded so we never blow the token / size budget.
// Free LLM tiers cap tokens-per-minute (Groq free ≈ 12k TPM), and the snapshot is resent
// every message, so cap it tight (~14k chars ≈ 3.5k tokens) as a hard backstop.
function safeContext(ctx) {
  let s;
  try { s = JSON.stringify(ctx); } catch (e) { return '{}'; }
  const MAX = 14000;
  return s.length > MAX ? s.slice(0, MAX) + ' …[snapshot truncated to stay within free-tier token limits]' : s;
}

function parseBody(req) {
  let b = req && req.body;
  if (b == null) return {};
  if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return {}; } }
  return b;
}

// Pick provider: explicit override, else whichever key exists (Groq first).
function pickProvider() {
  const forced = (process.env.CHAT_PROVIDER || '').toLowerCase().trim();
  if (forced === 'groq')   return process.env.GROQ_API_KEY ? 'groq' : null;
  if (forced === 'gemini') return process.env.GEMINI_API_KEY ? 'gemini' : null;
  if (process.env.GROQ_API_KEY)   return 'groq';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

/* ---------- Groq (OpenAI-compatible) ---------- */
async function callGroq(recent, snapshot) {
  const model = (process.env.GROQ_MODEL || GROQ_DEFAULT_MODEL).toString();
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: 'Current dashboard data snapshot (JSON):\n' + snapshot }
  ];
  recent.forEach((m) => {
    if (!m || !m.content) return;
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: clip(m.content, 8000) });
  });

  const r = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: 900 })
  });
  const data = await r.json();
  if (data.error) return { error: (data.error.message || 'Groq API error') };
  const reply = (((data.choices && data.choices[0]) || {}).message || {}).content;
  if (!reply || !reply.trim()) return { error: 'Empty response from Groq.' };
  return { reply: reply.trim(), model };
}

/* ---------- Gemini ---------- */
async function callGemini(recent, snapshot) {
  const model = (process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL).toString();
  const contents = recent
    .filter((m) => m && m.content)
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: clip(m.content, 8000) }] }));
  contents.unshift(
    { role: 'user', parts: [{ text: 'Here is the current dashboard data snapshot (JSON):\n' + snapshot }] },
    { role: 'model', parts: [{ text: 'Got it — I have the current dashboard data and will base my analysis on it.' }] }
  );

  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.4, topP: 0.9, maxOutputTokens: 1200 }
  };
  const url = GEMINI_BASE + '/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(process.env.GEMINI_API_KEY);

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (data.error) return { error: (data.error.message || 'Gemini API error') };
  const cand = (data.candidates && data.candidates[0]) || null;
  if (!cand) {
    const blocked = data.promptFeedback && data.promptFeedback.blockReason;
    return { error: blocked ? ('Request blocked: ' + blocked) : 'No response generated.' };
  }
  const parts = (cand.content && cand.content.parts) || [];
  const reply = parts.map((p) => (p && p.text) || '').join('').trim();
  if (!reply) return { error: 'Empty response (finish reason: ' + (cand.finishReason || 'unknown') + ').' };
  return { reply, model };
}

/* ---------- handler ---------- */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method && req.method !== 'POST') {
    res.status(200).json({ ok: false, error: 'Use POST with { messages, context }.' });
    return;
  }

  const provider = pickProvider();
  if (!provider) {
    res.status(200).json({
      ok: false, configured: false,
      error: 'AI assistant not configured. Set GROQ_API_KEY (free at https://console.groq.com/keys) or GEMINI_API_KEY in your environment variables.'
    });
    return;
  }

  const body = parseBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    res.status(200).json({ ok: false, error: 'No message provided.' });
    return;
  }

  const recent = messages.slice(-8);         // keep only the last ~8 turns (free-tier token budget)
  const snapshot = safeContext(body.context || {});

  try {
    const out = provider === 'groq'
      ? await callGroq(recent, snapshot)
      : await callGemini(recent, snapshot);

    if (out.error) { res.status(200).json({ ok: false, provider, error: out.error }); return; }
    res.status(200).json({ ok: true, provider, model: out.model, reply: out.reply });
  } catch (e) {
    res.status(200).json({ ok: false, provider, error: String(e && e.message ? e.message : e) });
  }
};

// Exported for unit testing
module.exports._test = { clip, safeContext, parseBody, pickProvider, SYSTEM_PROMPT };
