// listeners/musclemb/modelRouter.js
// ======================================================
// Model Router (optional)
// - If enabled: tries Groq (via groqWithDiscovery) first,
//   then OpenAI, then Grok (OpenAI-compatible endpoint).
// - Safe defaults: OFF, never crashes the bot.
// ======================================================

const Config = require('./config');
const { groqWithDiscovery } = require('./groq');

// ✅ PATCH: node-fetch v3 is ESM; use dynamic import correctly
async function fetchOpen(url, options) {
  const mod = await import('node-fetch');
  const fetch = mod.default;
  return fetch(url, options);
}

function isEnabled() {
  return Boolean(Config.MB_MODEL_ROUTER_ENABLED);
}

function debugLog(...args) {
  if (Config.MB_MODEL_ROUTER_DEBUG) console.log('[MB_ROUTER]', ...args);
}

function safeStr(s, max = 4000) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function buildMessages(system, user, extraMessages = []) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: safeStr(system, 3500) });

  if (Array.isArray(extraMessages) && extraMessages.length) {
    for (const m of extraMessages) {
      const role = (m?.role === 'assistant') ? 'assistant' : 'user';
      const content = safeStr(m?.content, 900);
      if (content) msgs.push({ role, content });
    }
  }

  if (user) msgs.push({ role: 'user', content: safeStr(user, 1500) });
  return msgs;
}

async function tryOpenAICompat({ baseUrl, apiKey, model, system, user, temperature, extraMessages }) {
  if (!apiKey || apiKey.trim().length < 10) return { ok: false, hint: 'missing api key' };
  if (!baseUrl || baseUrl.trim().length < 8) return { ok: false, hint: 'missing base url' };

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';

  const body = {
    model: model || 'gpt-4o-mini',
    temperature: typeof temperature === 'number' ? temperature : 0.7,
    messages: buildMessages(system, user, extraMessages),
  };

  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${apiKey}`,
  };

  try {
    // ✅ PATCH: correct fetch usage
    const res = await fetchOpen(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();

    if (!res.ok) {
      debugLog('OpenAI-compat HTTP', res.status, text.slice(0, 200));
      return { ok: false, hint: `http ${res.status}` };
    }

    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    const out = data?.choices?.[0]?.message?.content;
    const finalText = safeStr(out, 2200);

    if (!finalText) return { ok: false, hint: 'empty response' };
    return { ok: true, text: finalText };
  } catch (e) {
    debugLog('OpenAI-compat error', e?.message || e);
    return { ok: false, hint: 'network error' };
  }
}

// ======================================================
// Public: generate()
// ======================================================
async function generate({ client, system, user, temperature = 0.7, extraMessages = [], cacheKey = '' }) {
  // 1) Always try Groq first
  try {
    const groqTry = await groqWithDiscovery(system, user, { temperature, extraMessages, cacheKey });

    // ✅ PATCH: groqWithDiscovery already returns .text when successful
    if (groqTry && groqTry.text && String(groqTry.text).trim().length) {
      debugLog('Groq OK', groqTry.model);
      return { ok: true, text: safeStr(groqTry.text, 2200), provider: 'groq', model: groqTry.model };
    }

    debugLog('Groq failed', groqTry?.res?.status, groqTry?.model, groqTry?.error?.message || '');
  } catch (e) {
    debugLog('Groq throw', e?.message || e);
  }

  // 2) OpenAI fallback (optional)
  if (Config.OPENAI_API_KEY) {
    const r = await tryOpenAICompat({
      baseUrl: Config.OPENAI_BASE_URL,
      apiKey: Config.OPENAI_API_KEY,
      model: Config.OPENAI_MODEL,
      system,
      user,
      temperature,
      extraMessages,
    });
    if (r.ok) {
      debugLog('OpenAI OK', Config.OPENAI_MODEL);
      return { ok: true, text: r.text, provider: 'openai', model: Config.OPENAI_MODEL };
    }
  }

  // 3) Grok fallback (optional)
  if (Config.GROK_API_KEY && Config.GROK_BASE_URL) {
    const r = await tryOpenAICompat({
      baseUrl: Config.GROK_BASE_URL,
      apiKey: Config.GROK_API_KEY,
      model: Config.GROK_MODEL,
      system,
      user,
      temperature,
      extraMessages,
    });
    if (r.ok) {
      debugLog('Grok OK', Config.GROK_MODEL);
      return { ok: true, text: r.text, provider: 'grok', model: Config.GROK_MODEL };
    }
  }

  return { ok: false, hint: 'All models failed (Groq/OpenAI/Grok)' };
}

module.exports = {
  isEnabled,
  generate,
};
