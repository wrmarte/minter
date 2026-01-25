// listeners/musclemb/awarenessEngine.js
// ======================================================
// Awareness Engine (opt-in only)
// - Occasionally @mentions a user with a smart check-in
// - Uses DB memory (mb_user_state) to find inactive users
// - Hard guardrails: cooldowns + no mass pings + safe channels
// ======================================================

const MemoryStore = require('./memoryStore');

const ENABLED = String(process.env.MB_AWARENESS_ENABLED || '0').trim() === '1';
const CHANCE = Math.max(0, Math.min(1, Number(process.env.MB_AWARENESS_CHANCE || '0.18'))); // 18% of periodic pings by default
const INACTIVE_MS = Math.max(60_000, Number(process.env.MB_AWARENESS_INACTIVE_MS || String(3 * 24 * 60 * 60 * 1000))); // 3 days
const PING_COOLDOWN_MS = Math.max(60_000, Number(process.env.MB_AWARENESS_PING_COOLDOWN_MS || String(5 * 24 * 60 * 60 * 1000))); // 5 days
const MAX_PER_GUILD_PER_DAY = Math.max(0, Number(process.env.MB_AWARENESS_MAX_PER_GUILD_PER_DAY || '2'));
const DEBUG = String(process.env.MB_AWARENESS_DEBUG || '').trim() === '1';

function isEnabled() {
  return ENABLED;
}

function pickRandom(arr) {
  if (!arr?.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

// simple per-process limiter (DB also tracks last_pinged)
const inMemoryGuildDaily = new Map(); // guildId -> { dayKey, count }

function canPingGuildToday(guildId) {
  if (MAX_PER_GUILD_PER_DAY <= 0) return false;
  const dayKey = new Date().toISOString().slice(0, 10);
  const cur = inMemoryGuildDaily.get(guildId);
  if (!cur || cur.dayKey !== dayKey) {
    inMemoryGuildDaily.set(guildId, { dayKey, count: 0 });
    return true;
  }
  return cur.count < MAX_PER_GUILD_PER_DAY;
}

function incrGuildToday(guildId) {
  const dayKey = new Date().toISOString().slice(0, 10);
  const cur = inMemoryGuildDaily.get(guildId);
  if (!cur || cur.dayKey !== dayKey) {
    inMemoryGuildDaily.set(guildId, { dayKey, count: 1 });
    return;
  }
  cur.count += 1;
  inMemoryGuildDaily.set(guildId, cur);
}

function msAgo(ts) {
  const t = ts ? new Date(ts).getTime() : 0;
  if (!t) return Infinity;
  return Date.now() - t;
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

async function buildAwarenessPing(client, guild, channel) {
  if (!ENABLED) return null;
  if (!client?.pg?.query) return null;

  // chance gate
  if (Math.random() > CHANCE) return null;

  // per-day limiter
  if (!canPingGuildToday(guild.id)) return null;

  const ok = await MemoryStore.ensureSchema(client);
  if (!ok) return null;

  let candidates = [];
  try {
    candidates = await MemoryStore.getOptedInCandidates(client, guild.id);
  } catch (e) {
    if (DEBUG) console.warn('⚠️ [MB_AWARE] candidates query failed:', e?.message || String(e));
    return null;
  }

  if (!candidates.length) return null;

  // filter: inactive threshold AND ping cooldown
  const filtered = candidates.filter(r => {
    const inactiveOk = msAgo(r.last_seen) >= INACTIVE_MS;
    const pingOk = msAgo(r.last_pinged) >= PING_COOLDOWN_MS;
    return inactiveOk && pingOk;
  });

  if (!filtered.length) return null;

  // pick one, ensure still in guild
  const chosen = pickRandom(filtered);
  if (!chosen?.user_id) return null;

  let member = null;
  try {
    member = await guild.members.fetch(chosen.user_id).catch(() => null);
  } catch {
    member = null;
  }
  if (!member) return null;

  // build ping message
  const q = buildQuestion();
  const mention = `<@${chosen.user_id}>`;

  // ✅ one user mention only
  const content = `🧠 ${mention} — ${q}`;
  const allowedMentions = { parse: [], users: [chosen.user_id] };

  // mark pinged (best effort)
  try { await MemoryStore.markPinged(client, guild.id, chosen.user_id); } catch {}
  incrGuildToday(guild.id);

  if (DEBUG) {
    console.log(`[MB_AWARE] pinged user=${chosen.user_id} guild=${guild.id} channel=${channel.id}`);
  }

  return { content, allowedMentions };
}

module.exports = {
  isEnabled,
  buildAwarenessPing,
};
