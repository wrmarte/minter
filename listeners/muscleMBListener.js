// listeners/musclemb.js
const fetch = require('node-fetch');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL_ENV = (process.env.GROQ_MODEL || '').trim();

// Typing speed (match MBella by default)
const MB_MS_PER_CHAR = Number(process.env.MB_MS_PER_CHAR || '40');
const MB_MAX_DELAY_MS = Number(process.env.MB_MAX_DELAY_MS || '5000');

// Name MBella uses when posting via webhook/embeds
const MBELLA_NAME = (process.env.MBELLA_NAME || 'MBella').trim();

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

      const moodBadge = mood.tags.length ? ` • mood: ${mood.tags.join(',')}` : '';
      const prefix = `✨ quick vibe check (${category} • ${meta.daypart}${moodBadge}):`;

      try {
        await channel.send(`${prefix} ${text}`);
        lastNicePingByGuild.set(guildId, now);
        lastQuoteByGuild.set(guildId, { text, category, ts: now });
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

    // If MBella recently posted/claimed the channel, suppress MuscleMB here
    if (isTypingSuppressed(client, message.channel.id)) return;

    // Don’t compete directly with MBella triggers
    if (FEMALE_TRIGGERS.some(t => lowered.includes(t))) return;

    const botMentioned = message.mentions.has(client.user);
    const hasTriggerWord = TRIGGERS.some(trigger => lowered.includes(trigger));

    if (!hasTriggerWord && !botMentioned) return;
    if (message.mentions.everyone || message.mentions.roles.size > 0) return;

    const mentionedUsers = message.mentions.users.filter(u => u.id !== client.user.id);
    const shouldRoast = (hasTriggerWord || botMentioned) && mentionedUsers.size > 0;
    const isRoastingBot = shouldRoast && message.mentions.has(client.user) && mentionedUsers.size === 1 && mentionedUsers.has(client.user.id);

    const isOwner = message.author.id === process.env.BOT_OWNER_ID;
    if (cooldown.has(message.author.id) && !isOwner) return;
    cooldown.add(message.author.id);
    setTimeout(() => cooldown.delete(message.author.id), 10000);

    let cleanedInput = lowered;
    TRIGGERS.forEach(trigger => {
      cleanedInput = cleanedInput.replaceAll(trigger, '');
    });
    message.mentions.users.forEach(user => {
      cleanedInput = cleanedInput.replaceAll(`<@${user.id}>`, '');
      cleanedInput = cleanedInput.replaceAll(`<@!${user.id}>`, '');
    });
    cleanedInput = cleanedInput.replaceAll(`<@${client.user.id}>`, '').trim();

    let introLine = '';
    if (hasTriggerWord) {
      introLine = `Detected trigger word: "${TRIGGERS.find(trigger => lowered.includes(trigger))}". `;
    } else if (botMentioned) {
      introLine = `You mentioned MuscleMB directly. `;
    }
    if (!cleanedInput) cleanedInput = shouldRoast ? 'Roast these fools.' : 'Speak your alpha.';
    cleanedInput = `${introLine}${cleanedInput}`;

    try {
      // show typing as main bot while thinking
      await message.channel.sendTyping();

      const isRoast = shouldRoast && !isRoastingBot;
      const roastTargets = [...mentionedUsers.values()].map(u => u.username).join(', ');

      // ------ Mode from DB (no random override if DB has one) ------
      let currentMode = 'default';
      try {
        const modeRes = await client.pg.query(
          `SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`,
          [message.guild.id]
        );
        currentMode = modeRes.rows[0]?.mode || 'default';
      } catch {
        console.warn('⚠️ Failed to fetch mb_mode, using default.');
      }

      // Lightweight recent context (gives MB more awareness)
      const recentContext = await getRecentContext(message);

      // Persona overlays kept minimal; nicer tone by default in non-roast modes
      let systemPrompt = '';
      if (isRoast) {
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

      // ---- Groq with dynamic model discovery & clear diagnostics ----
      const groqTry = await groqWithDiscovery(fullSystemPrompt, cleanedInput, temperature);

      // Network/timeout error path
      if (!groqTry || groqTry.error) {
        console.error('❌ Groq fetch/network error (all models):', groqTry?.error?.message || 'unknown');
        try { await message.reply('⚠️ MB lag spike. One rep at a time—try again in a sec. ⏱️'); } catch {}
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
        try { await message.reply(hint); } catch {}
        return;
      }

      const groqData = safeJsonParse(groqTry.bodyText);
      if (!groqData) {
        console.error('❌ Groq returned non-JSON/empty:', groqTry.bodyText?.slice(0, 300));
        try { await message.reply('⚠️ MB static noise… say that again or keep it simple. 📻'); } catch {}
        return;
      }
      if (groqData.error) {
        console.error('❌ Groq API error:', groqData.error);
        const hint = (message.author.id === process.env.BOT_OWNER_ID)
          ? `⚠️ Groq error: ${groqData.error?.message || 'unknown'}. Check model access & payload size.`
          : '⚠️ MB slipped on a banana peel (API error). One sec. 🍌';
        try { await message.reply(hint); } catch {}
        return;
      }

      const aiReply = groqData.choices?.[0]?.message?.content?.trim();

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
          await message.reply({ embeds: [embed] });
        } catch (err) {
          console.warn('❌ MuscleMB embed reply error:', err.message);
          try { await message.reply(aiReply); } catch {}
        }
      } else {
        try {
          await message.reply('💬 (silent set) MB heard you but returned no sauce. Try again with fewer words.');
        } catch {}
      }

    } catch (err) {
      console.error('❌ MuscleMB error:', err?.stack || err?.message || String(err));
      try {
        await message.reply('⚠️ MuscleMB pulled a hammy 🦵. Try again soon.');
      } catch (fallbackErr) {
        console.warn('❌ Fallback send error:', fallbackErr.message);
      }
    }
  });
};




