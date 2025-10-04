const { flavorMap, getRandomFlavor } = require('../utils/flavorMap');
const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

/* ============================= Env knobs ============================= */
/** IMPORTANT: If EXP_PREFIX_ENABLED=true (default), expPrefix.js handles !exp.
 *  This file will then SKIP handling !exp to avoid double posts.
 *  Set EXP_PREFIX_ENABLED=false if you want THIS file to handle !exp instead.
 */
const EXP_PREFIX_ENABLED = process.env.EXP_PREFIX_ENABLED !== 'false'; // default true
const EXP_PREFIX = (process.env.EXP_PREFIX || '!exp').trim();

const GROQ_API_KEY   = process.env.GROQ_API_KEY || '';
const GROQ_MODEL_ENV = (process.env.GROQ_MODEL || '').trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL   = (process.env.OPENAI_MODEL || 'gpt-3.5-turbo').trim();

/* ============================= Discovery / Caching ============================= */
let MODEL_CACHE = { ts: 0, ids: [] };
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;
const DECOMMISSIONED_MODELS = new Set();
const MODEL_WARNED = new Set();

function nowMs() { return Date.now(); }
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

async function fetchWithTimeout(url, opts = {}, timeoutMs = 25000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { ...opts, signal: controller?.signal });
    const bodyText = await res.text();
    return { res, bodyText };
  } finally {
    if (t) clearTimeout(t);
  }
}

function preferOrder(a, b) {
  const size = (id) => { const m = id.match(/(\d+)\s*b|\b(\d+)[bB]\b|-(\d+)b/); return m ? parseInt(m[1]||m[2]||m[3]||'0',10) : 0; };
  const ver  = (id) => { const m = id.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  const d = size(b) - size(a);
  return d || (ver(b) - ver(a));
}

async function fetchGroqModels() {
  if (!GROQ_API_KEY) return [];
  try {
    const { res, bodyText } = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/models',
      { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` } },
      20000
    );
    if (!res.ok) {
      if (!MODEL_WARNED.has('models')) {
        console.warn(`Groq /models HTTP ${res.status}: ${bodyText?.slice(0, 300)}`);
        MODEL_WARNED.add('models');
      }
      return [];
    }
    const data = safeJsonParse(bodyText);
    if (!data || !Array.isArray(data.data)) return [];
    const ids = data.data.map(x => x.id).filter(Boolean);
    const chatLikely = ids
      .filter(id => /llama|mixtral|gemma|qwen|deepseek|phi|mistral|gpt/i.test(id))
      .filter(id => !DECOMMISSIONED_MODELS.has(id))
      .sort(preferOrder);
    return chatLikely.length ? chatLikely : ids.filter(id => !DECOMMISSIONED_MODELS.has(id)).sort(preferOrder);
  } catch (e) {
    if (!MODEL_WARNED.has('models_err')) {
      console.warn('Groq /models fetch failed:', e.message);
      MODEL_WARNED.add('models_err');
    }
    return [];
  }
}

async function getGroqModelsToTry() {
  const list = [];
  if (GROQ_MODEL_ENV && !DECOMMISSIONED_MODELS.has(GROQ_MODEL_ENV)) list.push(GROQ_MODEL_ENV);

  const now = nowMs();
  if (!MODEL_CACHE.ids.length || (now - MODEL_CACHE.ts) > MODEL_TTL_MS) {
    const discovered = await fetchGroqModels();
    if (discovered.length) MODEL_CACHE = { ts: now, ids: discovered };
  }
  for (const id of MODEL_CACHE.ids) {
    if (!list.includes(id) && !DECOMMISSIONED_MODELS.has(id)) list.push(id);
  }

  const FALLBACKS = [
    'llama-3.1-8b-instant',
    'gemma-7b-it'
  ].filter(id => !DECOMMISSIONED_MODELS.has(id));

  if (!list.length) list.push(...FALLBACKS);
  return list;
}

/* ============================= UI Helpers ============================= */
function getRandomColor() {
  const colors = [
    0xFFD700, 0x66CCFF, 0xFF66CC, 0xFF4500,
    0x00FF99, 0xFF69B4, 0x00CED1, 0xFFA500, 0x8A2BE2
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

function cleanQuotes(text) {
  return (text || '').replace(/^"(.*)"$/, '$1').trim();
}

function prepareVariants(content, userMention) {
  if (!content) return '';
  const parts = content.split(/\n---\n|\|\|/g).map(s => cleanQuotes(s.trim())).filter(Boolean);
  if (!parts.length) return cleanQuotes(content).replace(/{user}/gi, userMention);
  return parts.map(p => p.replace(/{user}/gi, userMention)).join('\n---\n');
}

function pickVariant(textOrGrouped, userMention) {
  if (!textOrGrouped) return '';
  const parts = textOrGrouped.split(/\n---\n/g).map(s => cleanQuotes(s.trim())).filter(Boolean);
  if (!parts.length) return cleanQuotes(textOrGrouped).replace(/{user}/gi, userMention);
  const chosen = parts[Math.floor(Math.random() * parts.length)];
  return chosen.replace(/{user}/gi, userMention).slice(0, 240);
}

/* ============================= Prompt Builders ============================= */
function buildSystemPromptBase({ guildName, recentContext, wantVariants = false }) {
  const base = [
    `You generate a short, stylish "expression vibe" line for a Discord server (${guildName}).`,
    'INTERPRET the given expression as a vibe. If it is slang/meme/other language, infer or translate meaning internally (do NOT output definitions).',
    'Craft ONE sentence (≤140 chars) that uses the expression literally once and reflects its meaning. Include {user} exactly once.',
    'Use Discord/Web3 slang tastefully. Avoid insults/slurs; keep it playful.',
    recentContext ? recentContext : ''
  ].filter(Boolean).join('\n\n');

  if (!wantVariants) return base;

  return base + `

Return EXACTLY 3 distinct one-line variants, each under 140 characters.
Separate variants with a single line containing three dashes exactly:
---
Do not number them. Include {user} in each line where the mention should go.
Do NOT output definitions or explanations—only the final lines.`;
}

function composeUserPrompt(keyword, wantVariants) {
  return wantVariants
    ? `Expression: "${keyword}". Return 3 variants separated by '---'.`
    : `Expression: "${keyword}". Return a single vibe line.`;
}

/* ============================= AI Core ============================= */
async function smartAIResponse(keyword, { userMention, guildName, recentContext, wantVariants = true }) {
  try {
    return await getGroqAI(keyword, { guildName, recentContext, wantVariants });
  } catch {
    console.warn('❌ Groq failed, trying OpenAI');
    try {
      return await getOpenAI(keyword, { guildName, recentContext, wantVariants });
    } catch {
      console.warn('❌ OpenAI failed — using local semantic fallback');
      return localSemanticVariants(keyword, userMention);
    }
  }
}

async function getGroqAI(keyword, { guildName, recentContext, wantVariants }) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY missing');

  const system = buildSystemPromptBase({ guildName, recentContext, wantVariants });
  const user   = composeUserPrompt(keyword, wantVariants);

  const models = await getGroqModelsToTry();
  if (!models.length) throw new Error('No Groq models available');

  const bodyFor = (model) => JSON.stringify({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user }
    ],
    max_tokens: wantVariants ? 180 : 80,
    temperature: 0.95
  });

  let lastErr = null;

  for (const model of models) {
    try {
      const { res, bodyText } = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: bodyFor(model)
        },
        25000
      );

      if (!res.ok) {
        const parsed = safeJsonParse(bodyText);
        const code = parsed?.error?.code || parsed?.error?.type || '';
        const msg  = parsed?.error?.message || bodyText?.slice(0, 300) || '';

        if (code === 'model_decommissioned' || /decommissioned/i.test(msg)) {
          DECOMMISSIONED_MODELS.add(model);
        }

        const warnKey = `groq_${model}`;
        if (!MODEL_WARNED.has(warnKey)) {
          console.warn(`Groq ${model} HTTP ${res.status}: ${msg}`);
          MODEL_WARNED.add(warnKey);
        }

        if (res.status === 400 || res.status === 404) { lastErr = new Error(`Groq ${model} unavailable`); continue; }
        throw new Error(`Groq ${model} HTTP ${res.status}`);
      }

      const data = safeJsonParse(bodyText);
      const raw  = data?.choices?.[0]?.message?.content?.trim();
      if (!raw) { lastErr = new Error('Groq empty'); continue; }

      const cleaned = cleanQuotes(raw);
      if (wantVariants && !/^\s*---\s*$/m.test(cleaned)) {
        const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);
        if (lines.length >= 3) return lines.slice(0, 3).join('\n---\n');
      }
      return cleaned;

    } catch (e) {
      lastErr = e;
      const warnKey = `groq_err_${model}`;
      if (!MODEL_WARNED.has(warnKey)) {
        console.warn(`Groq model "${model}" failed: ${e.message}`);
        MODEL_WARNED.add(warnKey);
      }
    }
  }

  throw lastErr || new Error('All Groq models failed');
}

async function getOpenAI(keyword, { guildName, recentContext, wantVariants }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

  const system = buildSystemPromptBase({ guildName, recentContext, wantVariants });
  const user   = composeUserPrompt(keyword, wantVariants);

  const { res, bodyText } = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user }
        ],
        max_tokens: wantVariants ? 180 : 80,
        temperature: 0.95
      })
    },
    25000
  );

  if (!res.ok) {
    const snippet = bodyText?.slice(0, 400);
    console.error(`❌ OpenAI HTTP ${res.status}: ${snippet}`);
    throw new Error(`OpenAI HTTP ${res.status}`);
  }

  const json = safeJsonParse(bodyText);
  const raw  = json?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('OpenAI gave no response');

  const cleaned = cleanQuotes(raw);
  if (wantVariants && !/^\s*---\s*$/m.test(cleaned)) {
    // FIXED: added the missing dot before split + String safety
    const lines = String(cleaned).split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (lines.length >= 3) return lines.slice(0, 3).join('\n---\n');
  }
  return cleaned;
}

/* ============================= Local Fallback (Semantic) ============================= */
function localSemanticVariants(keyword, userMention) {
  const k = (keyword || 'vibe').trim();

  const HINTS = {
    loco: 'wild/crazy',
    fuego: 'on fire',
    tranquilo: 'calm/chill',
    sigma: 'stoic boss energy',
    based: 'unapologetically true',
    cringe: 'awkward vibes',
    rizz: 'charisma',
    saucy: 'flashy/style',
    zen: 'calm focus',
    kaizen: 'continuous improvement',
    yolo: 'reckless fun',
    cozy: 'comfort mode',
    alpha: 'leader energy',
    giga: 'massive',
    sus: 'suspicious',
    drip: 'style',
    lit: 'hype',
    chad: 'confident unit',
    icy: 'cool under pressure',
    degen: 'chaotic trader energy',
    tidy: 'clean & organized',
    locohead: 'wild in the head'
  };

  const hint = HINTS[k] || null;
  const mk = (t) => t.replace(/{user}/gi, userMention).replace(/{k}/g, k).replace(/{hint}/g, hint || k);

  const variants = [
    hint ? `{user} is {k} in the head — ({hint}).`
         : `Ohh {user} is {k} in the head.`,
    hint ? `{user} just went full {k} — pure {hint}.`
         : `{user} just went full {k}.`,
    hint ? `{user} radiates {k} energy (aka {hint}).`
         : `{user} radiates {k} energy.`,
    hint ? `Patch notes: +20% {k} for {user} • {hint}.`
         : `Patch notes: +20% {k} for {user}.`,
    hint ? `{user} = {k} with extra sparkle ✨ ({hint}).`
         : `{user} = {k} with extra sparkle ✨`,
    hint ? `Status: {user} entered {k} mode • {hint}.`
         : `Status: {user} entered {k} mode.`
  ];

  return variants.map(mk).join('\n---\n');
}

/* ============================= Context Helper ============================= */
async function getRecentContextFromMessage(message, limit = 6) {
  try {
    const fetched = await message.channel.messages.fetch({ limit: 10 });
    const lines = [];
    for (const [, m] of fetched) {
      if (m.author?.bot) continue;
      const txt = (m.content || '').trim();
      if (!txt) continue;
      const one = txt.replace(/\s+/g, ' ').slice(0, 160);
      lines.push(`${m.member?.displayName || m.author.username}: ${one}`);
      if (lines.length >= limit) break;
    }
    return lines.length ? `Recent context:\n${lines.join('\n')}` : '';
  } catch {
    return '';
  }
}

/* ============================= The Listener ============================= */
module.exports = (client, pg) => {
  client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // If prefix listener is enabled, DO NOT handle here to avoid double posting
    if (EXP_PREFIX_ENABLED) return;

    const prefix = EXP_PREFIX.toLowerCase();
    const content = (message.content || '').trim().toLowerCase();
    if (!content.startsWith(prefix)) return;

    // Parse: !exp <word or "phrase"> [@mention?]
    let rest = message.content.slice(prefix.length).trim();
    if (!rest.length) {
      return message.reply({ content: `❌ Please provide an expression. Example: \`${EXP_PREFIX} "sigma" @user\` or \`${EXP_PREFIX} loco\`` });
    }

    // quoted phrase first
    let keyword = '';
    const m = rest.match(/^"([^"]+)"\s*(.*)$/);
    if (m) {
      keyword = (m[1] || '').trim();
      rest    = (m[2] || '').trim();
    } else {
      const split = rest.split(/\s+/);
      keyword = (split.shift() || '').trim();
      rest    = split.join(' ').trim();
    }

    if (!keyword) {
      return message.reply({ content: `❌ Please provide an expression. Example: \`${EXP_PREFIX} rich\`` });
    }

    const targetUser  = message.mentions.users.first() || message.author;
    const userMention = `<@${targetUser.id}>`;
    const guildId     = message.guild?.id ?? null;
    const guildName   = message.guild?.name || 'this server';

    try {
      // 1) Built-ins
      const builtIn = flavorMap[keyword.toLowerCase()];
      if (builtIn) {
        const msg = getRandomFlavor(keyword.toLowerCase(), userMention);
        const embed = new EmbedBuilder().setDescription(msg).setColor(getRandomColor());
        return message.reply({ embeds: [embed] });
      }

      // 2) DB lookup
      let dbRes = { rows: [] };
      try {
        dbRes = await pg.query(
          `SELECT * FROM expressions
           WHERE name = $1 AND (guild_id = $2 OR ($2 IS NULL AND guild_id IS NULL))
           ORDER BY RANDOM() LIMIT 1`,
          [keyword.toLowerCase(), guildId]
        );
      } catch (e) {
        console.error('❌ DB error in !exp:', e);
      }

      if (dbRes.rows.length) {
        const exp = dbRes.rows[0];
        const customMessage = (exp?.content || '').includes('{user}')
          ? exp.content.replace(/{user}/gi, userMention)
          : `${userMention} is experiencing **"${keyword}"** energy today!`;

        if (exp?.type === 'image') {
          try {
            const file = new AttachmentBuilder(exp.content);
            return await message.reply({ content: customMessage, files: [file] });
          } catch {
            return await message.reply({ content: customMessage });
          }
        }

        const embed = new EmbedBuilder().setDescription(customMessage).setColor(getRandomColor());
        return message.reply({ embeds: [embed] });
      }

      // 3) AI path
      try {
        const recentContext = await getRecentContextFromMessage(message);
        const textBlock = await smartAIResponse(keyword, {
          userMention,
          guildName,
          recentContext,
          wantVariants: true
        });

        const picked = pickVariant(textBlock, userMention);
        const embed = new EmbedBuilder().setDescription(picked).setColor(getRandomColor());
        return message.reply({ embeds: [embed] });

      } catch (aiErr) {
        console.error('❌ AI error:', aiErr);
        const fallback = pickVariant(localSemanticVariants(keyword, userMention), userMention);
        const embed = new EmbedBuilder().setDescription(fallback).setColor(getRandomColor());
        return message.reply({ embeds: [embed] });
      }

    } catch (err) {
      console.error('❌ Error handling !exp:', err);
      return message.reply({ content: '⚠️ Internal error occurred while processing this command.' });
    }
  });
};


