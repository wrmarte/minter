// listeners/musclemb/modelRouter.js
// ======================================================
// Model Router (optional)
// - Groq -> OpenAI -> Grok (OpenAI-compatible)
// - Designed to NEVER crash the bot
//
// ENVS:
//   MB_MODEL_ROUTER_ENABLED=1
//   OPENAI_API_KEY=...
//   OPENAI_MODEL=gpt-4o-mini (or any)
//   GROK_API_KEY=...
//   GROK_BASE_URL=https://api.x.ai/v1 (example)
//   GROK_MODEL=grok-2 (example)
// ======================================================

const { groqWithDiscovery } = require('./groq');

const ENABLED = String(process.env.MB_MODEL_ROUTER_ENABLED || '0').trim() === '1';
const DEBUG = String(process.env.MB_MODEL_ROUTER_DEBUG || '').trim() === '1';

function isEnabled() {
  return ENABLED;
}

function hasOpenAI() {
  return Boolean((process.env.OPENAI_API_KEY || '').trim());
}

function hasGrok() {
  return Boolean((process.env.GROK_API_KEY || '').trim() && (process.env.GROK_BASE_URL || '').trim());
}

async function postJSON(url, headers, body) {
  const f = global.fetch ? global.fetch : require('node-fetch');
  const res = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { res, text, json };
}

function buildMessages(system, user, extraMessages) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: String(system) });
  if (Array.isArray(extraMessages) && extraMessages.length) {
    for (const m of extraMessages) {
      if (!m?.role || !m?.content) continue;
      msgs.push({ role: m.role, content: String(m.content) });
    }
  }
  msgs.push({ role: 'user', content: String(user || '') });
  return msgs;
}

async function tryOpenAI({ system, user, temperature, extraMessages }) {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return { ok: false };

  const model = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const url = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions';

  const messages = buildMessages(system, user, extraMessages);

  const body = {
    model,
    messages,
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    max_tokens: 220,
  };

  const { res, json, text } = await postJSON(
    url,
    { Authorization: `Bearer ${apiKey}` },
    body
  );

  if (!res.ok) {
    if (DEBUG) console.warn(`[MB_ROUTER] OpenAI HTTP ${res.status}: ${text?.slice(0, 300)}`);
    return { ok: false };
  }

  const out = json?.choices?.[0]?.message?.content;
  return { ok: Boolean(out), text: out || '' };
}

async function tryGrok({ system, user, temperature, extraMessages }) {
  const apiKey = (process.env.GROK_API_KEY || '').trim();
  const base = (process.env.GROK_BASE_URL || '').trim().replace(/\/$/, '');
  if (!apiKey || !base) return { ok: false };

  const model = (process.env.GROK_MODEL || '').trim() || 'grok-2';
  const url = base + '/chat/completions';

  const messages = buildMessages(system, user, extraMessages);

  const body = {
    model,
    messages,
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    max_tokens: 220,
  };

  const { res, json, text } = await postJSON(
    url,
    { Authorization: `Bearer ${apiKey}` },
    body
  );

  if (!res.ok) {
    if (DEBUG) console.warn(`[MB_ROUTER] Grok HTTP ${res.status}: ${text?.slice(0, 300)}`);
    return { ok: false };
  }

  const out = json?.choices?.[0]?.message?.content;
  return { ok: Boolean(out), text: out || '' };
}

async function generate({ system, user, temperature, extraMessages, cacheKey }) {
  // 1) Groq first (keeps your exact current behavior style)
  try {
    const groqTry = await groqWithDiscovery(system, user, {
      temperature,
      extraMessages,
      cacheKey,
    });

    if (groqTry?.res?.ok) {
      let data = null;
      try { data = JSON.parse(groqTry.bodyText || ''); } catch {}
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) return { ok: true, provider: 'groq', text };
    }
  } catch (e) {
    if (DEBUG) console.warn('[MB_ROUTER] groq failed:', e?.message || String(e));
  }

  // 2) OpenAI fallback
  if (hasOpenAI()) {
    try {
      const r = await tryOpenAI({ system, user, temperature, extraMessages });
      if (r.ok) return { ok: true, provider: 'openai', text: r.text };
    } catch (e) {
      if (DEBUG) console.warn('[MB_ROUTER] openai failed:', e?.message || String(e));
    }
  }

  // 3) Grok fallback
  if (hasGrok()) {
    try {
      const r = await tryGrok({ system, user, temperature, extraMessages });
      if (r.ok) return { ok: true, provider: 'grok', text: r.text };
    } catch (e) {
      if (DEBUG) console.warn('[MB_ROUTER] grok failed:', e?.message || String(e));
    }
  }

  return {
    ok: false,
    hint: '⚠️ MB’s brain providers all timed out. Try again in a sec. ⏱️',
  };
}

module.exports = {
  isEnabled,
  generate,
};
