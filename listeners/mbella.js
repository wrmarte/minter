// listeners/mbella.js
const fetch = require('node-fetch');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');

/** ================= ENV & CONFIG ================= */
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL_ENV = (process.env.GROQ_MODEL || '').trim();

// Display config
const MBELLA_NAME = (process.env.MBELLA_NAME || 'MBella').trim();
// ⚠️ Use a DIRECT image URL (not an HTML page), e.g. https://iili.io/KnsvEAl.png
const MBELLA_AVATAR_URL = (process.env.MBELLA_AVATAR_URL || '').trim();

// Pace (match MuscleMB by default)
const MBELLA_MS_PER_CHAR = Number(process.env.MBELLA_MS_PER_CHAR || '40');     // 40ms/char
const MBELLA_MAX_DELAY_MS = Number(process.env.MBELLA_MAX_DELAY_MS || '5000'); // 5s cap
const MBELLA_DELAY_OFFSET_MS = Number(process.env.MBELLA_DELAY_OFFSET_MS || '150'); // small “land after thinking” offset

// Simulated typing: create a webhook placeholder only if LLM is slow
const MBELLA_TYPING_DEBOUNCE_MS = Number(process.env.MBELLA_TYPING_DEBOUNCE_MS || '1200');

// Ensure MBella sends only after at least this many ms have passed since main-bot sendTyping()
const MBELLA_TYPING_TARGET_MS = Number(process.env.MBELLA_TYPING_TARGET_MS || '9200'); // ~9.2s

// Behavior config
const COOLDOWN_MS = 10_000;
const FEMALE_TRIGGERS = ['mbella', 'mb ella', 'lady mb', 'queen mb', 'bella'];
const RELEASE_REGEX = /\b(stop|bye bella|goodbye bella|end chat|silence bella)\b/i;

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

// "current partner" cache
const BELLA_TTL_MS = 30 * 60 * 1000; // 30 mins
const bellaPartners = new Map(); // channelId -> { userId, expiresAt }
function setBellaPartner(channelId, userId, ttlMs = BELLA_TTL_MS) {
  bellaPartners.set(channelId, { userId, expiresAt: Date.now() + ttlMs });
}
function getBellaPartner(channelId) {
  const rec = bellaPartners.get(channelId);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) { bellaPartners.delete(channelId); return null; }
  return rec.userId;
}
function clearBellaPartner(channelId) { bellaPartners.delete(channelId); }

// 🔕 Cross-listener typing suppression (read/write shared map on client)
function setTypingSuppress(client, channelId, ms = 12000) {
  if (!client.__mbTypingSuppress) client.__mbTypingSuppress = new Map();
  const until = Date.now() + ms;
  client.__mbTypingSuppress.set(channelId, until);
  setTimeout(() => {
    const exp = client.__mbTypingSuppress.get(channelId);
    if (exp && exp <= Date.now()) client.__mbTypingSuppress.delete(channelId);
  }, ms + 500);
}

/** ================== UTILS ================== */
function safeJsonParse(text) { try { return JSON.parse(text); } catch { return null; } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  const size = (id) => { const m = id.match(/(\d+)\s*b|\b(\d+)[bB]\b|-(\d+)b/); return m ? parseInt(m[1] || m[2] || m[3] || '0', 10) : 0; };
  const ver  = (id) => { const m = id.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
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
  if (!GROQ_API_KEY || GROQ_API_KEY.trim().length < 10) return { error: new Error('Missing GROQ_API_KEY') };
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
  } catch { return ''; }
}

async function getReferenceSnippet(message) {
  const ref = message.reference;
  if (!ref?.messageId) return '';
  try {
    const referenced = await message.channel.messages.fetch(ref.messageId);
    const txt = (referenced?.content || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!txt) return '';
    return `You are replying to ${referenced.author?.username || 'someone'}: "${txt}"`;
  } catch { return ''; }
}

function canSendInChannel(guild, channel) {
  const me = guild.members.me;
  if (!me || !channel) return false;
  return channel.isTextBased?.() && channel.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages);
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

    // Refresh name/avatar so cached look stays current
    if (hook) {
      try {
        await hook.edit({
          name: 'MB Relay',
          avatar: MBELLA_AVATAR_URL || undefined
        });
      } catch {}
    }

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

// Send via webhook and return { hook, message }
async function sendViaWebhook(channel, { username, avatarURL, embeds, content }) {
  const hook = await getOrCreateWebhook(channel);
  if (!hook) return { hook: null, message: null };
  try {
    const message = await hook.send({
      username,
      avatarURL: avatarURL || undefined,
      embeds,
      content
    });
    return { hook, message };
  } catch {
    return { hook, message: null };
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
  } catch {}
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
    systemPrompt = `You are MBella — a sharp, seductive roastmistress. Roast these tagged degens: ${roastTargets}. Keep it witty and playful; never cruel. Punch up with humor and innuendo, not insults. 💋🔥`;
  } else if (isRoastingBot) {
    systemPrompt = `You are MBella — unbothered, clever, and dazzling. Someone tried to roast you; clap back with velvet-glove swagger, playful not mean. ✨`;
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

  const softGuard = 'Be kind by default; no slurs; no harassment. No explicit sexual content or graphic descriptions. Respect boundaries.';
  const convoNudge = 'After your main point, add one short flirty follow-up question to keep the conversation going.';

  return [systemPrompt, styleDeck, softGuard, convoNudge, recentContext || ''].filter(Boolean).join('\n\n');
}

/** ================== EXPORT LISTENER ================== */
module.exports = (client) => {
  // (Periodic 4h quotes removed)

  client.on('messageCreate', async (message) => {
    let typingTimer = null;      // debounce timer
    let placeholder = null;      // the temporary "..." webhook msg
    let placeholderHook = null;  // the webhook used to send it
    let typingStartMs = 0;       // when we sent main-bot sendTyping()

    const clearPlaceholderTimer = () => { if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; } };

    async function ensurePlaceholder(channel) {
      const { hook, message: ph } = await sendViaWebhook(channel, {
        username: MBELLA_NAME,
        avatarURL: MBELLA_AVATAR_URL,
        content: '…' // typing dots
      });
      placeholderHook = hook || null;
      placeholder = ph || null;
    }

    async function editPlaceholderToEmbed(embed, channel) {
      if (placeholder && placeholderHook) {
        try {
          await placeholderHook.editMessage(placeholder.id, { content: null, embeds: [embed] });
          return true;
        } catch (e) {
          try {
            const { message: fresh } = await sendViaWebhook(channel, {
              username: MBELLA_NAME,
              avatarURL: MBELLA_AVATAR_URL,
              embeds: [embed]
            });
            if (fresh) {
              try { await placeholderHook.deleteMessage(placeholder.id); } catch {}
              return true;
            }
          } catch {}
        }
      } else {
        try {
          const { message: finalMsg } = await sendViaWebhook(channel, {
            username: MBELLA_NAME,
            avatarURL: MBELLA_AVATAR_URL,
            embeds: [embed]
          });
          if (finalMsg) return true;
        } catch {}
      }
      return false;
    }

    try {
      if (message.author.bot || !message.guild) return;
      if (alreadyHandled(client, message.id)) return;

      const lowered = (message.content || '').toLowerCase();
      const hasFemaleTrigger = FEMALE_TRIGGERS.some(t => lowered.includes(t));
      const botMentioned = message.mentions.has(client.user);
      const hintedBella = /\bbella\b/.test(lowered);

      if (RELEASE_REGEX.test(message.content || '')) {
        clearBellaPartner(message.channel.id);
        return;
      }

      const replyingToMBella = await isReplyToMBella(message, client);
      const partnerId = getBellaPartner(message.channel.id);
      const replyAllowed = replyingToMBella && (!partnerId || partnerId === message.author.id);

      if (!hasFemaleTrigger && !(botMentioned && hintedBella) && !replyAllowed) return;
      if (message.mentions.everyone || message.mentions.roles.size > 0) return;

      const isOwner = message.author.id === process.env.BOT_OWNER_ID;
      const bypassCooldown = replyAllowed;
      if (!bypassCooldown) {
        if (cooldown.has(message.author.id) && !isOwner) return;
        cooldown.add(message.author.id);
        setTimeout(() => cooldown.delete(message.author.id), COOLDOWN_MS);
      }

      // Show main bot typing right away (single pulse) and remember when
      try { await message.channel.sendTyping(); } catch {}
      typingStartMs = Date.now();

      // Suppress MuscleMB typing spam (from other listener) during this turn
      setTypingSuppress(client, message.channel.id, 12000);

      // Debounce the webhook "…" placeholder — only if LLM is slow
      typingTimer = setTimeout(() => {
        ensurePlaceholder(message.channel).catch(() => {});
      }, MBELLA_TYPING_DEBOUNCE_MS);

      // Roast detection
      const mentionedUsers = message.mentions.users.filter(u => u.id !== client.user.id);
      const shouldRoast = (hasFemaleTrigger || (botMentioned && hintedBella) || replyAllowed) && mentionedUsers.size > 0;
      const isRoastingBot = shouldRoast && message.mentions.has(client.user) && mentionedUsers.size === 1 && message.mentions.has(client.user);

      // Mode from DB (reuse mb_modes)
      let currentMode = 'default';
      try {
        const modeRes = await client.pg.query(`SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`, [message.guild.id]);
        currentMode = modeRes.rows[0]?.mode || 'default';
      } catch { console.warn('⚠️ (MBella) failed to fetch mb_mode, using default.'); }

      // Awareness
      const [recentContext, referenceSnippet] = await Promise.all([ getRecentContext(message), getReferenceSnippet(message) ]);
      const awarenessContext = [recentContext, referenceSnippet].filter(Boolean).join('\n');

      // Clean input: remove triggers & mentions
      let cleanedInput = lowered;
      for (const t of FEMALE_TRIGGERS) cleanedInput = cleanedInput.replaceAll(t, '');
      message.mentions.users.forEach(user => {
        cleanedInput = cleanedInput.replaceAll(`<@${user.id}>`, '');
        cleanedInput = cleanedInput.replaceAll(`<@!${user.id}>`, '');
      });
      cleanedInput = cleanedInput.replaceAll(`<@${client.user.id}>`, '').trim();

      // Flavor intro
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

      let temperature = 0.85;
      if (currentMode === 'villain') temperature = 0.6;
      if (currentMode === 'motivator') temperature = 0.9;

      const groqTry = await groqWithDiscovery(systemPrompt, cleanedInput, temperature);

      // Stop the debounce timer if result returned fast
      clearPlaceholderTimer();

      if (!groqTry || groqTry.error) {
        console.error('❌ (MBella) network error:', groqTry?.error?.message || 'unknown');
        const embedErr = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription('⚠️ MBella lag spike. One breath, one rep. ⏱️');
        if (!(await editPlaceholderToEmbed(embedErr, message.channel))) {
          try { await message.reply({ embeds: [embedErr] }); } catch {}
        }
        return;
      }
      if (!groqTry.res.ok) {
        console.error(`❌ (MBella) HTTP ${groqTry.res.status} on "${groqTry.model}": ${groqTry.bodyText?.slice(0, 400)}`);
        let hint = '⚠️ MBella jammed the rep rack (API). Try again shortly. 🏋️‍♀️';
        if (groqTry.res.status === 401 || groqTry.res.status === 403) {
          hint = (message.author.id === process.env.BOT_OWNER_ID)
            ? '⚠️ MBella auth error (401/403). Verify GROQ_API_KEY & model access.'
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
        const embedErr = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription(hint);
        if (!(await editPlaceholderToEmbed(embedErr, message.channel))) {
          try { await message.reply({ embeds: [embedErr] }); } catch {}
        }
        return;
      }

      const groqData = safeJsonParse(groqTry.bodyText);
      if (!groqData || groqData.error) {
        console.error('❌ (MBella) API body error:', groqData?.error || groqTry.bodyText?.slice(0, 300));
        const embedErr = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription('⚠️ MBella static noise… say it simpler. 📻');
        if (!(await editPlaceholderToEmbed(embedErr, message.channel))) {
          try { await message.reply({ embeds: [embedErr] }); } catch {}
        }
        return;
      }

      let aiReply = groqData.choices?.[0]?.message?.content?.trim() || '';
      const embed = new EmbedBuilder()
        .setColor('#e84393')
        .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
        .setDescription(`💬 ${aiReply || '...'}`);

      // Natural pacing
      const plannedDelay = Math.min((aiReply || '').length * MBELLA_MS_PER_CHAR, MBELLA_MAX_DELAY_MS) + MBELLA_DELAY_OFFSET_MS;

      // Ensure total time since main-bot sendTyping() is at least MBELLA_TYPING_TARGET_MS
      const sinceTyping = typingStartMs ? (Date.now() - typingStartMs) : 0;
      const floorExtra = MBELLA_TYPING_TARGET_MS - sinceTyping;
      const finalDelay = Math.max(0, Math.max(plannedDelay, floorExtra));

      await sleep(finalDelay);

      // If placeholder exists, edit it to final embed; else send fresh embed now
      const edited = await editPlaceholderToEmbed(embed, message.channel);
      if (!edited) {
        try { await message.reply({ embeds: [embed] }); } catch (err) {
          console.warn('❌ (MBella) send fallback error:', err.message);
          if (aiReply) { try { await message.reply(aiReply); } catch {} }
        }
      }

      setBellaPartner(message.channel.id, message.author.id);
      markHandled(client, message.id);
    } catch (err) {
      clearPlaceholderTimer();
      console.error('❌ MBella listener error:', err?.stack || err?.message || String(err));
      try {
        const embedErr = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription('⚠️ MBella pulled a hammy. BRB. 🦵');
        if (placeholder && placeholderHook) {
          try { await placeholderHook.editMessage(placeholder.id, { content: null, embeds: [embedErr] }); } catch {}
        } else {
          await message.reply({ embeds: [embedErr] });
        }
      } catch {}
    }
  });
};

