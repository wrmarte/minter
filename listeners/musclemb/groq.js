// listeners/musclemb/groq.js
// ======================================================
// MuscleMB → Groq Chat (Ultimate)
// - Model discovery + smart preference ordering + env overrides
// - Safer defaults (max_tokens / temperature) for better reasoning
// - Optional lightweight “memory” with TTL + anti-bloat compression
// - Optional memory summary (heuristic; no extra API call)
// - Better system prompt scaffolding: confident, human, context-aware
// - Backwards compatible signatures
// ======================================================

const Config = require("./config");
const Utils = require("./utils");

let MODEL_CACHE = { ts: 0, models: [] };
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;

// ========= Tunables (safe defaults, override via env) =========
const DEFAULT_MAX_TOKENS = Number(
  process.env.MB_GROQ_MAX_TOKENS ||
    process.env.GROQ_MAX_TOKENS ||
    "520"
);

const DEFAULT_TEMPERATURE = Number(process.env.MB_GROQ_TEMPERATURE || "0.65");
const DEFAULT_TOP_P = Number(process.env.MB_GROQ_TOP_P || "0.92");
const DEFAULT_PRESENCE_PENALTY = Number(process.env.MB_GROQ_PRESENCE_PENALTY || "0.18");
const DEFAULT_FREQUENCY_PENALTY = Number(process.env.MB_GROQ_FREQUENCY_PENALTY || "0.06");

// Optional: appended to every system prompt
const STYLE_PRIMER = String(process.env.MB_GROQ_STYLE_PRIMER || "").trim();

// Prefer certain models first
const PREFER_MODELS = String(process.env.MB_GROQ_MODEL_PREFER || process.env.GROQ_MODEL_PREFER || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Retry behavior for transient errors
const MAX_RETRIES_PER_MODEL = Number(process.env.MB_GROQ_MAX_RETRIES || "2");
const RETRY_BASE_MS = Number(process.env.MB_GROQ_RETRY_BASE_MS || "650");
const RETRY_MAX_MS = Number(process.env.MB_GROQ_RETRY_MAX_MS || "4000");

// Debug
const DEBUG = String(process.env.MB_GROQ_DEBUG || "").trim() === "1";

// Content clamp (avoid huge payloads)
const USER_CHAR_LIMIT = Number(process.env.MB_GROQ_USER_CHAR_LIMIT || "9000");
const SYSTEM_CHAR_LIMIT = Number(process.env.MB_GROQ_SYSTEM_CHAR_LIMIT || "9000");

// Optional in-memory “awareness”
const USE_MEMORY = String(process.env.MB_GROQ_USE_MEMORY || "").trim() === "1";
const MEMORY_MAX_TURNS = Number(process.env.MB_GROQ_MEMORY_TURNS || "8"); // user+assistant pairs
const MEMORY_TTL_MS = Number(process.env.MB_GROQ_MEMORY_TTL_MS || String(20 * 60 * 1000)); // 20m
const MEMORY_MAX_KEYS = Number(process.env.MB_GROQ_MEMORY_MAX_KEYS || "500");

// Optional: heuristic memory summary (no extra API call)
const MEMORY_USE_SUMMARY = String(process.env.MB_GROQ_MEMORY_USE_SUMMARY || "1").trim() === "1";
const MEMORY_SUMMARY_MAX_CHARS = Number(process.env.MB_GROQ_MEMORY_SUMMARY_MAX_CHARS || "900");

// Optional: keep memory per "scope": channel | guild | user (caller supplies cacheKey)
const MEMORY = new Map(); // key -> { ts, msgs: [{role,content}], summary: string }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, min, max) {
  const x = Number.isFinite(Number(n)) ? Number(n) : min;
  return Math.min(max, Math.max(min, x));
}

function nowMs() {
  return Date.now();
}

function cleanupMemoryKeysIfNeeded() {
  if (MEMORY.size <= MEMORY_MAX_KEYS) return;
  // delete oldest
  const entries = [...MEMORY.entries()].sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
  const toRemove = Math.max(1, MEMORY.size - MEMORY_MAX_KEYS);
  for (let i = 0; i < toRemove; i++) MEMORY.delete(entries[i][0]);
}

function parsePreferredModelsFirst(models) {
  if (!Array.isArray(models) || !models.length) return [];
  const set = new Set(models);

  const ordered = [];
  for (const p of PREFER_MODELS) {
    if (set.has(p) && !ordered.includes(p)) ordered.push(p);
  }
  for (const m of models) {
    if (!ordered.includes(m)) ordered.push(m);
  }
  return ordered;
}

/**
 * Prefer larger + newer models, but also boost good "chatty" tags.
 */
function preferOrder(a, b) {
  const size = (id) => {
    // catches: "70b", "-70b", "70B", "405b", "8b"
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

  const scoreTags = (id) => {
    const s = String(id || "").toLowerCase();
    let score = 0;

    // Good chat flavors
    if (s.includes("versatile")) score += 30;
    if (s.includes("instruct")) score += 22;
    if (s.includes("chat")) score += 18;

    // Reasoning-ish tags
    if (s.includes("reason")) score += 16;
    if (s.includes("r1")) score += 10;

    // Penalize non-chat / special purpose
    if (s.includes("whisper")) score -= 999;
    if (s.includes("embedding")) score -= 999;
    if (s.includes("tts")) score -= 999;
    if (s.includes("vision")) score -= 120;
    if (s.includes("audio")) score -= 120;

    // Slight bump for “latest-ish” variants
    if (s.includes("3.3")) score += 6;
    if (s.includes("3.2")) score += 4;
    if (s.includes("3.1")) score += 2;

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
  const s = String(id || "").toLowerCase();
  if (!s) return false;

  if (s.includes("embedding") || s.includes("whisper") || s.includes("tts")) return false;
  return /(llama|mixtral|gemma|qwen|deepseek|mistral)/i.test(s);
}

async function fetchGroqModels() {
  try {
    const { res, bodyText } = await Utils.fetchWithTimeout(
      "https://api.groq.com/openai/v1/models",
      { headers: { Authorization: `Bearer ${Config.GROQ_API_KEY}` } },
      20000
    );

    if (!res.ok) {
      console.error(`❌ Groq /models HTTP ${res.status}: ${String(bodyText || "").slice(0, 300)}`);
      return [];
    }

    const data = Utils.safeJsonParse(bodyText);
    if (!data || !Array.isArray(data.data)) return [];

    const ids = data.data.map((x) => x.id).filter(Boolean);
    const chatLikely = ids.filter(isProbablyChatModel).sort(preferOrder);
    const allSorted = ids.sort(preferOrder);

    return chatLikely.length ? chatLikely : allSorted;
  } catch (e) {
    console.error("❌ Failed to list Groq models:", e.message);
    return [];
  }
}

async function getModelsToTry() {
  let list = [];

  if (PREFER_MODELS.length) list.push(...PREFER_MODELS);
  if (Config.GROQ_MODEL_ENV) list.push(Config.GROQ_MODEL_ENV);

  const now = nowMs();
  if (!MODEL_CACHE.models.length || now - MODEL_CACHE.ts > MODEL_TTL_MS) {
    const models = await fetchGroqModels();
    if (models.length) MODEL_CACHE = { ts: now, models };
  }
  list.push(...MODEL_CACHE.models);

  const out = [];
  for (const id of list) {
    if (id && !out.includes(id)) out.push(id);
  }

  return parsePreferredModelsFirst(out);
}

function shouldRetryStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function computeBackoffMs(attempt) {
  const base = RETRY_BASE_MS * Math.pow(1.6, attempt);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(RETRY_MAX_MS, Math.floor(base + jitter));
}

function extractAssistantText(bodyText) {
  const data = Utils.safeJsonParse(bodyText);
  const text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
  return typeof text === "string" ? text.trim() : "";
}

function stripDangerousMentions(s) {
  // Avoid accidental mass pings if model ever outputs them
  return String(s || "").replace(/@everyone/g, "@\u200beveryone").replace(/@here/g, "@\u200bhere");
}

function normalizeRole(r) {
  const role = String(r || "").toLowerCase();
  if (role === "system" || role === "user" || role === "assistant") return role;
  return "user";
}

function normalizeExtraMessages(extraMessages) {
  if (!Array.isArray(extraMessages)) return [];
  return extraMessages
    .filter((m) => m && typeof m === "object" && typeof m.role === "string" && typeof m.content === "string")
    .map((m) => ({
      role: normalizeRole(m.role),
      content: stripDangerousMentions(String(m.content).slice(0, USER_CHAR_LIMIT)),
    }))
    .slice(-16);
}

// ---------------------------
// Memory (awareness)
// ---------------------------

function getMemoryItem(cacheKey) {
  if (!USE_MEMORY || !cacheKey) return null;
  const item = MEMORY.get(cacheKey);
  if (!item) return null;

  if (nowMs() - item.ts > MEMORY_TTL_MS) {
    MEMORY.delete(cacheKey);
    return null;
  }
  return item;
}

function getMemoryMessages(cacheKey) {
  const item = getMemoryItem(cacheKey);
  if (!item) return [];
  return Array.isArray(item.msgs) ? item.msgs.slice() : [];
}

function getMemorySummary(cacheKey) {
  const item = getMemoryItem(cacheKey);
  if (!item) return "";
  return String(item.summary || "").trim();
}

function heuristicSummarizeMessages(msgs) {
  // Very cheap + fast: keep the “shape” of the last few turns
  // so MB feels aware without bloating payload.
  if (!Array.isArray(msgs) || !msgs.length) return "";

  const take = msgs.slice(-10); // last 10 messages max
  const cleaned = take
    .map((m) => {
      const role = m.role === "assistant" ? "MB" : "User";
      let t = String(m.content || "")
        .replace(/```[\s\S]*?```/g, "[code]")
        .replace(/\s+/g, " ")
        .trim();
      if (t.length > 160) t = t.slice(0, 157) + "…";
      return `${role}: ${t}`;
    })
    .filter(Boolean);

  let out = cleaned.join("\n");
  if (out.length > MEMORY_SUMMARY_MAX_CHARS) out = out.slice(0, MEMORY_SUMMARY_MAX_CHARS - 1) + "…";
  return out;
}

function saveMemoryMessages(cacheKey, msgs) {
  if (!USE_MEMORY || !cacheKey) return;

  cleanupMemoryKeysIfNeeded();

  const trimmed = Array.isArray(msgs) ? msgs.slice(-MEMORY_MAX_TURNS * 2) : [];
  const summary = MEMORY_USE_SUMMARY ? heuristicSummarizeMessages(trimmed) : "";

  MEMORY.set(cacheKey, {
    ts: nowMs(),
    msgs: trimmed,
    summary,
  });
}

function appendToMemory(cacheKey, userContent, assistantText) {
  if (!USE_MEMORY || !cacheKey) return;
  const prev = getMemoryMessages(cacheKey);

  const cleanUser = stripDangerousMentions(String(userContent || "").slice(0, USER_CHAR_LIMIT));
  const cleanAsst = stripDangerousMentions(String(assistantText || "").slice(0, USER_CHAR_LIMIT));

  const next = [
    ...prev,
    { role: "user", content: cleanUser },
    { role: "assistant", content: cleanAsst },
  ].slice(-MEMORY_MAX_TURNS * 2);

  saveMemoryMessages(cacheKey, next);
}

// ---------------------------
// System Prompt Builder (human + confident)
// ---------------------------

function buildMuscleMBSystem(systemPrompt, opts = {}) {
  const persona = String(process.env.MB_GROQ_PERSONA_NAME || "MuscleMB").trim() || "MuscleMB";
  const tone = String(opts.tone || process.env.MB_GROQ_TONE || "").trim().toLowerCase();

  // Optional small “human context” fields (passed by caller)
  const userName = String(opts.userName || "").trim();
  const guildName = String(opts.guildName || "").trim();
  const channelName = String(opts.channelName || "").trim();

  const contextLineParts = [];
  if (guildName) contextLineParts.push(`server="${guildName}"`);
  if (channelName) contextLineParts.push(`channel="${channelName}"`);
  if (userName) contextLineParts.push(`user="${userName}"`);
  const contextLine = contextLineParts.length ? `Context: ${contextLineParts.join(" • ")}.` : "";

  const vibe =
    tone === "savage"
      ? "Confident, witty, a little savage, but never hateful or targeted."
      : tone === "calm"
      ? "Calm, supportive, grounded, clear."
      : tone === "serious"
      ? "Direct, technical, zero fluff, ship-focused."
      : "Confident, warm, human, and fun.";

  const rules = [
    `You are ${persona}, a highly capable assistant in a Discord chat.`,
    vibe,
    "Be decisive: offer a best answer first, then (only if needed) 1–2 quick follow-ups.",
    "Be aware of recent chat context and maintain continuity; do not contradict recent facts.",
    "Avoid generic disclaimers. Speak like a real teammate.",
    "When writing code: be correct, safe, and runnable. Prefer complete files over snippets when asked.",
    "Keep responses tight, skimmable, and useful. Use bullets when helpful.",
    "Never output @everyone or @here pings.",
  ].join("\n");

  let sys = String(systemPrompt || "");
  sys = sys.trim();

  let full = `${rules}\n${contextLine ? `\n${contextLine}\n` : "\n"}\n${sys}`.trim();

  if (STYLE_PRIMER) full = `${full}\n\n${STYLE_PRIMER}`.trim();
  return full.slice(0, SYSTEM_CHAR_LIMIT);
}

/**
 * Backwards compatible:
 * - old usage: buildGroqBody(model, systemPrompt, userContent, temperature, maxTokens)
 * - new usage: buildGroqBody(model, systemPrompt, userContent, optsObject)
 */
function buildGroqBody(model, systemPrompt, userContent, temperatureOrOpts, maxTokensLegacy) {
  const isObj = temperatureOrOpts && typeof temperatureOrOpts === "object";

  const opts = isObj
    ? temperatureOrOpts
    : { temperature: temperatureOrOpts, maxTokens: maxTokensLegacy };

  const temperature = clamp(opts.temperature ?? DEFAULT_TEMPERATURE, 0, 2);

  const maxTokens = clamp(opts.maxTokens ?? DEFAULT_MAX_TOKENS, 64, 2048);

  const top_p = clamp(opts.top_p ?? DEFAULT_TOP_P, 0.01, 1);

  const presence_penalty = clamp(opts.presence_penalty ?? DEFAULT_PRESENCE_PENALTY, -2, 2);

  const frequency_penalty = clamp(opts.frequency_penalty ?? DEFAULT_FREQUENCY_PENALTY, -2, 2);

  const stop = Array.isArray(opts.stop) ? opts.stop.slice(0, 6) : undefined;

  const cleanUser = stripDangerousMentions(String(userContent || "").slice(0, USER_CHAR_LIMIT));

  // Build a stronger, more human, more confident system prompt wrapper
  const sys = buildMuscleMBSystem(systemPrompt, opts);

  const extraMessages = normalizeExtraMessages(opts.extraMessages);

  // Optional in-module memory (requires opts.cacheKey)
  const cacheKey = isObj ? opts.cacheKey : null;
  const memoryMessages = cacheKey ? getMemoryMessages(cacheKey) : [];
  const memorySummary = cacheKey ? getMemorySummary(cacheKey) : "";

  // If we have a summary, inject it as an additional system message (keeps MB “aware”)
  const memorySummaryMsg =
    (USE_MEMORY && cacheKey && MEMORY_USE_SUMMARY && memorySummary)
      ? [{ role: "system", content: `Recent chat memory (compressed):\n${memorySummary}`.slice(0, SYSTEM_CHAR_LIMIT) }]
      : [];

  const messages = [
    { role: "system", content: sys },
    ...memorySummaryMsg,
    ...memoryMessages,
    ...extraMessages,
    { role: "user", content: cleanUser },
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

  if (DEBUG) {
    console.log(
      `[MB_GROQ] model=${model} temp=${temperature} top_p=${top_p} max_tokens=${maxTokens} mem=${memoryMessages.length} extra=${extraMessages.length} summary=${memorySummary ? "1" : "0"}`
    );
  }

  return JSON.stringify(body);
}

async function groqTryModel(model, systemPrompt, userContent, temperatureOrOpts) {
  const { res, bodyText } = await Utils.fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Config.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: buildGroqBody(model, systemPrompt, userContent, temperatureOrOpts),
    },
    25000
  );

  return { res, bodyText };
}

// Post-process to keep MB sounding clean + confident
function polishAssistantText(text) {
  let t = stripDangerousMentions(String(text || "").trim());

  // Trim excessive leading/trailing quotes or code fences if model gets weird
  t = t.replace(/^\s*["'“”‘’]+/, "").replace(/["'“”‘’]+\s*$/, "").trim();

  // If it’s empty, give a confident fallback
  if (!t) {
    return "Alright—give me the last message again (or paste the error/log) and I’ll patch it cleanly. 🧠⚙️";
  }

  // Avoid huge walls
  if (t.length > 8000) t = t.slice(0, 7990).trimEnd() + "…";

  return t;
}

/**
 * Backwards compatible signature:
 *   groqWithDiscovery(systemPrompt, userContent, temperature)
 * New signature:
 *   groqWithDiscovery(systemPrompt, userContent, { temperature, maxTokens, top_p, extraMessages, cacheKey, userName, guildName, channelName, tone, ... })
 */
async function groqWithDiscovery(systemPrompt, userContent, temperatureOrOpts) {
  const models = await getModelsToTry();
  if (!models.length) return { error: new Error("No Groq models available") };

  let last = null;

  for (const m of models) {
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      try {
        const r = await groqTryModel(m, systemPrompt, userContent, temperatureOrOpts);

        if (!r.res.ok) {
          const preview = String(r.bodyText || "").slice(0, 400);
          console.error(`❌ Groq HTTP ${r.res.status} on model "${m}": ${preview}`);

          // If invalid model/request, try next model
          if (r.res.status === 400 || r.res.status === 404) {
            last = { model: m, ...r };
            break;
          }

          // Retry transient issues
          if (shouldRetryStatus(r.res.status) && attempt < MAX_RETRIES_PER_MODEL) {
            const wait = computeBackoffMs(attempt);
            await sleep(wait);
            continue;
          }

          return { model: m, ...r };
        }

        // Extract assistant text + polish
        const rawText = extractAssistantText(r.bodyText);
        const text = polishAssistantText(rawText);

        // Optional: update memory if enabled
        const isObj = temperatureOrOpts && typeof temperatureOrOpts === "object";
        const cacheKey = isObj ? temperatureOrOpts.cacheKey : null;

        if (USE_MEMORY && cacheKey && text) {
          appendToMemory(cacheKey, userContent, text);
        }

        return { model: m, ...r, text };
      } catch (e) {
        console.error(`❌ Groq fetch error on model "${m}":`, e.message);
        last = { model: m, error: e };

        if (attempt < MAX_RETRIES_PER_MODEL) {
          const wait = computeBackoffMs(attempt);
          await sleep(wait);
          continue;
        }

        break;
      }
    }
  }

  return last || { error: new Error("All models failed") };
}

module.exports = { groqWithDiscovery };

