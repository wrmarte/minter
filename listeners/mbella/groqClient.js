// listeners/mbella/groqClient.js
// ======================================================
// Groq client with model discovery + retries
// ======================================================

const fetch = require("node-fetch");
const Utils = require("./utils");

let MODEL_CACHE = { ts: 0, models: [] };
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;

function preferOrder(a, b) {
  const size = (id) => {
    const s = String(id || "");
    const m = s.match(/(?:^|[^0-9])(\d{1,4})\s*b\b|-(\d{1,4})\s*b\b|\b(\d{1,4})[bB]\b/i);
    const v = parseInt((m && (m[1] || m[2] || m[3])) || "0", 10);
    return Number.isFinite(v) ? v : 0;
  };
  const ver = (id) => {
    const m = String(id || "").match(/(\d+(?:\.\d+)?)/);
    const v = m ? parseFloat(m[1]) : 0;
    return Number.isFinite(v) ? v : 0;
  };

  const szDiff = size(b) - size(a);
  if (szDiff) return szDiff;
  return ver(b) - ver(a);
}

function shouldRetryStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function computeBackoffMs(attempt, baseMs = 650, maxMs = 4000) {
  const base = baseMs * Math.pow(1.6, attempt);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(maxMs, Math.floor(base + jitter));
}

async function fetchGroqModels(apiKey) {
  try {
    const { res, bodyText } = await Utils.fetchWithTimeout(
      fetch,
      "https://api.groq.com/openai/v1/models",
      { headers: { Authorization: `Bearer ${apiKey}` } },
      20_000
    );

    if (!res.ok) {
      console.error(`❌ Groq /models HTTP ${res.status}: ${String(bodyText || "").slice(0, 300)}`);
      return [];
    }

    const data = Utils.safeJsonParse(bodyText);
    if (!data || !Array.isArray(data.data)) return [];

    const ids = data.data.map((x) => x.id).filter(Boolean);
    const chatLikely = ids
      .filter((id) => /llama|mixtral|gemma|qwen|deepseek|mistral/i.test(String(id)))
      .sort(preferOrder);

    return chatLikely.length ? chatLikely : ids.sort(preferOrder);
  } catch (e) {
    console.error("❌ Failed to list Groq models:", e.message);
    return [];
  }
}

async function getModelsToTry({ apiKey, modelEnv }) {
  const list = [];

  if (modelEnv) list.push(modelEnv);

  const now = Date.now();
  if (!MODEL_CACHE.models.length || now - MODEL_CACHE.ts > MODEL_TTL_MS) {
    const models = await fetchGroqModels(apiKey);
    if (models.length) MODEL_CACHE = { ts: now, models };
  }

  for (const id of MODEL_CACHE.models) if (id && !list.includes(id)) list.push(id);
  return list;
}

function buildBody({ model, systemPrompt, messages, temperature, maxTokens, top_p, presence_penalty, frequency_penalty }) {
  // clamp
  const temp = Math.max(0, Math.min(1.2, Number(temperature)));
  const max_tokens = Math.max(96, Math.min(900, Number(maxTokens || 320)));

  const safeMsgs = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.role === "string" && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000) }))
    .slice(-24);

  return JSON.stringify({
    model,
    temperature: temp,
    top_p: Number.isFinite(Number(top_p)) ? Number(top_p) : 0.92,
    presence_penalty: Number.isFinite(Number(presence_penalty)) ? Number(presence_penalty) : 0.25,
    frequency_penalty: Number.isFinite(Number(frequency_penalty)) ? Number(frequency_penalty) : 0.07,
    max_tokens,
    messages: [{ role: "system", content: String(systemPrompt || "").slice(0, 9000) }, ...safeMsgs],
    stream: false,
  });
}

async function groqTryModel({ apiKey, model, systemPrompt, messages, temperature, maxTokens, top_p, presence_penalty, frequency_penalty }) {
  const { res, bodyText } = await Utils.fetchWithTimeout(
    fetch,
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: buildBody({ model, systemPrompt, messages, temperature, maxTokens, top_p, presence_penalty, frequency_penalty }),
    },
    25_000
  );

  return { res, bodyText };
}

/**
 * groqWithDiscovery
 * Input:
 * {
 *   apiKey, modelEnv,
 *   systemPrompt, messages,
 *   temperature, maxTokens,
 *   debug, maxRetriesPerModel,
 * }
 */
async function groqWithDiscovery(opts) {
  const apiKey = String(opts?.apiKey || "").trim();
  if (!apiKey || apiKey.length < 10) return { error: new Error("Missing GROQ_API_KEY") };

  const models = await getModelsToTry({ apiKey, modelEnv: String(opts?.modelEnv || "").trim() });
  if (!models.length) return { error: new Error("No Groq models available") };

  const maxRetriesPerModel = Number.isFinite(Number(opts?.maxRetriesPerModel)) ? Number(opts.maxRetriesPerModel) : 2;
  const retryBase = Number.isFinite(Number(opts?.retryBaseMs)) ? Number(opts.retryBaseMs) : 650;
  const retryMax = Number.isFinite(Number(opts?.retryMaxMs)) ? Number(opts.retryMaxMs) : 4000;

  let last = null;

  for (const m of models) {
    for (let attempt = 0; attempt <= maxRetriesPerModel; attempt++) {
      try {
        const r = await groqTryModel({
          apiKey,
          model: m,
          systemPrompt: opts.systemPrompt,
          messages: opts.messages,
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          top_p: opts.top_p,
          presence_penalty: opts.presence_penalty,
          frequency_penalty: opts.frequency_penalty,
        });

        if (!r.res.ok) {
          console.error(`❌ Groq (MBella) HTTP ${r.res.status} on model "${m}": ${String(r.bodyText || "").slice(0, 400)}`);

          if (r.res.status === 400 || r.res.status === 404) {
            last = { model: m, ...r };
            break;
          }

          if (shouldRetryStatus(r.res.status) && attempt < maxRetriesPerModel) {
            await Utils.sleep(computeBackoffMs(attempt, retryBase, retryMax));
            continue;
          }

          return { model: m, ...r };
        }

        return { model: m, ...r };
      } catch (e) {
        console.error(`❌ Groq (MBella) fetch error on model "${m}":`, e.message);
        last = { model: m, error: e };

        if (attempt < maxRetriesPerModel) {
          await Utils.sleep(computeBackoffMs(attempt, retryBase, retryMax));
          continue;
        }

        break;
      }
    }
  }

  return last || { error: new Error("All models failed") };
}

module.exports = {
  groqWithDiscovery,
};
