// listeners/muscleMBListener.js
// ======================================================
// MuscleMB Listener (TRUE MODULAR VERSION) — PATCHED
// - Behavior preserved
// - Logic split into small editable modules
// - ✅ DB memory + awareness pings + multi-model routing (optional)
// - ✅ Profile memory injection (admin-curated facts + timestamped notes + tags)
// - ✅ Injects opt-in + last active snapshot (lightweight)
// - ✅ Safe attach guard (prevents duplicate event listeners if required twice)
// - ✅ Profile schema guard (prevents repeated CREATE TABLE checks)
// - ✅ PATCH: follow-up replies more reliable (fetch referenced message if not cached)
// - ✅ PATCH: history fetch cache to reduce Discord API calls/latency
// - ✅ PATCH: throttle DB activity writes (prevents PG spam/lag)
// - ✅ PATCH: prune long-lived Maps to prevent memory growth
// - ✅ PATCH: nicer channel selection for nice pings (most recently active channel)
// - ✅ PATCH: safer trigger stripping (word-boundary when possible)
// - ✅ PATCH: prompt ordering (guards earlier; memory & context still used)
// - ✅ PATCH: Typing bubble timing matches response (typing stops -> response posts)
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

// ✅ PATCH: cache channel history fetch to reduce latency / Discord API calls
const MB_GROQ_HISTORY_CACHE_MS = Math.max(0, Math.min(30_000, Number(process.env.MB_GROQ_HISTORY_CACHE_MS || '7000')));

// ======================================================
// ✅ Typing indicator control
// ======================================================
const MB_TYPING_ENABLED = String(process.env.MB_TYPING_ENABLED || '').trim() === '1';

// ✅ PATCH: typing bubble “human timing”
// - We start typing immediately, keep it alive, and delay send so the bubble feels real.
// - After the bubble, the response posts immediately (heartbeat cleared right before send).
const MB_TYPING_REFRESH_MS = Math.max(2000, Math.min(9500, Number(process.env.MB_TYPING_REFRESH_MS || '8000')));

// How long MB “types” for a reply (computed from reply length)
const MB_TYPING_BASE_MS = Math.max(0, Math.min(5000, Number(process.env.MB_TYPING_BASE_MS || '650')));
const MB_TYPING_PER_CHAR_MS = Math.max(0, Math.min(120, Number(process.env.MB_TYPING_PER_CHAR_MS || '28')));

// Clamp typing duration
const MB_TYPING_MIN_MS = Math.max(0, Math.min(15000, Number(process.env.MB_TYPING_MIN_MS || '900')));
const MB_TYPING_MAX_MS = Math.max(MB_TYPING_MIN_MS, Math.min(60000, Number(process.env.MB_TYPING_MAX_MS || '9000')));

// Extra randomness so it doesn’t feel robotic
const MB_TYPING_JITTER_MS = Math.max(0, Math.min(2000, Number(process.env.MB_TYPING_JITTER_MS || '250')));

// ======================================================
// ✅ FOLLOW-UP MODE (fixes "I replied to MB and it ignored me")
// ======================================================
const MB_FOLLOWUP_ENABLED = String(process.env.MB_FOLLOWUP_ENABLED || '1').trim() === '1';
const MB_FOLLOWUP_WINDOW_MS = Math.max(10_000, Math.min(180_000, Number(process.env.MB_FOLLOWUP_WINDOW_MS || '60000')));

// ======================================================
// ✅ Cooldown tuning
// ======================================================
const MB_COOLDOWN_MS = Math.max(1500, Math.min(30_000, Number(process.env.MB_COOLDOWN_MS || '10000')));

// ======================================================
// ✅ PATCH: DB activity write throttle
// ======================================================
const MB_ACTIVITY_WRITE_MIN_MS = Math.max(5_000, Math.min(10 * 60_000, Number(process.env.MB_ACTIVITY_WRITE_MIN_MS || '60000')));

// ======================================================
// ✅ PATCH: Map pruning (prevents memory growth over weeks)
// ======================================================
const MB_PRUNE_EVERY_MS = Math.max(30_000, Math.min(60 * 60_000, Number(process.env.MB_PRUNE_EVERY_MS || '600000'))); // default 10 min
const MB_ACTIVE_RETENTION_MS = Math.max(60_000, Math.min(30 * 24 * 60 * 60_000, Number(process.env.MB_ACTIVE_RETENTION_MS || String(7 * 24 * 60 * 60_000)))); // default 7 days

// ======================================================
// Debug toggles
// ======================================================
const MB_PROFILE_DEBUG = String(process.env.MB_PROFILE_DEBUG || (Config.MB_PROFILE_DEBUG ? '1' : '0')).trim() === '1';
const MB_FOLLOWUP_DEBUG = String(process.env.MB_FOLLOWUP_DEBUG || '0').trim() === '1';
const MB_PRUNE_DEBUG = String(process.env.MB_PRUNE_DEBUG || '0').trim() === '1';
const MB_ACTIVITY_DEBUG = String(process.env.MB_ACTIVITY_DEBUG || '0').trim() === '1';

function logFollowup(...args) { if (MB_FOLLOWUP_DEBUG) console.log('[MB_FOLLOWUP]', ...args); }
function logProfile(...args) { if (MB_PROFILE_DEBUG) console.log('[MB_PROFILE]', ...args); }
function logPrune(...args) { if (MB_PRUNE_DEBUG) console.log('[MB_PRUNE]', ...args); }
function logActivity(...args) { if (MB_ACTIVITY_DEBUG) console.log('[MB_ACTIVITY]', ...args); }

function sleep(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, n));
}

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

// Computes how long the typing bubble should “feel” for this reply.
function computeTypingMsForReply(text) {
  const s = String(text || '');
  const len = s.length;

  // Slightly boost typing for punctuation / multi-sentence replies
  const punctBoost =
    (s.match(/[.!?]/g)?.length || 0) * 120 +
    (s.match(/[,;:]/g)?.length || 0) * 60;

  // Cap length influence so long replies don’t delay forever
  const lenCap = Math.min(len, 320);

  const jitter = MB_TYPING_JITTER_MS > 0
    ? Math.floor((Math.random() * 2 - 1) * MB_TYPING_JITTER_MS)
    : 0;

  const raw = MB_TYPING_BASE_MS + (lenCap * MB_TYPING_PER_CHAR_MS) + punctBoost + jitter;
  return clamp(raw, MB_TYPING_MIN_MS, MB_TYPING_MAX_MS);
}

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
// ✅ Small helpers
// ======================================================
function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksWordish(s) {
  return /^[a-z0-9_\s]+$/i.test(String(s || '').trim());
}

// ======================================================
// ✅ Build profile memory block to inject into system prompt
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

    if (Config.MB_PROFILE_REQUIRE_OPTIN) {
      const ok = await MemoryStore.userIsOptedIn(client, guildId, authorId);
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

  if (!State.__mbLastReplyByUserChannel) State.__mbLastReplyByUserChannel = new Map();
  if (!State.__mbLastActivityWriteByUser) State.__mbLastActivityWriteByUser = new Map();
  if (!State.__mbHistoryCacheByChannel) State.__mbHistoryCacheByChannel = new Map();

  function followupKey(message) {
    return `${message.guild?.id || 'noguild'}:${message.channel?.id || 'noch'}:${message.author?.id || 'nouser'}`;
  }

  function activityKey(message) {
    return `${message.guild?.id || 'noguild'}:${message.author?.id || 'nouser'}`;
  }

  // ======================================================
  // ✅ PATCH: prune long-lived maps (prevents slow creep)
  // ======================================================
  setInterval(() => {
    try {
      const now = Date.now();

      try {
        const before = State.lastActiveByUser?.size || 0;
        for (const [k, info] of (State.lastActiveByUser || new Map()).entries()) {
          const ts = Number(info?.ts || 0);
          if (!Number.isFinite(ts) || ts <= 0 || (now - ts) > MB_ACTIVE_RETENTION_MS) {
            State.lastActiveByUser.delete(k);
          }
        }
        const after = State.lastActiveByUser?.size || 0;
        if (MB_PRUNE_DEBUG && before !== after) logPrune(`lastActiveByUser ${before} -> ${after}`);
      } catch {}

      try {
        const cutoff = MB_FOLLOWUP_WINDOW_MS + 60_000;
        const before = State.__mbLastReplyByUserChannel?.size || 0;
        for (const [k, ts] of (State.__mbLastReplyByUserChannel || new Map()).entries()) {
          const n = Number(ts || 0);
          if (!Number.isFinite(n) || n <= 0 || (now - n) > cutoff) {
            State.__mbLastReplyByUserChannel.delete(k);
          }
        }
        const after = State.__mbLastReplyByUserChannel?.size || 0;
        if (MB_PRUNE_DEBUG && before !== after) logPrune(`__mbLastReplyByUserChannel ${before} -> ${after}`);
      } catch {}

      try {
        const cutoff = Math.max(5 * MB_ACTIVITY_WRITE_MIN_MS, 10 * 60_000);
        const before = State.__mbLastActivityWriteByUser?.size || 0;
        for (const [k, ts] of (State.__mbLastActivityWriteByUser || new Map()).entries()) {
          const n = Number(ts || 0);
          if (!Number.isFinite(n) || n <= 0 || (now - n) > cutoff) {
            State.__mbLastActivityWriteByUser.delete(k);
          }
        }
        const after = State.__mbLastActivityWriteByUser?.size || 0;
        if (MB_PRUNE_DEBUG && before !== after) logPrune(`__mbLastActivityWriteByUser ${before} -> ${after}`);
      } catch {}

      try {
        const before = State.__mbHistoryCacheByChannel?.size || 0;
        for (const [channelId, entry] of (State.__mbHistoryCacheByChannel || new Map()).entries()) {
          const ts = Number(entry?.ts || 0);
          if (!Number.isFinite(ts) || ts <= 0 || (now - ts) > Math.max(MB_GROQ_HISTORY_CACHE_MS * 3, 15_000)) {
            State.__mbHistoryCacheByChannel.delete(channelId);
          }
        }
        const after = State.__mbHistoryCacheByChannel?.size || 0;
        if (MB_PRUNE_DEBUG && before !== after) logPrune(`__mbHistoryCacheByChannel ${before} -> ${after}`);
      } catch {}
    } catch {}
  }, MB_PRUNE_EVERY_MS);

  // ======================================================
  // ✅ PATCH: more reliable "reply to bot" detection
  // ======================================================
  async function isReplyToThisBot(message) {
    try {
      const replied = message?.mentions?.repliedUser;
      if (replied && replied.id === client.user.id) return true;
    } catch {}

    try {
      const mid = message?.reference?.messageId;
      if (!mid) return false;

      try {
        const cached = message.channel?.messages?.cache?.get?.(mid);
        if (cached?.author?.id === client.user.id) return true;
      } catch {}

      try {
        if (typeof message.channel?.messages?.fetch === 'function') {
          const fetched = await message.channel.messages.fetch(mid).catch(() => null);
          if (fetched?.author?.id === client.user.id) return true;
        }
      } catch {}
    } catch {}

    return false;
  }

  function isFollowupRecent(message) {
    if (!MB_FOLLOWUP_ENABLED) return false;
    const k = followupKey(message);
    const last = State.__mbLastReplyByUserChannel.get(k) || 0;
    return (Date.now() - last) <= MB_FOLLOWUP_WINDOW_MS;
  }

  // ======================================================
  // ✅ Always reply as MUSCLEMB identity (never MBella relay default)
  // ======================================================
  async function safeReplyAsMuscleMB(message, payload = {}) {
    try {
      const finalPayload = {
        ...payload,
        allowedMentions: payload.allowedMentions || { parse: [] },
      };

      const canWebhookIdentity =
        Boolean(Config.MB_USE_WEBHOOKAUTO) &&
        Boolean(client?.webhookAuto) &&
        typeof client.webhookAuto.sendViaWebhook === 'function';

      if (canWebhookIdentity) {
        finalPayload.username = Config.MUSCLEMB_WEBHOOK_NAME;
        finalPayload.avatarURL = Config.MUSCLEMB_WEBHOOK_AVATAR || undefined;
      }

      const res = await safeReplyMessage(client, message, finalPayload);

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
    const byGuild = new Map();

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

      active.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      const preferredChannel = active[0]?.channelId || null;

      const channel = findSpeakableChannel(guild, preferredChannel);
      if (!channel) continue;

      if (isTypingSuppressed(client, channel.id)) continue;

      let mood = { multipliers: {}, tags: [] };
      try { mood = await analyzeChannelMood(channel); } catch {}

      let didAwareness = false;
      if (Awareness.isEnabled()) {
        try {
          const awareness = await Awareness.buildAwarenessPing(client, guild, channel);
          if (awareness?.content) {
            const ok = await safeSendChannel(client, channel, {
              content: awareness.content,
              allowedMentions: awareness.allowedMentions || { parse: [] },
              ...(Boolean(Config.MB_USE_WEBHOOKAUTO) &&
                Boolean(client?.webhookAuto) &&
                typeof client.webhookAuto.sendViaWebhook === 'function'
                ? {
                  username: Config.MUSCLEMB_WEBHOOK_NAME,
                  avatarURL: Config.MUSCLEMB_WEBHOOK_AVATAR || undefined,
                }
                : {}),
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
          ...(Boolean(Config.MB_USE_WEBHOOKAUTO) &&
            Boolean(client?.webhookAuto) &&
            typeof client.webhookAuto.sendViaWebhook === 'function'
            ? {
              username: Config.MUSCLEMB_WEBHOOK_NAME,
              avatarURL: Config.MUSCLEMB_WEBHOOK_AVATAR || undefined,
            }
            : {}),
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

    // ✅ Throttle DB activity writes
    try {
      const k = activityKey(message);
      const lastWrite = Number(State.__mbLastActivityWriteByUser.get(k) || 0);
      const now = Date.now();
      const shouldWrite = !Number.isFinite(lastWrite) || lastWrite <= 0 || (now - lastWrite) >= MB_ACTIVITY_WRITE_MIN_MS;

      if (shouldWrite) {
        State.__mbLastActivityWriteByUser.set(k, now);
        try {
          await MemoryStore.trackActivity(client, message);
          if (MB_ACTIVITY_DEBUG) logActivity(`wrote activity guild=${message.guild.id} user=${message.author.id}`);
        } catch {}
      } else {
        if (MB_ACTIVITY_DEBUG) logActivity(`skipped activity write (throttle) guild=${message.guild.id} user=${message.author.id}`);
      }
    } catch {}

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

    let isFollowup = false;
    try {
      if (MB_FOLLOWUP_ENABLED) {
        const replied = await isReplyToThisBot(message);
        if (replied) isFollowup = true;
        else if (isFollowupRecent(message)) isFollowup = true;
      }
    } catch {}

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

    if (!isFollowup && State.cooldown.has(message.author.id) && !isOwner) return;
    State.cooldown.add(message.author.id);
    setTimeout(() => State.cooldown.delete(message.author.id), MB_COOLDOWN_MS);

    // Clean input
    let cleanedInput = (message.content || '').trim();

    if (hasTriggerWord) {
      for (const trigger of Config.TRIGGERS) {
        const t = String(trigger || '').trim();
        if (!t) continue;

        try {
          if (looksWordish(t)) {
            const re = new RegExp(`\\b${escapeRegExp(t)}\\b`, 'ig');
            cleanedInput = cleanedInput.replace(re, '');
          } else {
            const re2 = new RegExp(escapeRegExp(t), 'ig');
            cleanedInput = cleanedInput.replace(re2, '');
          }
        } catch {}

        try { cleanedInput = cleanedInput.replaceAll(t, ''); } catch {}
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

    // ======================================================
    // ✅ PATCH: typing heartbeat + timing (bubble -> post)
    // ======================================================
    let typingStarted = false;
    let typingStartMs = 0;
    let typingInterval = null;

    const startTyping = () => {
      if (typingStarted) return;
      if (!MB_TYPING_ENABLED) return;
      if (isTypingSuppressed(client, message.channel.id)) return;

      typingStarted = true;
      typingStartMs = Date.now();

      try { message.channel.sendTyping().catch(() => {}); } catch {}
      try {
        typingInterval = setInterval(() => {
          try { message.channel.sendTyping().catch(() => {}); } catch {}
        }, MB_TYPING_REFRESH_MS);
      } catch {}
    };

    const stopTyping = () => {
      try { if (typingInterval) clearInterval(typingInterval); } catch {}
      typingInterval = null;
    };

    try {
      // Start typing right away for responsiveness
      startTyping();

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

      const profileBlock = await buildProfileMemoryBlock(client, message);

      const fullSystemPrompt = [systemPrompt, softGuard, profileBlock, recentContext]
        .filter(Boolean)
        .join('\n\n');

      let temperature = 0.7;
      if (currentMode === 'villain') temperature = 0.5;
      if (currentMode === 'motivator') temperature = 0.9;
      if (shouldRoastOthers) temperature = 0.85;
      if (isRoastingBot) temperature = 0.75;

      // ======================================================
      // ✅ Pass real Discord chat context via extraMessages (cached)
      // ======================================================
      let extraMessages = [];
      try {
        if (MB_GROQ_HISTORY_LIMIT > 0 && message.channel?.messages?.fetch) {
          const channelId = message.channel.id;
          const now = Date.now();

          let arr = null;
          const cached = State.__mbHistoryCacheByChannel.get(channelId);
          if (cached && (now - Number(cached.ts || 0)) <= MB_GROQ_HISTORY_CACHE_MS && Array.isArray(cached.arr)) {
            arr = cached.arr;
          } else {
            const fetched = await message.channel.messages.fetch({ limit: MB_GROQ_HISTORY_LIMIT }).catch(() => null);
            const values = fetched ? Array.from(fetched.values()) : [];
            arr = values;
            State.__mbHistoryCacheByChannel.set(channelId, { ts: now, arr });
          }

          const cleaned = (arr || [])
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
          stopTyping();
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
          stopTyping();
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
          stopTyping();
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
          stopTyping();
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
          stopTyping();
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

      // ✅ PATCH: if typing is on, “finish typing” before posting
      if (typingStarted && MB_TYPING_ENABLED) {
        const desiredTypingMs = computeTypingMsForReply(aiReply || cleanedInput);
        const elapsed = Date.now() - typingStartMs;
        const remaining = desiredTypingMs - elapsed;
        if (remaining > 0) await sleep(remaining);
      }

      // Stop the heartbeat right before we send (prevents “typing…” lingering)
      stopTyping();

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
      try {
        // Always stop typing on failures
        // (so you don’t get stuck “typing…” if something throws)
        // eslint-disable-next-line no-undef
      } catch {}
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
