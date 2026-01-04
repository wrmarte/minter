// listeners/musclemb/nicePings.js
// ======================================================
// MuscleMB "Nice Pings" (Ultimate)
// - Weighted category picker by daypart + DOW + weekend + mode
// - Optional channel mood analysis (light NLP via regex)
// - Deterministic RNG seeding (stable daily per guild/user/daypart)
// - Anti-repeat (per-scope history window) to avoid same line spam
// - Mood analysis caching (TTL) to reduce message fetch load
// - Safer multipliers (never accidentally zero-out missing keys)
// - Flexible formatting styles: vibe | clean | tag
// ======================================================

const Config = require("./config");
const Utils = require("./utils");
const NICE_LINES = require("./niceLines");

/**
 * Base weights by daypart.
 * Keys must match NICE_LINES categories.
 */
const DAYPART_WEIGHTS = {
  morning: {
    focus: 3,
    recharge: 3,
    progress: 2,
    kindness: 2,
    shipping: 1,
    thoughtful: 2,
    nutty: 1,
    degen: 0.5,
    chaotic_wisdom: 1,
    funny: 1,
  },
  midday: {
    focus: 3,
    shipping: 3,
    progress: 2,
    kindness: 1,
    thoughtful: 1.5,
    recharge: 1,
    funny: 1,
    nutty: 1,
    chaotic_wisdom: 1,
    degen: 1,
  },
  evening: {
    kindness: 2,
    thoughtful: 2,
    progress: 1.5,
    shipping: 1,
    recharge: 2,
    funny: 2,
    nutty: 1.2,
    chaotic_wisdom: 1.2,
    degen: 1,
    focus: 1,
  },
  late_evening: {
    thoughtful: 2.2,
    chaotic_wisdom: 2.2,
    funny: 1.6,
    nutty: 1.6,
    degen: 1.4,
    recharge: 1.2,
    progress: 1,
    shipping: 0.8,
    kindness: 1,
    focus: 0.8,
  },
  late_night: {
    chaotic_wisdom: 3,
    degen: 2.2,
    funny: 2,
    nutty: 2,
    thoughtful: 1.8,
    recharge: 1.2,
    progress: 0.8,
    shipping: 0.6,
    focus: 0.6,
    kindness: 0.8,
  },
};

/**
 * Day-of-week boosts (0=Sun..6=Sat)
 */
const DOW_WEIGHTS = {
  1: { focus: 1.2, shipping: 1.2, progress: 1.1 }, // Mon
  2: { focus: 1.1, shipping: 1.1, progress: 1.1 }, // Tue
  3: { focus: 1.0, shipping: 1.1, progress: 1.1 }, // Wed
  4: { shipping: 1.2, progress: 1.1, thoughtful: 1.1 }, // Thu
  5: { degen: 1.25, funny: 1.2, nutty: 1.1 }, // Fri
  6: { degen: 1.3, funny: 1.25, chaotic_wisdom: 1.15 }, // Sat
  0: { recharge: 1.2, thoughtful: 1.15, kindness: 1.1 }, // Sun
};

/**
 * Mode multipliers (optional)
 */
const MODE_MULTIPLIERS = {
  serious: { focus: 1.6, shipping: 1.6, progress: 1.4, thoughtful: 1.2 },
  chaotic: { chaotic_wisdom: 1.8, nutty: 1.6, funny: 1.4, degen: 1.3 },
  human: { kindness: 1.8, thoughtful: 1.4, recharge: 1.2 },
  degen: { degen: 2.0, chaotic_wisdom: 1.6, funny: 1.2, nutty: 1.2 },
  calm: { recharge: 1.8, thoughtful: 1.4, kindness: 1.2 },
};

/**
 * Weekend extra sauce (in addition to DOW)
 */
const WEEKEND_BONUS = {
  degen: 1.15,
  funny: 1.1,
  nutty: 1.08,
  chaotic_wisdom: 1.08,
};

// -----------------------------
// "Ultimate" additions (safe defaults)
// -----------------------------
const MOOD_CACHE_TTL_MS = Number(process.env.MB_MOOD_CACHE_TTL_MS || "60000"); // 60s
const MOOD_CACHE_MAX = Number(process.env.MB_MOOD_CACHE_MAX || "200");
const PICK_HISTORY_MAX = Number(process.env.MB_NICE_HISTORY_MAX || String((Config && Config.NICE_HISTORY_MAX) || 50));
const PICK_HISTORY_TTL_MS = Number(process.env.MB_NICE_HISTORY_TTL_MS || String((Config && Config.NICE_HISTORY_TTL_MS) || 6 * 60 * 60 * 1000)); // 6h
const PICK_MAX_ATTEMPTS = Number(process.env.MB_NICE_PICK_ATTEMPTS || "10");
const DEFAULT_ANALYZE_LIMIT = Math.max(10, Math.min(100, Number((Config && Config.NICE_ANALYZE_LIMIT) || 50)));

// Mood & history caches (module local; resets on restart)
const _moodCache = new Map(); // key -> { ts, value }
const _pickHistory = new Map(); // scopeKey -> { ts, items: [{sig, ts}] }

// -----------------------------
// Helpers
// -----------------------------

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function nowMs() {
  return Date.now();
}

function cleanupMapSize(map, maxSize) {
  if (map.size <= maxSize) return;
  // remove oldest entries
  const entries = [...map.entries()].sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
  const toRemove = Math.max(1, map.size - maxSize);
  for (let i = 0; i < toRemove; i++) map.delete(entries[i][0]);
}

/**
 * Multiply weights by multiplier objects.
 * Safer than the old version:
 * - Only multiplies keys that already exist in `base` (unless createMissing=true)
 * - Multiplier values default to 1 if invalid
 */
function applyMultipliers(base, ...multis) {
  const out = { ...base };
  for (const m of multis) {
    if (!m) continue;
    for (const k of Object.keys(m)) {
      if (out[k] == null) continue; // don't create new categories accidentally
      const mul = Number(m[k]);
      if (!Number.isFinite(mul)) continue;
      out[k] = out[k] * mul;
    }
  }
  return out;
}

/**
 * Convert weights object to weighted entries, respecting allow/block.
 */
function toEntries(weights, allowSet, blockSet) {
  const entries = [];
  for (const [key, weight] of Object.entries(weights || {})) {
    if (blockSet?.has(key)) continue;
    if (allowSet && allowSet.size && !allowSet.has(key)) continue;
    if ((weight || 0) > 0) entries.push({ key, weight });
  }
  return entries.length ? entries : [{ key: "focus", weight: 1 }];
}

/**
 * Deterministic RNG derivation (no Math.random).
 */
function deriveRng(seedStr, salt) {
  return Utils.makeRng(`${seedStr}:${salt}`);
}

/**
 * Signature used for anti-repeat (category + exact line).
 */
function makeSig(category, text) {
  const t = String(text || "").trim();
  return `${category}::${t}`;
}

/**
 * Get / init history bucket for a scope.
 */
function getHistory(scopeKey) {
  const bucket = _pickHistory.get(scopeKey);
  const t = nowMs();
  if (!bucket) {
    const b = { ts: t, items: [] };
    _pickHistory.set(scopeKey, b);
    cleanupMapSize(_pickHistory, 500);
    return b;
  }

  // expire old bucket
  if (t - (bucket.ts || 0) > PICK_HISTORY_TTL_MS) {
    bucket.ts = t;
    bucket.items = [];
    return bucket;
  }

  // prune items by ttl and length
  bucket.items = (bucket.items || []).filter((x) => t - (x.ts || 0) <= PICK_HISTORY_TTL_MS);
  if (bucket.items.length > PICK_HISTORY_MAX) bucket.items = bucket.items.slice(-PICK_HISTORY_MAX);
  bucket.ts = t;
  return bucket;
}

function rememberPick(scopeKey, sig) {
  if (!scopeKey || !sig) return;
  const bucket = getHistory(scopeKey);
  bucket.items.push({ sig, ts: nowMs() });
  if (bucket.items.length > PICK_HISTORY_MAX) bucket.items = bucket.items.slice(-PICK_HISTORY_MAX);
}

function wasRecentlyPicked(scopeKey, sig) {
  if (!scopeKey || !sig) return false;
  const bucket = getHistory(scopeKey);
  return (bucket.items || []).some((x) => x.sig === sig);
}

/**
 * Pick a random line from a category.
 */
function pickLineFromCategory(category, rng) {
  const arr = NICE_LINES[category] || [];
  if (!arr.length) return { text: "(no lines found)", category };
  const idx = Math.floor(rng() * arr.length);
  return { text: arr[idx], category };
}

/**
 * Build a reasonable default scopeKey for anti-repeat.
 * - If you want repeats allowed per-user, use `scope="user"`
 * - If you want repeats avoided per-channel, use `scope="channel"`
 * - If you want repeats avoided per-guild, use `scope="guild"`
 */
function makeScopeKey({ scope = "channel", guildId = "", channelId = "", userId = "" } = {}) {
  if (scope === "user") return `u:${guildId}:${userId}`;
  if (scope === "guild") return `g:${guildId}`;
  return `c:${guildId}:${channelId}`; // default: channel
}

// -----------------------------
// Mood analysis (Ultimate)
// -----------------------------

/**
 * analyzeChannelMood(channel[, options])
 * Returns: { multipliers: {cat:mult}, tags: [], stats: {...} }
 *
 * Options:
 * - limit: number (10..100)
 * - useCache: boolean (default true)
 * - force: boolean (default false)
 * - cacheKey: string (override)
 */
async function analyzeChannelMood(channel, options = {}) {
  const res = { multipliers: {}, tags: [], stats: {} };
  try {
    const limit = Math.max(10, Math.min(100, Number(options.limit || DEFAULT_ANALYZE_LIMIT)));
    const useCache = options.useCache !== false;
    const force = options.force === true;

    const cacheKey =
      options.cacheKey ||
      (channel && channel.id ? `ch:${channel.id}` : `ch:unknown`);

    if (useCache && !force) {
      const hit = _moodCache.get(cacheKey);
      if (hit && nowMs() - (hit.ts || 0) <= MOOD_CACHE_TTL_MS) {
        return hit.value;
      }
    }

    if (!channel || !channel.messages || !channel.messages.fetch) return res;

    const fetched = await channel.messages.fetch({ limit });
    const msgs = [...fetched.values()].filter(
      (m) => !m.author?.bot && (m.content || "").trim()
    );
    if (!msgs.length) return res;

    // Counters
    let hype = 0,
      laugh = 0,
      bug = 0,
      ship = 0,
      care = 0,
      stress = 0,
      reflect = 0,
      gmgn = 0,
      sleepy = 0,
      coffee = 0,
      wins = 0;

    // Regex groups (keep fast + readable)
    const rg = {
      hype:
        /\b(lfg|send it|to the moon|wen|pump|ape|degen|ngmi|wagmi|airdrop|bull|moon|rocket|rip|send)\b|🚀|🔥|📈/i,
      laugh: /😂|🤣|lmao|(^|\s)lol(\s|$)|rofl|💀|😭/i,
      bug:
        /\b(bug|error|fix|issue|crash|broken|stacktrace|trace|exception|timeout|retry|revert)\b|❌|⚠️/i,
      ship:
        /\b(ship|merge|deploy|pr|pull\s*request|release|commit|build|push|publish|hotfix)\b|📦|✅/i,
      care: /\b(thanks|ty|appreciate|gracias|love|good job|proud)\b|❤️|🙏|🫶/i,
      stress:
        /\b(tired|burn(?:ed)?\s*out|overwhelmed|stressed|angry|mad|annoyed|ugh|anxious)\b|😮‍💨|😵‍💫|😤/i,
      reflect: /\b(why|because|learn|insight|thought|ponder|idea|question|real talk)\b|🧠|🤔/i,
      gmgn: /\b(gm|gn|good\s*morning|good\s*night)\b/i,
      sleepy: /\b(sleep|slept|insomnia|nap|zzz)\b|😴/i,
      coffee: /\b(coffee|cafe|espresso|latte|caffeine)\b|☕/i,
      wins: /\b(w|win|won|gg|nice|let’s go|lets go|clutch)\b|🏆|🎉/i,
    };

    for (const m of msgs) {
      const t = m.content || "";
      if (rg.hype.test(t)) hype++;
      if (rg.laugh.test(t)) laugh++;
      if (rg.bug.test(t)) bug++;
      if (rg.ship.test(t)) ship++;
      if (rg.care.test(t)) care++;
      if (rg.stress.test(t)) stress++;
      if (rg.reflect.test(t)) reflect++;
      if (rg.gmgn.test(t)) gmgn++;
      if (rg.sleepy.test(t)) sleepy++;
      if (rg.coffee.test(t)) coffee++;
      if (rg.wins.test(t)) wins++;
    }

    const bump = (obj, k, v) => {
      if (!obj[k]) obj[k] = 1;
      obj[k] = obj[k] * v;
    };

    // Translate counts -> multipliers + tags
    if (hype >= 2) {
      bump(res.multipliers, "degen", 1.3);
      bump(res.multipliers, "funny", 1.15);
      bump(res.multipliers, "nutty", 1.1);
      bump(res.multipliers, "chaotic_wisdom", 1.08);
      res.tags.push("hype");
    }
    if (laugh >= 2) {
      bump(res.multipliers, "funny", 1.4);
      bump(res.multipliers, "nutty", 1.15);
      res.tags.push("laugh");
    }
    if (bug >= 2 || ship >= 2) {
      bump(res.multipliers, "shipping", 1.35);
      bump(res.multipliers, "focus", 1.25);
      bump(res.multipliers, "progress", 1.15);
      res.tags.push("shipfix");
    }
    if (care >= 2) {
      bump(res.multipliers, "kindness", 1.4);
      bump(res.multipliers, "thoughtful", 1.15);
      res.tags.push("care");
    }
    if (stress >= 2) {
      bump(res.multipliers, "recharge", 1.45);
      bump(res.multipliers, "kindness", 1.15);
      res.tags.push("stress");
    }
    if (reflect >= 2) {
      bump(res.multipliers, "thoughtful", 1.35);
      bump(res.multipliers, "chaotic_wisdom", 1.15);
      res.tags.push("reflect");
    }
    if (gmgn >= 2) {
      bump(res.multipliers, "recharge", 1.15);
      bump(res.multipliers, "progress", 1.1);
      bump(res.multipliers, "kindness", 1.1);
      res.tags.push("gmgn");
    }
    if (sleepy >= 2) {
      bump(res.multipliers, "recharge", 1.35);
      bump(res.multipliers, "thoughtful", 1.1);
      res.tags.push("sleepy");
    }
    if (coffee >= 2) {
      bump(res.multipliers, "focus", 1.15);
      bump(res.multipliers, "shipping", 1.1);
      res.tags.push("coffee");
    }
    if (wins >= 2) {
      bump(res.multipliers, "progress", 1.25);
      bump(res.multipliers, "funny", 1.08);
      res.tags.push("wins");
    }

    res.stats = { hype, laugh, bug, ship, care, stress, reflect, gmgn, sleepy, coffee, wins, sample: msgs.length };

    // cache it
    if (useCache) {
      _moodCache.set(cacheKey, { ts: nowMs(), value: res });
      cleanupMapSize(_moodCache, MOOD_CACHE_MAX);
    }

    return res;
  } catch (e) {
    console.warn("mood analyze failed:", e.message);
    return res;
  }
}

// -----------------------------
// Picking logic (Ultimate)
// -----------------------------

/**
 * smartPick(opts)
 *
 * Backwards compatible with your original signature, plus upgrades:
 * - channelId: used in default seed + history scope
 * - scope: "channel" | "guild" | "user"  (anti-repeat scope)
 * - noRepeat: boolean (default true)
 * - intensity: 0..2 (scales multipliers a bit; default 1)
 * - mood: { multipliers, tags } (if you already analyzed elsewhere)
 * - moodMultipliers: direct multiplier object (still supported)
 * - returnMood: boolean (adds moodTags to return)
 */
function smartPick(opts = {}) {
  const {
    mode,
    hour,
    date = new Date(),
    guildId = "",
    channelId = "",
    userId = "",
    allow,
    block,
    overrideWeights,
    seed,
    avoidText,
    avoidCategory,
    moodMultipliers,
    mood, // optional: { multipliers, tags }
    intensity = 1,
    noRepeat = true,
    scope = "channel",
    returnMood = false,
  } = opts;

  const h = typeof hour === "number" ? hour : date.getHours();
  const daypart = Utils.getDaypart(h);
  const dow = date.getDay();
  const isWeekend = dow === 0 || dow === 6;

  const base =
    (overrideWeights && overrideWeights[daypart]) ||
    DAYPART_WEIGHTS[daypart] ||
    DAYPART_WEIGHTS.midday;

  const modeMul = mode ? MODE_MULTIPLIERS[mode] : null;
  const weekendMul = isWeekend ? WEEKEND_BONUS : null;
  const dowMul = DOW_WEIGHTS[dow] || null;

  // mood multipliers can come from opts.mood or direct opts.moodMultipliers
  const moodMul = (mood && mood.multipliers) ? mood.multipliers : moodMultipliers;

  // intensity gently scales multipliers (not base weights)
  // 1.0 = normal, 0.0 = flatten multipliers toward 1, 2.0 = boost multipliers
  const inten = clamp(intensity, 0, 2);
  const scaleMultiplierObj = (obj) => {
    if (!obj) return null;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const mul = Number(v);
      if (!Number.isFinite(mul)) continue;
      // move mul toward 1 at low intensity, away from 1 at high intensity
      const scaled = 1 + (mul - 1) * (0.75 + inten * 0.5); // 0.75..1.75
      out[k] = scaled;
    }
    return out;
  };

  const finalWeights = applyMultipliers(
    base,
    scaleMultiplierObj(modeMul),
    scaleMultiplierObj(weekendMul),
    scaleMultiplierObj(dowMul),
    scaleMultiplierObj(moodMul)
  );

  const allowSet = allow ? new Set(allow) : null;
  const blockSet = block ? new Set(block) : null;
  const entries = toEntries(finalWeights, allowSet, blockSet);

  // Deterministic daily seed default
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  const seedStr =
    typeof seed === "string" && seed.length
      ? seed
      : `${guildId}:${channelId}:${userId}:${yyyy}-${mm}-${dd}:${daypart}`;

  const rng = deriveRng(seedStr, "main");

  // Anti-repeat scope
  const scopeKey = makeScopeKey({ scope, guildId, channelId, userId });

  // Attempt picker with constraints + anti-repeat
  let pickedCategory = null;
  let pickRes = null;

  const moodTags = (mood && Array.isArray(mood.tags)) ? mood.tags : [];

  for (let attempt = 0; attempt < PICK_MAX_ATTEMPTS; attempt++) {
    const attemptRng = attempt === 0 ? rng : deriveRng(seedStr, `alt:${attempt}`);
    const cat = Utils.weightedPick(entries, attemptRng);
    const res = pickLineFromCategory(cat, attemptRng);

    const badCat = avoidCategory && cat === avoidCategory;
    const badTxt = avoidText && res.text === avoidText;
    const sig = makeSig(cat, res.text);
    const badRepeat = noRepeat && wasRecentlyPicked(scopeKey, sig);

    if (!badCat && !badTxt && !badRepeat) {
      pickedCategory = cat;
      pickRes = res;
      rememberPick(scopeKey, sig);
      break;
    }

    // If we keep failing due to strict rules, loosen a bit on later attempts:
    // - after half attempts, ignore avoidText
    // - last 2 attempts, ignore anti-repeat (still respect block/allow via entries)
    const loosenAvoidText = attempt >= Math.floor(PICK_MAX_ATTEMPTS / 2);
    const loosenRepeat = attempt >= PICK_MAX_ATTEMPTS - 2;

    if (!badCat && (!badTxt || loosenAvoidText) && (!badRepeat || loosenRepeat)) {
      pickedCategory = cat;
      pickRes = res;
      rememberPick(scopeKey, sig);
      break;
    }
  }

  // Hard fallback
  if (!pickRes) {
    pickedCategory = "focus";
    pickRes = pickLineFromCategory("focus", rng);
  }

  const out = {
    text: pickRes.text,
    category: pickedCategory,
    meta: { daypart, hour: h, isWeekend, mode: mode || null, dow },
  };

  if (returnMood) out.moodTags = moodTags;

  return out;
}

// -----------------------------
// Text formatting (Ultimate)
// -----------------------------

function optimizeQuoteText(input) {
  if (!input) return "";
  let t = String(input);

  // collapse whitespace
  t = t.replace(/\s+/g, " ").trim();

  // remove leading bullets/dashes
  t = t.replace(/^(?:[\s\-–—•~·]+)+/, "").trim();

  // normalize trailing punctuation to a single mark
  t = t.replace(/[!?.,;:]+$/g, (m) => m[0]);

  // capitalize if it starts with a letter
  if (/^[a-z]/.test(t)) t = t[0].toUpperCase() + t.slice(1);

  // add a period if it looks like a sentence without punctuation
  if (!/[.!?]$/.test(t) && /[\p{Letter}\p{Number}]$/u.test(t)) t += ".";

  // keep it punchy
  if (t.length > 240) t = t.slice(0, 237).trimEnd() + "…";

  return t;
}

/**
 * formatNiceLine(style, ctx, textRaw)
 *
 * style: 'clean' | 'tag' | 'vibe'
 * ctx:   { category, meta, moodTags? }
 */
function formatNiceLine(style, { category, meta, moodTags = [] } = {}, textRaw) {
  const text = optimizeQuoteText(textRaw);
  const moodBadge = moodTags.length ? ` • mood: ${moodTags.join(",")}` : "";

  if (style === "clean") return text;
  if (style === "tag") return `${text} — ${category}`;

  const prefix = `✨ quick vibe check (${category} • ${meta?.daypart || "midday"}${moodBadge}):`;
  return `${prefix} ${text}`;
}

/**
 * Optional: expose weight computation (useful for debugging/telemetry)
 */
function computeFinalWeights(opts = {}) {
  const date = opts.date || new Date();
  const h = typeof opts.hour === "number" ? opts.hour : date.getHours();
  const daypart = Utils.getDaypart(h);
  const dow = date.getDay();
  const isWeekend = dow === 0 || dow === 6;

  const base =
    (opts.overrideWeights && opts.overrideWeights[daypart]) ||
    DAYPART_WEIGHTS[daypart] ||
    DAYPART_WEIGHTS.midday;

  const modeMul = opts.mode ? MODE_MULTIPLIERS[opts.mode] : null;
  const weekendMul = isWeekend ? WEEKEND_BONUS : null;
  const dowMul = DOW_WEIGHTS[dow] || null;

  const moodMul = (opts.mood && opts.mood.multipliers) ? opts.mood.multipliers : opts.moodMultipliers;

  return applyMultipliers(base, modeMul, weekendMul, dowMul, moodMul);
}

module.exports = {
  analyzeChannelMood,
  smartPick,
  optimizeQuoteText,
  formatNiceLine,

  // extras (non-breaking)
  computeFinalWeights,
  _debug: {
    DAYPART_WEIGHTS,
    DOW_WEIGHTS,
    MODE_MULTIPLIERS,
    WEEKEND_BONUS,
  },
};
