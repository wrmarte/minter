const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const fetch = require('node-fetch');
const { flavorMap, getRandomFlavor } = require('../utils/flavorMap');

const guildNameCache = new Map();

// Optional: allow overriding the OpenAI model via env
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-3.5-turbo').trim();

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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('exp')
    .setDescription('Show a visual experience vibe')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Name of the expression (e.g. rich)')
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
    const name = (rawName || '').trim().toLowerCase(); // ✅ normalize
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

    // If nothing in DB and no built-in, ask AI; if AI fails, use local fallback variants
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
          wantVariants: true
        });
      } catch (err) {
        console.error('❌ AI error in /exp:', err);
        // use local fallback generator if AI throws
        textBlock = localFallbackVariants(name, userMention);
      }

      // ensure we have something even if AI returned empty
      if (!textBlock || !textBlock.trim()) {
        textBlock = localFallbackVariants(name, userMention);
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

function buildSystemPromptBase(mode, recentContext, guildName, wantVariants = false) {
  const base = [
    `You generate a short, stylish "expression vibe" for a Discord server (${guildName}).`,
    modeSystemFlavor(mode),
    'Keep it to 1 sentence. Use Discord/Web3 slang tastefully. Avoid insults; be fun.',
    recentContext ? recentContext : ''
  ].filter(Boolean).join('\n\n');

  if (!wantVariants) return base;

  // Ask for 3 distinct variants; we’ll split on \n---\n later
  return base + `

Return EXACTLY 3 distinct one-line variants, each under 160 characters.
Separate variants with a single line containing three dashes exactly:
---
Do not number them. Include {user} in each line where the mention should go.`;
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

// ✅ Smart AI with Fallback Logic (context + mode aware, variant-capable)
async function smartAIResponse(keyword, userMention, opts = {}) {
  const {
    mode = 'default',
    recentContext = '',
    guildName = 'this server',
    displayTarget = userMention,
    wantVariants = false
  } = opts;

  try {
    return await getGroqAI(keyword, displayTarget, { mode, recentContext, guildName, wantVariants });
  } catch {
    console.warn('❌ Groq failed, trying OpenAI');
    try {
      return await getOpenAI(keyword, displayTarget, { mode, recentContext, guildName, wantVariants });
    } catch {
      console.warn('❌ OpenAI failed — using local fallback');
      // return 3 local variants joined by '---' so pickVariant works the same
      return localFallbackVariants(keyword, userMention);
    }
  }
}

async function getGroqAI(keyword, userMention, { mode, recentContext, guildName, wantVariants }) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const apiKey = process.env.GROQ_API_KEY;

  const body = {
    model: 'llama3-70b-8192',
    messages: [
      { role: 'system', content: buildSystemPromptBase(mode, recentContext, guildName, wantVariants) },
      { role: 'user', content: wantVariants
          ? `Expression: "${keyword}". Give 3 variants separated by '---' lines. Mention {user} in each.`
          : `Expression: "${keyword}". Output a single, punchy line. Mention {user} once.` }
    ],
    max_tokens: wantVariants ? 160 : 60,
    temperature: 0.9
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  const rawReply = data?.choices?.[0]?.message?.content?.trim();
  if (!rawReply) throw new Error('Empty AI response');

  const cleaned = cleanQuotes(rawReply);

  // If it doesn’t include '---' and we asked for variants, make quick splits
  if (wantVariants && !/^\s*---\s*$/m.test(cleaned)) {
    const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (lines.length >= 3) {
      return lines.slice(0, 3).join('\n---\n');
    }
  }
  return cleaned;
}

async function getOpenAI(keyword, userMention, { mode, recentContext, guildName, wantVariants }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: buildSystemPromptBase(mode, recentContext, guildName, wantVariants) },
        { role: 'user', content: wantVariants
            ? `Expression: "${keyword}". Give 3 variants separated by '---' lines. Mention {user} in each.`
            : `Expression: "${keyword}". Output a single, punchy line. Mention {user} once.` }
      ],
      max_tokens: wantVariants ? 160 : 60,
      temperature: 1.0
    })
  });

  const json = await res.json();
  const rawReply = json?.choices?.[0]?.message?.content;
  if (!rawReply) throw new Error('OpenAI gave no response');

  const cleaned = cleanQuotes(rawReply);

  // If it doesn’t include '---' and we asked for variants, make quick splits
  if (wantVariants && !/^\s*---\s*$/m.test(cleaned)) {
    const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (lines.length >= 3) {
      return lines.slice(0, 3).join('\n---\n');
    }
  }
  return cleaned;
}

function cleanQuotes(text) {
  return (text || '').replace(/^"(.*)"$/, '$1').trim();
}

// Local, AI-free fallback: return 3+ variants joined by '---'
function localFallbackVariants(keyword, userMention) {
  const k = (keyword || 'vibe').trim();
  const variants = [
    `{user} is pulling pure ${k} energy today. ⚡`,
    `${k} mode: ON. {user} just flipped the switch.`,
    `If ${k} had a soundtrack, {user} dropped the beat. 🎵`,
    `{user} = ${k} with extra sparkle ✨`,
    `Microdose of ${k}? Nah. {user} mainlined it.`,
    `Proof of ${k}: {user} just minted the vibe. ✅`,
    `{user} ate ${k} for breakfast and asked for seconds.`,
    `{user} called. They want more ${k} in the roadmap. 🗺️`,
    `Patch notes: +20% ${k} for {user} ⚙️`,
    `{user} speedrunning ${k} any% 🏁`,
    `Today’s theme for {user}: ${k} — ship it. 📦`,
    `{user} distilled ${k} down to one line and made it art.`
  ];

  // Return as '---' separated block so pickVariant can choose one
  return variants
    .map(v => v.replace(/{user}/gi, userMention))
    .join('\n---\n');
}
