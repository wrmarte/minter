// services/battleEngine.js
const fetch = require('node-fetch');

/* =================== ENV / knobs =================== */
const GROQ_API_KEY   = process.env.GROQ_API_KEY || '';
const GROQ_MODEL_ENV = (process.env.GROQ_MODEL || '').trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL   = (process.env.OPENAI_MODEL || 'gpt-3.5-turbo').trim();

const AI_TIMEOUT_MS  = Math.max(8000, Number(process.env.BATTLE_AI_TIMEOUT_MS || '12000'));
const COOL_MS        = Math.max(1000, Number(process.env.BATTLE_COOLDOWN_MS   || '8000'));

/* =================== tiny utils =================== */
function clampBestOf(n) {
  n = Number(n) || 3;
  if (n < 1) n = 1;
  if (n % 2 === 0) n += 1;        // enforce odd
  if (n > 9) n = 9;               // sane cap
  return n;
}
function makeBar(a, b, bestOf) {
  const total = Math.max(a + b, bestOf);
  const filledA = Math.max(0, a);
  const filledB = Math.max(0, b);
  const slots = Math.max(5, Math.min(15, bestOf)); // visual width
  const ratioA = filledA / Math.max(1, (filledA + filledB));
  const fillA = Math.round(ratioA * slots);
  const fillB = slots - fillA;
  return `**${a}** ${'█'.repeat(Math.max(0, fillA))}${'░'.repeat(Math.max(0, fillB))} **${b}**`;
}
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }
async function fetchWithTimeout(url, opts = {}, timeoutMs = AI_TIMEOUT_MS) {
  const hasAbort = typeof globalThis.AbortController === 'function';
  if (!hasAbort) {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, opts);
        const bodyText = await res.text();
        return { res, bodyText };
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeoutMs))
    ]);
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const bodyText = await res.text();
    return { res, bodyText };
  } finally {
    clearTimeout(t);
  }
}

/* =================== seeded RNG =================== */
// Deterministic, unbiased RNG (xorshift-ish) seeded from a string
function makeRng(seedStr = "") {
  let h = 2166136261 >>> 0; // FNV-ish
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

/* =================== simulator (unbiased) =================== */
/**
 * simulateBattle
 * - unbiased coin per round around 50/50 with small drift (+/- 3%) from seeded RNG
 * - a = challenger score, b = opponent score
 * - rounds: [{index, winner, loser, a, b}]
 */
function simulateBattle({ challenger, opponent, bestOf = 3, style, seed }) {
  bestOf = clampBestOf(bestOf);
  const need = Math.floor(bestOf / 2) + 1;

  const challId = challenger?.id || challenger?.user?.id || 'A';
  const opponId = opponent?.id || opponent?.user?.id || 'B';
  const rng = makeRng(String(seed || `${challId}:${opponId}`));

  let a = 0, b = 0, idx = 0;
  const rounds = [];

  while (a < need && b < need) {
    idx++;
    // tiny variance centered on 0.5 for fairness
    const p = 0.5 + (rng() - 0.5) * 0.06; // ±3%
    const aWins = rng() < p;

    const aName = challenger.displayName || challenger.username || challenger.user?.username || 'Challenger';
    const bName = opponent.displayName   || opponent.username   || opponent.user?.username   || 'Opponent';

    const winName = aWins ? aName : bName;
    const loseName = aWins ? bName : aName;

    if (aWins) a++; else b++;

    rounds.push({ index: idx, winner: winName, loser: loseName, a, b });
  }

  return { bestOf, rounds, a, b };
}

/* =================== AI commentary (best-effort) =================== */
const DECOMMISSIONED_MODELS = new Set();
const WARN_ONCE = new Set();
async function listGroqModels() {
  if (!GROQ_API_KEY) return [];
  try {
    const { res, bodyText } = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/models',
      { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` } },
      AI_TIMEOUT_MS
    );
    if (!res.ok) return [];
    const json = safeJsonParse(bodyText);
    const ids = Array.isArray(json?.data) ? json.data.map(x => x.id).filter(Boolean) : [];
    // prefer chat-ish
    return ids.filter(id => /llama|mixtral|gemma|qwen|mistral|deepseek|phi/i.test(id));
  } catch { return []; }
}
async function aiCommentary({ winner, loser, rounds, style = 'motivator', guildName = 'this server' }) {
  const prompt =
    `Write 2-3 short energetic lines recapping a match in ${guildName}.\n` +
    `Winner: ${winner}\nLoser: ${loser}\n` +
    `Rounds: ${rounds.map(r => `R${r.index}:${r.winner}`).join(' ')}\n` +
    `Tone: ${style} (fun, safe, hype). Avoid slurs. No hashtags.`;

  // Try Groq
  if (GROQ_API_KEY) {
    const models = [GROQ_MODEL_ENV].filter(Boolean);
    if (!models.length) {
      const discovered = await listGroqModels();
      models.push(...discovered);
    }
    for (const model of models) {
      if (!model || DECOMMISSIONED_MODELS.has(model)) continue;
      try {
        const { res, bodyText } = await fetchWithTimeout(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              max_tokens: 120,
              temperature: 0.8,
              messages: [
                { role: 'system', content: 'You are a concise, exciting esports commentator.' },
                { role: 'user', content: prompt }
              ]
            })
          },
          AI_TIMEOUT_MS
        );
        if (!res.ok) {
          const data = safeJsonParse(bodyText);
          const msg  = data?.error?.message || bodyText?.slice(0, 200) || '';
          if (/decommissioned/i.test(msg)) DECOMMISSIONED_MODELS.add(model);
          if (!WARN_ONCE.has(`groq_${model}`)) { console.warn(`Groq ${model} ${res.status}: ${msg}`); WARN_ONCE.add(`groq_${model}`); }
          if (res.status === 400 || res.status === 404) continue;
          break; // other errors: bail to OpenAI/local
        }
        const json = safeJsonParse(bodyText);
        const out  = json?.choices?.[0]?.message?.content?.trim();
        if (out) return out.slice(0, 800);
      } catch (e) {
        if (!WARN_ONCE.has(`groq_err_${model}`)) { console.warn(`Groq error ${model}:`, e.message); WARN_ONCE.add(`groq_err_${model}`); }
        continue;
      }
    }
  }

  // Try OpenAI
  if (OPENAI_API_KEY) {
    try {
      const { res, bodyText } = await fetchWithTimeout(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            max_tokens: 120,
            temperature: 0.8,
            messages: [
              { role: 'system', content: 'You are a concise, exciting esports commentator.' },
              { role: 'user', content: prompt }
            ]
          })
        },
        AI_TIMEOUT_MS
      );
      if (res.ok) {
        const json = safeJsonParse(bodyText);
        const out  = json?.choices?.[0]?.message?.content?.trim();
        if (out) return out.slice(0, 800);
      } else {
        if (!WARN_ONCE.has('openai')) {
          console.warn(`OpenAI ${res.status}: ${bodyText?.slice(0, 200) || ''}`);
          WARN_ONCE.add('openai');
        }
      }
    } catch (e) {
      if (!WARN_ONCE.has('openai_err')) { console.warn('OpenAI error:', e.message); WARN_ONCE.add('openai_err'); }
    }
  }

  // Local fallback
  const lines = [
    `**${winner}** controlled the pace and closed it out — props to ${loser} for the grit.`,
    `Clean reads, crisp timing, and crowd-pleasing moments. GG!`,
  ];
  return lines.join('\n');
}

/* =================== small cooldown gate =================== */
const lastUse = new Map(); // key -> ts
function ready(key = 'default') {
  const now = Date.now();
  const last = lastUse.get(key) || 0;
  if (now - last < COOL_MS) return false;
  lastUse.set(key, now);
  return true;
}

module.exports = {
  simulateBattle,
  aiCommentary,
  makeBar,
  clampBestOf,
  ready
};

