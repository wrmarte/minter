// listeners/musclemb.js
// ======================================================
// MuscleMB Listener (TRUE MODULAR VERSION)
// - Behavior preserved
// - Logic split into small editable modules
// ======================================================

const { EmbedBuilder } = require('discord.js'); // ✅ FIX: needed in this file

const Config = require('./musclemb/config');
const State = require('./musclemb/state');

const { isTypingSuppressed, markTypingSuppressed } = require('./musclemb/suppression');
const { safeSendChannel, safeReplyMessage, findSpeakableChannel } = require('./musclemb/messaging');

const { getRecentContext } = require('./musclemb/context');
const { isOwnerOrAdmin } = require('./musclemb/permissions');

const { groqWithDiscovery } = require('./musclemb/groq');

const { analyzeChannelMood, smartPick, optimizeQuoteText, formatNiceLine } = require('./musclemb/nicePings');

const AdrianChart = require('./musclemb/adrianChart');
const SweepReader = require('./musclemb/sweepReader');

// ===== Optional Groq "awareness" context (Discord message history) =====
const MB_GROQ_HISTORY_LIMIT = Math.max(0, Math.min(25, Number(process.env.MB_GROQ_HISTORY_LIMIT || '12'))); // fetch this many
const MB_GROQ_HISTORY_TURNS = Math.max(0, Math.min(16, Number(process.env.MB_GROQ_HISTORY_TURNS || '8'))); // keep this many (after filtering)
const MB_GROQ_HISTORY_MAX_CHARS = Math.max(120, Math.min(1200, Number(process.env.MB_GROQ_HISTORY_MAX_CHARS || '650'))); // per message
const MB_GROQ_DEBUG_CONTEXT = String(process.env.MB_GROQ_DEBUG_CONTEXT || '').trim() === '1';

module.exports = (client) => {
  /** 🔎 MBella-post detector: suppress MuscleMB in that channel for ~11s */
  client.on('messageCreate', (m) => {
    try {
      if (!m.guild) return;

      const fromWebhookBella = Boolean(m.webhookId) &&
        typeof m.author?.username === 'string' &&
        m.author.username.toLowerCase() === Config.MBELLA_NAME.toLowerCase();

      const fromEmbedBella = (m.author?.id === client.user.id) &&
        (m.embeds?.[0]?.author?.name || '').toLowerCase() === Config.MBELLA_NAME.toLowerCase();

      if (fromWebhookBella || fromEmbedBella) {
        markTypingSuppressed(client, m.channel.id, 11000);
      }
    } catch {}
  });

  /** Periodic nice pings */
  setInterval(async () => {
    const now = Date.now();
    const byGuild = new Map(); // guildId -> [{channelId, ts}]

    for (const [key, info] of State.lastActiveByUser.entries()) {
      const [guildId] = key.split(':');
      if (!byGuild.has(guildId)) byGuild.set(guildId, []);
      byGuild.get(guildId).push({ channelId: info.channelId, ts: info.ts });
    }

    for (const [guildId, entries] of byGuild.entries()) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      const lastPingTs = State.lastNicePingByGuild.get(guildId) || 0;
      if (now - lastPingTs < Config.NICE_PING_EVERY_MS) continue;

      const active = entries.filter(e => now - e.ts <= Config.NICE_ACTIVE_WINDOW_MS);
      if (!active.length) continue;

      const preferredChannel = active[0]?.channelId || null;
      const channel = findSpeakableChannel(guild, preferredChannel);
      if (!channel) continue;

      if (isTypingSuppressed(client, channel.id)) continue;

      let mood = { multipliers: {}, tags: [] };
      try { mood = await analyzeChannelMood(channel); } catch {}

      const last = State.lastQuoteByGuild.get(guildId) || null;

      const { text, category, meta } = smartPick({
        guildId,
        seed: `${guildId}:${now}:${Math.random()}`,
        avoidText: last?.text,
        avoidCategory: last?.category,
        moodMultipliers: mood.multipliers
      });

      const outLine = formatNiceLine(Config.MB_NICE_STYLE, { category, meta, moodTags: mood.tags }, text);

      try {
        const ok = await safeSendChannel(client, channel, {
          content: outLine,
          allowedMentions: { parse: [] },
          username: Config.MUSCLEMB_WEBHOOK_NAME,
          avatarURL: Config.MUSCLEMB_WEBHOOK_AVATAR || undefined,
        });

        if (ok) {
          State.lastNicePingByGuild.set(guildId, now);
          const stored = optimizeQuoteText(text);
          State.lastQuoteByGuild.set(guildId, { text: stored, category, ts: now });
        }
      } catch {}
    }
  }, Config.NICE_SCAN_EVERY_MS);

  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // Track activity
    State.lastActiveByUser.set(`${message.guild.id}:${message.author.id}`, {
      ts: Date.now(),
      channelId: message.channel.id,
    });

    const lowered = (message.content || '').toLowerCase();

    /** ===== $ADRIAN chart trigger (runs FIRST; bypasses typing suppression) ===== */
    try {
      if (AdrianChart.isTriggered(lowered)) {
        if (Config.ADRIAN_CHART_DEBUG) {
          console.log(`[ADRIAN_CHART] triggered by "${message.content}" in guild=${message.guild.id} channel=${message.channel.id}`);
        }

        const allowed = (!Config.ADRIAN_CHART_ADMIN_ONLY) || isOwnerOrAdmin(message);
        if (!allowed) {
          console.log(`[ADRIAN_CHART] denied (not admin/owner) user=${message.author.id} guild=${message.guild.id}`);
          if (Config.ADRIAN_CHART_DENY_REPLY) {
            await safeReplyMessage(client, message, {
              content: '⛔ Admin/Owner only: $ADRIAN chart.',
              allowedMentions: { parse: [] }
            }).catch(() => {});
          }
          return;
        }

        const key = `${message.guild.id}:${message.author.id}`;
        const lastTs = State.adrianChartCooldownByUser.get(key) || 0;
        const now = Date.now();
        const isOwner = Boolean(Config.BOT_OWNER_ID) && message.author.id === Config.BOT_OWNER_ID;

        if (!isOwner && now - lastTs < Config.ADRIAN_CHART_COOLDOWN_MS) return;
        State.adrianChartCooldownByUser.set(key, now);

        await AdrianChart.sendEmbed(message);
        return;
      }
    } catch (e) {
      console.warn('⚠️ adrian chart trigger failed:', e?.stack || e?.message || String(e));
    }

    // Suppression (MBella)
    if (isTypingSuppressed(client, message.channel.id)) return;

    // Don’t compete with MBella triggers
    if (Config.FEMALE_TRIGGERS.some(t => lowered.includes(t))) return;

    /** ===== Sweep reader ===== */
    try {
      if (SweepReader.isTriggered(lowered)) {
        const key = `${message.guild.id}:${message.author.id}`;
        const lastTs = State.sweepCooldownByUser.get(key) || 0;
        const now = Date.now();
        const isOwner = message.author.id === Config.BOT_OWNER_ID;

        if (!isOwner && now - lastTs < Config.SWEEP_COOLDOWN_MS) return;
        State.sweepCooldownByUser.set(key, now);

        const { source, snap } = await SweepReader.getSweepSnapshot(client, message.guild.id);
        if (!snap) {
          try {
            await safeReplyMessage(client, message, {
              content: '🧹 Sweep reader: no sweep-power stored yet. (Run the sweep tracker first.)',
              allowedMentions: { parse: [] }
            });
          } catch {}
          return;
        }

        await SweepReader.sendEmbed(message, snap, source);
        return;
      }
    } catch (e) {
      console.warn('⚠️ sweep reader failed:', e?.message || String(e));
    }

    // Main AI trigger gate
    const botMentioned = message.mentions.has(client.user);
    const hasTriggerWord = Config.TRIGGERS.some(trigger => lowered.includes(trigger));

    if (!hasTriggerWord && !botMentioned) return;
    if (message.mentions.everyone || message.mentions.roles.size > 0) return;

    // Mention handling + “roast the bot” detection
    const mentionedUsersAll = message.mentions.users || new Map();
    const mentionedOthers = mentionedUsersAll.filter(u => u.id !== client.user.id);
    const shouldRoastOthers = (hasTriggerWord || botMentioned) && mentionedOthers.size > 0;

    const roastKeywords = /\b(roast|trash|garbage|suck|weak|clown|noob|dumb|stupid|lame)\b|😂|🤣|💀/i;
    const isRoastingBot = botMentioned && mentionedOthers.size === 0 && roastKeywords.test(lowered);

    const isOwner = message.author.id === Config.BOT_OWNER_ID;
    if (State.cooldown.has(message.author.id) && !isOwner) return;
    State.cooldown.add(message.author.id);
    setTimeout(() => State.cooldown.delete(message.author.id), 10000);

    // Clean input
    let cleanedInput = (message.content || '').trim();

    for (const trigger of Config.TRIGGERS) {
      try { cleanedInput = cleanedInput.replaceAll(new RegExp(trigger, 'ig'), ''); } catch {}
      try { cleanedInput = cleanedInput.replaceAll(trigger, ''); } catch {}
    }

    try {
      message.mentions.users.forEach(user => {
        cleanedInput = cleanedInput.replaceAll(`<@${user.id}>`, '');
        cleanedInput = cleanedInput.replaceAll(`<@!${user.id}>`, '');
      });
    } catch {}

    cleanedInput = cleanedInput.replaceAll(`<@${client.user.id}>`, '').trim();

    let introLine = '';
    if (hasTriggerWord) {
      const found = Config.TRIGGERS.find(trigger => lowered.includes(trigger));
      introLine = found ? `Detected trigger word: "${found}". ` : '';
    } else if (botMentioned) {
      introLine = `You mentioned MuscleMB directly. `;
    }

    if (!cleanedInput) cleanedInput = shouldRoastOthers ? 'Roast these fools.' : 'Speak your alpha.';
    cleanedInput = `${introLine}${cleanedInput}`.trim();

    try {
      if (!isTypingSuppressed(client, message.channel.id)) {
        try { await message.channel.sendTyping(); } catch {}
      }

      const roastTargets = [...mentionedOthers.values()].map(u => u.username).join(', ');

      // Mode from DB
      let currentMode = 'default';
      try {
        if (client?.pg?.query) {
          const modeRes = await client.pg.query(
            `SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`,
            [message.guild.id]
          );
          currentMode = modeRes.rows[0]?.mode || 'default';
        }
      } catch {
        console.warn('⚠️ Failed to fetch mb_mode, using default.');
      }

      const recentContext = await getRecentContext(message);

      let systemPrompt = '';
      if (shouldRoastOthers) {
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

      const softGuard =
        'Be kind by default, avoid insults unless explicitly roasting. No private data. Keep it 1–2 short sentences.';
      const fullSystemPrompt = [systemPrompt, softGuard, recentContext].filter(Boolean).join('\n\n');

      let temperature = 0.7;
      if (currentMode === 'villain') temperature = 0.5;
      if (currentMode === 'motivator') temperature = 0.9;
      if (shouldRoastOthers) temperature = 0.85;
      if (isRoastingBot) temperature = 0.75;

      // ======================================================
      // ✅ NEW: Pass real Discord chat context via extraMessages
      // This is what makes Groq feel "aware" of the last messages.
      // - Excludes MBella posts + other bots
      // - Includes MuscleMB bot replies (client.user) as assistant
      // ======================================================
      let extraMessages = [];
      try {
        if (MB_GROQ_HISTORY_LIMIT > 0 && message.channel?.messages?.fetch) {
          const fetched = await message.channel.messages.fetch({ limit: MB_GROQ_HISTORY_LIMIT }).catch(() => null);
          const arr = fetched ? Array.from(fetched.values()) : [];

          const cleaned = arr
            .filter(m => m && m.id !== message.id)
            .filter(m => typeof m.content === 'string' && m.content.trim().length > 0)
            // drop other bots (but keep our own bot messages)
            .filter(m => (!m.author?.bot) || (m.author.id === client.user.id))
            // drop MBella webhook posts
            .filter(m => {
              const isWebhookBella = Boolean(m.webhookId) &&
                typeof m.author?.username === 'string' &&
                m.author.username.toLowerCase() === Config.MBELLA_NAME.toLowerCase();

              const isEmbedBella = (m.author?.id === client.user.id) &&
                (m.embeds?.[0]?.author?.name || '').toLowerCase() === Config.MBELLA_NAME.toLowerCase();

              return !(isWebhookBella || isEmbedBella);
            })
            // order oldest -> newest for chat history
            .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
            // map to OpenAI-style messages
            .map(m => {
              const isAssistant = (m.author?.id === client.user.id);
              const role = isAssistant ? 'assistant' : 'user';

              // Include username prefix for multi-user channel context (helps the model)
              const prefix = isAssistant ? '' : `${m.author?.username || 'User'}: `;
              const text = `${prefix}${m.content || ''}`.trim().slice(0, MB_GROQ_HISTORY_MAX_CHARS);

              return { role, content: text };
            });

          extraMessages = cleaned.slice(-MB_GROQ_HISTORY_TURNS);

          if (MB_GROQ_DEBUG_CONTEXT) {
            console.log(`[MB_GROQ_CONTEXT] guild=${message.guild.id} channel=${message.channel.id} extraMessages=${extraMessages.length}`);
          }
        }
      } catch (ctxErr) {
        if (MB_GROQ_DEBUG_CONTEXT) {
          console.warn('⚠️ MB_GROQ_CONTEXT build failed:', ctxErr?.message || String(ctxErr));
        }
        extraMessages = [];
      }

      // Optional cacheKey (safe even if your groq.js ignores it)
      const cacheKey = `${message.guild.id}:${message.channel.id}:${message.author.id}`;

      // ✅ IMPORTANT: call groqWithDiscovery with an options object (prevents max_tokens legacy issues)
      const groqTry = await groqWithDiscovery(fullSystemPrompt, cleanedInput, {
        temperature,
        extraMessages,
        cacheKey,
        // If you want longer "reasoning" replies, set via env MB_GROQ_MAX_TOKENS in groq.js.
        // maxTokens: 420,
      });

      if (!groqTry || groqTry.error) {
        console.error('❌ Groq fetch/network error (all models):', groqTry?.error?.message || 'unknown');
        try {
          await safeReplyMessage(client, message, {
            content: '⚠️ MB lag spike. One rep at a time—try again in a sec. ⏱️',
            allowedMentions: { parse: [] }
          });
        } catch {}
        return;
      }

      if (!groqTry.res.ok) {
        let hint = '⚠️ MB jammed the reps rack (API). Try again shortly. 🏋️';
        if (groqTry.res.status === 401 || groqTry.res.status === 403) {
          hint = (message.author.id === Config.BOT_OWNER_ID)
            ? '⚠️ MB auth error with Groq (401/403). Verify GROQ_API_KEY & project permissions.'
            : '⚠️ MB auth blip. Coach is reloading plates. 🏋️';
        } else if (groqTry.res.status === 429) {
          hint = '⚠️ Rate limited. Short breather—then we rip again. ⏱️';
        } else if (groqTry.res.status === 400 || groqTry.res.status === 404) {
          hint = (message.author.id === Config.BOT_OWNER_ID)
            ? `⚠️ Model issue (${groqTry.res.status}). Set GROQ_MODEL in Railway or rely on auto-discovery.`
            : '⚠️ MB switched plates. One more shot. 🏋️';
        } else if (groqTry.res.status >= 500) {
          hint = '⚠️ MB cloud cramps (server error). One more try soon. ☁️';
        }
        console.error(`❌ Groq HTTP ${groqTry.res.status} on "${groqTry.model}": ${groqTry.bodyText?.slice(0, 400)}`);
        try { await safeReplyMessage(client, message, { content: hint, allowedMentions: { parse: [] } }); } catch {}
        return;
      }

      const groqData = (() => {
        try { return JSON.parse(groqTry.bodyText); } catch { return null; }
      })();

      if (!groqData) {
        console.error('❌ Groq returned non-JSON/empty:', groqTry.bodyText?.slice(0, 300));
        try {
          await safeReplyMessage(client, message, {
            content: '⚠️ MB static noise… say that again or keep it simple. 📻',
            allowedMentions: { parse: [] }
          });
        } catch {}
        return;
      }

      if (groqData.error) {
        console.error('❌ Groq API error:', groqData.error);
        const hint = (message.author.id === Config.BOT_OWNER_ID)
          ? `⚠️ Groq error: ${groqData.error?.message || 'unknown'}. Check model access & payload size.`
          : '⚠️ MB slipped on a banana peel (API error). One sec. 🍌';
        try { await safeReplyMessage(client, message, { content: hint, allowedMentions: { parse: [] } }); } catch {}
        return;
      }

      const aiReplyRaw = groqData.choices?.[0]?.message?.content?.trim();
      const aiReply = (aiReplyRaw || '').slice(0, 1800).trim();

      if (aiReply?.length) {
        const modeColorMap = {
          chill: '#3498db',
          villain: '#8b0000',
          motivator: '#e67e22',
          default: '#9b59b6'
        };
        const embedColor = modeColorMap[currentMode] || '#9b59b6';

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

        const delayMs = Math.min(aiReply.length * Config.MB_MS_PER_CHAR, Config.MB_MAX_DELAY_MS);
        await new Promise(resolve => setTimeout(resolve, delayMs));

        try {
          await safeReplyMessage(client, message, { embeds: [embed], allowedMentions: { parse: [] } });
        } catch (err) {
          console.warn('❌ MuscleMB embed reply error:', err.message);
          try { await safeReplyMessage(client, message, { content: aiReply, allowedMentions: { parse: [] } }); } catch {}
        }
      } else {
        try {
          await safeReplyMessage(client, message, {
            content: '💬 (silent set) MB heard you but returned no sauce. Try again with fewer words.',
            allowedMentions: { parse: [] }
          });
        } catch {}
      }
    } catch (err) {
      console.error('❌ MuscleMB error:', err?.stack || err?.message || String(err));
      try {
        await safeReplyMessage(client, message, {
          content: '⚠️ MuscleMB pulled a hammy 🦵. Try again soon.',
          allowedMentions: { parse: [] }
        });
      } catch (fallbackErr) {
        console.warn('❌ Fallback send error:', fallbackErr.message);
      }
    }
  });
};

