// commands/exp.js
const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const fetch = require('node-fetch');
const { flavorMap, getRandomFlavor } = require('../utils/flavorMap');

const guildNameCache = new Map();

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

    // Prefer chat-capable families
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
  // If env override is set and not decommissioned, use it first
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

  // Static last-resort guesses (kept minimal; filtered if decommissioned)
  const FALLBACKS = [
    'llama-3.1-70b-versatile',
    'llama3-70b-8192',
    'mixtral-8x7b-32768',
    'llama-3.1-8b-instant',
    'gemma-7b-it'
  ].filter(id => !DECOMMISSIONED_MODELS.has(id));

  // If we still have nothing, use fallbacks
  if (!list.length) list.push(...FALLBACKS);

  return list;
}

/* ============================= UI Utils ============================= */
function getRandomColor() {
  const colors = [
    0xFFD700, 0x66CCFF, 0xFF66CC, 0xFF4500,
    0x00FF99, 0xFF69B4, 0x00CED1, 0xFFA500, 0x8A2BE2
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Ephemeral helper (flags instead of deprecated "ephemeral" option)
function asEphemeral(opts = {}) {
  const EPHEMERAL = (MessageFlags && MessageFlags.Ephemeral) ? MessageFlags.Ephemeral : (1 << 6); // 64
  return { ...opts, flags: EPHEMERAL };
}

/* ============================= Command ============================= */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('exp')
    .setDescription('Show a visual experience vibe')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Name of the expression (e.g. rich, loco, sigma)')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addUserOption(option =>
      option.setName('target')
        .setDescription('Tag another user (optional)')
        .setRequired(false)
    ),

  async execute(interaction, { pg }) {
    const ownerId = process.env.BOT_OWNER_ID;
    const isOwner = interaction.user.id === ownerId;

    const rawName = interaction.options.getString('name');
    const name = (rawName || '').trim().toLowerCase(); // normalize any input
    const targetUser = interaction.options.getUser('target') || interaction.user;
    const userMention = `<@${targetUser.id}>`;
    const guildId = interaction.guild?.id ?? null;

    // Use flags for ephemeral (avoid deprecation warning), then delete the deferred reply
    await interaction.deferReply(asEphemeral());
    await interaction.deleteReply().catch(() => {});

    // Friendly identity for embeds
    const guildName = interaction.guild?.name || 'this server';
    const displayTarget = interaction.guild?.members.cache.get(targetUser.id)?.displayName || targetUser.username;
    const avatar = targetUser.displayAvatarURL({ size: 256 });

    let res = { rows: [] };
    try {
      if (pg) {
        if (isOwner) {
          res = await pg.query(
            `SELECT * FROM expressions WHERE name = $1 ORDER BY RANDOM() LIMIT 1`,
            [name]
          );
        } else {
          res = await pg.query(
            `SELECT * FROM expressions WHERE name = $1 AND (guild_id = $2 OR guild_id IS NULL) ORDER BY RANDOM() LIMIT 1`,
            [name, guildId]
          );
        }
      }
    } catch (err) {
      console.error('❌ DB error in /exp:', err);
    }

    // If nothing in DB and no built-in, ask AI to interpret the word; if AI fails, use local semantic fallback
    if (!res.rows.length && !flavorMap[name]) {
      let textBlock = '';
      try {
        const mode = await getMbMode(pg, guildId);
        const recentContext = await getRecentContext(interaction);
        textBlock = await smartAIResponse(name, userMention, {
          mode,
          recentContext,
          guildName,
          displayTarget,
          wantVariants: true,      // return 3 variants
          semantic: true           // interpret slang/foreign/meme
        });
      } catch (err) {
        console.error('❌ AI error in /exp:', err);
        textBlock = localSemanticVariants(name, userMention); // semantic local fallback
      }

      if (!textBlock || !textBlock.trim()) {
        textBlock = localSemanticVariants(name, userMention);
      }

      const aiPicked = pickVariant(textBlock, userMention);

      const embed = new EmbedBuilder()
        .setColor(getRandomColor())
        .setAuthor({ name: `For ${displayTarget} @ ${guildName}`, iconURL: avatar })
        .setDescription(`💬 ${aiPicked}`);

      return await interaction.channel.send({ embeds: [embed] });
    }

    // If we got a DB row (support multi-variant content via "||" or "\n---\n")
    if (res.rows.length) {
      const exp = res.rows[0];

      if (exp?.type === 'image') {
        // keep original image behavior
        try {
          const imageRes = await fetch(exp.content);
          if (!imageRes.ok) throw new Error(`Image failed to load: ${imageRes.status}`);
          const file = new AttachmentBuilder(exp.content);
          const fallbackMsg = exp?.content_text?.includes?.('{user}')
            ? exp.content_text.replace('{user}', userMention)
            : `💥 ${userMention} is experiencing "${name}" energy today!`;
          return await interaction.channel.send({ content: fallbackMsg, files: [file] });
        } catch (err) {
          const fallbackMsg = exp?.content_text?.includes?.('{user}')
            ? exp.content_text.replace('{user}', userMention)
            : `⚠️ Image broken, but ${userMention} still channels "${name}" energy!`;
          return await interaction.channel.send({ content: fallbackMsg });
        }
      }

      // Text or other types: allow multi-variants in exp.content separated by || or \n---\n
      const customPrepared = prepareVariants(exp?.content || '', userMention);
      const picked = pickVariant(customPrepared, userMention) ||
        `💥 ${userMention} is experiencing "${name}" energy today!`;

      const embed = new EmbedBuilder()
        .setColor(getRandomColor())
        .setAuthor({ name: `For ${displayTarget} @ ${guildName}`, iconURL: avatar })
        .setDescription(picked);

      return interaction.channel.send({ embeds: [embed] });
    }

    // Built-in fallback (single line kept as-is)
    const builtIn = getRandomFlavor(name, userMention);
    const embed = new EmbedBuilder()
      .setColor(getRandomColor())
      .setAuthor({ name: `For ${displayTarget} @ ${guildName}`, iconURL: avatar })
      .setDescription(builtIn || `💥 ${userMention} is experiencing "${name}" energy today!`);

    return interaction.channel.send({ embeds: [embed] });
  },

  async autocomplete(interaction, { pg }) {
    const focused = interaction.options.getFocused();
    const guildId = interaction.guild?.id ?? null;
    const userId = interaction.user.id;
    const ownerId = process.env.BOT_OWNER_ID;
    const isOwner = userId === ownerId;
    const client = interaction.client;

    const builtInChoices = Object.keys(flavorMap).map(name => ({
      name: `🔥 ${name} (Built-in)`,
      value: name
    }));

    let query, params, res = { rows: [] };
    try {
      if (pg) {
        if (isOwner) {
          query = `SELECT DISTINCT name, guild_id FROM expressions`;
          params = [];
        } else {
          query = `SELECT DISTINCT name, guild_id FROM expressions WHERE guild_id = $1 OR guild_id IS NULL`;
          params = [guildId];
        }
        res = await pg.query(query, params);
      }
    } catch (err) {
      console.error('❌ Autocomplete DB error for exp:', err);
    }

    const thisServer = [], global = [], otherServers = [];
    for (const row of res.rows) {
      if (!row.name) continue;
      if (row.guild_id === null) {
        global.push({ name: `🌐 ${row.name} (Global)`, value: row.name });
      } else if (row.guild_id === guildId) {
        thisServer.push({ name: `🏠 ${row.name} (This Server)`, value: row.name });
      } else {
        let guildName = guildNameCache.get(row.guild_id);
        if (!guildName) {
          const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
          guildName = guild?.name ?? 'Other Server';
          guildNameCache.set(row.guild_id, guildName);
        }
        otherServers.push({ name: `🛡️ ${row.name} (${guildName})`, value: row.name });
      }
    }

    const combined = [...builtInChoices, ...thisServer, ...global, ...otherServers];

    // Smarter ranking: exact > prefix > substring
    const norm = (s) => (s || '').toLowerCase();
    const q = norm(focused || '');
    const scored = combined.map(c => {
      const label = norm(c.name);
      let score = 0;
      if (label.includes(q)) score += 1;
      if (label.startsWith(q)) score += 2;
      if (label === q) score += 3;
      return { ...c, _score: score };
    });

    const filtered = scored
      .filter(c => q ? c._score > 0 : true)
      .sort((a, b) => b._score - a._score)
      .slice(0, 25)
      .map(({ name, value }) => ({ name, value }));

    await interaction.respond(filtered.length ? filtered : combined.slice(0, 25));
  }
};

/* ============================= Helpers ============================= */

// Pull a short, recent, non-bot context window from the channel
async function getRecentContext(interaction, limit = 6) {
  try {
    const fetched = await interaction.channel.messages.fetch({ limit: 10 });
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

// Read mb mode for tone alignment
async function getMbMode(pg, guildId) {
  if (!pg || !guildId) return 'default';
  try {
    const r = await pg.query(`SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`, [guildId]);
    return r.rows[0]?.mode || 'default';
  } catch {
    return 'default';
  }
}

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

  // Ask for 3 distinct variants; we’ll split on \n---\n later
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
  // semantic mode: instruct to infer meaning/translation internally
  return wantVariants
    ? `Expression: "${keyword}". Interpret as slang/meme/foreign if needed; reflect its meaning in the line. Return 3 variants separated by '---'. Mention {user} each.`
    : `Expression: "${keyword}". Interpret as slang/meme/foreign if needed; reflect its meaning in the line. Single line, mention {user} once.`;
}

// Prepare multi-variant content strings (DB custom): split by || or \n---\n
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
  // final safety: user mention replacement if not already done
  return chosen.replace(/{user}/gi, userMention).slice(0, 240);
}

function cleanQuotes(text) {
  return (text || '').replace(/^"(.*)"$/, '$1').trim();
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
        // Parse error body for code and reduce noisy repeats
        const parsed = safeJsonParse(bodyText);
        const code = parsed?.error?.code || parsed?.error?.type || '';
        const msg = parsed?.error?.message || bodyText?.slice(0, 300) || '';

        // Track and silently skip decommissioned models next time
        if (code === 'model_decommissioned' || /decommissioned/i.test(msg)) {
          DECOMMISSIONED_MODELS.add(model);
        }

        const warnKey = `groq_${model}`;
        if (!MODEL_WARNED.has(warnKey)) {
          console.warn(`Groq ${model} HTTP ${res.status}: ${msg}`);
          MODEL_WARNED.add(warnKey);
        }

        // 400/404: try next model; 401/403/429/5xx: bail out
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
      // try next model
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
/**
 * Local, AI-free semantic fallback: tries to infer simple meaning hints for common slang/foreign words,
 * then crafts multiple variants. Always returns '---' separated block so pickVariant can choose one.
 */
function localSemanticVariants(keyword, userMention) {
  const k = (keyword || 'vibe').trim();

  // Simple semantic hints (extend as needed)
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



