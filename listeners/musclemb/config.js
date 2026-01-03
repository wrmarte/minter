// listeners/musclemb/config.js
const envStr = (k, d = '') => (process.env[k] ?? d).toString().trim();
const envNum = (k, d) => {
  const v = Number(envStr(k, String(d)));
  return Number.isFinite(v) ? v : Number(d);
};
const envBool = (k, d = '0') => envStr(k, d) === '1';

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

if (!GROQ_API_KEY || GROQ_API_KEY.trim().length < 10) {
  console.warn('⚠️ GROQ_API_KEY is missing or too short. Verify Railway env.');
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
};
