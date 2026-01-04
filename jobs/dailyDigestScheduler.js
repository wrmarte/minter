// jobs/dailyDigestScheduler.js
const { PermissionsBitField } = require("discord.js");
const { generateDailyDigest } = require("../services/dailyDigestService");

const timers = new Map(); // guildId -> timeout

// ===== Leader lock settings =====
// If multiple bot instances exist, only ONE should schedule + send digests.
const LEADER_LOCK_ENABLED = String(process.env.DAILY_DIGEST_LEADER_LOCK || "1").trim() === "1";
const LEADER_LOCK_KEY = "daily_digest_scheduler_leader";

// Extra local spam-guard (per process)
const RECENT_SEND_GUARD_MS = Number(process.env.DAILY_DIGEST_RECENT_GUARD_MS || (3 * 60 * 1000)); // 3 minutes
const lastRunByGuild = new Map(); // guildId -> { runKey, ts }

// Persistent send-once guard (survives restarts)
const RUNS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS daily_digest_runs (
  run_key     TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  tz          TEXT NOT NULL,
  hour        INT  NOT NULL,
  minute      INT  NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// Try to be precise to local time without external deps.
function tzPartsAt(tz, dateObj) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(dateObj);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Finds next local-time match (hour/minute) by scanning forward minute-by-minute.
 * ✅ FIX: start from the NEXT minute boundary (never “same minute” re-trigger)
 */
function nextRunDelayMs({ tz, hour, minute }) {
  const now = new Date();
  const targetH = Math.max(0, Math.min(23, Number(hour)));
  const targetM = Math.max(0, Math.min(59, Number(minute)));

  // Start from next minute boundary (plus a tiny offset)
  const msToNextMinute =
    (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 250;
  const base = new Date(now.getTime() + Math.max(250, msToNextMinute));

  for (let addMin = 0; addMin <= 48 * 60; addMin++) {
    const test = new Date(base.getTime() + addMin * 60_000);
    const tp = tzPartsAt(tz, test);
    if (tp.hour === targetH && tp.minute === targetM) {
      const delay = test.getTime() - now.getTime();
      return Math.max(5_000, delay);
    }
  }
  return 60 * 60_000; // fallback
}

async function loadEnabledSettings(pg) {
  const r = await pg.query(`SELECT * FROM daily_digest_settings WHERE enabled = TRUE`);
  return r.rows || [];
}

async function canSend(guild, channel) {
  try {
    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    if (!me || !channel) return false;

    return (
      channel.isTextBased?.() &&
      channel.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages)
    );
  } catch {
    return false;
  }
}

// ---- Advisory locks (Postgres) ----
// Uses int lock keys via hashtext(text)
async function tryAdvisoryLock(pg, keyText) {
  try {
    const r = await pg.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [String(keyText)]);
    return Boolean(r.rows?.[0]?.ok);
  } catch {
    return false;
  }
}

async function unlockAdvisory(pg, keyText) {
  try {
    await pg.query(`SELECT pg_advisory_unlock(hashtext($1))`, [String(keyText)]);
  } catch {}
}

// Persistent send-once guard
async function ensureRunsTable(pg) {
  try {
    await pg.query(RUNS_TABLE_SQL);
  } catch (e) {
    console.warn("[DAILY_DIGEST] failed to ensure daily_digest_runs table:", e?.message || e);
  }
}

async function claimRunKey(pg, runKey, meta) {
  // Insert once; if already exists, skip
  try {
    const r = await pg.query(
      `INSERT INTO daily_digest_runs (run_key, guild_id, channel_id, tz, hour, minute)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (run_key) DO NOTHING
       RETURNING run_key`,
      [
        runKey,
        String(meta.guild_id),
        String(meta.channel_id),
        String(meta.tz),
        Number(meta.hour),
        Number(meta.minute),
      ]
    );
    return Boolean(r.rowCount);
  } catch (e) {
    console.warn("[DAILY_DIGEST] claimRunKey failed:", e?.message || e);
    return false;
  }
}

function makeRunKey({ guildId, tz, hour, minute, dateObj }) {
  const p = tzPartsAt(tz, dateObj);
  // key is based on local date + scheduled HH:MM
  const ymd = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  return `${guildId}:${ymd}:${pad2(hour)}:${pad2(minute)}:${tz}`;
}

function recentlyRan(guildId, runKey) {
  const rec = lastRunByGuild.get(String(guildId));
  if (!rec) return false;
  if (rec.runKey === runKey) return true;
  if ((Date.now() - rec.ts) < RECENT_SEND_GUARD_MS) return true;
  return false;
}

function markRan(guildId, runKey) {
  lastRunByGuild.set(String(guildId), { runKey, ts: Date.now() });
}

async function runOnceForGuild(client, guildId) {
  const pg = client?.pg;
  if (!pg?.query) return;

  const sres = await pg.query(
    `SELECT * FROM daily_digest_settings WHERE guild_id = $1 LIMIT 1`,
    [String(guildId)]
  );
  const settings = sres.rows?.[0];
  if (!settings?.enabled) return;

  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) return;

  // fetch channel if not cached
  let channel =
    guild.channels.cache.get(String(settings.channel_id)) ||
    (await guild.channels.fetch(String(settings.channel_id)).catch(() => null));

  if (!channel || !(await canSend(guild, channel))) return;

  const tz = String(settings.tz || "UTC");
  const hour = Number(settings.hour ?? 21);
  const minute = Number(settings.minute ?? 0);

  // Build runKey first so both our in-memory guard + locks are tied to the scheduled window
  const runKey = makeRunKey({ guildId, tz, hour, minute, dateObj: new Date() });

  // ✅ In-process spam guard (covers weird edge cases)
  if (recentlyRan(guildId, runKey)) return;

  // ✅ Per-run advisory lock (locks THIS runKey across instances)
  const lockKey = `daily_digest_run:${runKey}`;
  const gotRunLock = await tryAdvisoryLock(pg, lockKey);
  if (!gotRunLock) {
    // Another instance is running the same digest window right now
    return;
  }

  try {
    // ✅ Persistent run claim (prevents repeats across restarts/instances)
    const claimed = await claimRunKey(pg, runKey, {
      guild_id: guildId,
      channel_id: settings.channel_id,
      tz,
      hour,
      minute,
    });

    if (!claimed) {
      // Already sent this digest window
      markRan(guildId, runKey);
      return;
    }

    const embed = await generateDailyDigest({
      pg,
      guild,
      settings,
      hours: 24,
    });

    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });

    markRan(guildId, runKey);
  } catch (e) {
    console.error(`[DAILY_DIGEST] run failed guild=${guildId}:`, e?.message || e);
  } finally {
    await unlockAdvisory(pg, lockKey);
  }
}

function clearGuildTimer(guildId) {
  const id = String(guildId);
  if (timers.has(id)) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  }
}

function scheduleGuild(client, settings) {
  const guildId = String(settings.guild_id);
  const tz = String(settings.tz || "UTC");
  const hour = Number(settings.hour ?? 21);
  const minute = Number(settings.minute ?? 0);

  clearGuildTimer(guildId);

  let delayMs = 60_000;
  try {
    delayMs = nextRunDelayMs({ tz, hour, minute });
  } catch {
    delayMs = 60 * 60_000;
  }

  const t = setTimeout(async () => {
    await runOnceForGuild(client, guildId);

    // Reload settings and reschedule
    try {
      const pg = client?.pg;
      if (pg?.query) {
        const r = await pg.query(
          `SELECT * FROM daily_digest_settings WHERE guild_id = $1 LIMIT 1`,
          [guildId]
        );
        const fresh = r.rows?.[0];
        if (fresh?.enabled) scheduleGuild(client, fresh);
        else clearGuildTimer(guildId);
      }
    } catch {
      // If reload fails, schedule again using current settings
      scheduleGuild(client, settings);
    }
  }, delayMs);

  timers.set(guildId, t);

  console.log(
    `[DAILY_DIGEST] scheduled guild=${guildId} tz=${tz} @ ${pad2(hour)}:${pad2(minute)} (in ~${Math.round(
      delayMs / 60000
    )}m)`
  );
}

async function startDailyDigestScheduler(client) {
  // ✅ process-level singleton guard
  if (client.__dailyDigestSchedulerStarted) {
    console.log("[DAILY_DIGEST] scheduler already started (skipping).");
    return;
  }
  client.__dailyDigestSchedulerStarted = true;

  const pg = client?.pg;
  if (!pg?.query) {
    console.warn("[DAILY_DIGEST] client.pg missing — scheduler not started.");
    return;
  }

  await ensureRunsTable(pg);

  // ✅ Leader lock to prevent multi-instance dupes
  if (LEADER_LOCK_ENABLED) {
    const gotLeader = await tryAdvisoryLock(pg, LEADER_LOCK_KEY);
    if (!gotLeader) {
      console.warn("[DAILY_DIGEST] leader lock not acquired — another instance is scheduler. Skipping start.");
      return;
    }
    console.log("[DAILY_DIGEST] leader lock acquired — scheduler is active on this instance.");
  }

  const settings = await loadEnabledSettings(pg);
  for (const s of settings) scheduleGuild(client, s);

  // expose helpers
  client.dailyDigestScheduler = {
    rescheduleGuild: async (guildId) => {
      const r = await pg.query(
        `SELECT * FROM daily_digest_settings WHERE guild_id = $1 LIMIT 1`,
        [String(guildId)]
      );
      const s = r.rows?.[0];
      if (s?.enabled) scheduleGuild(client, s);
      else clearGuildTimer(guildId);
    },
    runNow: async (guildId) => runOnceForGuild(client, guildId),
    stop: async () => {
      for (const [gid, t] of timers.entries()) {
        clearTimeout(t);
        timers.delete(gid);
      }
      if (LEADER_LOCK_ENABLED) await unlockAdvisory(pg, LEADER_LOCK_KEY);
    },
  };
}

module.exports = { startDailyDigestScheduler };

