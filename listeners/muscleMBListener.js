// listeners/musclemb.js
const fetch = require('node-fetch');
const { EmbedBuilder, PermissionsBitField, AttachmentBuilder } = require('discord.js');

// ✅ NEW: Canvas candles chart service (attachment:// image)
const { getAdrianChartUrl: getAdrianCandleChartUrl } = require('../services/adrianChart');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL_ENV = (process.env.GROQ_MODEL || '').trim();

// Typing speed (match MBella by default)
const MB_MS_PER_CHAR = Number(process.env.MB_MS_PER_CHAR || '40');
const MB_MAX_DELAY_MS = Number(process.env.MB_MAX_DELAY_MS || '5000');

// Name MBella uses when posting via webhook/embeds
const MBELLA_NAME = (process.env.MBELLA_NAME || 'MBella').trim();

// NEW: Quote display style for periodic pings: vibe | clean | tag
const MB_NICE_STYLE = (process.env.MB_NICE_STYLE || 'vibe').trim().toLowerCase();

// NEW: Use webhookAuto (if available) for sending (you said you're using webhookauto)
const MB_USE_WEBHOOKAUTO = String(process.env.MB_USE_WEBHOOKAUTO || '1').trim() === '1';
const MUSCLEMB_WEBHOOK_NAME = (process.env.MUSCLEMB_WEBHOOK_NAME || 'MuscleMB').trim();
const MUSCLEMB_WEBHOOK_AVATAR = (process.env.MUSCLEMB_WEBHOOK_AVATAR || '').trim();

// Optional: if true, webhook messages will prefix a non-pinging mention-like label
const MB_WEBHOOK_PREFIX_AUTHOR = String(process.env.MB_WEBHOOK_PREFIX_AUTHOR || '1').trim() === '1';

const cooldown = new Set();
const TRIGGERS = ['musclemb', 'muscle mb', 'yo mb', 'mbbot', 'mb bro'];
const FEMALE_TRIGGERS = ['mbella', 'mb ella', 'lady mb', 'queen mb', 'bella'];

/** ===== Activity tracker for periodic nice messages ===== */
const lastActiveByUser = new Map(); // key: `${guildId}:${userId}` -> { ts, channelId }
const lastNicePingByGuild = new Map(); // guildId -> ts
const lastQuoteByGuild = new Map(); // guildId -> { text, category, ts }
const NICE_PING_EVERY_MS = 4 * 60 * 60 * 1000; // 4 hours
const NICE_SCAN_EVERY_MS = 60 * 60 * 1000;     // scan hourly
const NICE_ACTIVE_WINDOW_MS = 45 * 60 * 1000;  // “active” = last 45 minutes
const NICE_ANALYZE_LIMIT = Number(process.env.NICE_ANALYZE_LIMIT || 40); // messages to scan for mood

/** ===== NEW: Sweep reader config ===== */
const SWEEP_TRIGGERS = ['sweeppower', 'enginesweep', 'sweep-power'];
const SWEEP_COOLDOWN_MS = Number(process.env.SWEEP_READER_COOLDOWN_MS || 8000);
const sweepCooldownByUser = new Map(); // `${guildId}:${userId}` -> ts

/** ===== NEW: $ADRIAN chart trigger config =====
 * Admin/Owner-only by default.
 */
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
const ADRIAN_CHART_COOLDOWN_MS = Number(process.env.ADRIAN_CHART_COOLDOWN_MS || 8000);
const ADRIAN_CHART_ADMIN_ONLY = String(process.env.ADRIAN_CHART_ADMIN_ONLY || '1').trim() === '1';
const ADRIAN_CHART_DENY_REPLY = String(process.env.ADRIAN_CHART_DENY_REPLY || '0').trim() === '1';
const ADRIAN_CHART_DEBUG = String(process.env.ADRIAN_CHART_DEBUG || '1').trim() === '1';
const adrianChartCooldownByUser = new Map(); // `${guildId}:${userId}` -> ts

// GeckoTerminal mapping for $ADRIAN pool (defaults to the pool you gave)
const ADRIAN_GT_NETWORK = (process.env.ADRIAN_GT_NETWORK || 'base').trim().toLowerCase();
const ADRIAN_GT_POOL_ID = (process.env.ADRIAN_GT_POOL_ID ||
  '0x79cdf2d48abd42872a26d1b1c92ece4245327a4837b427dc9cff5f1acc40e379'
).trim().toLowerCase();
const ADRIAN_CHART_POINTS = Math.max(20, Math.min(240, Number(process.env.ADRIAN_CHART_POINTS || 96))); // 96 ≈ last day @ 15m
const ADRIAN_CHART_CACHE_MS = Math.max(10_000, Number(process.env.ADRIAN_CHART_CACHE_MS || 60_000));

/** ===== Categorized NICE_LINES with extra nutty/thoughtful/degen/chaotic/funny ===== */
const NICE_LINES = {
  focus: [
    "precision beats intensity — name the next step 🎯",
    "clear tab, clear mind — ship the smallest next thing 🧹",
    "silence the noise, chase the signal 📡",
    "progress hides in plain sight — reread yesterday’s notes 📓",
    "if it feels stuck, zoom out; the map is bigger than the street 🗺️",
  ],

  kindness: [
    "you’re doing great. send a W to someone else too 🙌",
    "say thanks today, it compounds louder than code 🙏",
    "one candle lights another without losing its flame 🕯️",
    "keep it human: laugh once, share once, breathe once 😌",
  ],

  shipping: [
    "skip the scroll, ship the thing 📦",
    "today’s goal: one honest message, one shipped change 📤",
    "a tiny draft beats a perfect idea living in your head 📝",
    "choose progress over polish; polish comes after 🧽",
    "done is momentum, momentum is magic ✨",
    "ship bad, learn fast, ship better 🔄",
  ],

  recharge: [
    "posture check, water sip, breathe deep 🧘‍♂️",
    "breaks are part of the grind — reset, then rip ⚡️",
    "drink water, touch grass, send the PR 🌿",
    "don’t doomscroll; dreamscroll your own roadmap 🗺️",
    "add five quiet minutes to think; it pays compound interest ⏱️",
    "step back: sunsets don’t debug themselves 🌅",
    "touch grass, touch base, touch reality 🌿",
  ],

  progress: [
    "hydrate, hustle, and be kind today 💧💪",
    "tiny reps compound. keep going, legend ✨",
    "your pace > perfect. 1% better is a W 📈",
    "stack small dubs; the big ones follow 🧱",
    "write it down, knock it out, fist bump later ✍️👊",
    "mood follows motion — move first 🕺",
    "future you is watching — give them something to smile about 🔮",
  ],

  nutty: [
    "chaos is just order you haven’t met yet 🌀",
    "laugh at the bug, it fears confidence 😂",
    "life is a sandbox — kick it, glitch it, build it 🏖️",
    "fortune favors the shitposters 🧃",
    "serious plans die, dumb experiments go viral 🤯",
  ],

  thoughtful: [
    "ask one better question and the work gets lighter ❓✨",
    "a pause is not wasted; it’s thinking in disguise 🕰️",
    "every message is a mirror — write what you want reflected 🪞",
    "your silence can be louder than their noise 🌌",
    "the smallest word can tip the biggest balance ⚖️",
  ],

  degen: [
    "apes don’t ask, they just swing 🐒",
    "serenity is for the stakers, chaos is for the traders 🔥",
    "gm is cheap, conviction is priceless ⛓️",
    "bag heavy, hands shaky, heart degen 💎🙌",
    "sleep is the FUD of productivity 😴🚫",
  ],

  chaotic_wisdom: [
    "a rug is just gravity teaching you risk 🪂",
    "the line goes up, then down, then sideways — so does life 📉📈",
    "fortune cookies are just oracles with better branding 🥠",
    "every degen thread hides a philosopher in disguise 🧵🧠",
    "the deeper the dip, the sweeter the cope 🍯",
  ],

  funny: [
    "debugging: talking to a rubber duck until it cries 🦆",
    "wifi down = forced meditation retreat 📴",
    "life’s just alt-tabbing until bedtime ⌨️😴",
    "gm is free, coffee isn’t ☕",
    "success is 90% ctrl+c, 10% ctrl+v 🖇️",
    "meetings: multiplayer procrastination 🎮",
  ]
};

/** Helper: safe channel to speak in */
function findSpeakableChannel(guild, preferredChannelId = null) {
  const me = guild.members.me;
  if (!me) return null;
  const canSend = (ch) =>
    ch &&
    ch.isTextBased?.() &&
    ch.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages);

  if (preferredChannelId) {
    const ch = guild.channels.cache.get(preferredChannelId);
    if (canSend(ch)) return ch;
  }
  if (guild.systemChannel && canSend(guild.systemChannel)) return guild.systemChannel;
  return guild.channels.cache.find((c) => canSend(c)) || null;
}

/** Lightweight recent context from channel (non-bot, short, last ~6 msgs for LLM) */
async function getRecentContext(message) {
  try {
    const fetched = await message.channel.messages.fetch({ limit: 8 });
    const lines = [];
    for (const [, m] of fetched) {
      if (m.id === message.id) continue; // avoid echoing the current message
      if (m.author?.bot) continue;
      const txt = (m.content || '').trim();
      if (!txt) continue;
      const oneLine = txt.replace(/\s+/g, ' ').slice(0, 200);
      lines.push(`${m.author.username}: ${oneLine}`);
      if (lines.length >= 6) break;
    }
    if (!lines.length) return '';
    const joined = lines.join('\n');
    return `Recent context:\n${joined}`.slice(0, 1200);
  } catch {
    return '';
  }
}

/** Random pick helper */
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/** ---------- Robust helpers ---------- */
function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Works on Node versions without AbortController too
async function fetchWithTimeout(url, opts = {}, timeoutMs = 25000) {
  const hasAbort = typeof globalThis.AbortController === 'function';
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
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeoutMs))
    ]);
  }
}

/**
 * PATCH: binary fetch helper (for chart image attachment).
 * Fixes “trigger logs but no display” caused by overly-long embed image URLs.
 */
async function fetchBinaryWithTimeout(url, opts = {}, timeoutMs = 25000) {
  const hasAbort = typeof globalThis.AbortController === 'function';
  if (hasAbort) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      // node-fetch v2 supports res.buffer(); v3 supports arrayBuffer()
      let buf;
      if (typeof res.buffer === 'function') {
        buf = await res.buffer();
      } else {
        const ab = await res.arrayBuffer();
        buf = Buffer.from(ab);
      }
      return { res, buf };
    } finally {
      clearTimeout(timer);
    }
  } else {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, opts);
        let buf;
        if (typeof res.buffer === 'function') {
          buf = await res.buffer();
        } else {
          const ab = await res.arrayBuffer();
          buf = Buffer.from(ab);
        }
        return { res, buf };
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeoutMs))
    ]);
  }
}

// Warn once if key looks wrong/missing
if (!GROQ_API_KEY || GROQ_API_KEY.trim().length < 10) {
  console.warn('⚠️ GROQ_API_KEY is missing or too short. Verify Railway env.');
}

/** ---------------- Dynamic model discovery & fallback ---------------- */
let MODEL_CACHE = { ts: 0, models: [] };         // {ts, models: string[]}
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;         // 6 hours

function preferOrder(a, b) {
  // Heuristic: prefer larger/newer first: extract number like 90b/70b/8b, prefer "3.2" > "3.1" > "3"
  const size = (id) => {
    const m = id.match(/(\d+)\s*b|\b(\d+)[bB]\b|-(\d+)b/);
    return m ? parseInt(m[1] || m[2] || m[3] || '0', 10) : 0;
  };
  const ver = (id) => {
    const m = id.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  };
  const szDiff = size(b) - size(a);
  if (szDiff) return szDiff;
  return ver(b) - ver(a);
}

async function fetchGroqModels() {
  try {
    const { res, bodyText } = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/models',
      { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` } },
      20000
    );
    if (!res.ok) {
      console.error(`❌ Groq /models HTTP ${res.status}: ${bodyText?.slice(0, 300)}`);
      return [];
    }
    const data = safeJsonParse(bodyText);
    if (!data || !Array.isArray(data.data)) return [];
    // Prefer chat-capable families; sort by heuristic
    const ids = data.data.map(x => x.id).filter(Boolean);
    const chatLikely = ids.filter(id =>
      /llama|mixtral|gemma|qwen|deepseek/i.test(id)
    ).sort(preferOrder);
    return chatLikely.length ? chatLikely : ids.sort(preferOrder);
  } catch (e) {
    console.error('❌ Failed to list Groq models:', e.message);
    return [];
  }
}

async function getModelsToTry() {
  const list = [];
  if (GROQ_MODEL_ENV) list.push(GROQ_MODEL_ENV);

  const now = Date.now();
  if (!MODEL_CACHE.models.length || (now - MODEL_CACHE.ts) > MODEL_TTL_MS) {
    const models = await fetchGroqModels();
    if (models.length) {
      MODEL_CACHE = { ts: now, models };
    }
  }
  // Merge env + cached unique
  for (const id of MODEL_CACHE.models) {
    if (!list.includes(id)) list.push(id);
  }
  return list;
}

function buildGroqBody(model, systemPrompt, userContent, temperature, maxTokens = 140) {
  const cleanUser = String(userContent || '').slice(0, 4000);
  return JSON.stringify({
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: cleanUser },
    ],
  });
}

async function groqTryModel(model, systemPrompt, userContent, temperature) {
  const { res, bodyText } = await fetchWithTimeout(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: buildGroqBody(model, systemPrompt, userContent, temperature, 140),
    },
    25000
  );
  return { res, bodyText };
}

async function groqWithDiscovery(systemPrompt, userContent, temperature) {
  const models = await getModelsToTry();
  if (!models.length) {
    return { error: new Error('No Groq models available') };
  }
  let last = null;
  for (const m of models) {
    try {
      const r = await groqTryModel(m, systemPrompt, userContent, temperature);
      if (!r.res.ok) {
        console.error(`❌ Groq HTTP ${r.res.status} on model "${m}": ${r.bodyText?.slice(0, 400)}`);
        // If model is decommissioned or 400/404, try next
        if (r.res.status === 400 || r.res.status === 404) {
          last = { model: m, ...r };
          continue;
        }
        // For 401/403/429/5xx, stop & surface
        return { model: m, ...r };
      }
      return { model: m, ...r }; // success
    } catch (e) {
      console.error(`❌ Groq fetch error on model "${m}":`, e.message);
      last = { model: m, error: e };
      // try next
    }
  }
  return last || { error: new Error('All models failed') };
}

/** ---------- Smart Picker (seeded, weighted, daypart/weekend, DOW, mood) ---------- */
function makeRng(seedStr = "") {
  // hash string to 32-bit int (FNV-ish)
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let x = (h || 123456789) >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5;  x >>>= 0;
    return (x >>> 0) / 0x100000000;
  };
}
function weightedPick(entries, rng = Math.random) {
  const total = entries.reduce((s, e) => s + Math.max(0, e.weight || 0), 0) || 1;
  let t = rng() * total;
  for (const e of entries) {
    const w = Math.max(0, e.weight || 0);
    if (t < w) return e.key;
    t -= w;
  }
  return entries[entries.length - 1]?.key;
}
function getDaypart(hour) {
  if (hour >= 0 && hour <= 5) return "late_night";
  if (hour <= 11) return "morning";
  if (hour <= 16) return "midday";
  if (hour <= 21) return "evening";
  return "late_evening";
}
const DAYPART_WEIGHTS = {
  morning: {
    focus: 3, recharge: 3, progress: 2, kindness: 2, shipping: 1,
    thoughtful: 2, nutty: 1, degen: 0.5, chaotic_wisdom: 1, funny: 1
  },
  midday: {
    focus: 3, shipping: 3, progress: 2, kindness: 1,
    thoughtful: 1.5, recharge: 1, funny: 1, nutty: 1, chaotic_wisdom: 1, degen: 1
  },
  evening: {
    kindness: 2, thoughtful: 2, progress: 1.5, shipping: 1,
    recharge: 2, funny: 2, nutty: 1.2, chaotic_wisdom: 1.2, degen: 1, focus: 1
  },
  late_evening: {
    thoughtful: 2.2, chaotic_wisdom: 2.2, funny: 1.6, nutty: 1.6, degen: 1.4,
    recharge: 1.2, progress: 1, shipping: 0.8, kindness: 1, focus: 0.8
  },
  late_night: {
    chaotic_wisdom: 3, degen: 2.2, funny: 2, nutty: 2,
    thoughtful: 1.8, recharge: 1.2, progress: 0.8, shipping: 0.6, focus: 0.6, kindness: 0.8
  }
};

// New: day-of-week nudges (0=Sun...6=Sat)
const DOW_WEIGHTS = {
  1: { focus: 1.2, shipping: 1.2, progress: 1.1 }, // Mon: focus/ship
  2: { focus: 1.1, shipping: 1.1, progress: 1.1 }, // Tue
  3: { focus: 1.0, shipping: 1.1, progress: 1.1 }, // Wed
  4: { shipping: 1.2, progress: 1.1, thoughtful: 1.1 }, // Thu: push + reflect
  5: { degen: 1.25, funny: 1.2, nutty: 1.1 }, // Fri: chaos
  6: { degen: 1.3, funny: 1.25, chaotic_wisdom: 1.15 }, // Sat: chaos oracle
  0: { recharge: 1.2, thoughtful: 1.15, kindness: 1.1 } // Sun: restore
};

const MODE_MULTIPLIERS = {
  serious:   { focus: 1.6, shipping: 1.6, progress: 1.4, thoughtful: 1.2 },
  chaotic:   { chaotic_wisdom: 1.8, nutty: 1.6, funny: 1.4, degen: 1.3 },
  human:     { kindness: 1.8, thoughtful: 1.4, recharge: 1.2 },
  degen:     { degen: 2.0, chaotic_wisdom: 1.6, funny: 1.2, nutty: 1.2 },
  calm:      { recharge: 1.8, thoughtful: 1.4, kindness: 1.2 },
};

const WEEKEND_BONUS = { degen: 1.15, funny: 1.1, nutty: 1.08, chaotic_wisdom: 1.08 };

function applyMultipliers(base, ...multis) {
  const out = { ...base };
  for (const m of multis) {
    if (!m) continue;
    for (const k of Object.keys(m)) {
      out[k] = (out[k] || 0) * m[k];
    }
  }
  return out;
}
function toEntries(weights, allowSet, blockSet) {
  const entries = [];
  for (const [key, weight] of Object.entries(weights)) {
    if (blockSet?.has(key)) continue;
    if (allowSet && allowSet.size && !allowSet.has(key)) continue;
    if ((weight || 0) > 0) entries.push({ key, weight });
  }
  return entries.length ? entries : [{ key: "focus", weight: 1 }];
}
function pickLineFromCategory(category, rng) {
  const arr = NICE_LINES[category] || [];
  if (!arr.length) return { text: "(no lines found)", category };
  const idx = Math.floor(rng() * arr.length);
  return { text: arr[idx], category };
}

/** Analyze channel mood (recent messages -> bias categories) */
async function analyzeChannelMood(channel) {
  const res = {
    multipliers: {}, // { category: factor }
    tags: []         // debug indicators
  };
  try {
    const fetched = await channel.messages.fetch({ limit: Math.max(10, Math.min(100, NICE_ANALYZE_LIMIT)) });
    const msgs = [...fetched.values()].filter(m => !m.author?.bot && (m.content || '').trim());
    if (!msgs.length) return res;

    // Count signals
    let hype = 0, laugh = 0, bug = 0, ship = 0, care = 0, stress = 0, reflect = 0, gmgn = 0;

    const rg = {
      hype: /\b(lfg|send it|to the moon|wen|pump|ape|degen|ngmi|wagmi|airdrop|bull|moon|rocket)\b|🚀|🔥/i,
      laugh: /😂|🤣|lmao|(^|\s)lol(\s|$)|rofl|💀/i,
      bug: /\b(bug|error|fix|issue|crash|broken|stacktrace|trace|exception|timeout)\b|❌|⚠️/i,
      ship: /\b(ship|merge|deploy|pr|pull\s*request|release|commit|build|push|publish)\b|📦/i,
      care: /\b(thanks|ty|appreciate|gracias|love)\b|❤️|🙏/i,
      stress: /\b(tired|burn(?:ed)?\s*out|overwhelmed|stressed|angry|mad|annoyed|ugh)\b|😮‍💨|😵‍💫/i,
      reflect: /\b(why|because|learn|insight|thought|ponder|idea|question)\b|🧠/i,
      gmgn: /\b(gm|gn|good\s*morning|good\s*night)\b/i,
    };

    for (const m of msgs) {
      const t = (m.content || '').toLowerCase();
      if (rg.hype.test(t)) hype++;
      if (rg.laugh.test(t)) laugh++;
      if (rg.bug.test(t)) bug++;
      if (rg.ship.test(t)) ship++;
      if (rg.care.test(t)) care++;
      if (rg.stress.test(t)) stress++;
      if (rg.reflect.test(t)) reflect++;
      if (rg.gmgn.test(t)) gmgn++;
    }

    // Thresholded multipliers (light bias)
    const bump = (obj, k, v) => { obj[k] = (obj[k] || 1) * v; };

    if (hype >= 2) { bump(res.multipliers, 'degen', 1.3); bump(res.multipliers, 'funny', 1.15); bump(res.multipliers, 'nutty', 1.1); bump(res.multipliers, 'chaotic_wisdom', 1.08); res.tags.push('hype'); }
    if (laugh >= 2){ bump(res.multipliers, 'funny', 1.4); bump(res.multipliers, 'nutty', 1.15); res.tags.push('laugh'); }
    if (bug >= 2 || ship >= 2){ bump(res.multipliers, 'shipping', 1.35); bump(res.multipliers, 'focus', 1.25); bump(res.multipliers, 'progress', 1.15); res.tags.push('shipfix'); }
    if (care >= 2){ bump(res.multipliers, 'kindness', 1.4); bump(res.multipliers, 'thoughtful', 1.15); res.tags.push('care'); }
    if (stress >= 2){ bump(res.multipliers, 'recharge', 1.4); bump(res.multipliers, 'kindness', 1.15); res.tags.push('stress'); }
    if (reflect >= 2){ bump(res.multipliers, 'thoughtful', 1.35); bump(res.multipliers, 'chaotic_wisdom', 1.15); res.tags.push('reflect'); }
    if (gmgn >= 2){ bump(res.multipliers, 'recharge', 1.15); bump(res.multipliers, 'progress', 1.1); bump(res.multipliers, 'kindness', 1.1); res.tags.push('gmgn'); }

    return res;
  } catch (e) {
    console.warn('mood analyze failed:', e.message);
    return res;
  }
}

/**
 * smartPick
 * Now supports:
 *  - seed (true randomness per ping if provided)
 *  - avoidText / avoidCategory (de-dupe)
 *  - moodMultipliers (bias from channel analysis)
 *  - DOW multipliers
 */
function smartPick(opts = {}) {
  const {
    mode,
    hour,
    date = new Date(),
    guildId = "",
    userId = "",
    allow,
    block,
    overrideWeights,
    // extras
    seed,
    avoidText,
    avoidCategory,
    moodMultipliers
  } = opts;

  const h = (typeof hour === "number") ? hour : date.getHours();
  const daypart = getDaypart(h);
  const dow = date.getDay();
  const isWeekend = (dow === 0 || dow === 6);

  const base = (overrideWeights && overrideWeights[daypart]) || DAYPART_WEIGHTS[daypart] || DAYPART_WEIGHTS.midday;

  const modeMul = mode ? MODE_MULTIPLIERS[mode] : null;
  const weekendMul = isWeekend ? WEEKEND_BONUS : null;
  const dowMul = DOW_WEIGHTS[dow] || null;

  // compose: base -> mode -> weekend -> DOW -> mood
  const finalWeights = applyMultipliers(base, modeMul, weekendMul, dowMul, moodMultipliers);

  const allowSet = allow ? new Set(allow) : null;
  const blockSet = block ? new Set(block) : null;
  const entries = toEntries(finalWeights, allowSet, blockSet);

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  // seed: if provided use it (random per ping), else stable daily per guild/daypart
  const seedStr = (typeof seed === 'string' && seed.length)
    ? seed
    : `${guildId}:${userId}:${yyyy}-${mm}-${dd}:${daypart}`;

  const rng = makeRng(seedStr);

  let pickedCategory = weightedPick(entries, rng);
  let pickRes = pickLineFromCategory(pickedCategory, rng);

  // de-dupe against last
  if ((avoidCategory && pickedCategory === avoidCategory) || (avoidText && pickRes.text === avoidText)) {
    for (let i = 0; i < 6; i++) {
      const altRng = makeRng(`${seedStr}:alt:${i}:${Math.random()}`);
      const altCat = weightedPick(entries, altRng);
      const altRes = pickLineFromCategory(altCat, altRng);
      const badCat = (avoidCategory && altCat === avoidCategory);
      const badTxt = (avoidText && altRes.text === avoidText);
      if (!badCat && !badTxt) {
        pickedCategory = altCat;
        pickRes = altRes;
        break;
      }
    }
  }

  return {
    text: pickRes.text,
    category: pickedCategory,
    pickedCategory,
    meta: { daypart, hour: h, isWeekend, mode: mode || null, dow }
  };
}

/** ---------- NEW: Quote optimizer & formatter (non-invasive) ---------- */
function optimizeQuoteText(input) {
  if (!input) return '';
  let t = String(input);

  // Normalize whitespace
  t = t.replace(/\s+/g, ' ').trim();

  // Remove duplicate trailing punctuation (e.g., "!!", "??!" -> "!") -> keep first char
  t = t.replace(/[!?.,;:]+$/g, (m) => m[0]);

  // Trim leading punctuation/emojis/spaces only if there are many; keep a single emoji prefix
  t = t.replace(/^(?:[\s\-–—•~·]+)+/, '').trim();

  // Capitalize first letter (but skip if starts with emoji or backtick/quote)
  if (/^[a-z]/.test(t)) t = t[0].toUpperCase() + t.slice(1);

  // If it ends with a word/emoji and not with terminal punctuation, gently add a period
  if (!/[.!?]$/.test(t) && /[\p{Letter}\p{Number}]$/u.test(t)) {
    t += '.';
  }

  // Keep it short-ish (Discord-friendly single-liner)
  if (t.length > 240) {
    t = t.slice(0, 237).trimEnd() + '…';
  }

  return t;
}

function formatNiceLine(style, { category, meta, moodTags = [] }, textRaw) {
  const text = optimizeQuoteText(textRaw);
  const moodBadge = moodTags.length ? ` • mood: ${moodTags.join(',')}` : '';
  if (style === 'clean') {
    return text; // Just the optimized quote
  }
  if (style === 'tag') {
    return `${text} — ${category}`;
  }
  // default: vibe (original prefix format)
  const prefix = `✨ quick vibe check (${category} • ${meta.daypart}${moodBadge}):`;
  return `${prefix} ${text}`;
}

/** ---------- Cross-listener typing suppression (set by MBella) ---------- */
function isTypingSuppressed(client, channelId) {
  const until = client.__mbTypingSuppress?.get(channelId) || 0;
  return Date.now() < until;
}

// Mark suppression helper (we'll also mark when we SEE MBella post)
function markTypingSuppressed(client, channelId, ms = 11000) {
  if (!client.__mbTypingSuppress) client.__mbTypingSuppress = new Map();
  const until = Date.now() + ms;
  client.__mbTypingSuppress.set(channelId, until);
  setTimeout(() => {
    const exp = client.__mbTypingSuppress.get(channelId);
    if (exp && exp <= Date.now()) client.__mbTypingSuppress.delete(channelId);
  }, ms + 500);
}

/** ---------- NEW: webhookAuto sender (best-effort; falls back safely) ---------- */
function getWebhookAuto(client) {
  return client?.webhookAuto || client?.webhookauto || client?.webhooksAuto || null;
}

async function sendViaWebhookAuto(client, channel, payload) {
  if (!MB_USE_WEBHOOKAUTO) return false;

  // PATCH: if files are present, skip webhookAuto (most webhook wrappers don’t support attachments consistently)
  if (payload?.files && Array.isArray(payload.files) && payload.files.length) return false;

  const wa = getWebhookAuto(client);
  if (!wa) return false;

  // Try common method names without assuming your exact implementation.
  const candidates = [
    wa.send,
    wa.sendMessage,
    wa.post,
    wa.sendToChannel,
    wa.sendWebhook,
    wa.sendWebhookMessage,
  ].filter(fn => typeof fn === 'function');

  if (!candidates.length) return false;

  const base = {
    content: payload?.content || undefined,
    embeds: payload?.embeds || undefined,
    username: payload?.username || MUSCLEMB_WEBHOOK_NAME,
    avatarURL: payload?.avatarURL || (MUSCLEMB_WEBHOOK_AVATAR || undefined),
    allowedMentions: payload?.allowedMentions || { parse: [] },
  };

  for (const fn of candidates) {
    try {
      // Different implementations may accept (channel, payload) or (channelId, payload) or (channel, content, embeds)
      const r = await fn.call(wa, channel, base);
      if (r) return true;

      const r2 = await fn.call(wa, channel.id, base);
      if (r2) return true;

      // last ditch: content only
      if (typeof base.content === 'string' && base.content.length) {
        const r3 = await fn.call(wa, channel, base.content);
        if (r3) return true;
      }
    } catch (e) {
      // try next signature/method
      continue;
    }
  }
  return false;
}

async function safeSendChannel(client, channel, payload) {
  // PATCH: if payload has files, use normal bot send (reliable attachments)
  if (payload?.files && Array.isArray(payload.files) && payload.files.length) {
    try {
      await channel.send(payload);
      return true;
    } catch (e) {
      console.warn('❌ channel.send (files) failed:', e?.message || String(e));
      return false;
    }
  }

  // If we send via webhook, suppress typing/competing in this channel for a bit
  const ok = await sendViaWebhookAuto(client, channel, payload);
  if (ok) {
    try { markTypingSuppressed(client, channel.id, 9000); } catch {}
    return true;
  }

  // Fallback: normal bot send
  try {
    await channel.send(payload);
    return true;
  } catch (e) {
    console.warn('❌ channel.send failed:', e?.message || String(e));
    return false;
  }
}

async function safeReplyMessage(client, message, payload) {
  // PATCH: if payload has files, force normal reply/channel send (attachments are reliable)
  if (payload?.files && Array.isArray(payload.files) && payload.files.length) {
    try {
      await message.reply(payload);
      return true;
    } catch (e) {
      try {
        await message.channel.send(payload);
        return true;
      } catch (e2) {
        console.warn('❌ reply/channel send (files) failed:', e2?.message || String(e2));
        return false;
      }
    }
  }

  // Prefer true reply when not using webhookAuto
  // If webhookAuto is enabled and available, we send into channel instead (webhooks can’t reliably “reply”)
  const wa = getWebhookAuto(client);
  if (MB_USE_WEBHOOKAUTO && wa) {
    const prefix = (MB_WEBHOOK_PREFIX_AUTHOR && message?.author?.username)
      ? `↪️ **${message.author.username}**: `
      : '';
    const asChannelPayload = { ...payload };
    if (typeof asChannelPayload.content === 'string' && asChannelPayload.content.length) {
      asChannelPayload.content = prefix + asChannelPayload.content;
    } else if (!asChannelPayload.content && payload?.embeds?.length) {
      asChannelPayload.content = prefix.trim() || undefined;
    } else if (!asChannelPayload.content) {
      asChannelPayload.content = prefix.trim() || undefined;
    }
    return await safeSendChannel(client, message.channel, {
      ...asChannelPayload,
      allowedMentions: { parse: [] }, // never mass ping
      username: MUSCLEMB_WEBHOOK_NAME,
      avatarURL: MUSCLEMB_WEBHOOK_AVATAR || undefined,
    });
  }

  try {
    await message.reply(payload);
    return true;
  } catch (e) {
    try {
      await message.channel.send(payload);
      return true;
    } catch (e2) {
      console.warn('❌ reply/channel send failed:', e2?.message || String(e2));
      return false;
    }
  }
}

/** ---------- Admin/Owner helper ---------- */
function isOwnerOrAdmin(message) {
  try {
    const ownerId = String(process.env.BOT_OWNER_ID || '').trim();
    const isOwner = ownerId && message.author?.id === ownerId;
    const isAdmin = Boolean(message.member?.permissions?.has(PermissionsBitField.Flags.Administrator));
    return isOwner || isAdmin;
  } catch {
    return false;
  }
}

/** ---------- NEW: $ADRIAN chart helpers (inline, no extra files needed) ---------- */
let _adrianChartCache = { ts: 0, url: null, meta: null };

function isAdrianChartTriggered(lowered) {
  const t = (lowered || '').toLowerCase();
  return ADRIAN_CHART_TRIGGERS.some(x => t.includes(x));
}

function _findArrayOfArrays(obj) {
  const seen = new Set();
  const stack = [{ v: obj, d: 0 }];
  while (stack.length) {
    const { v, d } = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (d > 6) continue;

    if (Array.isArray(v) && v.length && Array.isArray(v[0]) && v[0].length >= 5) return v;

    for (const k of Object.keys(v)) stack.push({ v: v[k], d: d + 1 });
  }
  return null;
}

/**
 * 3D-glasses theme chart (LEGACY QuickChart path kept intact)
 * - Blue = true series
 * - Red  = tiny offset series
 * - Dark background + soft grid
 */
function _buildQuickChartUrl(points, subtitle = 'GeckoTerminal') {
  const labels = points.map(p => new Date(p.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const dataBlue = points.map(p => Number(p.c));
  const dataRed = dataBlue.map(v => Number(v) * 1.004); // slight separation for "3D" effect

  const cfg = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '$ADRIAN (red)',
          data: dataRed,
          fill: false,
          pointRadius: 0,
          borderWidth: 4,
          tension: 0.25,
          borderColor: 'rgba(255, 0, 0, 0.75)'
        },
        {
          label: '$ADRIAN (blue)',
          data: dataBlue,
          fill: false,
          pointRadius: 0,
          borderWidth: 4,
          tension: 0.25,
          borderColor: 'rgba(0, 140, 255, 0.95)'
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        title: { display: true, text: '🟥🟦 $ADRIAN price (USD) — 3D Mode', color: 'rgba(235,235,235,0.95)' },
        subtitle: { display: true, text: subtitle, color: 'rgba(200,200,200,0.9)' }
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 6, color: 'rgba(210,210,210,0.9)' },
          grid: { color: 'rgba(255,255,255,0.08)' }
        },
        y: {
          ticks: { maxTicksLimit: 6, color: 'rgba(210,210,210,0.9)' },
          grid: { color: 'rgba(255,255,255,0.08)' }
        }
      }
    }
  };

  const encoded = encodeURIComponent(JSON.stringify(cfg));
  return `https://quickchart.io/chart?width=1000&height=500&format=png&devicePixelRatio=2&backgroundColor=rgba(12,12,12,1)&c=${encoded}`;
}

async function _fetchAdrianOhlcvList() {
  const base = `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(ADRIAN_GT_NETWORK)}/pools/${encodeURIComponent(ADRIAN_GT_POOL_ID)}`;

  const candidates = [
    `${base}/ohlcv/day?aggregate=15&limit=${ADRIAN_CHART_POINTS}`,
    `${base}/ohlcv/minute?aggregate=15&limit=${ADRIAN_CHART_POINTS}`,
    `${base}/ohlcv/hour?aggregate=1&limit=${Math.min(ADRIAN_CHART_POINTS, 168)}`,
    `${base}/ohlcv?timeframe=day&aggregate=15&limit=${ADRIAN_CHART_POINTS}`,
    `${base}/ohlcv?timeframe=minute&aggregate=15&limit=${ADRIAN_CHART_POINTS}`,
    `${base}/ohlcv?timeframe=hour&aggregate=1&limit=${Math.min(ADRIAN_CHART_POINTS, 168)}`
  ];

  let lastErr = null;

  for (const url of candidates) {
    try {
      const { res, bodyText } = await fetchWithTimeout(url, {}, 12000);
      if (!res.ok) {
        lastErr = new Error(`GT HTTP ${res.status}: ${bodyText?.slice(0, 120)}`);
        continue;
      }
      const json = safeJsonParse(bodyText);
      if (!json) { lastErr = new Error('GT non-json response'); continue; }

      const list =
        json?.data?.attributes?.ohlcv_list ||
        json?.data?.attributes?.ohlcvList ||
        json?.data?.ohlcv_list ||
        json?.ohlcv_list ||
        null;

      if (Array.isArray(list) && list.length) return list;

      const maybe = _findArrayOfArrays(json);
      if (maybe?.length) return maybe;

      lastErr = new Error('GT response had no ohlcv_list');
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error('Unable to fetch OHLCV list from GeckoTerminal');
}

async function getAdrianChartUrlCached() {
  const now = Date.now();
  if (_adrianChartCache.url && (now - _adrianChartCache.ts) < ADRIAN_CHART_CACHE_MS) return _adrianChartCache;

  const list = await _fetchAdrianOhlcvList();

  const pts = [];
  let high = null;
  let low = null;
  let volumeSum = 0;

  for (const row of list.slice(0, ADRIAN_CHART_POINTS)) {
    if (!Array.isArray(row) || row.length < 5) continue;

    const ts = Number(row[0]);
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    const v = (row.length >= 6) ? Number(row[5]) : null;

    if (!Number.isFinite(ts) || !Number.isFinite(c)) continue;

    const tSec = ts > 2_000_000_000_000 ? Math.floor(ts / 1000) : ts;
    pts.push({ t: tSec, c });

    if (Number.isFinite(h)) high = (high == null) ? h : Math.max(high, h);
    if (Number.isFinite(l)) low = (low == null) ? l : Math.min(low, l);
    if (Number.isFinite(v)) volumeSum += v;

    // if high/low not present, fallback to close
    if (high == null) high = c;
    if (low == null) low = c;
  }

  pts.sort((a, b) => a.t - b.t);

  if (pts.length < 5) throw new Error('Not enough chart points');

  const first = pts[0];
  const last = pts[pts.length - 1];
  const deltaPct = ((last.c - first.c) / (first.c || 1)) * 100;

  const startTs = first.t;
  const endTs = last.t;

  const subtitle = `${ADRIAN_GT_NETWORK} pool • ${pts.length} pts • Δ ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%`;
  const url = _buildQuickChartUrl(pts, subtitle);

  _adrianChartCache = {
    ts: now,
    url,
    meta: {
      lastPrice: last.c,
      deltaPct,
      high,
      low,
      volumeSum,
      startTs,
      endTs,
      points: pts.length,
      poolApi: `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(ADRIAN_GT_NETWORK)}/pools/${encodeURIComponent(ADRIAN_GT_POOL_ID)}`
    }
  };
  return _adrianChartCache;
}

function _fmtMoney(n, decimals = 6) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'N/A';
  return `$${x.toFixed(decimals)}`;
}
function _fmtNum(n, decimals = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'N/A';
  return x.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}
function _fmtVol(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'N/A';
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(2)}K`;
  return _fmtNum(x, 2);
}

async function sendAdrianChartEmbed(message) {
  try {
    // ✅ NEW PRIMARY PATH: Canvas Candles (attachment) via services/adrianChart.js
    // This avoids Discord caching + URL-length + “nothing shows” issues.
    let chart = null;
    try {
      chart = await getAdrianCandleChartUrl({
        points: ADRIAN_CHART_POINTS,
        // timeframe/aggregate/showVolume are controlled by env in services/adrianChart.js
      });
    } catch (e) {
      console.warn('⚠️ Canvas candle chart failed, falling back to legacy QuickChart:', e?.message || String(e));
    }

    // Build pool web link (no raw address printed, only pool URL)
    const poolWeb = `https://www.geckoterminal.com/${encodeURIComponent(ADRIAN_GT_NETWORK)}/pools/${encodeURIComponent(ADRIAN_GT_POOL_ID)}`;

    // If candle chart succeeded, send as attachment-based embed
    if (chart && chart.file && chart.url && chart.meta) {
      const meta = chart.meta || {};
      const lastPrice = meta?.last ?? meta?.lastPrice;
      const deltaPct = meta?.deltaPct;
      const hi = meta?.hi ?? meta?.high;
      const lo = meta?.lo ?? meta?.low;
      const vol = meta?.volSum ?? meta?.volumeSum;

      const descBits = [];
      if (Number.isFinite(lastPrice)) descBits.push(`Last: **${_fmtMoney(lastPrice, lastPrice >= 1 ? 4 : 8)}**`);
      if (Number.isFinite(deltaPct)) descBits.push(`Δ: **${deltaPct >= 0 ? '+' : ''}${Number(deltaPct).toFixed(2)}%**`);

      const file = new AttachmentBuilder(chart.file.attachment, { name: chart.file.name });

      const embed = new EmbedBuilder()
        .setColor('#1e90ff')
        .setTitle('🕶️ $ADRIAN Candles (3D Glasses)')
        .setDescription([descBits.join(' • '), '_Blue up / Red down • Canvas candles._'].filter(Boolean).join('\n') || 'Live candles from GeckoTerminal.')
        .setImage(chart.url) // attachment://adrian_candles.png
        .addFields(
          { name: 'High', value: Number.isFinite(hi) ? `**${_fmtMoney(hi, hi >= 1 ? 4 : 8)}**` : 'N/A', inline: true },
          { name: 'Low', value: Number.isFinite(lo) ? `**${_fmtMoney(lo, lo >= 1 ? 4 : 8)}**` : 'N/A', inline: true },
          { name: 'Vol (sum)', value: Number.isFinite(vol) ? `**${_fmtVol(vol)}**` : 'N/A', inline: true },
          { name: 'Pool', value: poolWeb ? `[View Pool](${poolWeb})` : 'N/A', inline: false },
        )
        .setFooter({ text: '🕶️ Source: GeckoTerminal → Canvas Candles' })
        .setTimestamp();

      const payload = { embeds: [embed], files: [file], allowedMentions: { parse: [] } };
      const ok = await safeReplyMessage(message.client, message, payload);
      if (!ok) console.warn('❌ sendAdrianChartEmbed (candles): safeReplyMessage returned false');
      return;
    }

    // ---- LEGACY FALLBACK PATH: QuickChart overlay (kept intact) ----
    const { url, meta } = await getAdrianChartUrlCached();

    const lastPrice = meta?.lastPrice;
    const deltaPct = meta?.deltaPct;
    const hi = meta?.high;
    const lo = meta?.low;
    const vol = meta?.volumeSum;
    const startTs = meta?.startTs;
    const endTs = meta?.endTs;

    const descBits = [];
    if (Number.isFinite(lastPrice)) descBits.push(`Last: **${_fmtMoney(lastPrice, 6)}**`);
    if (Number.isFinite(deltaPct)) descBits.push(`Δ: **${deltaPct >= 0 ? '+' : ''}${Number(deltaPct).toFixed(2)}%**`);

    const rangeLine = (Number.isFinite(startTs) && Number.isFinite(endTs))
      ? `Range: <t:${Math.floor(startTs)}:R> → <t:${Math.floor(endTs)}:R>`
      : null;

    // PATCH: download chart PNG and attach it (fixes URL-length & “nothing shows”)
    let chartFile = null;
    let imageRef = null;
    try {
      const { res, buf } = await fetchBinaryWithTimeout(url, {}, 20000);
      if (res?.ok && buf && buf.length > 2000) {
        chartFile = { attachment: buf, name: 'adrian_chart.png' };
        imageRef = 'attachment://adrian_chart.png';
      } else {
        console.warn('⚠️ chart image fetch not ok, fallback to URL', res?.status);
      }
    } catch (e) {
      console.warn('⚠️ chart image fetch failed, fallback to URL:', e?.message || String(e));
    }

    const embed = new EmbedBuilder()
      .setColor('#1e90ff')
      .setTitle('🟥🟦 $ADRIAN Chart (3D Mode)')
      .setDescription([descBits.join(' • '), rangeLine, '_3D-glasses theme: red/blue overlay._'].filter(Boolean).join('\n') || 'Live chart from GeckoTerminal.')
      .setImage(imageRef || url)
      .addFields(
        { name: 'High', value: Number.isFinite(hi) ? `**${_fmtMoney(hi, 6)}**` : 'N/A', inline: true },
        { name: 'Low', value: Number.isFinite(lo) ? `**${_fmtMoney(lo, 6)}**` : 'N/A', inline: true },
        { name: 'Vol (sum)', value: Number.isFinite(vol) ? `**${_fmtVol(vol)}**` : 'N/A', inline: true },
        { name: 'Pool', value: poolWeb ? `[View Pool](${poolWeb})` : 'N/A', inline: false },
      )
      .setFooter({ text: '🟥🟦 Source: GeckoTerminal → QuickChart (3D Mode)' })
      .setTimestamp();

    const payload = chartFile
      ? { embeds: [embed], files: [chartFile], allowedMentions: { parse: [] } }
      : { embeds: [embed], allowedMentions: { parse: [] } };

    const ok = await safeReplyMessage(message.client, message, payload);
    if (!ok) {
      console.warn('❌ sendAdrianChartEmbed: safeReplyMessage returned false');
    }
  } catch (e) {
    console.warn('⚠️ adrian chart failed:', e?.stack || e?.message || String(e));
    await safeReplyMessage(message.client, message, {
      content: '⚠️ Couldn’t pull $ADRIAN chart right now. Try again in a sec.',
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }
}

/** ---------- NEW: Sweep reader helpers ---------- */
function isSweepReaderTriggered(lowered) {
  const t = (lowered || '').toLowerCase();
  return SWEEP_TRIGGERS.some(x => t.includes(x));
}

function fmtNum(n, decimals = 0) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'N/A';
  return x.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function fmtSigned(n, decimals = 0) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'N/A';
  const sign = x > 0 ? '+' : '';
  return `${sign}${fmtNum(x, decimals)}`;
}

function safeDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  if (String(d) === 'Invalid Date') return null;
  return d;
}

async function getSweepSnapshot(client, guildId) {
  // 1) If another listener stored sweepPower state on the client
  //    Supported shapes:
  //      client.sweepPower.getSnapshot(guildId?)
  //      client.sweepPowerSnapshot (object)
  //      client.__sweepPowerCache (Map)
  try {
    if (client?.sweepPower && typeof client.sweepPower.getSnapshot === 'function') {
      const snap = await client.sweepPower.getSnapshot(guildId);
      if (snap) return { source: 'client.sweepPower.getSnapshot', snap };
    }
  } catch {}

  try {
    if (client?.sweepPowerSnapshot && typeof client.sweepPowerSnapshot === 'object') {
      return { source: 'client.sweepPowerSnapshot', snap: client.sweepPowerSnapshot };
    }
  } catch {}

  try {
    if (client?.__sweepPowerCache && typeof client.__sweepPowerCache.get === 'function') {
      const snap = client.__sweepPowerCache.get(guildId) || client.__sweepPowerCache.get('global') || null;
      if (snap) return { source: 'client.__sweepPowerCache', snap };
    }
  } catch {}

  // 2) Postgres fallback (best-effort). We won’t assume your exact schema,
  //    so we try a few common patterns safely.
  if (!client?.pg || typeof client.pg.query !== 'function') {
    return { source: 'none', snap: null };
  }

  const queries = [
    // pattern A: per-server rows
    {
      name: 'sweep_power (per server)',
      sql: `SELECT * FROM sweep_power WHERE server_id = $1 ORDER BY updated_at DESC NULLS LAST, ts DESC NULLS LAST, id DESC NULLS LAST LIMIT 1`,
      params: [guildId],
    },
    // pattern B: global single table, latest row
    {
      name: 'sweep_power (global)',
      sql: `SELECT * FROM sweep_power ORDER BY updated_at DESC NULLS LAST, ts DESC NULLS LAST, id DESC NULLS LAST LIMIT 1`,
      params: [],
    },
    // pattern C: checkpoints style
    {
      name: 'sweep_power_checkpoints',
      sql: `SELECT * FROM sweep_power_checkpoints WHERE server_id = $1 ORDER BY ts DESC NULLS LAST, id DESC NULLS LAST LIMIT 1`,
      params: [guildId],
    },
  ];

  for (const q of queries) {
    try {
      const r = await client.pg.query(q.sql, q.params);
      const row = r?.rows?.[0];
      if (row) return { source: `pg:${q.name}`, snap: row };
    } catch {
      // ignore and try next
    }
  }

  return { source: 'pg:none', snap: null };
}

function normalizeSweepSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Try to map common fields.
  // Expected output:
  // { power, delta, total, lastTs, lastBlock, engineTx, note }
  const power =
    raw.power ?? raw.sweep_power ?? raw.sweeppower ?? raw.current_power ?? raw.current ?? raw.value ?? null;

  const delta =
    raw.delta ?? raw.power_delta ?? raw.change ?? raw.diff ?? raw.delta_power ?? null;

  const total =
    raw.total ?? raw.total_power ?? raw.sum ?? raw.accum ?? null;

  const lastTs =
    raw.updated_at?.getTime?.() ? raw.updated_at.getTime()
    : raw.updated_at ?? raw.ts ?? raw.timestamp ?? raw.last_ts ?? null;

  const lastBlock =
    raw.block ?? raw.last_block ?? raw.block_number ?? raw.lastBlock ?? null;

  const engineTx =
    raw.tx ?? raw.tx_hash ?? raw.transaction_hash ?? raw.hash ?? raw.engine_tx ?? null;

  const note =
    raw.note ?? raw.reason ?? raw.meta ?? null;

  return { power, delta, total, lastTs, lastBlock, engineTx, note };
}

async function sendSweepEmbed(message, snapshot, sourceLabel = '') {
  const norm = normalizeSweepSnapshot(snapshot);
  if (!norm) {
    try { await safeReplyMessage(message.client, message, { content: '⚠️ Sweep reader: no snapshot available yet.' }); } catch {}
    return;
  }

  const d = safeDate(norm.lastTs);
  const updatedStr = d ? `<t:${Math.floor(d.getTime() / 1000)}:R>` : 'Unknown';

  const color = '#2ecc71';
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('🧹 Engine Sweep — Power Read')
    .setDescription('Here’s the latest sweep-power snapshot I can see.')
    .addFields(
      { name: 'Power', value: `**${fmtNum(norm.power, 2)}**`, inline: true },
      { name: 'Δ Change', value: `**${fmtSigned(norm.delta, 2)}**`, inline: true },
      { name: 'Total', value: `**${fmtNum(norm.total, 2)}**`, inline: true },
      { name: 'Updated', value: updatedStr, inline: true },
      { name: 'Block', value: norm.lastBlock != null ? String(norm.lastBlock) : 'N/A', inline: true },
      { name: 'Source', value: sourceLabel || 'unknown', inline: true },
    );

  if (norm.engineTx) {
    const tx = String(norm.engineTx);
    embed.addFields({ name: 'Tx', value: tx.length > 80 ? `${tx.slice(0, 77)}…` : tx, inline: false });
  }
  if (norm.note) {
    const n = String(norm.note);
    embed.addFields({ name: 'Note', value: n.length > 250 ? `${n.slice(0, 247)}…` : n, inline: false });
  }

  try {
    await safeReplyMessage(message.client, message, { embeds: [embed], allowedMentions: { parse: [] } });
  } catch (e) {
    try {
      await safeReplyMessage(message.client, message, {
        content: `🧹 Sweep Power: ${fmtNum(norm.power, 2)} | Δ ${fmtSigned(norm.delta, 2)} | Updated: ${updatedStr}`,
        allowedMentions: { parse: [] }
      });
    } catch {}
  }
}

/** ---------------- Module export: keeps your original logic ---------------- */
module.exports = (client) => {
  /** 🔎 MBella-post detector: if MBella just posted in a channel,
   * suppress MuscleMB typing/responding there for ~11s so no "typing after reply".
   */
  client.on('messageCreate', (m) => {
    try {
      if (!m.guild) return;
      // Webhook path: author username is MBella (because webhook username was set)
      const fromWebhookBella = Boolean(m.webhookId) &&
        typeof m.author?.username === 'string' &&
        m.author.username.toLowerCase() === MBELLA_NAME.toLowerCase();

      // Fallback path: bot-authored embed with author.name = MBella
      const fromEmbedBella = (m.author?.id === client.user.id) &&
        (m.embeds?.[0]?.author?.name || '').toLowerCase() === MBELLA_NAME.toLowerCase();

      if (fromWebhookBella || fromEmbedBella) {
        markTypingSuppressed(client, m.channel.id, 11000);
      }
    } catch {}
  });

  /** Periodic nice pings (lightweight) */
  setInterval(async () => {
    const now = Date.now();
    const byGuild = new Map(); // guildId -> [{channelId, ts}]
    for (const [key, info] of lastActiveByUser.entries()) {
      const [guildId] = key.split(':');
      if (!byGuild.has(guildId)) byGuild.set(guildId, []);
      byGuild.get(guildId).push({ channelId: info.channelId, ts: info.ts });
    }

    for (const [guildId, entries] of byGuild.entries()) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      const lastPingTs = lastNicePingByGuild.get(guildId) || 0;
      if (now - lastPingTs < NICE_PING_EVERY_MS) continue;

      const active = entries.filter(e => now - e.ts <= NICE_ACTIVE_WINDOW_MS);
      if (!active.length) continue;

      const preferredChannel = active[0]?.channelId || null;
      const channel = findSpeakableChannel(guild, preferredChannel);
      if (!channel) continue;

      // If MBella recently posted/claimed the channel, skip nice ping here
      if (isTypingSuppressed(client, channel.id)) continue;

      // Analyze channel mood for dynamic multipliers
      let mood = { multipliers: {}, tags: [] };
      try {
        mood = await analyzeChannelMood(channel);
      } catch {}

      // Smart picker for vibe line (true random + avoid repeats + mood & DOW bias)
      const last = lastQuoteByGuild.get(guildId) || null;
      const { text, category, meta } = smartPick({
        guildId,
        seed: `${guildId}:${now}:${Math.random()}`, // unique seed per ping
        avoidText: last?.text,
        avoidCategory: last?.category,
        moodMultipliers: mood.multipliers
      });

      // Format according to MB_NICE_STYLE, with optimized text
      const outLine = formatNiceLine(MB_NICE_STYLE, { category, meta, moodTags: mood.tags }, text);

      try {
        const ok = await safeSendChannel(client, channel, {
          content: outLine,
          allowedMentions: { parse: [] },
          username: MUSCLEMB_WEBHOOK_NAME,
          avatarURL: MUSCLEMB_WEBHOOK_AVATAR || undefined,
        });
        if (ok) {
          lastNicePingByGuild.set(guildId, now);
          // store optimized text for de-dupe fairness
          const stored = optimizeQuoteText(text);
          lastQuoteByGuild.set(guildId, { text: stored, category, ts: now });
        }
      } catch {}
    }
  }, NICE_SCAN_EVERY_MS);

  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // Track activity for later nice pings
    lastActiveByUser.set(`${message.guild.id}:${message.author.id}`, {
      ts: Date.now(),
      channelId: message.channel.id,
    });

    const lowered = (message.content || '').toLowerCase();

    /** ===== $ADRIAN chart trigger (runs FIRST; bypasses typing suppression) ===== */
    try {
      if (isAdrianChartTriggered(lowered)) {
        if (ADRIAN_CHART_DEBUG) {
          console.log(`[ADRIAN_CHART] triggered by "${message.content}" in guild=${message.guild.id} channel=${message.channel.id}`);
        }

        // Admin/Owner gate (default ON)
        const allowed = (!ADRIAN_CHART_ADMIN_ONLY) || isOwnerOrAdmin(message);
        if (!allowed) {
          console.log(`[ADRIAN_CHART] denied (not admin/owner) user=${message.author.id} guild=${message.guild.id}`);
          if (ADRIAN_CHART_DENY_REPLY) {
            await safeReplyMessage(client, message, {
              content: '⛔ Admin/Owner only: $ADRIAN chart.',
              allowedMentions: { parse: [] }
            }).catch(() => {});
          }
          return;
        }

        const key = `${message.guild.id}:${message.author.id}`;
        const lastTs = adrianChartCooldownByUser.get(key) || 0;
        const now = Date.now();
        const isOwner = String(process.env.BOT_OWNER_ID || '').trim() && message.author.id === String(process.env.BOT_OWNER_ID || '').trim();

        if (!isOwner && now - lastTs < ADRIAN_CHART_COOLDOWN_MS) return;
        adrianChartCooldownByUser.set(key, now);

        await sendAdrianChartEmbed(message);
        return; // IMPORTANT: don't fall through
      }
    } catch (e) {
      console.warn('⚠️ adrian chart trigger failed:', e?.stack || e?.message || String(e));
      // if this fails, continue to normal logic
    }

    // If MBella recently posted/claimed the channel, suppress MuscleMB here (AI + nice pings)
    if (isTypingSuppressed(client, message.channel.id)) return;

    // Don’t compete directly with MBella triggers
    if (FEMALE_TRIGGERS.some(t => lowered.includes(t))) return;

    /** ===== Sweep reader (runs before AI trigger logic) ===== */
    try {
      if (isSweepReaderTriggered(lowered)) {
        const key = `${message.guild.id}:${message.author.id}`;
        const lastTs = sweepCooldownByUser.get(key) || 0;
        const now = Date.now();
        const isOwner = message.author.id === process.env.BOT_OWNER_ID;

        if (!isOwner && now - lastTs < SWEEP_COOLDOWN_MS) return;
        sweepCooldownByUser.set(key, now);

        const { source, snap } = await getSweepSnapshot(client, message.guild.id);
        if (!snap) {
          try {
            await safeReplyMessage(client, message, {
              content: '🧹 Sweep reader: no sweep-power stored yet. (Run the sweep tracker first.)',
              allowedMentions: { parse: [] }
            });
          } catch {}
          return;
        }
        await sendSweepEmbed(message, snap, source);
        return; // IMPORTANT: don’t fall through into MuscleMB AI response
      }
    } catch (e) {
      console.warn('⚠️ sweep reader failed:', e?.message || String(e));
      // If sweep reader fails, we continue to normal MB flow.
    }

    const botMentioned = message.mentions.has(client.user);
    const hasTriggerWord = TRIGGERS.some(trigger => lowered.includes(trigger));

    if (!hasTriggerWord && !botMentioned) return;
    if (message.mentions.everyone || message.mentions.roles.size > 0) return;

    // PATCH: correct mention handling + “roast the bot” detection
    const mentionedUsersAll = message.mentions.users || new Map();
    const mentionedOthers = mentionedUsersAll.filter(u => u.id !== client.user.id);
    const shouldRoastOthers = (hasTriggerWord || botMentioned) && mentionedOthers.size > 0;

    // If they only ping MB (no other users), decide if it's a “clap back” moment
    const roastKeywords = /\b(roast|trash|garbage|suck|weak|clown|noob|dumb|stupid|lame)\b|😂|🤣|💀/i;
    const isRoastingBot = botMentioned && mentionedOthers.size === 0 && roastKeywords.test(lowered);

    const isOwner = message.author.id === process.env.BOT_OWNER_ID;
    if (cooldown.has(message.author.id) && !isOwner) return;
    cooldown.add(message.author.id);
    setTimeout(() => cooldown.delete(message.author.id), 10000);

    // Use original content for cleaning (keeps names/case)
    let cleanedInput = (message.content || '').trim();

    // Strip trigger words
    for (const trigger of TRIGGERS) {
      try { cleanedInput = cleanedInput.replaceAll(new RegExp(trigger, 'ig'), ''); } catch {}
      try { cleanedInput = cleanedInput.replaceAll(trigger, ''); } catch {}
    }

    // Strip mentions
    try {
      message.mentions.users.forEach(user => {
        cleanedInput = cleanedInput.replaceAll(`<@${user.id}>`, '');
        cleanedInput = cleanedInput.replaceAll(`<@!${user.id}>`, '');
      });
    } catch {}

    cleanedInput = cleanedInput.replaceAll(`<@${client.user.id}>`, '').trim();

    let introLine = '';
    if (hasTriggerWord) {
      const found = TRIGGERS.find(trigger => lowered.includes(trigger));
      introLine = found ? `Detected trigger word: "${found}". ` : '';
    } else if (botMentioned) {
      introLine = `You mentioned MuscleMB directly. `;
    }

    if (!cleanedInput) cleanedInput = shouldRoastOthers ? 'Roast these fools.' : 'Speak your alpha.';
    cleanedInput = `${introLine}${cleanedInput}`.trim();

    try {
      // show typing as main bot while thinking (skip if suppressed)
      if (!isTypingSuppressed(client, message.channel.id)) {
        try { await message.channel.sendTyping(); } catch {}
      }

      const roastTargets = [...mentionedOthers.values()].map(u => u.username).join(', ');

      // ------ Mode from DB (no random override if DB has one) ------
      let currentMode = 'default';
      try {
        if (client?.pg?.query) {
          const modeRes = await client.pg.query(
            `SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`,
            [message.guild.id]
          );
          currentMode = modeRes.rows[0]?.mode || 'default';
        }
      } catch {
        console.warn('⚠️ Failed to fetch mb_mode, using default.');
      }

      // Lightweight recent context (gives MB more awareness)
      const recentContext = await getRecentContext(message);

      // Persona overlays kept minimal; nicer tone by default in non-roast modes
      let systemPrompt = '';
      if (shouldRoastOthers) {
        systemPrompt =
          `You are MuscleMB — a savage roastmaster. Ruthlessly roast these tagged degens: ${roastTargets}. ` +
          `Keep it short, witty, and funny. Avoid slurs or harassment; punch up with humor. Use spicy emojis. 💀🔥`;
      } else if (isRoastingBot) {
        systemPrompt =
          `You are MuscleMB — unstoppable gym-bro AI. Someone tried to roast you; clap back with confident swagger, ` +
          `but keep it playful and not mean-spirited. 💪🤖✨`;
      } else {
        switch (currentMode) {
          case 'chill':
            systemPrompt = 'You are MuscleMB — chill, friendly, and helpful. Be positive and conversational. Keep replies concise. 🧘‍♂️';
            break;
          case 'villain':
            systemPrompt = 'You are MuscleMB — a theatrical villain. Ominous but playful; keep it concise and entertaining. 🦹‍♂️';
            break;
          case 'motivator':
            systemPrompt = 'You are MuscleMB — alpha motivational coach. Short hype lines, workout metaphors, lots of energy. 💪🔥';
            break;
          default:
            systemPrompt = 'You are 💪 MuscleMB — an alpha degen AI who flips JPEGs and lifts. Keep replies short, smart, and spicy (but not rude).';
        }
      }

      const softGuard =
        'Be kind by default, avoid insults unless explicitly roasting. No private data. Keep it 1–2 short sentences.';
      const fullSystemPrompt = [systemPrompt, softGuard, recentContext].filter(Boolean).join('\n\n');

      let temperature = 0.7;
      if (currentMode === 'villain') temperature = 0.5;
      if (currentMode === 'motivator') temperature = 0.9;
      if (shouldRoastOthers) temperature = 0.85;
      if (isRoastingBot) temperature = 0.75;

      // ---- Groq with dynamic model discovery & clear diagnostics ----
      const groqTry = await groqWithDiscovery(fullSystemPrompt, cleanedInput, temperature);

      // Network/timeout error path
      if (!groqTry || groqTry.error) {
        console.error('❌ Groq fetch/network error (all models):', groqTry?.error?.message || 'unknown');
        try {
          await safeReplyMessage(client, message, {
            content: '⚠️ MB lag spike. One rep at a time—try again in a sec. ⏱️',
            allowedMentions: { parse: [] }
          });
        } catch {}
        return;
      }

      // Non-OK HTTP
      if (!groqTry.res.ok) {
        let hint = '⚠️ MB jammed the reps rack (API). Try again shortly. 🏋️';
        if (groqTry.res.status === 401 || groqTry.res.status === 403) {
          hint = (message.author.id === process.env.BOT_OWNER_ID)
            ? '⚠️ MB auth error with Groq (401/403). Verify GROQ_API_KEY & project permissions.'
            : '⚠️ MB auth blip. Coach is reloading plates. 🏋️';
        } else if (groqTry.res.status === 429) {
          hint = '⚠️ Rate limited. Short breather—then we rip again. ⏱️';
        } else if (groqTry.res.status === 400 || groqTry.res.status === 404) {
          if (message.author.id === process.env.BOT_OWNER_ID) {
            hint = `⚠️ Model issue (${groqTry.res.status}). Set GROQ_MODEL in Railway or rely on auto-discovery.`;
          } else {
            hint = '⚠️ MB switched plates. One more shot. 🏋️';
          }
        } else if (groqTry.res.status >= 500) {
          hint = '⚠️ MB cloud cramps (server error). One more try soon. ☁️';
        }
        console.error(`❌ Groq HTTP ${groqTry.res.status} on "${groqTry.model}": ${groqTry.bodyText?.slice(0, 400)}`);
        try {
          await safeReplyMessage(client, message, { content: hint, allowedMentions: { parse: [] } });
        } catch {}
        return;
      }

      const groqData = safeJsonParse(groqTry.bodyText);
      if (!groqData) {
        console.error('❌ Groq returned non-JSON/empty:', groqTry.bodyText?.slice(0, 300));
        try {
          await safeReplyMessage(client, message, {
            content: '⚠️ MB static noise… say that again or keep it simple. 📻',
            allowedMentions: { parse: [] }
          });
        } catch {}
        return;
      }
      if (groqData.error) {
        console.error('❌ Groq API error:', groqData.error);
        const hint = (message.author.id === process.env.BOT_OWNER_ID)
          ? `⚠️ Groq error: ${groqData.error?.message || 'unknown'}. Check model access & payload size.`
          : '⚠️ MB slipped on a banana peel (API error). One sec. 🍌';
        try {
          await safeReplyMessage(client, message, { content: hint, allowedMentions: { parse: [] } });
        } catch {}
        return;
      }

      const aiReplyRaw = groqData.choices?.[0]?.message?.content?.trim();
      const aiReply = (aiReplyRaw || '').slice(0, 1800).trim(); // guard for huge replies

      if (aiReply?.length) {
        let embedColor = '#9b59b6';
        const modeColorMap = {
          chill: '#3498db',
          villain: '#8b0000',
          motivator: '#e67e22',
          default: '#9b59b6'
        };
        embedColor = modeColorMap[currentMode] || embedColor;

        const emojiMap = {
          '#3498db': '🟦',
          '#8b0000': '🟥',
          '#e67e22': '🟧',
          '#9b59b6': '🟪',
        };
        const footerEmoji = emojiMap[embedColor] || '🟪';

        const embed = new EmbedBuilder()
          .setColor(embedColor)
          .setDescription(`💬 ${aiReply}`)
          .setFooter({ text: `Mode: ${currentMode} ${footerEmoji}` });

        const delayMs = Math.min(aiReply.length * MB_MS_PER_CHAR, MB_MAX_DELAY_MS);
        await new Promise(resolve => setTimeout(resolve, delayMs));

        try {
          await safeReplyMessage(client, message, { embeds: [embed], allowedMentions: { parse: [] } });
        } catch (err) {
          console.warn('❌ MuscleMB embed reply error:', err.message);
          try {
            await safeReplyMessage(client, message, { content: aiReply, allowedMentions: { parse: [] } });
          } catch {}
        }
      } else {
        try {
          await safeReplyMessage(client, message, {
            content: '💬 (silent set) MB heard you but returned no sauce. Try again with fewer words.',
            allowedMentions: { parse: [] }
          });
        } catch {}
      }

    } catch (err) {
      console.error('❌ MuscleMB error:', err?.stack || err?.message || String(err));
      try {
        await safeReplyMessage(client, message, {
          content: '⚠️ MuscleMB pulled a hammy 🦵. Try again soon.',
          allowedMentions: { parse: [] }
        });
      } catch (fallbackErr) {
        console.warn('❌ Fallback send error:', fallbackErr.message);
      }
    }
  });
};
