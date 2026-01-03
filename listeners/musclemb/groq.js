// listeners/musclemb/groq.js
const Config = require('./config');
const Utils = require('./utils');

let MODEL_CACHE = { ts: 0, models: [] };
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;

// ========= Tunables (safe defaults, override via env) =========
// Your current max_tokens=140 is *very* limiting. Bump it.
const DEFAULT_MAX_TOKENS = Number(
  process.env.MB_GROQ_MAX_TOKENS ||
  process.env.GROQ_MAX_TOKENS ||
  '420'
);

// Sampling controls (OpenAI-compatible; Groq generally supports these)
const DEFAULT_TOP_P = Number(process.env.MB_GROQ_TOP_P || '0.92');
const DEFAULT_PRESENCE_PENALTY = Number(process.env.MB_GROQ_PRESENCE_PENALTY || '0.15');
const DEFAULT_FREQUENCY_PENALTY = Number(process.env.MB_GROQ_FREQUENCY_PENALTY || '0.05');

// Optional: append a consistent style primer to *every* system prompt
// (Example: "You are MuscleMB... be witty, confident, but helpful...")
const STYLE_PRIMER = String(process.env.MB_GROQ_STYLE_PRIMER || '').trim();

// Retry behavior for transient errors (429 / 5xx)
const MAX_RETRIES_PER_MODEL = Number(process.env.MB_GROQ_MAX_RETRIES || '2');
const RETRY_BASE_MS = Number(process.env.MB_GROQ_RETRY_BASE_MS || '650');
const RETRY_MAX_MS = Number(process.env.MB_GROQ_RETRY_MAX_MS || '4000');

// User content clamp (avoid huge payloads)
const USER_CHAR_LIMIT = Number(process.env.MB_GROQ_USER_CHAR_LIMIT || '8000');
const SYSTEM_CHAR_LIMIT = Number(process.env.MB_GROQ_SYSTEM_CHAR_LIMIT || '8000');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, min, max) {
  const x = Number.isFinite(Number(n)) ? Number(n) : min;
  return Math.min(max, Math.max(min, x));
}

/**
 * Prefer larger + newer models, but also boost good "chatty" tags.
 * Works on model id strings returned by Groq /models.
 */
function preferOrder(a, b) {
  const size = (id) => {
    // catches: "70b", "70B", "-70b", "llama3-70b", "llama-3.3-70b"
    const m = String(id || '').match(/(?:^|[^0-9])(\d+)\s*b\b|-(\d+)\s*b\b|\b(\d+)[bB]\b/i);
    const v = parseInt((m && (m[1] || m[2] || m[3])) || '0', 10);
    return Number.isFinite(v) ? v : 0;
  };

  const ver = (id) => {
    // catches 3, 3.1, 3.2, 3.3, etc
    const m = String(id || '').match(/(\d+(?:\.\d+)?)/);
    const v = m ? parseFloat(m[1]) : 0;
    return Number.isFinite(v) ? v : 0;
  };

  const scoreTags = (id) => {
    const s = String(id || '').toLowerCase();
    let score = 0;

    // Generally good chat flavors
    if (s.includes('versatile')) score += 30;
    if (s.includes('instruct')) score += 22;
    if (s.includes('chat')) score += 18;

    // Reasoning-ish tags (if they exist)
    if (s.includes('reason')) score += 16;
    if (s.includes('r1')) score += 10;

    // Penalize non-chat / special-purpose
    if (s.includes('whisper')) score -= 999;
    if (s.includes('embedding')) score -= 999;
    if (s.includes('tts')) score -= 999;
    if (s.includes('vision')) score -= 120; // not always bad, but usually not needed for MuscleMB
    if (s.includes('audio')) score -= 120;

    return score;
  };

  const sa = scoreTags(a);
  const sb = scoreTags(b);
  if (sb !== sa) return sb - sa;

  const szDiff = size(b) - size(a);
  if (szDiff) return szDiff;

  return ver(b) - ver(a);
}

function isProbablyChatModel(id) {
  const s = String(id || '').toLowerCase();
  if (!s) return false;

  // Exclude obvious non-chat models
  if (s.includes('embedding') || s.includes('whisper') || s.includes('tts')) return false;

  // Include likely chat LLM families
  return /(llama|mixtral|gemma|qwen|deepseek|mistral)/i.test(s);
}

async function fetchGroqModels() {
  try {
    const { res, bodyText } = await Utils.fetchWithTimeout(
      'https://api.groq.com/openai/v1/models',
      { headers: { 'Authorization': `Bearer ${Config.GROQ_API_KEY}` } },
      20000
    );

    if (!res.ok) {
      console.error(`❌ Groq /models HTTP ${res.status}: ${bodyText?.slice(0, 300)}`);
      return [];
    }

    const data = Utils.safeJsonParse(bodyText);
    if (!data || !Array.isArray(data.data)) return [];

    const ids = data.data.map(x => x.id).filter(Boolean);

    // Prefer chat-capable model families; fall back to anything if none match
    const chatLikely = ids.filter(isProbablyChatModel).sort(preferOrder);
    const allSorted = ids.sort(preferOrder);

    return chatLikely.length ? chatLikely : allSorted;
  } catch (e) {
    console.error('❌ Failed to list Groq models:', e.message);
    return [];
  }
}

async function getModelsToTry() {
  const list = [];
  if (Config.GROQ_MODEL_ENV) list.push(Config.GROQ_MODEL_ENV);

  const now = Date.now();
  if (!MODEL_CACHE.models.length || (now - MODEL_CACHE.ts) > MODEL_TTL_MS) {
    const models = await fetchGroqModels();
    if (models.length) MODEL_CACHE = { ts: now, models };
  }

  for (const id of MODEL_CACHE.models) {
    if (!list.includes(id)) list.push(id);
  }

  return list;
}

/**
 * Backwards compatible:
 * - old usage: buildGroqBody(model, systemPrompt, userContent, temperature, maxTokens)
 * - new usage: buildGroqBody(model, systemPrompt, userContent, optsObject)
 */
function buildGroqBody(model, systemPrompt, userContent, temperatureOrOpts, maxTokensLegacy) {
  const opts =
    (temperatureOrOpts && typeof temperatureOrOpts === 'object')
      ? temperatureOrOpts
      : { temperature: temperatureOrOpts, maxTokens: maxTokensLegacy };

  const temperature = clamp(
    (opts.temperature ?? 0.8),
    0,
    2
  );

  const maxTokens = clamp(
    (opts.maxTokens ?? DEFAULT_MAX_TOKENS),
    32,
    2048
  );

  const top_p = clamp(
    (opts.top_p ?? DEFAULT_TOP_P),
    0.01,
    1
  );

  const presence_penalty = clamp(
    (opts.presence_penalty ?? DEFAULT_PRESENCE_PENALTY),
    -2,
    2
  );

  const frequency_penalty = clamp(
    (opts.frequency_penalty ?? DEFAULT_FREQUENCY_PENALTY),
    -2,
    2
  );

  const stop = Array.isArray(opts.stop) ? opts.stop.slice(0, 6) : undefined;

  const cleanUser = String(userContent || '').slice(0, USER_CHAR_LIMIT);

  // Allow a style primer to enforce "MuscleMB vibe" consistently
  let sys = String(systemPrompt || '');
  if (STYLE_PRIMER) {
    sys = `${sys}\n\n${STYLE_PRIMER}`;
  }
  sys = sys.slice(0, SYSTEM_CHAR_LIMIT);

  // Optional "extraMessages" for better context-awareness (history)
  // Must be: [{role:'user'|'assistant', content:'...'}]
  const extraMessages = Array.isArray(opts.extraMessages)
    ? opts.extraMessages
        .filter(m => m && typeof m === 'object' && typeof m.role === 'string' && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: String(m.content).slice(0, USER_CHAR_LIMIT) }))
        .slice(-12) // keep it light; don't blow tokens
    : [];

  const messages = [
    { role: 'system', content: sys },
    ...extraMessages,
    { role: 'user', content: cleanUser },
  ];

  const body = {
    model,
    temperature,
    top_p,
    presence_penalty,
    frequency_penalty,
    max_tokens: maxTokens,
    messages,
    stream: false,
  };

  if (stop && stop.length) body.stop = stop;
  if (Number.isFinite(opts.seed)) body.seed = Number(opts.seed);

  return JSON.stringify(body);
}

async function groqTryModel(model, systemPrompt, userContent, temperatureOrOpts) {
  const { res, bodyText } = await Utils.fetchWithTimeout(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Config.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: buildGroqBody(model, systemPrompt, userContent, temperatureOrOpts, 140),
    },
    25000
  );

  return { res, bodyText };
}

function shouldRetryStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function computeBackoffMs(attempt) {
  // exponential-ish with jitter, capped
  const base = RETRY_BASE_MS * Math.pow(1.6, attempt);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(RETRY_MAX_MS, Math.floor(base + jitter));
}

/**
 * Backwards compatible signature:
 *   groqWithDiscovery(systemPrompt, userContent, temperature)
 * New signature:
 *   groqWithDiscovery(systemPrompt, userContent, { temperature, maxTokens, top_p, ... })
 */
async function groqWithDiscovery(systemPrompt, userContent, temperatureOrOpts) {
  const models = await getModelsToTry();
  if (!models.length) return { error: new Error('No Groq models available') };

  let last = null;

  for (const m of models) {
    // Per-model retry loop for transient failures
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      try {
        const r = await groqTryModel(m, systemPrompt, userContent, temperatureOrOpts);

        if (!r.res.ok) {
          const preview = (r.bodyText || '').slice(0, 400);
          console.error(`❌ Groq HTTP ${r.res.status} on model "${m}": ${preview}`);

          // If invalid model/request, try next model (no retry unless you want)
          if (r.res.status === 400 || r.res.status === 404) {
            last = { model: m, ...r };
            break; // next model
          }

          // Retry transient issues
          if (shouldRetryStatus(r.res.status) && attempt < MAX_RETRIES_PER_MODEL) {
            const wait = computeBackoffMs(attempt);
            await sleep(wait);
            continue;
          }

          // Non-retryable or exhausted retries: return this failure
          return { model: m, ...r };
        }

        return { model: m, ...r };
      } catch (e) {
        console.error(`❌ Groq fetch error on model "${m}":`, e.message);

        // Retry fetch/timeouts a bit
        last = { model: m, error: e };

        if (attempt < MAX_RETRIES_PER_MODEL) {
          const wait = computeBackoffMs(attempt);
          await sleep(wait);
          continue;
        }

        // exhausted retries; move to next model
        break;
      }
    }
  }

  return last || { error: new Error('All models failed') };
}

module.exports = { groqWithDiscovery };

