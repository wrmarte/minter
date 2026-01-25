// listeners/musclemb/awarenessEngine.js
// ======================================================
// Awareness Engine (opt-in only)
// - Occasionally @mentions a user with a smart check-in
// - Uses DB memory (mb_user_state) to find inactive users
// - Hard guardrails: cooldowns + no mass pings + DB daily caps
// - Compatible with MemoryStore.getInactiveOptedInCandidates()
// ======================================================

const Config = require('./config');
const MemoryStore = require('./memoryStore');

const DEBUG = Boolean(Config.MB_AWARENESS_DEBUG);

function isEnabled() {
  return Boolean(Config.MB_AWARENESS_ENABLED);
}

function isoDayUTC() {
  // YYYY-MM-DD in UTC
  return new Date().toISOString().slice(0, 10);
}

function pickRandom(arr) {
  if (!arr?.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function msAgo(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return Infinity;
  return Date.now() - n;
}

function buildQuestion() {
  const pool = [
    "Where you been at? Drop a quick update 👀",
    "You still cooking… or did you ship it already? 📦",
    "Status check: we locked in or we ghosting? 💀",
    "Give me one win from this week. One. 🏆",
    "You alive? Say the word and I’ll spot you. 💪",
    "What’s the next move—smallest next step only. 🎯",
    "You still building that thing or did it become a ‘someday’? 😤",
  ];
  return pickRandom(pool) || "Status check. 👀";
}

// ------------------------------------------------------
// Optional in-process “burst” limiter
// (DB is the source of truth; this is just extra safety)
// ------------------------------------------------------
const burst = new Map(); // guildId -> ts
const BURST_MS = 45_000;

function burstGate(guildId) {
  const last = burst.get(guildId) || 0;
  const now = Date.now();
  if (now - last < BURST_MS) return false;
  burst.set(guildId, now);
  return true;
}

// ------------------------------------------------------
// DB Daily cap check (persistent across restarts)
// ------------------------------------------------------
async function canPingGuildToday_DB(client, guildId) {
  const cap = Number(Config.MB_AWARENESS_MAX_PER_GUILD_PER_DAY || 0);
  if (cap <= 0) return false;

  const today = isoDayUTC();
  const { dayDate, count } = await MemoryStore.getGuildDailyCount(client, guildId);

  const sameDay = String(dayDate || '').slice(0, 10) === today;
  const cur = sameDay ? Number(count || 0) : 0;

  if (DEBUG) {
    console.log(`[MB_AWARE] daily check guild=${guildId} day=${today} count=${cur}/${cap}`);
  }

  return cur < cap;
}

// ======================================================
// Build awareness ping candidate
// ======================================================
async function buildAwarenessPing(client, guild, channel) {
  try {
    if (!isEnabled()) return null;
    if (!client?.pg?.query) return null;
    if (!guild?.id || !channel?.id) return null;

    // chance gate
    const chance = Number(Config.MB_AWARENESS_CHANCE || 0);
    if (Math.random() > Math.max(0, Math.min(1, chance))) return null;

    // burst gate (extra safety)
    if (!burstGate(guild.id)) return null;

    // schema
    const ok = await MemoryStore.ensureSchema(client);
    if (!ok) return null;

    // DB daily cap
    const okCap = await canPingGuildToday_DB(client, guild.id);
    if (!okCap) return null;

    // Find inactive opted-in candidates (DB does heavy lift)
    const candidates = await MemoryStore.getInactiveOptedInCandidates(
      client,
      guild.id,
      Date.now(),
      Config.MB_AWARENESS_INACTIVE_MS,
      Config.MB_AWARENESS_PING_COOLDOWN_MS,
      25
    );

    if (!candidates.length) return null;

    // Pick one (oldest inactive first is already returned by MemoryStore)
    const chosen = candidates[0];
    if (!chosen?.userId) return null;

    // confirm member still exists in guild
    const member = await guild.members.fetch(chosen.userId).catch(() => null);
    if (!member) return null;

    const q = buildQuestion();
    const content = `🧠 <@${chosen.userId}> — ${q}`;

    // allow ping ONLY for that one user
    const allowedMentions = { parse: [], users: [chosen.userId] };

    if (DEBUG) {
      console.log(`[MB_AWARE] candidate guild=${guild.id} user=${chosen.userId} inactiveAgo=${msAgo(chosen.lastActiveTs)} pingAgo=${msAgo(chosen.lastPingTs)}`);
    }

    // IMPORTANT: do NOT mark pinged here anymore in the “new flow”.
    // The listener calls markAwarenessSent() after successful send.
    return { userId: chosen.userId, content, allowedMentions };
  } catch (e) {
    if (DEBUG) console.warn('⚠️ [MB_AWARE] buildAwarenessPing failed:', e?.message || String(e));
    return null;
  }
}

// ======================================================
// Mark awareness as sent (DB source of truth)
// - mark user pinged
// - increment guild daily count (persistent cap)
// ======================================================
async function markAwarenessSent(client, guildId, userId) {
  try {
    if (!client?.pg?.query) return false;
    if (!guildId || !userId) return false;

    const ok = await MemoryStore.ensureSchema(client);
    if (!ok) return false;

    const now = Date.now();

    // mark user ping ts
    await MemoryStore.markPinged(client, guildId, userId, now);

    // increment persistent daily counter
    const day = isoDayUTC();
    const inc = await MemoryStore.incrementGuildDaily(client, guildId, day);

    if (DEBUG) {
      console.log(`[MB_AWARE] marked sent guild=${guildId} user=${userId} ok=${inc?.ok} count=${inc?.count}`);
    }

    return true;
  } catch (e) {
    if (DEBUG) console.warn('⚠️ [MB_AWARE] markAwarenessSent failed:', e?.message || String(e));
    return false;
  }
}

module.exports = {
  isEnabled,
  buildAwarenessPing,
  markAwarenessSent,
};
