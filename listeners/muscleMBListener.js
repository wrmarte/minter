const fetch = require('node-fetch');
const { EmbedBuilder, ChannelType, PermissionsBitField } = require('discord.js');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL_ENV = (process.env.GROQ_MODEL || '').trim();
const cooldown = new Set();
const TRIGGERS = ['musclemb', 'muscle mb', 'yo mb', 'mbbot', 'mb bro'];

/** ===== Activity tracker for periodic nice messages ===== */
const lastActiveByUser = new Map(); // key: `${guildId}:${userId}` -> { ts, channelId }
const lastNicePingByGuild = new Map(); // guildId -> ts
const NICE_PING_EVERY_MS = 4 * 60 * 60 * 1000; // 4 hours
const NICE_SCAN_EVERY_MS = 60 * 60 * 1000;     // scan hourly
const NICE_ACTIVE_WINDOW_MS = 45 * 60 * 1000;  // “active” = last 45 minutes

const NICE_LINES = [
  "hydrate, hustle, and be kind today 💧💪",
  "tiny reps compound. keep going, legend ✨",
  "your pace > perfect. 1% better is a W 📈",
  "posture check, water sip, breathe deep 🧘‍♂️",
  "you’re doing great. send a W to someone else too 🙌",
  "breaks are part of the grind — reset, then rip ⚡️",
  "stack small dubs; the big ones follow 🧱",
  "write it down, knock it out, fist bump later ✍️👊",
  "skip the scroll, ship the thing 📦",
  "mood follows motion — move first 🕺",
];

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

/** Lightweight recent context from channel (non-bot, short, last ~6 msgs) */
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
    const joined = lines.join('\n');
    // keep the prompt small even if we ever change fetch limit
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

/** Build Groq payload once (model injected later) */
function buildGroqBody(model, systemPrompt, userContent, temperature, maxTokens = 120) {
  // keep payload lean; trim user content hard just in case
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

/** Try Groq once with the provided model id */
async function groqOnce(model, systemPrompt, userContent, temperature) {
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

/** Try Groq with model fallback (ENV -> llama3-70b-8192 -> llama-3.1-70b-versatile) */
async function groqWithFallback(systemPrompt, userContent, temperature, authorId) {
  const modelsToTry = [];
  if (GROQ_MODEL_ENV) modelsToTry.push(GROQ_MODEL_ENV);
  modelsToTry.push('llama3-70b-8192', 'llama-3.1-70b-versatile');

  let last = null;
  for (const m of modelsToTry) {
    try {
      const r = await groqOnce(m, systemPrompt, userContent, temperature);
      if (!r.res.ok) {
        // Owner hint for obvious config issues
        if (r.res.status === 401 || r.res.status === 403) {
          r.ownerHint = '⚠️ MB auth error with Groq (401/403). Verify GROQ_API_KEY & project permissions.';
        } else if (r.res.status === 400 || r.res.status === 404) {
          r.ownerHint = `⚠️ Model issue (${r.res.status}). Set a valid GROQ_MODEL or try 'llama-3.1-70b-versatile'.`;
        }
        last = { model: m, ...r };
        console.error(`❌ Groq HTTP ${r.res.status} on model "${m}": ${r.bodyText?.slice(0, 400)}`);
        // If 400/404, try next model automatically
        if (r.res.status === 400 || r.res.status === 404) continue;
        // For other codes, break and surface
        break;
      } else {
        return { model: m, ...r };
      }
    } catch (e) {
      console.error(`❌ Groq fetch error on model "${m}":`, e.message);
      last = { model: m, error: e };
      // try next model
    }
  }
  return last;
}

module.exports = (client) => {
  /** Periodic nice pings (lightweight) */
  setInterval(async () => {
    const now = Date.now();
    const byGuild = new Map(); // guildId -> [{userId, channelId, ts}]
    for (const [key, info] of lastActiveByUser.entries()) {
      const [guildId, userId] = key.split(':');
      if (!byGuild.has(guildId)) byGuild.set(guildId, []);
      byGuild.get(guildId).push({ userId, channelId: info.channelId, ts: info.ts });
    }

    for (const [guildId, entries] of byGuild.entries()) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      const lastPingTs = lastNicePingByGuild.get(guildId) || 0;
      if (now - lastPingTs < NICE_PING_EVERY_MS) continue;

      const active = entries.filter(e => now - e.ts <= NICE_ACTIVE_WINDOW_MS);
      if (!active.length) continue;

      const targets = [pick(active)];
      if (active.length > 3 && Math.random() < 0.5) {
        let candidate = pick(active);
        let attempts = 0;
        while (attempts++ < 5 && targets.find(t => t.userId === candidate.userId)) {
          candidate = pick(active);
        }
        if (!targets.find(t => t.userId === candidate.userId)) targets.push(candidate);
      }

      const preferredChannel = targets[0]?.channelId || null;
      const channel = findSpeakableChannel(guild, preferredChannel);
      if (!channel) continue;

      const nice = pick(NICE_LINES);
      try {
        await channel.send(`✨ quick vibe check: ${nice}`);
        lastNicePingByGuild.set(guildId, now);
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

    const lowered = message.content.toLowerCase();
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

      // Add context & guardrails + brevity instruction
      const softGuard =
        'Be kind by default, avoid insults unless explicitly roasting. No private data. Keep it 1–2 short sentences.';
      const fullSystemPrompt = [systemPrompt, softGuard, recentContext].filter(Boolean).join('\n\n');

      let temperature = 0.7;
      if (currentMode === 'villain') temperature = 0.5;
      if (currentMode === 'motivator') temperature = 0.9;

      // ---- Groq with model fallback & clear diagnostics ----
      const groqTry = await groqWithFallback(fullSystemPrompt, cleanedInput, temperature, message.author.id);

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
          // Owner-only config hint for model issues
          if (message.author.id === process.env.BOT_OWNER_ID) {
            hint = `⚠️ Model issue (${groqTry.res.status}). Set GROQ_MODEL or try 'llama-3.1-70b-versatile'.`;
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

        const delayMs = Math.min(aiReply.length * 40, 5000);
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

