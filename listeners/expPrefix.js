// listeners/expPrefix.js
const fetch = require('node-fetch');
const { EmbedBuilder } = require('discord.js');
const { flavorMap, getRandomFlavor } = require('../utils/flavorMap');

/* ============================= Config / Env ============================= */
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-3.5-turbo').trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL_ENV = (process.env.GROQ_MODEL || '').trim(); // optional override

/* ============================= Discovery / Caching ============================= */
// Cache discovered Groq models for 6h
let MODEL_CACHE = { ts: 0, ids: [] };
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;

// Avoid noisy repeat logs per model
const MODEL_WARNED = new Set();
// Track models that returned "model_decommissioned"
const DECOMMISSIONED_MODELS = new Set();

function nowMs() { return Date.now(); }

function preferOrder(a, b) {
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

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 25000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { ...opts, signal: controller?.signal });
    const bodyText = await res.text();
    return { res, bodyText };
  } finally {
    if (timer) clearTimeout(timer);
  }
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

    // Prefer chat-capable families and skip decommissioned
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

  // Static last-resort guesses (filtered if decommissioned)
  const FALLBACKS = [
    'llama-3.1-70b-versatile',
    'llama3-70b-8192',
    'mixtral-8x7b-32768',
    'llama-3.1-8b-instant',
    'gemma-7b-it'
  ].filter(id => !DECOMMISSIONED_MODELS.has(id));

  if (!list.length) list.push(...FALLBACKS);
  return list;
}

/* ============================= Small Helpers ============================= */
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
function modeSystemFlavor(mode) {
  switch (mode) {
    case 'chill':
      return 'Tone: chill, friendly, supportive. Keep it positive.';
    case 'villain':
      return 'Tone: theatrical villain, playful ominous swagger.';
    case 'motivator':
      return 'Tone: alpha motivator, gym metaphors, high energy.';
    default:
      return 'Tone: sharp, witty, degen-savvy but kind by default.';
  }
}

// Semantic instruction layer so AI interprets "any word" (slang/foreign/meme)
function buildSystemPromptBase(mode, recentContext, guildName, wantVariants = false) {
  const base = [
    `You generate a short, stylish "expression vibe" line for a Discord server (${guildName}).`,
    modeSystemFlavor(mode),
    'Your job: INTERPRET the given expression as a vibe. If it is slang/meme/other language, infer or briefly translate the meaning internally (DO NOT output a definition).',
    'Then craft a one-line vibe targeting the mentioned user. Use the expression literally once and reflect its meaning (e.g., "loco" → wild/crazy; "sigma" → stoic boss energy).',
    'Keep it to 1 sentence, under ~140 chars. Use Discord/Web3 slang tastefully. Avoid insults/slurs; keep it playful. Include {user} once.',
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

function composeUserPrompt(keyword, wantVariants, semantic) {
  if (!semantic) {
    return wantVariants
      ? `Expression: "${keyword}". Give 3 vibe variants separated by '---' lines. Mention {user} in each.`
      : `Expression: "${keyword}". Output a single, punchy vibe line. Mention {user} once.`;
  }
  return wantVariants
    ? `Expression: "${keyword}". Interpret as slang/meme/foreign if needed; reflect its meaning in the line. Return 3 variants separated by '---'. Mention {user} each.`
    : `Expression: "${keyword}". Interpret as slang/meme/foreign if needed; reflect its meaning in the line. Single line, mention {user} once.`;
}

/* ============================= AI Core (Groq discovery + OpenAI) ============================= */
async function smartAIResponse(keyword, userMention, opts = {}) {
  const {
    mode = 'default',
    recentContext = '',
    guildName = 'this server',
    displayTarget = userMention,
    wantVariants = false,
    semantic = true
  } = opts;

  try {
    return await getGroqAI(keyword, displayTarget, { mode, recentContext, guildName, wantVariants, semantic });
  } catch {
    console.warn('❌ Groq failed, trying OpenAI');
    try {
      return await getOpenAI(keyword, displayTarget, { mode, recentContext, guildName, wantVariants, semantic });
    } catch {
      console.warn('❌ OpenAI failed — using local semantic fallback');
      return localSemanticVariants(keyword, userMention);
    }
  }
}

async function getGroqAI(keyword, userMention, { mode, recentContext, guildName, wantVariants, semantic }) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY missing');

  const system = buildSystemPromptBase(mode, recentContext, guildName, wantVariants);
  const user = composeUserPrompt(keyword, wantVariants, semantic);

  const models = await getGroqModelsToTry();
  if (!models.length) throw new Error('No Groq models available');

  const bodyFor = (model) => JSON.stringify({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
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
        const msg = parsed?.error?.message || bodyText?.slice(0, 300) || '';

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
      const rawReply = data?.choices?.[0]?.message?.content?.trim();
      if (!rawReply) { lastErr = new Error('Groq empty'); continue; }

      const cleaned = cleanQuotes(rawReply);
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

async function getOpenAI(keyword, userMention, { mode, recentContext, guildName, wantVariants, semantic }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

  const system = buildSystemPromptBase(mode, recentContext, guildName, wantVariants);
  const user = composeUserPrompt(keyword, wantVariants, semantic);

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
          { role: 'user', content: user }
        ],
        max_tokens: wantVariants ? 180 : 80,
        temperature: 0.95
      })
    },
    25000
  );

  if (!res.ok) {
    console.error(`❌ OpenAI HTTP ${res.status}: ${bodyText?.slice(0, 400)}`);
    throw new Error(`OpenAI HTTP ${res.status}`);
  }

  const json = safeJsonParse(bodyText);
  const rawReply = json?.choices?.[0]?.message?.content?.trim();
  if (!rawReply) throw new Error('OpenAI gave no response');

  const cleaned = cleanQuotes(rawReply);
  if (wantVariants && !/^\s*---\s*$/m.test(cleaned)) {
    const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (lines.length >= 3) {
      return lines.slice(0, 3).join('\n---\n');
    }
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

/* ============================= Context / Mode Helpers ============================= */
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

async function getMbMode(pg, guildId) {
  if (!pg || !guildId) return 'default';
  try {
    const r = await pg.query(`SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`, [guildId]);
    return r.rows[0]?.mode || 'default';
  } catch {
    return 'default';
  }
}

/* ============================= Parser / Handler ============================= */
// Parse: !exp <word or "phrase"> [@mention?]
function parseExpCommand(text, prefix) {
  // remove prefix
  let rest = text.slice(prefix.length).trim();
  if (!rest) return { keyword: '', trailing: '' };

  // quoted "..." first
  const m = rest.match(/^"([^"]+)"\s*(.*)$/);
  if (m) return { keyword: m[1].trim(), trailing: (m[2] || '').trim() };

  // else first token to whitespace
  const sp = rest.split(/\s+/);
  const keyword = (sp.shift() || '').trim();
  const trailing = sp.join(' ').trim();
  return { keyword, trailing };
}

/* ============================= Exported Listener ============================= */
module.exports = (client, { pg, prefix = '!exp', cooldownMs = 6000 } = {}) => {
  const cooldown = new Set();

  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild) return;
      if (message.author.bot) return;

      const content = (message.content || '').trim();
      if (!content.toLowerCase().startsWith(prefix.toLowerCase())) return;

      // Cooldown per user to avoid spam
      const uid = `${message.guild.id}:${message.author.id}`;
      if (cooldown.has(uid)) return;
      cooldown.add(uid);
      setTimeout(() => cooldown.delete(uid), cooldownMs);

      // Parse args
      const { keyword, trailing } = parseExpCommand(content, prefix);
      if (!keyword) {
        await message.reply(`Usage: \`${prefix} <word or "phrase"> [@user?]\``);
        return;
      }

      // Resolve target: first mention or author
      const targetUser = message.mentions.users.first() || message.author;
      const userMention = `<@${targetUser.id}>`;
      const displayTarget = message.guild?.members.cache.get(targetUser.id)?.displayName || targetUser.username;
      const avatar = targetUser.displayAvatarURL({ size: 256 });
      const guildName = message.guild?.name || 'this server';
      const guildId = message.guild.id;

      // DB lookup
      let rowRes = { rows: [] };
      const name = (keyword || '').trim().toLowerCase();
      try {
        if (pg) {
          const isOwner = (message.author.id === process.env.BOT_OWNER_ID);
          if (isOwner) {
            rowRes = await pg.query(
              `SELECT * FROM expressions WHERE name = $1 ORDER BY RANDOM() LIMIT 1`,
              [name]
            );
          } else {
            rowRes = await pg.query(
              `SELECT * FROM expressions WHERE name = $1 AND (guild_id = $2 OR guild_id IS NULL) ORDER BY RANDOM() LIMIT 1`,
              [name, guildId]
            );
          }
        }
      } catch (err) {
        console.error('❌ DB error in !exp:', err);
      }

      // If no DB and no built-in, go AI path with semantic interpretation → fallback to local semantic
      if (!rowRes.rows.length && !flavorMap[name]) {
        let textBlock = '';
        try {
          const mode = await getMbMode(pg, guildId);
          const recentContext = await getRecentContextFromMessage(message);
          textBlock = await smartAIResponse(name, userMention, {
            mode,
            recentContext,
            guildName,
            displayTarget,
            wantVariants: true,
            semantic: true
          });
        } catch (err) {
          console.error('❌ AI error in !exp:', err);
          textBlock = localSemanticVariants(name, userMention);
        }

        if (!textBlock || !textBlock.trim()) {
          textBlock = localSemanticVariants(name, userMention);
        }

        const picked = pickVariant(textBlock, userMention);

        const embed = new EmbedBuilder()
          .setColor(getRandomColor())
          .setAuthor({ name: `For ${displayTarget} @ ${guildName}`, iconURL: avatar })
          .setDescription(`💬 ${picked}`);

        await message.channel.send({ embeds: [embed] });
        return;
      }

      // If DB row present (supports images + multi-variant text)
      if (rowRes.rows.length) {
        const exp = rowRes.rows[0];

        if (exp?.type === 'image') {
          try {
            const imageRes = await fetch(exp.content);
            if (!imageRes.ok) throw new Error(`Image failed: ${imageRes.status}`);
            // AttachmentBuilder can accept URL, discord will proxy it
            const fallbackMsg = exp?.content_text?.includes?.('{user}')
              ? exp.content_text.replace('{user}', userMention)
              : `💥 ${userMention} is experiencing "${name}" energy today!`;
            await message.channel.send({ content: fallbackMsg, files: [exp.content] });
          } catch (err) {
            const fallbackMsg = exp?.content_text?.includes?.('{user}')
              ? exp.content_text.replace('{user}', userMention)
              : `⚠️ Image broken, but ${userMention} still channels "${name}" energy!`;
            await message.channel.send({ content: fallbackMsg });
          }
          return;
        }

        const prepared = prepareVariants(exp?.content || '', userMention);
        const picked = pickVariant(prepared, userMention) ||
          `💥 ${userMention} is experiencing "${name}" energy today!`;

        const embed = new EmbedBuilder()
          .setColor(getRandomColor())
          .setAuthor({ name: `For ${displayTarget} @ ${guildName}`, iconURL: avatar })
          .setDescription(picked);

        await message.channel.send({ embeds: [embed] });
        return;
      }

      // Built-in fallback
      const builtIn = getRandomFlavor(name, userMention);
      const embed = new EmbedBuilder()
        .setColor(getRandomColor())
        .setAuthor({ name: `For ${displayTarget} @ ${guildName}`, iconURL: avatar })
        .setDescription(builtIn || `💥 ${userMention} is experiencing "${name}" energy today!`);

      await message.channel.send({ embeds: [embed] });

    } catch (err) {
      console.error('❌ !exp handler error:', err?.stack || err?.message || String(err));
      try { await message.reply('⚠️ Couldn’t process that one. Try again.'); } catch {}
    }
  });
};
