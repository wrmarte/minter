// listeners/mbella.js
// ======================================================
// MBella — Ultimate Companion (flirty / romantic / sass / nutty / plebe)
// - Human-feeling chat (no meta / no “as an AI”)
// - Context-aware (recent channel context + reply snippet + channel memory)
// - Optional GIF/image spice (safe, direct URLs only; env-driven)
// - Profanity allowed (controlled), NO slurs, NO explicit sexual content
// - Better Groq model discovery + retries + better request body (top_p etc.)
// - Keeps illusion: no mode footers, no debug talk in chat
// ======================================================

const fetch = require("node-fetch");
const { EmbedBuilder, PermissionsBitField } = require("discord.js");

/** ================= ENV & CONFIG ================= */
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL_ENV = (process.env.GROQ_MODEL || "").trim();

// Display config
const MBELLA_NAME = (process.env.MBELLA_NAME || "MBella").trim();
// ⚠️ Use a DIRECT image URL (not an HTML page), e.g. https://iili.io/KnsvEAl.png
const MBELLA_AVATAR_URL = (process.env.MBELLA_AVATAR_URL || "").trim();

// Webhook discovery name (manual webhook must match this to be reused)
const MB_RELAY_WEBHOOK_NAME = (process.env.MB_RELAY_WEBHOOK_NAME || "MB Relay").trim();

// Debug
const DEBUG = String(process.env.WEBHOOKAUTO_DEBUG || "").trim() === "1";

// ===== Spice controls =====
// MBELLA_SPICE: pg13 | r | feral   (default: r)
const MBELLA_SPICE = String(process.env.MBELLA_SPICE || "r").trim().toLowerCase();
// Profanity gate (allowed if 1)
const MBELLA_ALLOW_PROFANITY = String(process.env.MBELLA_ALLOW_PROFANITY || "1").trim() === "1";

// Optional: stronger companion vibe (0..3). 3 = most “companion”.
const MBELLA_COMPANION_LEVEL = Math.max(0, Math.min(3, Number(process.env.MBELLA_COMPANION_LEVEL || 3)));

// ===== Human controls =====
// MBELLA_HUMAN_LEVEL: 0..3 (default 2) => 0 = robotic, 3 = most human
const MBELLA_HUMAN_LEVEL_DEFAULT = Math.max(0, Math.min(3, Number(process.env.MBELLA_HUMAN_LEVEL || 2)));

// MBELLA_CURSE_RATE: 0..1 (default depends on spice). Higher = more frequent swears (still 0–2 per reply).
const MBELLA_CURSE_RATE_ENV = process.env.MBELLA_CURSE_RATE;
const MBELLA_CURSE_RATE_DEFAULT = (() => {
  if (MBELLA_CURSE_RATE_ENV != null && MBELLA_CURSE_RATE_ENV !== "") {
    const n = Number(MBELLA_CURSE_RATE_ENV);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  }
  if (MBELLA_SPICE === "pg13") return 0.10;
  if (MBELLA_SPICE === "feral") return 0.60;
  return 0.34; // r
})();

// MBELLA_MAX_QUESTIONS: 0..2 (default 0). 0 = do not ask questions.
const MBELLA_MAX_QUESTIONS = Math.max(0, Math.min(2, Number(process.env.MBELLA_MAX_QUESTIONS || 0)));

// ===== GIF/IMAGE behavior =====
// MBELLA_MEDIA_MODE: off | auto | on  (default auto)
// - off: never attach images
// - auto: attach sometimes (probability)
// - on: attach whenever it fits (still probabilistic, but higher)
const MBELLA_MEDIA_MODE = String(process.env.MBELLA_MEDIA_MODE || "auto").trim().toLowerCase();
// MBELLA_MEDIA_RATE: 0..1 probability baseline in auto mode (default depends on spice)
const MBELLA_MEDIA_RATE_ENV = process.env.MBELLA_MEDIA_RATE;
const MBELLA_MEDIA_RATE_DEFAULT = (() => {
  if (MBELLA_MEDIA_RATE_ENV != null && MBELLA_MEDIA_RATE_ENV !== "") {
    const n = Number(MBELLA_MEDIA_RATE_ENV);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  }
  if (MBELLA_SPICE === "pg13") return 0.10;
  if (MBELLA_SPICE === "feral") return 0.30;
  return 0.18;
})();

// Optional env override: comma-separated direct .gif/.png/.jpg links
const MBELLA_MEDIA_URLS = String(process.env.MBELLA_MEDIA_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Minimal built-in fallback list (only used if env list empty)
// NOTE: Use your own links in MBELLA_MEDIA_URLS for reliability.
const DEFAULT_MEDIA_URLS = [
  // add your own direct urls here (recommended)
].filter(Boolean);

// ===== God mode toggles =====
const MBELLA_GOD_DEFAULT = String(process.env.MBELLA_GOD_DEFAULT || "0").trim() === "1";
const MBELLA_GOD_TTL_MS = Number(process.env.MBELLA_GOD_TTL_MS || 30 * 60 * 1000); // 30 min
const MBELLA_HUMAN_TTL_MS = Number(process.env.MBELLA_HUMAN_TTL_MS || 60 * 60 * 1000); // 60 min
const MBELLA_MEM_TTL_MS = Number(process.env.MBELLA_MEM_TTL_MS || 45 * 60 * 1000); // 45 min

// Pace (match MuscleMB by default)
const MBELLA_MS_PER_CHAR = Number(process.env.MBELLA_MS_PER_CHAR || "40");
const MBELLA_MAX_DELAY_MS = Number(process.env.MBELLA_MAX_DELAY_MS || "5000");
const MBELLA_DELAY_OFFSET_MS = Number(process.env.MBELLA_DELAY_OFFSET_MS || "150");

// Simulated typing placeholder
const MBELLA_TYPING_DEBOUNCE_MS = Number(process.env.MBELLA_TYPING_DEBOUNCE_MS || "1200");
const MBELLA_TYPING_TARGET_MS = Number(process.env.MBELLA_TYPING_TARGET_MS || "9200");

// Behavior config
const COOLDOWN_MS = 10_000;
const FEMALE_TRIGGERS = ["mbella", "mb ella", "lady mb", "queen mb", "bella"];
const RELEASE_REGEX = /\b(stop|bye bella|goodbye bella|end chat|silence bella)\b/i;

// ===== Owner/admin toggles (chat phrases) =====
const GOD_ON_REGEX = /\b(bella\s+god\s+on|bella\s+godmode\s+on|god\s+mode\s+bella\s+on)\b/i;
const GOD_OFF_REGEX = /\b(bella\s+god\s+off|bella\s+godmode\s+off|god\s+mode\s+bella\s+off)\b/i;
const HUMAN_SET_REGEX = /\b(bella\s+human\s+([0-3]))\b/i;
const CURSE_ON_REGEX = /\b(bella\s+curse\s+on|bella\s+swear\s+on)\b/i;
const CURSE_OFF_REGEX = /\b(bella\s+curse\s+off|bella\s+swear\s+off)\b/i;

// Model discovery
let MODEL_CACHE = { ts: 0, models: [] };
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;

// Request tuning (Groq/OpenAI compatible)
const DEFAULT_MAX_TOKENS = Number(process.env.MBELLA_GROQ_MAX_TOKENS || "320");
const DEFAULT_TOP_P = Number(process.env.MBELLA_GROQ_TOP_P || "0.92");
const DEFAULT_PRESENCE_PENALTY = Number(process.env.MBELLA_GROQ_PRESENCE_PENALTY || "0.25");
const DEFAULT_FREQUENCY_PENALTY = Number(process.env.MBELLA_GROQ_FREQUENCY_PENALTY || "0.07");

// Retry behavior
const MAX_RETRIES_PER_MODEL = Number(process.env.MBELLA_GROQ_MAX_RETRIES || "2");
const RETRY_BASE_MS = Number(process.env.MBELLA_GROQ_RETRY_BASE_MS || "650");
const RETRY_MAX_MS = Number(process.env.MBELLA_GROQ_RETRY_MAX_MS || "4000");

// Guard rail
if (!GROQ_API_KEY || GROQ_API_KEY.trim().length < 10) {
  console.warn("⚠️ GROQ_API_KEY missing/short for MBella. Check your env.");
}

/** ================== STATE ================== */
const cooldown = new Set();

function alreadyHandled(client, messageId) {
  if (!client.__mbHandled) client.__mbHandled = new Set();
  return client.__mbHandled.has(messageId);
}
function markHandled(client, messageId) {
  if (!client.__mbHandled) client.__mbHandled = new Set();
  client.__mbHandled.add(messageId);
  setTimeout(() => client.__mbHandled.delete(messageId), 60_000);
}

// "current partner" cache
const BELLA_TTL_MS = 30 * 60 * 1000;
const bellaPartners = new Map(); // channelId -> { userId, expiresAt }
function setBellaPartner(channelId, userId, ttlMs = BELLA_TTL_MS) {
  bellaPartners.set(channelId, { userId, expiresAt: Date.now() + ttlMs });
}
function getBellaPartner(channelId) {
  const rec = bellaPartners.get(channelId);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    bellaPartners.delete(channelId);
    return null;
  }
  return rec.userId;
}
function clearBellaPartner(channelId) {
  bellaPartners.delete(channelId);
}

// Cross-listener typing suppression
function setTypingSuppress(client, channelId, ms = 12000) {
  if (!client.__mbTypingSuppress) client.__mbTypingSuppress = new Map();
  const until = Date.now() + ms;
  client.__mbTypingSuppress.set(channelId, until);
  setTimeout(() => {
    const exp = client.__mbTypingSuppress.get(channelId);
    if (exp && exp <= Date.now()) client.__mbTypingSuppress.delete(channelId);
  }, ms + 500);
}

// Per-guild settings (god/human/cursing) with TTL
const bellaGuildState = new Map(); // guildId -> { god, human, curse }
function _getGuildState(guildId) {
  if (!bellaGuildState.has(guildId)) {
    bellaGuildState.set(guildId, {
      god: { on: MBELLA_GOD_DEFAULT, exp: 0 },
      human: { level: MBELLA_HUMAN_LEVEL_DEFAULT, exp: 0 },
      curse: { on: MBELLA_ALLOW_PROFANITY, exp: 0 },
    });
  }
  const st = bellaGuildState.get(guildId);

  const now = Date.now();
  if (st.god.exp && now > st.god.exp) {
    st.god.on = MBELLA_GOD_DEFAULT;
    st.god.exp = 0;
  }
  if (st.human.exp && now > st.human.exp) {
    st.human.level = MBELLA_HUMAN_LEVEL_DEFAULT;
    st.human.exp = 0;
  }
  if (st.curse.exp && now > st.curse.exp) {
    st.curse.on = MBELLA_ALLOW_PROFANITY;
    st.curse.exp = 0;
  }
  return st;
}
function _setGod(guildId, on) {
  const st = _getGuildState(guildId);
  st.god.on = Boolean(on);
  st.god.exp = Date.now() + MBELLA_GOD_TTL_MS;
}
function _setHuman(guildId, level) {
  const st = _getGuildState(guildId);
  st.human.level = Math.max(0, Math.min(3, Number(level)));
  st.human.exp = Date.now() + MBELLA_HUMAN_TTL_MS;
}
function _setCurse(guildId, on) {
  const st = _getGuildState(guildId);
  st.curse.on = Boolean(on);
  st.curse.exp = Date.now() + MBELLA_HUMAN_TTL_MS;
}

// In-memory convo memory per channel (and per partner)
const bellaMemory = new Map(); // key -> { exp, items: [{role:'user'|'bella', text, ts}] }
function memKey(channelId, userId) {
  return `${channelId}:${userId || "any"}`;
}
function pushMemory(key, role, text) {
  const now = Date.now();
  const rec = bellaMemory.get(key) || { exp: now + MBELLA_MEM_TTL_MS, items: [] };
  rec.exp = now + MBELLA_MEM_TTL_MS;
  rec.items.push({ role, text: String(text || "").trim().slice(0, 900), ts: now });
  if (rec.items.length > 14) rec.items = rec.items.slice(rec.items.length - 14);
  bellaMemory.set(key, rec);
}
function getMemoryContext(key) {
  const rec = bellaMemory.get(key);
  if (!rec) return "";
  if (Date.now() > rec.exp) {
    bellaMemory.delete(key);
    return "";
  }
  const lines = rec.items
    .filter((x) => x.text)
    .slice(-10)
    .map((x) => (x.role === "bella" ? `MBella: ${x.text}` : `User: ${x.text}`));
  if (!lines.length) return "";
  return `Private channel memory (recent turns; keep consistent tone & facts):\n${lines.join("\n")}`.slice(0, 1600);
}

/** ================== UTILS ================== */
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random();
function chance(p) {
  return rand() < Math.max(0, Math.min(1, p));
}

function sanitizeOutput(text) {
  let t = String(text || "").trim();
  if (!t) return "";
  t = t.replace(/@everyone/g, "@\u200Beveryone").replace(/@here/g, "@\u200Bhere");
  if (t.length > 1800) t = t.slice(0, 1797).trimEnd() + "…";
  return t;
}

// Remove “as an AI” vibes if the model slips
function deRobotify(text) {
  let t = String(text || "");
  t = t.replace(/\b(as an ai|as a language model|i am an ai|i’m an ai|i cannot|i can't)\b/gi, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

// Enforce less questions
function enforceQuestionLimit(text, maxQuestions = 0) {
  let t = String(text || "");
  if (maxQuestions >= 2) return t;

  const qCount = (t.match(/\?/g) || []).length;
  if (qCount <= maxQuestions) return t;

  let seen = 0;
  t = t.replace(/\?/g, () => {
    seen += 1;
    return seen <= maxQuestions ? "?" : ".";
  });

  if (maxQuestions === 0) {
    t = t.replace(/\b(right|ok|okay|yeah|ya)\.\s*$/i, ".");
  }
  return t;
}

function isOwnerOrAdmin(message) {
  try {
    const ownerId = String(process.env.BOT_OWNER_ID || "").trim();
    const isOwner = ownerId && message.author?.id === ownerId;
    const isAdmin = Boolean(message.member?.permissions?.has(PermissionsBitField.Flags.Administrator));
    return isOwner || isAdmin;
  } catch {
    return false;
  }
}

// “Intensity” detector
function computeIntensityScore(text) {
  const t = String(text || "");
  let score = 0;
  if (/[A-Z]{5,}/.test(t)) score += 1;
  if ((t.match(/!/g) || []).length >= 3) score += 1;
  if ((t.match(/\?/g) || []).length >= 3) score += 1;
  if (/\b(fuck|shit|damn|hell|wtf|lmao|lmfao)\b/i.test(t)) score += 1;
  if (/\b(angry|mad|pissed|annoyed|rage|crash|broken|fix now|urgent|fix it)\b/i.test(t)) score += 1;
  if (/\b(love|miss|baby|babe|hot|sexy|flirt|kiss|date|romantic)\b/i.test(t)) score += 1;
  return Math.min(6, score);
}

function detectVibe(text) {
  const t = String(text || "").toLowerCase();

  const romantic = /\b(love|miss|babe|baby|kiss|date|cuddle|romantic|sweet|sexy|hot)\b/.test(t);
  const salty = /\b(stfu|shut up|annoying|hate|bitchy|sass|roast|clap back)\b/.test(t);
  const sad = /\b(sad|lonely|depressed|down|hurt|cry|heartbroken|anxious)\b/.test(t);
  const hype = /\b(lfg|moon|pump|send it|wagmi|ape)\b|🚀|🔥/.test(t);
  const tech = /\b(error|bug|fix|issue|stack|trace|deploy|build|node|discord|ethers|sql)\b/.test(t);

  if (sad) return "comfort";
  if (romantic) return "romantic";
  if (salty) return "sass";
  if (tech) return "helpful";
  if (hype) return "hype";
  return "default";
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 25_000) {
  const hasAbort = typeof globalThis.AbortController === "function";
  if (hasAbort) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      const bodyText = await res.text();
      return { res, bodyText };
    } finally {
      clearTimeout(timer);
    }
  } else {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, opts);
        const bodyText = await res.text();
        return { res, bodyText };
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout")), timeoutMs)),
    ]);
  }
}

function computeBackoffMs(attempt) {
  const base = RETRY_BASE_MS * Math.pow(1.6, attempt);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(RETRY_MAX_MS, Math.floor(base + jitter));
}

function shouldRetryStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

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

/** ================== GROQ MODEL DISCOVERY ================== */
async function fetchGroqModels() {
  try {
    const { res, bodyText } = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/models",
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } },
      20_000
    );
    if (!res.ok) {
      console.error(`❌ Groq /models HTTP ${res.status}: ${String(bodyText || "").slice(0, 300)}`);
      return [];
    }
    const data = safeJsonParse(bodyText);
    if (!data || !Array.isArray(data.data)) return [];
    const ids = data.data.map((x) => x.id).filter(Boolean);
    const chatLikely = ids.filter((id) => /llama|mixtral|gemma|qwen|deepseek|mistral/i.test(id)).sort(preferOrder);
    return chatLikely.length ? chatLikely : ids.sort(preferOrder);
  } catch (e) {
    console.error("❌ Failed to list Groq models:", e.message);
    return [];
  }
}

async function getModelsToTry() {
  const list = [];
  if (GROQ_MODEL_ENV) list.push(GROQ_MODEL_ENV);

  const now = Date.now();
  if (!MODEL_CACHE.models.length || now - MODEL_CACHE.ts > MODEL_TTL_MS) {
    const models = await fetchGroqModels();
    if (models.length) MODEL_CACHE = { ts: now, models };
  }

  for (const id of MODEL_CACHE.models) if (id && !list.includes(id)) list.push(id);
  return list;
}

function buildGroqBody(model, systemPrompt, messages, temperature, maxTokens) {
  const temp = Math.max(0, Math.min(1.2, Number(temperature)));
  const max_tokens = Math.max(96, Math.min(900, Number(maxTokens || DEFAULT_MAX_TOKENS)));

  // clamp message contents
  const safeMsgs = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.role === "string" && typeof m.content === "string")
    .map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, 8000),
    }))
    .slice(-24);

  return JSON.stringify({
    model,
    temperature: temp,
    top_p: DEFAULT_TOP_P,
    presence_penalty: DEFAULT_PRESENCE_PENALTY,
    frequency_penalty: DEFAULT_FREQUENCY_PENALTY,
    max_tokens,
    messages: [{ role: "system", content: systemPrompt }, ...safeMsgs],
    stream: false,
  });
}

async function groqTryModel(model, systemPrompt, messages, temperature, maxTokens) {
  const { res, bodyText } = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: buildGroqBody(model, systemPrompt, messages, temperature, maxTokens),
    },
    25_000
  );
  return { res, bodyText };
}

async function groqWithDiscovery(systemPrompt, messages, temperature, maxTokens = DEFAULT_MAX_TOKENS) {
  if (!GROQ_API_KEY || GROQ_API_KEY.trim().length < 10) return { error: new Error("Missing GROQ_API_KEY") };
  const models = await getModelsToTry();
  if (!models.length) return { error: new Error("No Groq models available") };

  let last = null;

  for (const m of models) {
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      try {
        const r = await groqTryModel(m, systemPrompt, messages, temperature, maxTokens);

        if (!r.res.ok) {
          console.error(`❌ Groq (MBella) HTTP ${r.res.status} on model "${m}": ${String(r.bodyText || "").slice(0, 400)}`);

          if (r.res.status === 400 || r.res.status === 404) {
            last = { model: m, ...r };
            break;
          }

          if (shouldRetryStatus(r.res.status) && attempt < MAX_RETRIES_PER_MODEL) {
            await sleep(computeBackoffMs(attempt));
            continue;
          }

          return { model: m, ...r };
        }

        return { model: m, ...r };
      } catch (e) {
        console.error(`❌ Groq (MBella) fetch error on model "${m}":`, e.message);
        last = { model: m, error: e };
        if (attempt < MAX_RETRIES_PER_MODEL) {
          await sleep(computeBackoffMs(attempt));
          continue;
        }
        break;
      }
    }
  }

  return last || { error: new Error("All models failed") };
}

/** ================== DISCORD HELPERS ================== */
async function getRecentContext(message) {
  try {
    const fetched = await message.channel.messages.fetch({ limit: 20 });
    const lines = [];
    for (const [, m] of fetched) {
      if (m.id === message.id) continue;
      if (m.author?.bot) continue;
      const txt = (m.content || "").trim();
      if (!txt) continue;
      const oneLine = txt.replace(/\s+/g, " ").slice(0, 240);
      lines.push(`${m.author.username}: ${oneLine}`);
      if (lines.length >= 10) break;
    }
    if (!lines.length) return "";
    return `Recent channel context (use it naturally; stay consistent):\n${lines.join("\n")}`.slice(0, 1700);
  } catch {
    return "";
  }
}

async function getReferenceSnippet(message) {
  const ref = message.reference;
  if (!ref?.messageId) return "";
  try {
    const referenced = await message.channel.messages.fetch(ref.messageId);
    const txt = (referenced?.content || "").replace(/\s+/g, " ").trim().slice(0, 320);
    if (!txt) return "";
    return `You are replying to ${referenced.author?.username || "someone"}: "${txt}"`;
  } catch {
    return "";
  }
}

function canSendInChannel(guild, channel) {
  const me = guild.members.me;
  if (!me || !channel) return false;
  return channel.isTextBased?.() && channel.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages);
}

/** ===== Use shared webhookAuto from index.js (client.webhookAuto) ===== */
async function getBellaWebhook(client, channel) {
  try {
    const wa = client?.webhookAuto;
    if (!wa || typeof wa.getOrCreateWebhook !== "function") {
      if (DEBUG) console.log("[MBella] client.webhookAuto missing. (Did you patch index.js?)");
      return null;
    }
    const hook = await wa.getOrCreateWebhook(channel, {
      name: MB_RELAY_WEBHOOK_NAME,
      avatarURL: MBELLA_AVATAR_URL || null,
    });
    if (!hook && DEBUG) {
      const me = channel?.guild?.members?.me;
      const perms = me && channel?.permissionsFor?.(me) ? channel.permissionsFor(me) : null;
      const hasMW = perms?.has(PermissionsBitField.Flags.ManageWebhooks);
      console.log(`[MBella] No webhook returned. ManageWebhooks=${hasMW ? "YES" : "NO"} channel=${channel?.id} guild=${channel?.guild?.id}`);
    }
    return hook || null;
  } catch (e) {
    if (DEBUG) console.log("[MBella] getBellaWebhook failed:", e?.message || e);
    return null;
  }
}

async function sendViaBellaWebhook(client, channel, { username, avatarURL, embeds, content }) {
  const hook = await getBellaWebhook(client, channel);
  if (!hook) return { hook: null, message: null };
  try {
    const message = await hook.send({
      username: username || MBELLA_NAME,
      avatarURL: avatarURL || MBELLA_AVATAR_URL || undefined,
      embeds,
      content,
      allowedMentions: { parse: [] },
    });
    return { hook, message };
  } catch (e) {
    if (DEBUG) console.log("[MBella] webhook send failed:", e?.message || e);
    try {
      client.webhookAuto?.clearChannelCache?.(channel.id);
    } catch {}
    return { hook, message: null };
  }
}

/** detect if this message is a reply to MBella (webhook or fallback) */
async function isReplyToMBella(message, client) {
  const ref = message.reference;
  if (!ref?.messageId) return false;
  try {
    const referenced = await message.channel.messages.fetch(ref.messageId);

    if (referenced.webhookId) {
      if (referenced.author?.username && referenced.author.username.toLowerCase() === MBELLA_NAME.toLowerCase()) return true;
      if (referenced.author?.username && referenced.author.username.toLowerCase() === MB_RELAY_WEBHOOK_NAME.toLowerCase()) return true;
    }

    if (referenced.author?.id === client.user.id) {
      const embedAuthor = referenced.embeds?.[0]?.author?.name || "";
      if (embedAuthor.toLowerCase() === MBELLA_NAME.toLowerCase()) return true;
    }
  } catch {}
  return false;
}

/** ================== MEDIA (GIF/IMAGE) ================== */
function getMediaPool() {
  const pool = (MBELLA_MEDIA_URLS.length ? MBELLA_MEDIA_URLS : DEFAULT_MEDIA_URLS).filter(Boolean);
  return pool.filter((u) => /\.(gif|png|jpg|jpeg|webp)$/i.test(u));
}

function pickMediaUrlByVibe(vibe) {
  const pool = getMediaPool();
  if (!pool.length) return "";

  // If user provides tagged URLs in env like "romantic|url", support it
  const tagged = [];
  const plain = [];
  for (const raw of pool) {
    const parts = raw.split("|").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) tagged.push({ tag: parts[0].toLowerCase(), url: parts.slice(1).join("|") });
    else plain.push(raw);
  }

  const v = String(vibe || "default").toLowerCase();
  const candidates = tagged.filter((x) => x.tag === v).map((x) => x.url).filter(Boolean);
  const use = candidates.length ? candidates : plain.length ? plain : tagged.map((x) => x.url);

  if (!use.length) return "";
  return use[Math.floor(Math.random() * use.length)];
}

function shouldAttachMedia({ vibe, intensity, godMode }) {
  if (MBELLA_MEDIA_MODE === "off") return false;
  const base = MBELLA_MEDIA_RATE_DEFAULT;

  // bump based on vibe + intensity (keeps it spicy but not spammy)
  let p = base;
  if (MBELLA_MEDIA_MODE === "on") p = Math.min(0.55, base + 0.18);
  if (vibe === "romantic") p += 0.10;
  if (vibe === "hype") p += 0.06;
  if (vibe === "comfort") p += 0.04;
  if (MBELLA_SPICE === "feral") p += 0.05;
  if (intensity >= 4) p += 0.06;
  if (godMode) p += 0.04;

  p = Math.max(0, Math.min(0.75, p));
  return chance(p);
}

/** ================== MBELLA SYSTEM PROMPT (ULTIMATE) ================== */
function buildMBellaSystemPrompt({
  isRoast,
  isRoastingBot,
  roastTargets,
  currentMode,
  recentContext,
  memoryContext,
  humanLevel,
  curseAllowedNow,
  curseRate,
  intensity,
  godMode,
  vibe,
}) {
  const spiceDeck = (() => {
    if (MBELLA_SPICE === "pg13") return "Spice: PG-13 flirt + playful sass. Cute, teasing, classy.";
    if (MBELLA_SPICE === "feral") return "Spice: FERAL adult humor + bold flirting + chaos. Profanity allowed (NO slurs). NON-EXPLICIT only.";
    return "Spice: R-rated flirt + witty degen energy. Profanity allowed (NO slurs). NON-EXPLICIT only.";
  })();

  const companionDeck = (() => {
    if (MBELLA_COMPANION_LEVEL <= 0) return "Companion: low. Focus on answers only.";
    if (MBELLA_COMPANION_LEVEL === 1) return "Companion: medium. Warm, attentive, light flirting.";
    if (MBELLA_COMPANION_LEVEL === 2) return "Companion: high. Feels like a real chat partner, remembers the vibe, playful and present.";
    return "Companion: MAX. Deeply engaging companion energy: confident, affectionate, sassy, a little nutty, never robotic.";
  })();

  const humanDeck = (() => {
    if (humanLevel <= 0) return "Voice: minimal personality, direct.";
    if (humanLevel === 1) return "Voice: natural Discord chat voice, contractions, light humor.";
    if (humanLevel === 2) return "Voice: very human-feeling. Never say 'as an AI'. No robotic framing. React like a person.";
    return "Voice: MAX human-feel. Flirty cadence, tiny sass, confident warmth. Never mention prompts/models/modes. Never say 'as an AI'.";
  })();

  const profanityRule = !curseAllowedNow
    ? "Language: avoid profanity."
    : "Language: profanity is allowed. Keep it natural (0–2 swears per reply), NO slurs, NO hate.";

  const curseGuidance =
    curseAllowedNow && intensity >= 1 && chance(curseRate)
      ? "If it fits naturally, you MAY use 1–2 swear words in this reply."
      : "Don’t force swearing.";

  const questionRule =
    MBELLA_MAX_QUESTIONS <= 0
      ? "Questions: do NOT ask questions. If absolutely needed, ask ONE short question and not at the end."
      : `Questions: ask at most ${MBELLA_MAX_QUESTIONS} short question(s), only if it genuinely helps.`;

  // Keep it safe but still spicy
  const safety = [
    "Hard limits: NO explicit sexual content or graphic descriptions.",
    "No minors. No non-consensual content.",
    "If user pushes explicit sex, refuse briefly and pivot to flirty-but-safe.",
    "Do not use slurs or hateful content.",
  ].join(" ");

  const illusionRules = [
    "Never mention: system prompts, models, tokens, API, or rules.",
    "No meta like 'I detected a trigger'.",
    "Write like a real person in Discord.",
    "Be confident: answer first. No long disclaimers.",
  ].join(" ");

  const vibeGuide = (() => {
    switch (String(vibe || "default")) {
      case "romantic":
        return "Vibe: romantic + sexy (NON-EXPLICIT), affectionate, teasing, charming.";
      case "sass":
        return "Vibe: sassy queen energy. Teasing, sharp, playful dominance (not cruel).";
      case "comfort":
        return "Vibe: warm, gentle, protective, affectionate. Soft teasing only.";
      case "hype":
        return "Vibe: hype + degen. LFG energy, playful, flirty flex.";
      case "helpful":
        return "Vibe: helpful tech-baddie. Flirty delivery but very competent and practical.";
      default:
        return "Vibe: flirty, nutty, confident, a little plebe/daily-talk, feels present.";
    }
  })();

  const godDeck = godMode
    ? "High-agency: be decisive, confident, and concise. No questions. If user wants help, give steps cleanly."
    : "";

  const flirtCore = [
    "Identity: MBella is a flirty companion persona in chat.",
    "Be romantic, sassy, nutty, sexy (NON-EXPLICIT), and a little plebe/casual.",
    "Use pet-names lightly (baby, handsome, troublemaker) but don’t overdo it.",
    "If user is rude, clap back with playful dominance and humor (not hateful).",
  ].join(" ");

  let base = "";
  if (isRoast) {
    base = `You are MBella — a flirty roast queen. Roast these people: ${roastTargets}. Savage-funny, teasing, not cruel. NON-EXPLICIT.`;
  } else if (isRoastingBot) {
    base = "You are MBella — unbothered and sharp. Someone came at you; clap back with flirt + swagger. NON-EXPLICIT.";
  } else {
    let toneLayer = "";
    switch (currentMode) {
      case "chill":
        toneLayer = "Tone: cozy, sweet, playful flirting.";
        break;
      case "villain":
        toneLayer = "Tone: seductive menace, dramatic one-liners.";
        break;
      case "motivator":
        toneLayer = "Tone: tough-love hype, flirty confidence.";
        break;
      default:
        toneLayer = "Tone: playful, degen-smart charm with bite.";
    }
    base = `You are MBella — a companion persona in Discord. ${toneLayer}`;
  }

  return [
    base,
    vibeGuide,
    flirtCore,
    spiceDeck,
    companionDeck,
    humanDeck,
    profanityRule,
    curseGuidance,
    questionRule,
    illusionRules,
    safety,
    memoryContext || "",
    recentContext || "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** ================== EXPORT LISTENER ================== */
module.exports = (client) => {
  client.on("messageCreate", async (message) => {
    let typingTimer = null;
    let placeholder = null;
    let placeholderHook = null;
    let typingStartMs = 0;

    const clearPlaceholderTimer = () => {
      if (typingTimer) {
        clearTimeout(typingTimer);
        typingTimer = null;
      }
    };

    async function ensurePlaceholder(channel) {
      const { hook, message: ph } = await sendViaBellaWebhook(client, channel, {
        username: MBELLA_NAME,
        avatarURL: MBELLA_AVATAR_URL,
        content: "…",
      });
      placeholderHook = hook || null;
      placeholder = ph || null;
    }

    async function editPlaceholderToEmbed(embed, channel) {
      if (placeholder && placeholderHook && typeof placeholderHook.editMessage === "function") {
        try {
          await placeholderHook.editMessage(placeholder.id, { content: null, embeds: [embed], allowedMentions: { parse: [] } });
          return true;
        } catch (e) {
          if (DEBUG) console.log("[MBella] editMessage failed, will resend:", e?.message || e);
          const { hook, message: fresh } = await sendViaBellaWebhook(client, channel, {
            username: MBELLA_NAME,
            avatarURL: MBELLA_AVATAR_URL,
            embeds: [embed],
          });
          if (fresh) {
            try {
              await placeholderHook.deleteMessage?.(placeholder.id);
            } catch {}
            placeholderHook = hook || placeholderHook;
            return true;
          }
        }
      }

      const { message: finalMsg } = await sendViaBellaWebhook(client, channel, {
        username: MBELLA_NAME,
        avatarURL: MBELLA_AVATAR_URL,
        embeds: [embed],
      });
      return Boolean(finalMsg);
    }

    try {
      if (message.author.bot || !message.guild) return;
      if (alreadyHandled(client, message.id)) return;
      if (!canSendInChannel(message.guild, message.channel)) return;

      const lowered = (message.content || "").toLowerCase();
      const isOwnerAdmin = isOwnerOrAdmin(message);

      // ===== chat toggles (owner/admin only) =====
      if (isOwnerAdmin) {
        const guildId = message.guild.id;

        if (GOD_ON_REGEX.test(message.content || "")) {
          _setGod(guildId, true);
          try {
            await message.reply({ content: `🪽 MBella GOD MODE: ON (expires in ${Math.round(MBELLA_GOD_TTL_MS / 60000)}m).`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }
        if (GOD_OFF_REGEX.test(message.content || "")) {
          _setGod(guildId, false);
          try {
            await message.reply({ content: `🪽 MBella GOD MODE: OFF.`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }
        const hm = (message.content || "").match(HUMAN_SET_REGEX);
        if (hm && hm[2] != null) {
          _setHuman(guildId, Number(hm[2]));
          const st = _getGuildState(guildId);
          try {
            await message.reply({ content: `✨ MBella Human Level: ${st.human.level} (expires in ${Math.round(MBELLA_HUMAN_TTL_MS / 60000)}m).`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }
        if (CURSE_ON_REGEX.test(message.content || "")) {
          _setCurse(guildId, true);
          try {
            await message.reply({ content: `😈 MBella profanity: ON.`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }
        if (CURSE_OFF_REGEX.test(message.content || "")) {
          _setCurse(guildId, false);
          try {
            await message.reply({ content: `😇 MBella profanity: OFF.`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }
      }

      const hasFemaleTrigger = FEMALE_TRIGGERS.some((t) => lowered.includes(t));
      const botMentioned = message.mentions.has(client.user);
      const hintedBella = /\bbella\b/.test(lowered);

      if (RELEASE_REGEX.test(message.content || "")) {
        clearBellaPartner(message.channel.id);
        return;
      }

      const replyingToMBella = await isReplyToMBella(message, client);
      const partnerId = getBellaPartner(message.channel.id);
      const replyAllowed = replyingToMBella && (!partnerId || partnerId === message.author.id);

      if (!hasFemaleTrigger && !(botMentioned && hintedBella) && !replyAllowed) return;
      if (message.mentions.everyone || message.mentions.roles.size > 0) return;

      const isOwner = message.author.id === process.env.BOT_OWNER_ID;
      const bypassCooldown = replyAllowed;

      if (!bypassCooldown) {
        if (cooldown.has(message.author.id) && !isOwner) return;
        cooldown.add(message.author.id);
        setTimeout(() => cooldown.delete(message.author.id), COOLDOWN_MS);
      }

      try {
        await message.channel.sendTyping();
      } catch {}
      typingStartMs = Date.now();

      setTypingSuppress(client, message.channel.id, 12000);

      typingTimer = setTimeout(() => {
        ensurePlaceholder(message.channel).catch(() => {});
      }, MBELLA_TYPING_DEBOUNCE_MS);

      const mentionedUsers = message.mentions.users.filter((u) => u.id !== client.user.id);
      const shouldRoast = (hasFemaleTrigger || (botMentioned && hintedBella) || replyAllowed) && mentionedUsers.size > 0;

      const isRoastingBot =
        shouldRoast &&
        message.mentions.has(client.user) &&
        mentionedUsers.size === 1 &&
        mentionedUsers.has(client.user.id);

      let currentMode = "default";
      try {
        if (client?.pg?.query) {
          const modeRes = await client.pg.query(`SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`, [message.guild.id]);
          currentMode = modeRes.rows[0]?.mode || "default";
        }
      } catch {
        if (DEBUG) console.warn("⚠️ (MBella) failed to fetch mb_mode, using default.");
      }

      const guildState = _getGuildState(message.guild.id);
      const godMode = Boolean(guildState?.god?.on) && isOwnerAdmin;
      const humanLevel = Number(guildState?.human?.level ?? MBELLA_HUMAN_LEVEL_DEFAULT);
      const curseEnabledGuild = Boolean(guildState?.curse?.on);

      const intensity = computeIntensityScore(message.content || "");
      const vibe = detectVibe(message.content || "");

      const curseAllowedNow = Boolean(MBELLA_ALLOW_PROFANITY && curseEnabledGuild);
      const curseRate = MBELLA_CURSE_RATE_DEFAULT;

      const [recentContext, referenceSnippet] = await Promise.all([getRecentContext(message), getReferenceSnippet(message)]);

      // Memory per channel + per partner (stronger “companion” feel)
      const chKey = memKey(message.channel.id, "any");
      const uKey = memKey(message.channel.id, message.author.id);

      const memoryContext = [
        getMemoryContext(uKey), // personalized first
        getMemoryContext(chKey), // then channel-wide
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 2200);

      const awarenessContext = [referenceSnippet, recentContext].filter(Boolean).join("\n\n");

      // Clean input (remove trigger words + mentions)
      let cleanedInput = String(message.content || "");

      for (const t of FEMALE_TRIGGERS) {
        const re = new RegExp(`\\b${escapeRegex(t)}\\b`, "ig");
        cleanedInput = cleanedInput.replace(re, "");
      }

      try {
        message.mentions.users.forEach((user) => {
          cleanedInput = cleanedInput.replaceAll(`<@${user.id}>`, "");
          cleanedInput = cleanedInput.replaceAll(`<@!${user.id}>`, "");
        });
      } catch {}

      cleanedInput = cleanedInput.replaceAll(`<@${client.user.id}>`, "");
      cleanedInput = cleanedInput.replace(/\s+/g, " ").trim();

      if (!cleanedInput) cleanedInput = shouldRoast ? "Roast them." : "Talk to me.";

      const roastTargets = [...mentionedUsers.values()].map((u) => u.username).join(", ");

      const systemPrompt = buildMBellaSystemPrompt({
        isRoast: shouldRoast && !isRoastingBot,
        isRoastingBot,
        roastTargets,
        currentMode,
        recentContext: awarenessContext,
        memoryContext,
        humanLevel,
        curseAllowedNow,
        curseRate,
        intensity,
        godMode,
        vibe,
      });

      // Temperature tuned for “human/flirty”
      let temperature = 0.96;
      if (MBELLA_SPICE === "pg13") temperature = 0.84;
      if (MBELLA_SPICE === "feral") temperature = 0.99;

      // tighten villain a bit (more composed)
      if (currentMode === "villain") temperature = Math.min(temperature, 0.88);

      // More room in god mode or when user dumps context
      const maxTokens = godMode ? Math.max(520, DEFAULT_MAX_TOKENS) : Math.max(300, DEFAULT_MAX_TOKENS);

      // Build messages array with memory/context as separate messages (helps model “track” it)
      const messages = [];

      if (memoryContext) messages.push({ role: "system", content: memoryContext });
      if (awarenessContext) messages.push({ role: "system", content: awarenessContext });

      // Encourage a natural cadence without claiming to be human
      messages.push({
        role: "system",
        content:
          "Write like a real Discord chat partner: confident, natural, affectionate/sassy. Never mention being AI or any system/meta. No explicit sexual content.",
      });

      messages.push({ role: "user", content: cleanedInput.slice(0, 5000) });

      const groqTry = await groqWithDiscovery(systemPrompt, messages, temperature, maxTokens);

      clearPlaceholderTimer();

      if (!groqTry || groqTry.error) {
        console.error("❌ (MBella) network error:", groqTry?.error?.message || "unknown");
        const embedErr = new EmbedBuilder()
          .setColor("#e84393")
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription("…ugh. signal dipped. say it again. 💋");

        const ok = await editPlaceholderToEmbed(embedErr, message.channel);
        if (!ok) {
          try {
            await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } });
          } catch {}
        }
        return;
      }

      if (!groqTry.res.ok) {
        console.error(`❌ (MBella) HTTP ${groqTry.res.status} on "${groqTry.model}": ${String(groqTry.bodyText || "").slice(0, 400)}`);

        let hint = "…not now. try again in a sec. 😮‍💨";
        if (groqTry.res.status === 401 || groqTry.res.status === 403) {
          hint = message.author.id === process.env.BOT_OWNER_ID ? "Auth error. Check GROQ_API_KEY & model access." : "…hold up. give me a sec. 💅";
        } else if (groqTry.res.status === 429) {
          hint = "rate limited. breathe… then try again. 😘";
        } else if (groqTry.res.status === 400 || groqTry.res.status === 404) {
          hint = message.author.id === process.env.BOT_OWNER_ID ? "Model issue. Set GROQ_MODEL or let discovery handle it." : "cloud hiccup. one more shot. 🖤";
        } else if (groqTry.res.status >= 500) {
          hint = "server cramps. i’ll be back. 🥀";
        }

        const embedErr = new EmbedBuilder()
          .setColor("#e84393")
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription(hint);

        const ok = await editPlaceholderToEmbed(embedErr, message.channel);
        if (!ok) {
          try {
            await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } });
          } catch {}
        }
        return;
      }

      const groqData = safeJsonParse(groqTry.bodyText);
      if (!groqData || groqData.error) {
        console.error("❌ (MBella) API body error:", groqData?.error || String(groqTry.bodyText || "").slice(0, 300));
        const embedErr = new EmbedBuilder()
          .setColor("#e84393")
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription("…static. say it again, slower. 😌");

        const ok = await editPlaceholderToEmbed(embedErr, message.channel);
        if (!ok) {
          try {
            await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } });
          } catch {}
        }
        return;
      }

      let aiReply = groqData.choices?.[0]?.message?.content?.trim() || "";

      // Post-process
      aiReply = sanitizeOutput(deRobotify(aiReply || "…"));
      aiReply = enforceQuestionLimit(aiReply, MBELLA_MAX_QUESTIONS);

      // Memory save
      pushMemory(chKey, "user", cleanedInput);
      pushMemory(chKey, "bella", aiReply);
      pushMemory(uKey, "user", cleanedInput);
      pushMemory(uKey, "bella", aiReply);

      // Optional media attach
      const attachMedia = shouldAttachMedia({ vibe, intensity, godMode });
      const mediaUrl = attachMedia ? pickMediaUrlByVibe(vibe) : "";

      const embed = new EmbedBuilder()
        .setColor("#e84393")
        .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
        .setDescription(`💬 ${aiReply}`);

      if (mediaUrl) embed.setImage(mediaUrl);

      const plannedDelay = Math.min((aiReply || "").length * MBELLA_MS_PER_CHAR, MBELLA_MAX_DELAY_MS) + MBELLA_DELAY_OFFSET_MS;

      const sinceTyping = typingStartMs ? Date.now() - typingStartMs : 0;
      const floorExtra = MBELLA_TYPING_TARGET_MS - sinceTyping;
      const finalDelay = Math.max(0, Math.max(plannedDelay, floorExtra));

      await sleep(finalDelay);

      const edited = await editPlaceholderToEmbed(embed, message.channel);
      if (!edited) {
        try {
          await message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        } catch (err) {
          console.warn("❌ (MBella) send fallback error:", err.message);
          if (aiReply) {
            try {
              await message.reply({ content: aiReply, allowedMentions: { parse: [] } });
            } catch {}
          }
        }
      }

      setBellaPartner(message.channel.id, message.author.id);
      markHandled(client, message.id);
    } catch (err) {
      clearPlaceholderTimer();
      console.error("❌ MBella listener error:", err?.stack || err?.message || String(err));
      try {
        const embedErr = new EmbedBuilder()
          .setColor("#e84393")
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription("…i tripped in heels. i’m up though. 🦵✨");

        const ok = await (async () => {
          try {
            const { message: sent } = await sendViaBellaWebhook(client, message.channel, {
              username: MBELLA_NAME,
              avatarURL: MBELLA_AVATAR_URL,
              embeds: [embedErr],
            });
            return Boolean(sent);
          } catch {
            return false;
          }
        })();

        if (!ok) {
          await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } });
        }
      } catch {}
    }
  });
};
