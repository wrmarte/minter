// listeners/mbella.js
const fetch = require('node-fetch');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');

/** ================= ENV & CONFIG ================= */
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL_ENV = (process.env.GROQ_MODEL || '').trim();

// Display config
const MBELLA_NAME = (process.env.MBELLA_NAME || 'MBella').trim();
const MBELLA_AVATAR_URL = (process.env.MBELLA_AVATAR_URL || '').trim();

// Typing delay: match MuscleMB by default (env overridable)
const MBELLA_MS_PER_CHAR = Number(process.env.MBELLA_MS_PER_CHAR || '40');     // 40ms/char
const MBELLA_MAX_DELAY_MS = Number(process.env.MBELLA_MAX_DELAY_MS || '5000'); // 5s cap

// Behavior config
const COOLDOWN_MS = 10_000;
const FEMALE_TRIGGERS = ['mbella', 'mb ella', 'lady mb', 'queen mb', 'bella'];
const RELEASE_REGEX = /\b(stop|bye bella|goodbye bella|end chat|silence bella)\b/i;

// Periodic quotes: enabled by default so she auto-posts every ~4h in active guilds
const MBELLA_PERIODIC_QUOTES = /^true$/i.test(process.env.MBELLA_PERIODIC_QUOTES || 'true');
const NICE_PING_EVERY_MS = 4 * 60 * 60 * 1000; // 4 hours
const NICE_SCAN_EVERY_MS = 60 * 60 * 1000;     // scan hourly
const NICE_ACTIVE_WINDOW_MS = 45 * 60 * 1000;  // “active” = last 45 minutes

/** Guard rail */
if (!GROQ_API_KEY || GROQ_API_KEY.trim().length < 10) {
  console.warn('⚠️ GROQ_API_KEY missing/short for MBella. Check your env.');
}

/** ================== STATE ================== */
const cooldown = new Set();
const channelWebhookCache = new Map(); // channelId -> webhook

function alreadyHandled(client, messageId) {
  if (!client.__mbHandled) client.__mbHandled = new Set();
  return client.__mbHandled.has(messageId);
}
function markHandled(client, messageId) {
  if (!client.__mbHandled) client.__mbHandled = new Set();
  client.__mbHandled.add(messageId);
  setTimeout(() => client.__mbHandled.delete(messageId), 60_000);
}

// "current partner" cache: only that user can keep the reply-thread going
const BELLA_TTL_MS = 30 * 60 * 1000; // 30 mins
const bellaPartners = new Map(); // channelId -> { userId, expiresAt }
function setBellaPartner(channelId, userId, ttlMs = BELLA_TTL_MS) {
  bellaPartners.set(channelId, { userId, expiresAt: Date.now() + ttlMs });
}
function getBellaPartner(channelId) {
  const rec = bellaPartners.get(channelId);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    bellaPartners.delete(channelId);
    return null;
  }
  return rec.userId;
}
function clearBellaPartner(channelId) {
  bellaPartners.delete(channelId);
}

// Activity trackers for periodic quotes
const lastActiveByUser = new Map(); // key: `${guildId}:${userId}` -> { ts, channelId }
const lastNicePingByGuild = new Map(); // guildId -> ts

/** ================== QUOTES ================== */
const SEXY_QUOTES = [
  'Confidence is the best outfit—wear it and own the room. ✨',
  'Slow breath, bold move. I like that combo. 😉',
  'Soft voice, sharp mind, unstoppable energy. That’s the vibe. 💋',
  'Discipline is a love language. Show up for yourself first. ❤️',
  'Flirt with your goals like you mean it. They’ll chase you back. 🔥',
  'Elegance is refusing to rush the magic. We’re cooking. ✨',
  'You don’t need permission to glow—just decide and do. 🌶️',
  'Mischief + mastery = unfair advantage. Use both. 😼',
  'Touch the task. The task touches back. Momentum is romantic. 💞',
  'Hydrate, stretch, then wreck your todo list—sensually. 💦',
];

/** ================== UTILS ================== */
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function safeJsonParse(text) { try { return JSON.parse(text); } catch { return null; } }

async function fetchWithTimeout(url, opts = {}, timeoutMs = 25_000) {
  const hasAbort = typeof globalThis.AbortController === 'function';
  if (hasAbort) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      const bodyText = await res.text();
      return { res, bodyText };
    } finally { clearTimeout(timer); }
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

/** ================== GROQ MODEL DISCOVERY ================== */
let MODEL_CACHE = { ts: 0, models: [] };
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;

async function fetchGroqModels() {
  try {
    const { res, bodyText } = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/models',
      { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` } },
      20_000
    );
    if (!res.ok) {
      console.error(`❌ Groq /models HTTP ${res.status}: ${bodyText?.slice(0, 300)}`);
      return [];
    }
    const data = safeJsonParse(bodyText);
    if (!data || !Array.isArray(data.data)) return [];
    const ids = data.data.map(x => x.id).filter(Boolean);
    const chatLikely = ids.filter(id => /llama|mixtral|gemma|qwen|deepseek/i.test(id)).sort(preferOrder);
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
    if (models.length) MODEL_CACHE = { ts: now, models };
  }
  for (const id of MODEL_CACHE.models) if (!list.includes(id)) list.push(id);
  return list;
}

function buildGroqBody(model, systemPrompt, userContent, temperature, maxTokens = 180) {
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
      body: buildGroqBody(model, systemPrompt, userContent, temperature, 180),
    },
    25_000
  );
  return { res, bodyText };
}

async function groqWithDiscovery(systemPrompt, userContent, temperature) {
  if (!GROQ_API_KEY || GROQ_API_KEY.trim().length < 10) {
    return { error: new Error('Missing GROQ_API_KEY') };
  }
  const models = await getModelsToTry();
  if (!models.length) return { error: new Error('No Groq models available') };

  let last = null;
  for (const m of models) {
    try {
      const r = await groqTryModel(m, systemPrompt, userContent, temperature);
      if (!r.res.ok) {
        console.error(`❌ Groq (MBella) HTTP ${r.res.status} on model "${m}": ${r.bodyText?.slice(0, 400)}`);
        if (r.res.status === 400 || r.res.status === 404) { last = { model: m, ...r }; continue; }
        return { model: m, ...r };
      }
      return { model: m, ...r };
    } catch (e) {
      console.error(`❌ Groq (MBella) fetch error on model "${m}":`, e.message);
      last = { model: m, error: e };
    }
  }
  return last || { error: new Error('All models failed') };
}

/** ================== DISCORD HELPERS ================== */
async function getRecentContext(message) {
  try {
    const fetched = await message.channel.messages.fetch({ limit: 8 });
    const lines = [];
    for (const [, m] of fetched) {
      if (m.id === message.id) continue;
      if (m.author?.bot) continue;
      const txt = (m.content || '').trim();
      if (!txt) continue;
      const oneLine = txt.replace(/\s+/g, ' ').slice(0, 200);
      lines.push(`${m.author.username}: ${oneLine}`);
      if (lines.length >= 6) break;
    }
    if (!lines.length) return '';
    return `Recent context:\n${lines.join('\n')}`.slice(0, 1200);
  } catch {
    return '';
  }
}

async function getReferenceSnippet(message) {
  const ref = message.reference;
  if (!ref?.messageId) return '';
  try {
    const referenced = await message.channel.messages.fetch(ref.messageId);
    const txt = (referenced?.content || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!txt) return '';
    return `You are replying to ${referenced.author?.username || 'someone'}: "${txt}"`;
  } catch {
    return '';
  }
}

function canSendInChannel(guild, channel) {
  const me = guild.members.me;
  if (!me || !channel) return false;
  return channel.isTextBased?.() && channel.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages);
}

function findSpeakableChannel(guild, preferredChannelId = null) {
  const me = guild.members.me;
  if (!me) return null;

  if (preferredChannelId) {
    const ch = guild.channels.cache.get(preferredChannelId);
    if (canSendInChannel(guild, ch)) return ch;
  }
  if (guild.systemChannel && canSendInChannel(guild, guild.systemChannel)) return guild.systemChannel;
  return guild.channels.cache.find((c) => canSendInChannel(guild, c)) || null;
}

async function getOrCreateWebhook(channel) {
  try {
    if (!channel || !channel.guild) return null;
    const cached = channelWebhookCache.get(channel.id);
    if (cached) return cached;

    const me = channel.guild.members.me;
    if (!me) return null;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.ManageWebhooks)) return null;

    const hooks = await channel.fetchWebhooks().catch(() => null);
    let hook = hooks?.find(h => h.owner?.id === channel.client.user.id);

    if (!hook) {
      hook = await channel.createWebhook({
        name: 'MB Relay',
        avatar: MBELLA_AVATAR_URL || undefined
      }).catch(() => null);
    }
    if (hook) channelWebhookCache.set(channel.id, hook);
    return hook || null;
  } catch {
    return null;
  }
}

async function sendViaWebhook(channel, { username, avatarURL, embeds, content }) {
  const hook = await getOrCreateWebhook(channel);
  if (!hook) return null;
  try {
    return await hook.send({
      username,
      avatarURL: avatarURL || undefined,
      embeds,
      content
    });
  } catch {
    return null;
  }
}

/** detect if this message is a reply to MBella (webhook or fallback) */
async function isReplyToMBella(message, client) {
  const ref = message.reference;
  if (!ref?.messageId) return false;
  try {
    const referenced = await message.channel.messages.fetch(ref.messageId);

    if (referenced.webhookId) {
      let hook = channelWebhookCache.get(message.channel.id);
      if (!hook) {
        const hooks = await message.channel.fetchWebhooks().catch(() => null);
        hook = hooks?.find(h => h.owner?.id === client.user.id);
        if (hook) channelWebhookCache.set(message.channel.id, hook);
      }
      if (hook && referenced.webhookId === hook.id) return true;
      if (referenced.author?.username && referenced.author.username.toLowerCase() === MBELLA_NAME.toLowerCase()) return true;
    }

    if (referenced.author?.id === client.user.id) {
      const embedAuthor = referenced.embeds?.[0]?.author?.name || '';
      if (embedAuthor.toLowerCase() === MBELLA_NAME.toLowerCase()) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** ================== MBELLA STYLE PROMPT ================== */
function buildMBellaSystemPrompt({ isRoast, isRoastingBot, roastTargets, currentMode, recentContext }) {
  const styleDeck = [
    'Style: sensual, flirty, a bit chaotic-nutty, and smart; playful teasing and witty banter.',
    'Tone: confident, charming, and warm; use 1–3 tasteful emojis max.',
    'Safety: PG-13 only; no explicit sexual content; no minors; consent & boundaries always.',
    'Brevity: 2–4 short sentences total.',
    'Conversation: end with a short flirty/open-ended follow-up question by default (unless the user asked to stop).',
  ].join(' ');

  let systemPrompt = '';
  if (isRoast) {
    systemPrompt =
      `You are MBella — a sharp, seductive roastmistress. Roast these tagged degens: ${roastTargets}. ` +
      `Keep it witty and playful; never cruel. Punch up with humor and innuendo, not insults. 💋🔥`;
  } else if (isRoastingBot) {
    systemPrompt =
      `You are MBella — unbothered, clever, and dazzling. Someone tried to roast you; clap back with velvet-glove swagger, playful not mean. ✨`;
  } else {
    let modeLayer = '';
    switch (currentMode) {
      case 'chill':     modeLayer = 'Chill, friendly, helpful — soft, flirty banter. 🧘‍♀️'; break;
      case 'villain':   modeLayer = 'Theatrical vamp — dramatic, playful shadows; keep it fun, not harsh. 🦹‍♀️'; break;
      case 'motivator': modeLayer = 'Flirty hype — energy, sparkle, and gentle push. 🔥'; break;
      default:          modeLayer = 'Default — cheeky, smart, a bit nutty; charming and kind.';
    }
    systemPrompt = `You are MBella — a savvy, sensual degen AI with style. ${modeLayer}`;
  }

  const softGuard =
    'Be kind by default; no slurs; no harassment. No explicit sexual content or graphic descriptions. Respect boundaries.';
  const convoNudge =
    'After your main point, add one short flirty follow-up question to keep the conversation going.';

  return [systemPrompt, styleDeck, softGuard, convoNudge, recentContext || '']
    .filter(Boolean)
    .join('\n\n');
}

/** ================== OPTIONAL PERIODIC QUOTES ================== */
function schedulePeriodicQuotes(client) {
  if (!MBELLA_PERIODIC_QUOTES) return;
  setInterval(async () => {
    try {
      const now = Date.now();
      const byGuild = new Map(); // guildId -> last seen entries
      for (const [key, info] of lastActiveByUser.entries()) {
        const [guildId] = key.split(':');
        if (!byGuild.has(guildId)) byGuild.set(guildId, []);
        byGuild.get(guildId).push(info);
      }

      for (const [guildId, entries] of byGuild.entries()) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;

        const lastPingTs = lastNicePingByGuild.get(guildId) || 0;
        if (now - lastPingTs < NICE_PING_EVERY_MS) continue; // not time yet

        const active = entries.filter(e => now - e.ts <= NICE_ACTIVE_WINDOW_MS);
        if (!active.length) continue;

        const preferredChannel = active[0]?.channelId || null;
        const channel = findSpeakableChannel(guild, preferredChannel);
        if (!channel) continue;

        const quote = pick(SEXY_QUOTES);
        const embed = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription(`✨ ${quote}`);

        // try webhook (speaks as MBella), fallback to normal send
        let sent = null;
        try {
          sent = await sendViaWebhook(channel, {
            username: MBELLA_NAME,
            avatarURL: MBELLA_AVATAR_URL,
            embeds: [embed],
          });
        } catch {}
        if (!sent) {
          try { await channel.send({ embeds: [embed] }); } catch {}
        }

        lastNicePingByGuild.set(guildId, now);
      }
    } catch (e) {
      console.warn('⚠️ MBella periodic quote error:', e.message);
    }
  }, NICE_SCAN_EVERY_MS);
}

/** ================== EXPORT LISTENER ================== */
module.exports = (client) => {
  // Optional periodic quotes scheduler (enabled by default; toggle with MBELLA_PERIODIC_QUOTES=false)
  schedulePeriodicQuotes(client);

  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot || !message.guild) return;

      // Track activity for periodic quotes
      lastActiveByUser.set(`${message.guild.id}:${message.author.id}`, {
        ts: Date.now(),
        channelId: message.channel.id,
      });

      if (alreadyHandled(client, message.id)) return;

      const lowered = (message.content || '').toLowerCase();
      const hasFemaleTrigger = FEMALE_TRIGGERS.some(t => lowered.includes(t));
      const botMentioned = message.mentions.has(client.user);
      const hintedBella = /\bbella\b/.test(lowered);

      // "release" phrases: clear partner lock
      if (RELEASE_REGEX.test(message.content || '')) {
        clearBellaPartner(message.channel.id);
        return;
      }

      // reply detection
      const replyingToMBella = await isReplyToMBella(message, client);

      // author-gated reply: only current partner can keep the flow
      const partnerId = getBellaPartner(message.channel.id);
      const replyAllowed = replyingToMBella && (!partnerId || partnerId === message.author.id);

      // overall trigger decision
      if (!hasFemaleTrigger && !(botMentioned && hintedBella) && !replyAllowed) return;
      if (message.mentions.everyone || message.mentions.roles.size > 0) return;

      // cooldown — bypass when replying to her
      const isOwner = message.author.id === process.env.BOT_OWNER_ID;
      const bypassCooldown = replyAllowed;
      if (!bypassCooldown) {
        if (cooldown.has(message.author.id) && !isOwner) return;
        cooldown.add(message.author.id);
        setTimeout(() => cooldown.delete(message.author.id), COOLDOWN_MS);
      }

      // ⛔️ Don’t call sendTyping() -> avoids showing “MuscleMB is typing…”
      // await message.channel.sendTyping();

      // Roast logic
      const mentionedUsers = message.mentions.users.filter(u => u.id !== client.user.id);
      const shouldRoast = (hasFemaleTrigger || (botMentioned && hintedBella) || replyAllowed) && mentionedUsers.size > 0;
      const isRoastingBot = shouldRoast && message.mentions.has(client.user) && mentionedUsers.size === 1 && mentionedUsers.has(client.user.id);

      // Mode from DB (reuse mb_modes)
      let currentMode = 'default';
      try {
        const modeRes = await client.pg.query(
          `SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`,
          [message.guild.id]
        );
        currentMode = modeRes.rows[0]?.mode || 'default';
      } catch {
        console.warn('⚠️ (MBella) failed to fetch mb_mode, using default.');
      }

      // Recent context + replied-to snippet = more awareness
      const [recentContext, referenceSnippet] = await Promise.all([
        getRecentContext(message),
        getReferenceSnippet(message)
      ]);
      const awarenessContext = [recentContext, referenceSnippet].filter(Boolean).join('\n');

      // Clean input: remove triggers & mentions
      let cleanedInput = lowered;
      for (const t of FEMALE_TRIGGERS) cleanedInput = cleanedInput.replaceAll(t, '');
      message.mentions.users.forEach(user => {
        cleanedInput = cleanedInput.replaceAll(`<@${user.id}>`, '');
        cleanedInput = cleanedInput.replaceAll(`<@!${user.id}>`, '');
      });
      cleanedInput = cleanedInput.replaceAll(`<@${client.user.id}>`, '').trim();

      // Intro flavor
      let intro = '';
      if (hasFemaleTrigger) intro = `Detected trigger word: "${FEMALE_TRIGGERS.find(t => lowered.includes(t))}". `;
      else if (botMentioned && hintedBella) intro = `You called for MBella. `;
      else if (replyAllowed) intro = `Reply detected — continuing with MBella. `;
      if (!cleanedInput) cleanedInput = shouldRoast ? 'Roast these fools.' : 'Your move, darling.';
      cleanedInput = `${intro}${cleanedInput}`;

      // Build prompt
      const roastTargets = [...mentionedUsers.values()].map(u => u.username).join(', ');
      const systemPrompt = buildMBellaSystemPrompt({
        isRoast: (shouldRoast && !isRoastingBot),
        isRoastingBot,
        roastTargets,
        currentMode,
        recentContext: awarenessContext
      });

      // Temperature tuned higher for playful variance
      let temperature = 0.85;
      if (currentMode === 'villain') temperature = 0.6;
      if (currentMode === 'motivator') temperature = 0.9;

      // Groq call
      const groqTry = await groqWithDiscovery(systemPrompt, cleanedInput, temperature);

      if (!groqTry || groqTry.error) {
        console.error('❌ (MBella) network error:', groqTry?.error?.message || 'unknown');
        try { await message.reply('⚠️ MBella lag spike. One breath, one rep. ⏱️'); } catch {}
        return;
      }
      if (!groqTry.res.ok) {
        let hint = '⚠️ MBella jammed the rep rack (API). Try again shortly. 🏋️‍♀️';
        if (groqTry.res.status === 401 || groqTry.res.status === 403) {
          hint = (message.author.id === process.env.BOT_OWNER_ID)
            ? '⚠️ MBella auth error (401/403). Verify GROQ_API_KEY & project/model access.'
            : '⚠️ MBella auth blip. Re-racking plates. 🏋️‍♀️';
        } else if (groqTry.res.status === 429) {
          hint = '⚠️ Rate limited. Tiny breather, then we glow up. ⏱️';
        } else if (groqTry.res.status === 400 || groqTry.res.status === 404) {
          hint = (message.author.id === process.env.BOT_OWNER_ID)
            ? '⚠️ Model issue. Set GROQ_MODEL or let auto-discovery handle it.'
            : '⚠️ Cloud hiccup. One more shot. ✨';
        } else if (groqTry.res.status >= 500) {
          hint = '⚠️ Cloud cramps (server error). Try again soon. ☁️';
        }
        console.error(`❌ (MBella) HTTP ${groqTry.res.status} on "${groqTry.model}": ${groqTry.bodyText?.slice(0, 400)}`);
        try { await message.reply(hint); } catch {}
        return;
      }

      const groqData = safeJsonParse(groqTry.bodyText);
      if (!groqData) {
        console.error('❌ (MBella) non-JSON body:', groqTry.bodyText?.slice(0, 300));
        try { await message.reply('⚠️ MBella static noise… say it simpler. 📻'); } catch {}
        return;
      }
      if (groqData.error) {
        console.error('❌ (MBella) API error:', groqData.error);
        const hint = (message.author.id === process.env.BOT_OWNER_ID)
          ? `⚠️ MBella Groq error: ${groqData.error?.message || 'unknown'}.`
          : '⚠️ MBella slipped on a peel (API). One sec. 🍌';
        try { await message.reply(hint); } catch {}
        return;
      }

      let aiReply = groqData.choices?.[0]?.message?.content?.trim() || '';

      // ❌ No add-on quotes on replies anymore
      // (quotes are sent only by the periodic scheduler above)

      // Build embed (MBella style)
      const embed = new EmbedBuilder()
        .setColor('#e84393')
        .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
        .setDescription(`💬 ${aiReply || '...'}`);

      // Typing delay (match MuscleMB defaults)
      const delayMs = Math.min((aiReply || '').length * MBELLA_MS_PER_CHAR, MBELLA_MAX_DELAY_MS);
      await new Promise(r => setTimeout(r, delayMs));

      let sent = null;
      try {
        sent = await sendViaWebhook(message.channel, {
          username: MBELLA_NAME,
          avatarURL: MBELLA_AVATAR_URL,
          embeds: [embed]
        });
      } catch {}

      if (!sent) {
        try { await message.reply({ embeds: [embed] }); } catch (err) {
          console.warn('❌ (MBella) send fallback error:', err.message);
          if (aiReply) { try { await message.reply(aiReply); } catch {} }
        }
      }

      // lock the conversation to this user so their replies keep the flow
      setBellaPartner(message.channel.id, message.author.id);

      markHandled(client, message.id);
    } catch (err) {
      console.error('❌ MBella listener error:', err?.stack || err?.message || String(err));
      try { await message.reply('⚠️ MBella pulled a hammy. BRB. 🦵'); } catch {}
    }
  });
};




