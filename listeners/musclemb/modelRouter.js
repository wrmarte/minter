// listeners/musclemb/modelRouter.js
// ======================================================
// Model Router
// - Groq -> OpenAI -> Grok (optional)
// - OpenAI/Grok use OpenAI-compatible /chat/completions
// ======================================================

const Config = require('./config');
const { groqWithDiscovery } = require('./groq');

const CACHE = new Map(); // cacheKey -> { ts, text }
const CACHE_TTL_MS = 12_000;

function isEnabled() {
  return Boolean(Config.MB_MODEL_ROUTER_ENABLED);
}

function nowMs() { return Date.now(); }

function getCached(cacheKey) {
  if (!cacheKey) return null;
  const hit = CACHE.get(cacheKey);
  if (!hit) return null;
  if (nowMs() - hit.ts > CACHE_TTL_MS) {
    CACHE.delete(cacheKey);
    return null;
  }
  return hit.text || null;
}

function setCached(cacheKey, text) {
  if (!cacheKey || !text) return;
  CACHE.set(cacheKey, { ts: nowMs(), text: String(text) });
  // simple bound
  if (CACHE.size > 500) {
    const first = CACHE.keys().next().value;
    if (first) CACHE.delete(first);
  }
}

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return `${b}/${p}`;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 18_000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, text, json };
  } catch (e) {
    return { ok: false, status: 0, text: '', json: null, error: e };
  } finally {
    clearTimeout(t);
  }
}

async function callOpenAICompatible({ baseUrl, apiKey, model, messages, temperature }) {
  if (!apiKey || String(apiKey).trim().length < 10) {
    return { ok: false, hint: 'Missing API key.' };
  }
  if (!baseUrl || String(baseUrl).trim().length < 8) {
    return { ok: false, hint: 'Missing base URL.' };
  }

  const url = joinUrl(baseUrl, 'chat/completions');
  const payload = {
    model,
    temperature,
    messages,
  };

  const r = await fetchJsonWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    18_000
  );

  if (!r.ok) {
    const msg = r?.json?.error?.message || r.text?.slice(0, 180) || `HTTP ${r.status}`;
    return { ok: false, hint: msg, status: r.status };
  }

  const out = r.json?.choices?.[0]?.message?.content;
  if (!out || !String(out).trim()) {
    return { ok: false, hint: 'Empty completion.' };
  }

  return { ok: true, text: String(out).trim() };
}

async function generate({ client, system, user, temperature = 0.7, extraMessages = [], cacheKey = '' }) {
  try {
    // cache
    const cached = getCached(cacheKey);
    if (cached) return { ok: true, text: cached, provider: 'cache' };

    // 1) Groq first
    const groqTry = await groqWithDiscovery(system, user, { temperature, extraMessages, cacheKey });
    if (groqTry && !groqTry.error && groqTry.res?.ok) {
      let data = null;
      try { data = JSON.parse(groqTry.bodyText); } catch {}
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) {
        setCached(cacheKey, text);
        return { ok: true, text, provider: `groq:${groqTry.model || 'auto'}` };
      }
    }

    // 2) OpenAI (optional)
    const hasOpenAI = Config.OPENAI_API_KEY && String(Config.OPENAI_API_KEY).trim().length > 10;
    if (hasOpenAI) {
      const messages = [
        { role: 'system', content: String(system || '') },
        ...(Array.isArray(extraMessages) ? extraMessages : []),
        { role: 'user', content: String(user || '') }
      ];

      const r = await callOpenAICompatible({
        baseUrl: Config.OPENAI_BASE_URL,
        apiKey: Config.OPENAI_API_KEY,
        model: Config.OPENAI_MODEL,
        messages,
        temperature,
      });

      if (r.ok) {
        setCached(cacheKey, r.text);
        return { ok: true, text: r.text, provider: 'openai' };
      }

      if (Config.MB_MODEL_ROUTER_DEBUG) {
        console.warn('[MB_ROUTER] OpenAI failed:', r.hint || r.status);
      }
    }

    // 3) Grok/xAI (optional, OpenAI-compatible)
    const hasGrok = Config.GROK_API_KEY && String(Config.GROK_API_KEY).trim().length > 10
      && Config.GROK_BASE_URL && String(Config.GROK_BASE_URL).trim().length > 8;

    if (hasGrok) {
      const messages = [
        { role: 'system', content: String(system || '') },
        ...(Array.isArray(extraMessages) ? extraMessages : []),
        { role: 'user', content: String(user || '') }
      ];

      const r = await callOpenAICompatible({
        baseUrl: Config.GROK_BASE_URL,
        apiKey: Config.GROK_API_KEY,
        model: Config.GROK_MODEL,
        messages,
        temperature,
      });

      if (r.ok) {
        setCached(cacheKey, r.text);
        return { ok: true, text: r.text, provider: 'grok' };
      }

      if (Config.MB_MODEL_ROUTER_DEBUG) {
        console.warn('[MB_ROUTER] Grok failed:', r.hint || r.status);
      }
    }

    return { ok: false, hint: '⚠️ All model providers failed (Groq/OpenAI/Grok).' };
  } catch (e) {
    return { ok: false, hint: e?.message || 'Router crashed.' };
  }
}

module.exports = {
  isEnabled,
  generate,
};

