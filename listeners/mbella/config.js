// listeners/mbella/config.js
// ======================================================
// MBella Config (env parsing + defaults)
// ======================================================

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}
function clamp01(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}
function str(v, def = "") {
  const s = String(v ?? def).trim();
  return s;
}
function bool01(v, def = false) {
  const s = String(v ?? "").trim();
  if (s === "1" || s.toLowerCase() === "true" || s.toLowerCase() === "yes") return true;
  if (s === "0" || s.toLowerCase() === "false" || s.toLowerCase() === "no") return false;
  return def;
}

const GROQ_API_KEY = str(process.env.GROQ_API_KEY, "");
const GROQ_MODEL_ENV = str(process.env.GROQ_MODEL, "");

// Display
const MBELLA_NAME = str(process.env.MBELLA_NAME, "Bella");
const MBELLA_AVATAR_URL = str(process.env.MBELLA_AVATAR_URL, "");

// Webhook
const MB_RELAY_WEBHOOK_NAME = str(process.env.MB_RELAY_WEBHOOK_NAME, "MB Relay");

// Debug
const DEBUG = bool01(process.env.WEBHOOKAUTO_DEBUG, false);

// Spice
const MBELLA_SPICE = str(process.env.MBELLA_SPICE, "r").toLowerCase(); // pg13 | r | feral
const MBELLA_ALLOW_PROFANITY = bool01(process.env.MBELLA_ALLOW_PROFANITY, true);

// Companion / human levels
const MBELLA_COMPANION_LEVEL = clampInt(process.env.MBELLA_COMPANION_LEVEL ?? 3, 0, 3, 3);
const MBELLA_HUMAN_LEVEL_DEFAULT = clampInt(process.env.MBELLA_HUMAN_LEVEL ?? 2, 0, 3, 2);

// Curse behavior
const MBELLA_CURSE_RATE_ENV = process.env.MBELLA_CURSE_RATE;
const MBELLA_CURSE_RATE_DEFAULT = (() => {
  if (MBELLA_CURSE_RATE_ENV != null && MBELLA_CURSE_RATE_ENV !== "") return clamp01(MBELLA_CURSE_RATE_ENV, 0.34);
  if (MBELLA_SPICE === "pg13") return 0.10;
  if (MBELLA_SPICE === "feral") return 0.60;
  return 0.34;
})();

const MBELLA_MAX_QUESTIONS = clampInt(process.env.MBELLA_MAX_QUESTIONS ?? 0, 0, 2, 0);

// Media
const MBELLA_MEDIA_MODE = str(process.env.MBELLA_MEDIA_MODE, "auto").toLowerCase(); // off|auto|on
const MBELLA_MEDIA_RATE_ENV = process.env.MBELLA_MEDIA_RATE;
const MBELLA_MEDIA_RATE_DEFAULT = (() => {
  if (MBELLA_MEDIA_RATE_ENV != null && MBELLA_MEDIA_RATE_ENV !== "") return clamp01(MBELLA_MEDIA_RATE_ENV, 0.18);
  if (MBELLA_SPICE === "pg13") return 0.10;
  if (MBELLA_SPICE === "feral") return 0.30;
  return 0.18;
})();

const MBELLA_MEDIA_URLS = str(process.env.MBELLA_MEDIA_URLS, "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// God mode + TTL
const MBELLA_GOD_DEFAULT = bool01(process.env.MBELLA_GOD_DEFAULT, false);
const MBELLA_GOD_TTL_MS = clampInt(process.env.MBELLA_GOD_TTL_MS ?? (30 * 60 * 1000), 10_000, 24 * 60 * 60 * 1000, 30 * 60 * 1000);
const MBELLA_HUMAN_TTL_MS = clampInt(process.env.MBELLA_HUMAN_TTL_MS ?? (60 * 60 * 1000), 10_000, 24 * 60 * 60 * 1000, 60 * 60 * 1000);
const MBELLA_MEM_TTL_MS = clampInt(process.env.MBELLA_MEM_TTL_MS ?? (45 * 60 * 1000), 10_000, 24 * 60 * 60 * 1000, 45 * 60 * 1000);

// Pace
const MBELLA_MS_PER_CHAR = clampInt(process.env.MBELLA_MS_PER_CHAR ?? 40, 0, 250, 40);
const MBELLA_MAX_DELAY_MS = clampInt(process.env.MBELLA_MAX_DELAY_MS ?? 5000, 0, 30_000, 5000);
const MBELLA_DELAY_OFFSET_MS = clampInt(process.env.MBELLA_DELAY_OFFSET_MS ?? 150, 0, 5000, 150);
const MBELLA_TYPING_DEBOUNCE_MS = clampInt(process.env.MBELLA_TYPING_DEBOUNCE_MS ?? 1200, 0, 20_000, 1200);
const MBELLA_TYPING_TARGET_MS = clampInt(process.env.MBELLA_TYPING_TARGET_MS ?? 9200, 0, 60_000, 9200);

// Core behavior
const COOLDOWN_MS = clampInt(process.env.MBELLA_COOLDOWN_MS ?? 10_000, 0, 120_000, 10_000);
const FEMALE_TRIGGERS = ["mbella", "mb ella", "lady mb", "queen mb", "bella"];
const RELEASE_REGEX = /\b(stop|bye bella|goodbye bella|end chat|silence bella)\b/i;

// Owner/admin toggles
const GOD_ON_REGEX = /\b(bella\s+god\s+on|bella\s+godmode\s+on|god\s+mode\s+bella\s+on)\b/i;
const GOD_OFF_REGEX = /\b(bella\s+god\s+off|bella\s+godmode\s+off|god\s+mode\s+bella\s+off)\b/i;
const HUMAN_SET_REGEX = /\b(bella\s+human\s+([0-3]))\b/i;
const CURSE_ON_REGEX = /\b(bella\s+curse\s+on|bella\s+swear\s+on)\b/i;
const CURSE_OFF_REGEX = /\b(bella\s+curse\s+off|bella\s+swear\s+off)\b/i;

// Groq request tuning
const DEFAULT_MAX_TOKENS = clampInt(process.env.MBELLA_GROQ_MAX_TOKENS ?? 320, 96, 900, 320);
const DEFAULT_TOP_P = Number(process.env.MBELLA_GROQ_TOP_P || "0.92");
const DEFAULT_PRESENCE_PENALTY = Number(process.env.MBELLA_GROQ_PRESENCE_PENALTY || "0.25");
const DEFAULT_FREQUENCY_PENALTY = Number(process.env.MBELLA_GROQ_FREQUENCY_PENALTY || "0.07");

// Retries
const MAX_RETRIES_PER_MODEL = clampInt(process.env.MBELLA_GROQ_MAX_RETRIES ?? 2, 0, 6, 2);
const RETRY_BASE_MS = clampInt(process.env.MBELLA_GROQ_RETRY_BASE_MS ?? 650, 100, 10_000, 650);
const RETRY_MAX_MS = clampInt(process.env.MBELLA_GROQ_RETRY_MAX_MS ?? 4000, 500, 20_000, 4000);

// Visuals
const MBELLA_EMBED_COLOR = str(process.env.MBELLA_EMBED_COLOR, "#e84393");

// Partner TTL
const BELLA_TTL_MS = clampInt(process.env.MBELLA_PARTNER_TTL_MS ?? (30 * 60 * 1000), 10_000, 12 * 60 * 60 * 1000, 30 * 60 * 1000);

module.exports = {
  GROQ_API_KEY,
  GROQ_MODEL_ENV,

  MBELLA_NAME,
  MBELLA_AVATAR_URL,
  MB_RELAY_WEBHOOK_NAME,
  DEBUG,

  MBELLA_SPICE,
  MBELLA_ALLOW_PROFANITY,
  MBELLA_COMPANION_LEVEL,
  MBELLA_HUMAN_LEVEL_DEFAULT,

  MBELLA_CURSE_RATE_DEFAULT,
  MBELLA_MAX_QUESTIONS,

  MBELLA_MEDIA_MODE,
  MBELLA_MEDIA_RATE_DEFAULT,
  MBELLA_MEDIA_URLS,

  MBELLA_GOD_DEFAULT,
  MBELLA_GOD_TTL_MS,
  MBELLA_HUMAN_TTL_MS,
  MBELLA_MEM_TTL_MS,

  MBELLA_MS_PER_CHAR,
  MBELLA_MAX_DELAY_MS,
  MBELLA_DELAY_OFFSET_MS,
  MBELLA_TYPING_DEBOUNCE_MS,
  MBELLA_TYPING_TARGET_MS,

  COOLDOWN_MS,
  FEMALE_TRIGGERS,
  RELEASE_REGEX,

  GOD_ON_REGEX,
  GOD_OFF_REGEX,
  HUMAN_SET_REGEX,
  CURSE_ON_REGEX,
  CURSE_OFF_REGEX,

  DEFAULT_MAX_TOKENS,
  DEFAULT_TOP_P,
  DEFAULT_PRESENCE_PENALTY,
  DEFAULT_FREQUENCY_PENALTY,

  MAX_RETRIES_PER_MODEL,
  RETRY_BASE_MS,
  RETRY_MAX_MS,

  MBELLA_EMBED_COLOR,
  BELLA_TTL_MS,
};
