// listeners/musclemb/config.js
const envStr = (k, d = '') => (process.env[k] ?? d).toString().trim();
const envNum = (k, d) => {
  const v = Number(envStr(k, String(d)));
  return Number.isFinite(v) ? v : Number(d);
};
// ✅ PATCH: accept 1/true/yes/on (case-insensitive)
const envBool = (k, d = '0') => {
  const v = envStr(k, d).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

const GROQ_API_KEY = envStr('GROQ_API_KEY', '');
const GROQ_MODEL_ENV = envStr('GROQ_MODEL', '');

const MB_MS_PER_CHAR = envNum('MB_MS_PER_CHAR', 40);
const MB_MAX_DELAY_MS = envNum('MB_MAX_DELAY_MS', 5000);

const MBELLA_NAME = envStr('MBELLA_NAME', 'MBella');

const MB_NICE_STYLE = envStr('MB_NICE_STYLE', 'vibe').toLowerCase();

const MB_USE_WEBHOOKAUTO = envBool('MB_USE_WEBHOOKAUTO', '1');
const MUSCLEMB_WEBHOOK_NAME = envStr('MUSCLEMB_WEBHOOK_NAME', 'MuscleMB');
const MUSCLEMB_WEBHOOK_AVATAR = envStr('MUSCLEMB_WEBHOOK_AVATAR', '');
const MB_WEBHOOK_PREFIX_AUTHOR = envBool('MB_WEBHOOK_PREFIX_AUTHOR', '1');

const NICE_PING_EVERY_MS = 4 * 60 * 60 * 1000;
const NICE_SCAN_EVERY_MS = 60 * 60 * 1000;
const NICE_ACTIVE_WINDOW_MS = 45 * 60 * 1000;
const NICE_ANALYZE_LIMIT = envNum('NICE_ANALYZE_LIMIT', 40);

// ✅ NEW: Nice ping anti-repeat knobs (used by nicePings.js, safe defaults)
const NICE_HISTORY_MAX = Math.max(10, Math.min(500, envNum('NICE_HISTORY_MAX', 50)));
const NICE_HISTORY_TTL_MS = Math.max(60_000, envNum('NICE_HISTORY_TTL_MS', 6 * 60 * 60 * 1000)); // 6h

const SWEEP_TRIGGERS = ['sweeppower', 'enginesweep', 'sweep-power'];
const SWEEP_COOLDOWN_MS = envNum('SWEEP_READER_COOLDOWN_MS', 8000);

const ADRIAN_CHART_TRIGGERS = [
  'adrian-chart',
  'chart-adrian',
  'adrian chart',
  'chart adrian',
  '$adrian chart',
  'adrianchart',
  'price adrian',
  'adrian price'
];
const ADRIAN_CHART_COOLDOWN_MS = envNum('ADRIAN_CHART_COOLDOWN_MS', 8000);
const ADRIAN_CHART_ADMIN_ONLY = envBool('ADRIAN_CHART_ADMIN_ONLY', '1');
const ADRIAN_CHART_DENY_REPLY = envBool('ADRIAN_CHART_DENY_REPLY', '0');
const ADRIAN_CHART_DEBUG = envBool('ADRIAN_CHART_DEBUG', '1');

const ADRIAN_CHART_MODE = envStr('ADRIAN_CHART_MODE', 'candles').toLowerCase();

const ADRIAN_GT_NETWORK = envStr('ADRIAN_GT_NETWORK', 'base').toLowerCase();
const ADRIAN_GT_POOL_ID = envStr(
  'ADRIAN_GT_POOL_ID',
  '0x79cdf2d48abd42872a26d1b1c92ece4245327a4837b427dc9cff5f1acc40e379'
).toLowerCase();
const ADRIAN_CHART_POINTS = Math.max(20, Math.min(240, envNum('ADRIAN_CHART_POINTS', 96)));
const ADRIAN_CHART_CACHE_MS = Math.max(10_000, envNum('ADRIAN_CHART_CACHE_MS', 60_000));

const TRIGGERS = ['musclemb', 'muscle mb', 'yo mb', 'mbbot', 'mb bro'];
const FEMALE_TRIGGERS = ['mbella', 'mb ella', 'lady mb', 'queen mb', 'bella'];

const BOT_OWNER_ID = envStr('BOT_OWNER_ID', '');

// ======================================================
// ✅ Awareness (opt-in mentions) settings
// ======================================================
const MB_AWARENESS_ENABLED = envBool('MB_AWARENESS_ENABLED', '0'); // default OFF
const MB_AWARENESS_CHANCE = Math.max(0, Math.min(1, envNum('MB_AWARENESS_CHANCE', 0.18))); // 18%
const MB_AWARENESS_INACTIVE_MS = Math.max(60_000, envNum('MB_AWARENESS_INACTIVE_MS', 3 * 24 * 60 * 60 * 1000)); // 3d
const MB_AWARENESS_PING_COOLDOWN_MS = Math.max(60_000, envNum('MB_AWARENESS_PING_COOLDOWN_MS', 5 * 24 * 60 * 60 * 1000)); // 5d
const MB_AWARENESS_MAX_PER_GUILD_PER_DAY = Math.max(0, envNum('MB_AWARENESS_MAX_PER_GUILD_PER_DAY', 2));
const MB_AWARENESS_DEBUG = envBool('MB_AWARENESS_DEBUG', '0');

// ======================================================
// ✅ Model Router (Groq -> OpenAI -> Grok) settings
// ======================================================
const MB_MODEL_ROUTER_ENABLED = envBool('MB_MODEL_ROUTER_ENABLED', '0'); // default OFF
const MB_MODEL_ROUTER_DEBUG = envBool('MB_MODEL_ROUTER_DEBUG', '0');

// OpenAI (optional)
const OPENAI_API_KEY = envStr('OPENAI_API_KEY', '');
const OPENAI_MODEL = envStr('OPENAI_MODEL', 'gpt-4o-mini');
const OPENAI_BASE_URL = envStr('OPENAI_BASE_URL', 'https://api.openai.com/v1');

// Grok/xAI (optional, OpenAI-compatible shape)
const GROK_API_KEY = envStr('GROK_API_KEY', '');
const GROK_MODEL = envStr('GROK_MODEL', 'grok-2');
const GROK_BASE_URL = envStr('GROK_BASE_URL', '');

// ======================================================
// ✅ Profile Memory (admin/owner curated “who is who”)
// ======================================================
const MB_PROFILE_MEMORY_ENABLED = envBool('MB_PROFILE_MEMORY_ENABLED', '0'); // default OFF
const MB_PROFILE_REQUIRE_OPTIN = envBool('MB_PROFILE_REQUIRE_OPTIN', '0');
const MB_PROFILE_MAX_KEYS = Math.max(2, Math.min(12, envNum('MB_PROFILE_MAX_KEYS', 6)));
const MB_PROFILE_MAX_NOTES = Math.max(1, Math.min(10, envNum('MB_PROFILE_MAX_NOTES', 4)));
const MB_PROFILE_DEBUG = envBool('MB_PROFILE_DEBUG', '0');

// ======================================================
// Warnings (boot-time)
// ======================================================
if (!GROQ_API_KEY || GROQ_API_KEY.trim().length < 10) {
  console.warn('⚠️ GROQ_API_KEY is missing or too short. Verify Railway env.');
}

if (MB_MODEL_ROUTER_ENABLED) {
  const hasOpenAI = OPENAI_API_KEY && OPENAI_API_KEY.trim().length > 10;
  const hasGrok = GROK_API_KEY && GROK_API_KEY.trim().length > 10 && GROK_BASE_URL && GROK_BASE_URL.trim().length > 8;

  if (!hasOpenAI && !hasGrok) {
    console.warn('⚠️ MB_MODEL_ROUTER_ENABLED=1 but OPENAI_API_KEY and GROK_API_KEY/BASE_URL are missing. Router will still try Groq first only.');
  }
}

if (MB_AWARENESS_ENABLED && !BOT_OWNER_ID) {
  console.warn('⚠️ MB_AWARENESS_ENABLED=1 but BOT_OWNER_ID is empty. (Not fatal) Consider setting BOT_OWNER_ID for better controls.');
}

if (MB_PROFILE_MEMORY_ENABLED && !BOT_OWNER_ID) {
  console.warn('⚠️ MB_PROFILE_MEMORY_ENABLED=1 but BOT_OWNER_ID is empty. (Not fatal) Owner/admin controls still work, but owner-only commands may rely on BOT_OWNER_ID.');
}

module.exports = {
  GROQ_API_KEY,
  GROQ_MODEL_ENV,
  MB_MS_PER_CHAR,
  MB_MAX_DELAY_MS,
  MBELLA_NAME,
  MB_NICE_STYLE,
  MB_USE_WEBHOOKAUTO,
  MUSCLEMB_WEBHOOK_NAME,
  MUSCLEMB_WEBHOOK_AVATAR,
  MB_WEBHOOK_PREFIX_AUTHOR,
  NICE_PING_EVERY_MS,
  NICE_SCAN_EVERY_MS,
  NICE_ACTIVE_WINDOW_MS,
  NICE_ANALYZE_LIMIT,

  // ✅ exports for nicePings anti-repeat
  NICE_HISTORY_MAX,
  NICE_HISTORY_TTL_MS,

  SWEEP_TRIGGERS,
  SWEEP_COOLDOWN_MS,
  ADRIAN_CHART_TRIGGERS,
  ADRIAN_CHART_COOLDOWN_MS,
  ADRIAN_CHART_ADMIN_ONLY,
  ADRIAN_CHART_DENY_REPLY,
  ADRIAN_CHART_DEBUG,
  ADRIAN_CHART_MODE,
  ADRIAN_GT_NETWORK,
  ADRIAN_GT_POOL_ID,
  ADRIAN_CHART_POINTS,
  ADRIAN_CHART_CACHE_MS,
  TRIGGERS,
  FEMALE_TRIGGERS,
  BOT_OWNER_ID,

  // ✅ Awareness exports
  MB_AWARENESS_ENABLED,
  MB_AWARENESS_CHANCE,
  MB_AWARENESS_INACTIVE_MS,
  MB_AWARENESS_PING_COOLDOWN_MS,
  MB_AWARENESS_MAX_PER_GUILD_PER_DAY,
  MB_AWARENESS_DEBUG,

  // ✅ Model router exports
  MB_MODEL_ROUTER_ENABLED,
  MB_MODEL_ROUTER_DEBUG,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  OPENAI_BASE_URL,
  GROK_API_KEY,
  GROK_MODEL,
  GROK_BASE_URL,

  // ✅ Profile memory exports
  MB_PROFILE_MEMORY_ENABLED,
  MB_PROFILE_REQUIRE_OPTIN,
  MB_PROFILE_MAX_KEYS,
  MB_PROFILE_MAX_NOTES,
  MB_PROFILE_DEBUG,
};

