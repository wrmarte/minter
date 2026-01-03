// listeners/musclemb/nicePings.js
const Config = require('./config');
const Utils = require('./utils');
const NICE_LINES = require('./niceLines');

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

const DOW_WEIGHTS = {
  1: { focus: 1.2, shipping: 1.2, progress: 1.1 },
  2: { focus: 1.1, shipping: 1.1, progress: 1.1 },
  3: { focus: 1.0, shipping: 1.1, progress: 1.1 },
  4: { shipping: 1.2, progress: 1.1, thoughtful: 1.1 },
  5: { degen: 1.25, funny: 1.2, nutty: 1.1 },
  6: { degen: 1.3, funny: 1.25, chaotic_wisdom: 1.15 },
  0: { recharge: 1.2, thoughtful: 1.15, kindness: 1.1 }
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
    for (const k of Object.keys(m)) out[k] = (out[k] || 0) * m[k];
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

async function analyzeChannelMood(channel) {
  const res = { multipliers: {}, tags: [] };
  try {
    const fetched = await channel.messages.fetch({ limit: Math.max(10, Math.min(100, Config.NICE_ANALYZE_LIMIT)) });
    const msgs = [...fetched.values()].filter(m => !m.author?.bot && (m.content || '').trim());
    if (!msgs.length) return res;

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
    seed,
    avoidText,
    avoidCategory,
    moodMultipliers
  } = opts;

  const h = (typeof hour === "number") ? hour : date.getHours();
  const daypart = Utils.getDaypart(h);
  const dow = date.getDay();
  const isWeekend = (dow === 0 || dow === 6);

  const base = (overrideWeights && overrideWeights[daypart]) || DAYPART_WEIGHTS[daypart] || DAYPART_WEIGHTS.midday;
  const modeMul = mode ? MODE_MULTIPLIERS[mode] : null;
  const weekendMul = isWeekend ? WEEKEND_BONUS : null;
  const dowMul = DOW_WEIGHTS[dow] || null;

  const finalWeights = applyMultipliers(base, modeMul, weekendMul, dowMul, moodMultipliers);

  const allowSet = allow ? new Set(allow) : null;
  const blockSet = block ? new Set(block) : null;
  const entries = toEntries(finalWeights, allowSet, blockSet);

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  const seedStr = (typeof seed === 'string' && seed.length)
    ? seed
    : `${guildId}:${userId}:${yyyy}-${mm}-${dd}:${daypart}`;

  const rng = Utils.makeRng(seedStr);

  let pickedCategory = Utils.weightedPick(entries, rng);
  let pickRes = pickLineFromCategory(pickedCategory, rng);

  if ((avoidCategory && pickedCategory === avoidCategory) || (avoidText && pickRes.text === avoidText)) {
    for (let i = 0; i < 6; i++) {
      const altRng = Utils.makeRng(`${seedStr}:alt:${i}:${Math.random()}`);
      const altCat = Utils.weightedPick(entries, altRng);
      const altRes = pickLineFromCategory(altCat, altRng);
      const badCat = (avoidCategory && altCat === avoidCategory);
      const badTxt = (avoidText && altRes.text === avoidText);
      if (!badCat && !badTxt) { pickedCategory = altCat; pickRes = altRes; break; }
    }
  }

  return { text: pickRes.text, category: pickedCategory, meta: { daypart, hour: h, isWeekend, mode: mode || null, dow } };
}

function optimizeQuoteText(input) {
  if (!input) return '';
  let t = String(input);
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/[!?.,;:]+$/g, (m) => m[0]);
  t = t.replace(/^(?:[\s\-–—•~·]+)+/, '').trim();
  if (/^[a-z]/.test(t)) t = t[0].toUpperCase() + t.slice(1);
  if (!/[.!?]$/.test(t) && /[\p{Letter}\p{Number}]$/u.test(t)) t += '.';
  if (t.length > 240) t = t.slice(0, 237).trimEnd() + '…';
  return t;
}

function formatNiceLine(style, { category, meta, moodTags = [] }, textRaw) {
  const text = optimizeQuoteText(textRaw);
  const moodBadge = moodTags.length ? ` • mood: ${moodTags.join(',')}` : '';
  if (style === 'clean') return text;
  if (style === 'tag') return `${text} — ${category}`;
  const prefix = `✨ quick vibe check (${category} • ${meta.daypart}${moodBadge}):`;
  return `${prefix} ${text}`;
}

module.exports = {
  analyzeChannelMood,
  smartPick,
  optimizeQuoteText,
  formatNiceLine,
};
