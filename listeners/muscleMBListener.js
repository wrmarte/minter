// listeners/muscleMBListener.js
// ======================================================
// MuscleMB Listener (TRUE MODULAR VERSION)
// - Behavior preserved
// - Logic split into small editable modules
// - ✅ DB memory + awareness pings + multi-model routing (optional)
// - ✅ Profile memory injection (admin-curated facts + timestamped notes + tags)
// - ✅ Injects opt-in + last active snapshot (lightweight)
// - ✅ Safe attach guard (prevents duplicate event listeners if required twice)
// - ✅ Profile schema guard (prevents repeated CREATE TABLE checks)
// ======================================================

const { EmbedBuilder } = require('discord.js');

const Config = require('./musclemb/config');
const State = require('./musclemb/state');

const { isTypingSuppressed, markTypingSuppressed } = require('./musclemb/suppression');
const { safeSendChannel, safeReplyMessage, findSpeakableChannel } = require('./musclemb/messaging');

const { getRecentContext } = require('./musclemb/context');
const { isOwnerOrAdmin } = require('./musclemb/permissions');

const { groqWithDiscovery } = require('./musclemb/groq');

const {
  analyzeChannelMood,
  smartPick,
  optimizeQuoteText,
  formatNiceLine
} = require('./musclemb/nicePings');

const AdrianChart = require('./musclemb/adrianChart');
const SweepReader = require('./musclemb/sweepReader');

// ✅ Memory + Awareness + Model router
const MemoryStore = require('./musclemb/memoryStore');
const Awareness = require('./musclemb/awarenessEngine');
const ModelRouter = require('./musclemb/modelRouter');

// ✅ Profile Memory (facts + notes + tags)
const ProfileStore = require('./musclemb/profileStore');

// ===== Optional Groq "awareness" context (Discord message history) =====
const MB_GROQ_HISTORY_LIMIT = Math.max(0, Math.min(25, Number(process.env.MB_GROQ_HISTORY_LIMIT || '12'))); // fetch this many
const MB_GROQ_HISTORY_TURNS = Math.max(0, Math.min(16, Number(process.env.MB_GROQ_HISTORY_TURNS || '8'))); // keep this many (after filtering)
const MB_GROQ_HISTORY_MAX_CHARS = Math.max(120, Math.min(1200, Number(process.env.MB_GROQ_HISTORY_MAX_CHARS || '650'))); // per message
const MB_GROQ_DEBUG_CONTEXT = String(process.env.MB_GROQ_DEBUG_CONTEXT || '').trim() === '1';

// ======================================================
// ✅ Typing indicator control
// Default OFF to prevent lingering bubble.
// ======================================================
const MB_TYPING_ENABLED = String(process.env.MB_TYPING_ENABLED || '').trim() === '1';

// ======================================================
// ✅ FOLLOW-UP MODE (fixes "I replied to MB and it ignored me")
// - If user replies to a MuscleMB message OR speaks again within window,
//   treat it as continuation even without trigger word/mention.
// ======================================================
const MB_FOLLOWUP_ENABLED = String(process.env.MB_FOLLOWUP_ENABLED || '1').trim() === '1';
const MB_FOLLOWUP_WINDOW_MS = Math.max(10_000, Math.min(180_000, Number(process.env.MB_FOLLOWUP_WINDOW_MS || '60000')));

// ======================================================
// ✅ Cooldown tuning
// - Default was hard 10s. Keep, but allow follow-ups to bypass.
// ======================================================
const MB_COOLDOWN_MS = Math.max(1500, Math.min(30_000, Number(process.env.MB_COOLDOWN_MS || '10000')));

// ======================================================
// Debug toggles
// ======================================================
const MB_PROFILE_DEBUG = String(process.env.MB_PROFILE_DEBUG || (Config.MB_PROFILE_DEBUG ? '1' : '0')).trim() === '1';
const MB_FOLLOWUP_DEBUG = String(process.env.MB_FOLLOWUP_DEBUG || '0').trim() === '1';

function logFollowup(...args) { if (MB_FOLLOWUP_DEBUG) console.log('[MB_FOLLOWUP]', ...args); }
function logProfile(...args) { if (MB_PROFILE_DEBUG) console.log('[MB_PROFILE]', ...args); }

// ======================================================
// ✅ Mention humanizer (shows names but prevents pings)
// ======================================================
function humanizeMentions(text, msg) {
  let out = String(text || '');

  out = out.replace(/@everyone/g, '@ everyone').replace(/@here/g, '@ here');

  out = out.replace(/<#!?(\d+)>|<#(\d+)>/g, (m, a, b) => {
    const id = a || b;
    const ch = msg?.guild?.channels?.cache?.get(id) || msg?.client?.channels?.cache?.get(id);
    if (ch?.name) return `#${ch.name}`;
    return '#channel';
  });

  out = out.replace(/<@&(\d+)>/g, (m, id) => {
    const role = msg?.guild?.roles?.cache?.get(id);
    if (role?.name) return `@${role.name}`;
    return '@role';
  });

  out = out.replace(/<@!?(\d+)>/g, (m, id) => {
    const u =
      msg?.mentions?.users?.get?.(id) ||
      msg?.client?.users?.cache?.get?.(id) ||
      null;

    const member = msg?.guild?.members?.cache?.get?.(id) || null;

    const name = member?.displayName || u?.username || (id ? `user-${String(id).slice(-4)}` : 'user');
    return `@${name}`;
  });

  return out;
}

// ======================================================
// ✅ Compact state line for memory prompt injection
// ======================================================
function fmtRel(ts) {
  try {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const sec = Math.floor(n / 1000);
    return `<t:${sec}:R>`;
  } catch {
    return '';
  }
}

function safeNameFromMessage(message, userId, fallback = null) {
  try {
    const member = message?.guild?.members?.cache?.get?.(userId);
    if (member?.displayName) return member.displayName;
  } catch {}
  try {
    const u = message?.client?.users?.cache?.get?.(userId);
    if (u?.username) return u.username;
  } catch {}
  return fallback || (userId ? `user-${String(userId).slice(-4)}` : 'User');
}

// ======================================================
// ✅ Build profile memory block to inject into system prompt
// - Adds owner/admin override for author if opt-in is required
// ======================================================
async function buildProfileMemoryBlock(client, message) {
  try {
    if (!Config.MB_PROFILE_MEMORY_ENABLED) return '';
    if (!client?.pg?.query) return '';

    const guildId = message.guild.id;

    if (!client.__mbProfileSchemaReady) {
      await ProfileStore.ensureSchema(client);
      client.__mbProfileSchemaReady = true;
    }

    const authorId = message.author.id;

    // Optional: require opt-in before using memory (paranoid mode)
    if (Config.MB_PROFILE_REQUIRE_OPTIN) {
      const ok = await MemoryStore.userIsOptedIn(client, guildId, authorId);

      // ✅ Owner/Admin override for *author only* so you can debug / run your bot without needing opt-in toggles
      const authorIsAdmin = Boolean(isOwnerOrAdmin(message));
      if (!ok && !authorIsAdmin) {
        if (MB_PROFILE_DEBUG) logProfile(`author opted_out guild=${guildId} user=${authorId} (require optin=true)`);
        return '';
      }
      if (!ok && authorIsAdmin) {
        if (MB_PROFILE_DEBUG) logProfile(`author opted_out but admin override guild=${guildId} user=${authorId}`);
      }
    }

    const [authorFacts, authorNotes, authorTags, authorState] = await Promise.all([
      ProfileStore.getFacts(client, guildId, authorId),
      ProfileStore.getNotes(client, guildId, authorId, Config.MB_PROFILE_MAX_NOTES),
      (typeof ProfileStore.getTags === 'function')
        ? ProfileStore.getTags(client, guildId, authorId, 20)
        : Promise.resolve([]),
      (typeof MemoryStore.getUserState === 'function')
        ? MemoryStore.getUserState(client, guildId, authorId)
        : Promise.resolve(null),
    ]);

    // Mentioned user (optional — only if exactly 1 other user mentioned)
    let mentionedBlock = null;
    try {
      const mentionedOthers = (message.mentions?.users || new Map())
        .filter(u => u.id !== message.client.user.id);

      if (mentionedOthers.size === 1) {
        const u = [...mentionedOthers.values()][0];

        if (Config.MB_PROFILE_REQUIRE_OPTIN) {
          const ok2 = await MemoryStore.userIsOptedIn(client, guildId, u.id);
          if (!ok2) {
            mentionedBlock = null;
          } else {
            const [mf, mn, mt, ms] = await Promise.all([
              ProfileStore.getFacts(client, guildId, u.id),
              ProfileStore.getNotes(client, guildId, u.id, Math.min(2, Config.MB_PROFILE_MAX_NOTES)),
              (typeof ProfileStore.getTags === 'function')
                ? ProfileStore.getTags(client, guildId, u.id, 20)
                : Promise.resolve([]),
              (typeof MemoryStore.getUserState === 'function')
                ? MemoryStore.getUserState(client, guildId, u.id)
                : Promise.resolve(null),
            ]);
            mentionedBlock = { userId: u.id, username: u.username, facts: mf, notes: mn, tags: mt, state: ms };
          }
        } else {
          const [mf, mn, mt, ms] = await Promise.all([
            ProfileStore.getFacts(client, guildId, u.id),
            ProfileStore.getNotes(client, guildId, u.id, Math.min(2, Config.MB_PROFILE_MAX_NOTES)),
            (typeof ProfileStore.getTags === 'function')
              ? ProfileStore.getTags(client, guildId, u.id, 20)
              : Promise.resolve([]),
            (typeof MemoryStore.getUserState === 'function')
              ? MemoryStore.getUserState(client, guildId, u.id)
              : Promise.resolve(null),
          ]);
          mentionedBlock = { userId: u.id, username: u.username, facts: mf, notes: mn, tags: mt, state: ms };
        }
      }
    } catch {}

    const parts = [];

    const authorName = safeNameFromMessage(message, authorId, message.author?.username || 'User');

    // ✅ These formatters live in ProfileStore; if they return empty, memory looks "missing"
    const authorSummary = ProfileStore.formatFactsInline(authorFacts, Config.MB_PROFILE_MAX_KEYS);
    const authorNotesTxt = ProfileStore.formatNotesInline(authorNotes, Config.MB_PROFILE_MAX_NOTES);
    const authorTagsTxt = (typeof ProfileStore.formatTagsInline === 'function')
      ? ProfileStore.formatTagsInline(authorTags, 10)
      : '';

    const authorOpt = authorState?.opted_in != null ? Boolean(authorState.opted_in) : null;
    const authorLast = authorState?.last_active_ts ? fmtRel(authorState.last_active_ts) : '';

    const authorLines = [];
    if (authorSummary) authorLines.push(authorSummary);
    if (authorTagsTxt) authorLines.push(`tags=[${authorTagsTxt}]`);
    if (authorOpt !== null || authorLast) {
      const bits = [];
      if (authorOpt !== null) bits.push(`optin=${authorOpt ? 'on' : 'off'}`);
      if (authorLast) bits.push(`last_active=${authorLast}`);
      if (bits.length) authorLines.push(bits.join(', '));
    }

    if (authorLines.length || authorNotesTxt) {
      parts.push(`Trusted User Memory (admin-curated; use when relevant; never invent):`);
      if (authorLines.length) parts.push(`- ${authorName}: ${authorLines.join(' | ')}`);
      if (authorNotesTxt) parts.push(`- ${authorName} notes: ${authorNotesTxt}`);
    }

    if (mentionedBlock) {
      const mName = mentionedBlock.username || safeNameFromMessage(message, mentionedBlock.userId, null);
      const mSummary = ProfileStore.formatFactsInline(mentionedBlock.facts, Math.min(4, Config.MB_PROFILE_MAX_KEYS));
      const mNotes = ProfileStore.formatNotesInline(mentionedBlock.notes, 2);

      const mTagsTxt = (typeof ProfileStore.formatTagsInline === 'function')
        ? ProfileStore.formatTagsInline(mentionedBlock.tags, 8)
        : '';

      const mOpt = mentionedBlock.state?.opted_in != null ? Boolean(mentionedBlock.state.opted_in) : null;
      const mLast = mentionedBlock.state?.last_active_ts ? fmtRel(mentionedBlock.state.last_active_ts) : '';

      const mLines = [];
      if (mSummary) mLines.push(mSummary);
      if (mTagsTxt) mLines.push(`tags=[${mTagsTxt}]`);
      if (mOpt !== null || mLast) {
        const bits = [];
        if (mOpt !== null) bits.push(`optin=${mOpt ? 'on' : 'off'}`);
        if (mLast) bits.push(`last_active=${mLast}`);
        if (bits.length) mLines.push(bits.join(', '));
      }

      if (mLines.length) parts.push(`- Mentioned: ${mName}: ${mLines.join(' | ')}`);
      if (mNotes) parts.push(`- Mentioned notes: ${mNotes}`);
    }

    const block = parts.length ? parts.join('\n') : '';
    if (MB_PROFILE_DEBUG) logProfile(`block_len=${block.length} guild=${guildId} user=${authorId}`);
    return block;
  } catch (e) {
    if (MB_PROFILE_DEBUG) {
      console.warn('⚠️ [MB_PROFILE] build block failed:', e?.message || String(e));
    }
    return '';
  }
}

module.exports = (client) => {
  // ======================================================
  // ✅ Attach guard
  // ======================================================
  if (client.__muscleMBListenerAttached) {
    console.log('🟣 [MuscleMB] listener already attached — skipping duplicate attach');
    return;
  }
  client.__muscleMBListenerAttached = true;

  // Follow-up tracking map (user+channel -> last bot reply ts)
  if (!State.__mbLastReplyByUserChannel) State.__mbLastReplyByUserChannel = new Map();

  function followupKey(message) {
    return `${message.guild?.id || 'noguild'}:${message.channel?.id || 'noch'}:${message.author?.id || 'nouser'}`;
  }

  function isReplyToThisBot(message) {
    try {
      // discord.js sets repliedUser when the message is a reply
      const replied = message?.mentions?.repliedUser;
      if (replied && replied.id === client.user.id) return true;
    } catch {}
    // fallback: best-effort (some messages won’t have repliedUser hydrated)
    try {
      if (message?.reference?.messageId) {
        const mid = message.reference.messageId;
        const cached = message.channel?.messages?.cache?.get?.(mid);
        if (cached?.author?.id === client.user.id) return true;
      }
    } catch {}
    return false;
  }

  function isFollowupMessage(message) {
    if (!MB_FOLLOWUP_ENABLED) return false;

    // If user directly replied to MuscleMB message → always follow-up
    if (isReplyToThisBot(message)) return true;

    // If MuscleMB replied recently in this channel to this user → follow-up
    const k = followupKey(message);
    const last = State.__mbLastReplyByUserChannel.get(k) || 0;
    const ok = (Date.now() - last) <= MB_FOLLOWUP_WINDOW_MS;
    return ok;
  }

  // ======================================================
  // ✅ Always reply as MUSCLEMB identity (never MBella relay default)
  // + record reply timestamp for follow-up mode
  // ======================================================
  async function safeReplyAsMuscleMB(message, payload = {}) {
    try {
      const finalPayload = {
        ...payload,
        allowedMentions: payload.allowedMentions || { parse: [] },

        username: Config.MUSCLEMB_WEBHOOK_NAME,
        avatarURL: Config.MUSCLEMB_WEBHOOK_AVATAR || undefined,
      };

      const res = await safeReplyMessage(client, message, finalPayload);

      // Record follow-up window on successful send
      if (res) {
        try {
          const k = followupKey(message);
          State.__mbLastReplyByUserChannel.set(k, Date.now());
        } catch {}
      }

      return res;
    } catch {
      return false;
    }
  }

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

  /** Periodic nice pings (✅ now can also do awareness pings, opt-in only) */
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

      // ✅ awareness ping (opt-in only) sometimes replaces quote
      let didAwareness = false;
      if (Awareness.isEnabled()) {
        try {
          const awareness = await Awareness.buildAwarenessPing(client, guild, channel);
          if (awareness?.content) {
            const ok = await safeSendChannel(client, channel, {
              content: awareness.content,
              allowedMentions: awareness.allowedMentions || { parse: [] },
              username: Config.MUSCLEMB_WEBHOOK_NAME,
              avatarURL: Config.MUSCLEMB_WEBHOOK_AVATAR || undefined,
            });

            if (ok) {
              try { await Awareness.markAwarenessSent(client, guildId, awareness.userId); } catch {}
              State.lastNicePingByGuild.set(guildId, now);
              didAwareness = true;
            }
          }
        } catch {}
      }

      if (didAwareness) continue;

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

    // ✅ lightweight memory log (won’t crash if pg missing)
    try { await MemoryStore.trackActivity(client, message); } catch {}

    State.lastActiveByUser.set(`${message.guild.id}:${message.author.id}`, {
      ts: Date.now(),
      channelId: message.channel.id,
    });

    const lowered = (message.content || '').toLowerCase();

    /** ===== $ADRIAN chart trigger ===== */
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

    if (isTypingSuppressed(client, message.channel.id)) return;
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

    // ======================================================
    // ✅ Main AI trigger gate + Follow-up override
    // ======================================================
    const botMentioned = message.mentions.has(client.user);
    const hasTriggerWord = Config.TRIGGERS.some(trigger => lowered.includes(trigger));
    const isFollowup = isFollowupMessage(message);

    if (!hasTriggerWord && !botMentioned && !isFollowup) return;

    if (MB_FOLLOWUP_DEBUG && isFollowup && !hasTriggerWord && !botMentioned) {
      logFollowup(`followup accepted guild=${message.guild.id} channel=${message.channel.id} user=${message.author.id}`);
    }

    if (message.mentions.everyone || message.mentions.roles.size > 0) return;

    const mentionedUsersAll = message.mentions.users || new Map();
    const mentionedOthers = mentionedUsersAll.filter(u => u.id !== client.user.id);
    const shouldRoastOthers = (hasTriggerWord || botMentioned) && mentionedOthers.size > 0;

    const roastKeywords = /\b(roast|trash|garbage|suck|weak|clown|noob|dumb|stupid|lame)\b|😂|🤣|💀/i;
    const isRoastingBot = botMentioned && mentionedOthers.size === 0 && roastKeywords.test(lowered);

    const isOwner = message.author.id === Config.BOT_OWNER_ID;

    // Cooldown: allow follow-ups to bypass (fixes "I asked again and nothing happened")
    if (!isFollowup && State.cooldown.has(message.author.id) && !isOwner) return;
    State.cooldown.add(message.author.id);
    setTimeout(() => State.cooldown.delete(message.author.id), MB_COOLDOWN_MS);

    // Clean input
    let cleanedInput = (message.content || '').trim();

    // Only strip triggers when they were used (don’t mangle follow-up messages)
    if (hasTriggerWord) {
      for (const trigger of Config.TRIGGERS) {
        try { cleanedInput = cleanedInput.replaceAll(new RegExp(trigger, 'ig'), ''); } catch {}
        try { cleanedInput = cleanedInput.replaceAll(trigger, ''); } catch {}
      }
    }

    try {
      message.mentions.users.forEach(user => {
        cleanedInput = cleanedInput.replaceAll(`<@${user.id}>`, '');
        cleanedInput = cleanedInput.replaceAll(`<@!${user.id}>`, '');
      });
    } catch {}

    cleanedInput = cleanedInput.replaceAll(`<@${client.user.id}>`, '').trim();

    let introLine = '';
    if (isFollowup && !hasTriggerWord && !botMentioned) {
      introLine = 'Follow-up: ';
    } else if (hasTriggerWord) {
      const found = Config.TRIGGERS.find(trigger => lowered.includes(trigger));
      introLine = found ? `Detected trigger word: "${found}". ` : '';
    } else if (botMentioned) {
      introLine = `You mentioned MuscleMB directly. `;
    }

    if (!cleanedInput) cleanedInput = shouldRoastOthers ? 'Roast these fools.' : 'Speak your alpha.';
    cleanedInput = `${introLine}${cleanedInput}`.trim();

    try {
      if (MB_TYPING_ENABLED && !isTypingSuppressed(client, message.channel.id)) {
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

      // ✅ Inject profile memory block (admin-curated) if enabled
      const profileBlock = await buildProfileMemoryBlock(client, message);

      // Put memory early so the model uses it
      const fullSystemPrompt = [systemPrompt, profileBlock, recentContext, softGuard]
        .filter(Boolean)
        .join('\n\n');

      let temperature = 0.7;
      if (currentMode === 'villain') temperature = 0.5;
      if (currentMode === 'motivator') temperature = 0.9;
      if (shouldRoastOthers) temperature = 0.85;
      if (isRoastingBot) temperature = 0.75;

      // ======================================================
      // ✅ Pass real Discord chat context via extraMessages
      // ======================================================
      let extraMessages = [];
      try {
        if (MB_GROQ_HISTORY_LIMIT > 0 && message.channel?.messages?.fetch) {
          const fetched = await message.channel.messages.fetch({ limit: MB_GROQ_HISTORY_LIMIT }).catch(() => null);
          const arr = fetched ? Array.from(fetched.values()) : [];

          const cleaned = arr
            .filter(m => m && m.id !== message.id)
            .filter(m => typeof m.content === 'string' && m.content.trim().length > 0)
            .filter(m => (!m.author?.bot) || (m.author.id === client.user.id))
            .filter(m => {
              const isWebhookBella = Boolean(m.webhookId) &&
                typeof m.author?.username === 'string' &&
                m.author.username.toLowerCase() === Config.MBELLA_NAME.toLowerCase();

              const isEmbedBella = (m.author?.id === client.user.id) &&
                (m.embeds?.[0]?.author?.name || '').toLowerCase() === Config.MBELLA_NAME.toLowerCase();

              return !(isWebhookBella || isEmbedBella);
            })
            .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
            .map(m => {
              const isAssistant = (m.author?.id === client.user.id);
              const role = isAssistant ? 'assistant' : 'user';

              const prefix = isAssistant ? '' : `${m.author?.username || 'User'}: `;
              const raw = `${prefix}${m.content || ''}`.trim().slice(0, MB_GROQ_HISTORY_MAX_CHARS);

              const text = humanizeMentions(raw, m);
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

      const cacheKey = `${message.guild.id}:${message.channel.id}:${message.author.id}`;

      const useRouter = ModelRouter.isEnabled();

      let aiReplyRaw = null;

      if (useRouter) {
        const routed = await ModelRouter.generate({
          client,
          system: fullSystemPrompt,
          user: cleanedInput,
          temperature,
          extraMessages,
          cacheKey,
        });

        if (!routed?.ok) {
          const hint = routed?.hint || '⚠️ MB lag spike. One rep at a time—try again in a sec. ⏱️';
          try { await safeReplyAsMuscleMB(message, { content: hint, allowedMentions: { parse: [] } }); } catch {}
          return;
        }

        aiReplyRaw = String(routed.text || '').trim();
      } else {
        const groqTry = await groqWithDiscovery(fullSystemPrompt, cleanedInput, {
          temperature,
          extraMessages,
          cacheKey,
        });

        if (!groqTry || groqTry.error) {
          console.error('❌ Groq fetch/network error (all models):', groqTry?.error?.message || 'unknown');
          try {
            await safeReplyAsMuscleMB(message, {
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
          try { await safeReplyAsMuscleMB(message, { content: hint, allowedMentions: { parse: [] } }); } catch {}
          return;
        }

        const groqData = (() => {
          try { return JSON.parse(groqTry.bodyText); } catch { return null; }
        })();

        if (!groqData) {
          console.error('❌ Groq returned non-JSON/empty:', groqTry.bodyText?.slice(0, 300));
          try {
            await safeReplyAsMuscleMB(message, {
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
          try { await safeReplyAsMuscleMB(message, { content: hint, allowedMentions: { parse: [] } }); } catch {}
          return;
        }

        aiReplyRaw = groqData.choices?.[0]?.message?.content?.trim() || '';
      }

      const aiReplyHuman = humanizeMentions(aiReplyRaw || '', message);
      const aiReply = (aiReplyHuman || '').slice(0, 1800).trim();

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

        try {
          await safeReplyAsMuscleMB(message, { embeds: [embed], allowedMentions: { parse: [] } });
        } catch (err) {
          console.warn('❌ MuscleMB embed reply error:', err.message);
          try { await safeReplyAsMuscleMB(message, { content: aiReply, allowedMentions: { parse: [] } }); } catch {}
        }
      } else {
        try {
          await safeReplyAsMuscleMB(message, {
            content: '💬 (silent set) MB heard you but returned no sauce. Try again with fewer words.',
            allowedMentions: { parse: [] }
          });
        } catch {}
      }
    } catch (err) {
      console.error('❌ MuscleMB error:', err?.stack || err?.message || String(err));
      try {
        await safeReplyAsMuscleMB(message, {
          content: '⚠️ MuscleMB pulled a hammy 🦵. Try again soon.',
          allowedMentions: { parse: [] }
        });
      } catch (fallbackErr) {
        console.warn('❌ Fallback send error:', fallbackErr.message);
      }
    }
  });
};
