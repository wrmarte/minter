// jobs/dailyDigestScheduler.js
const { PermissionsBitField } = require("discord.js");
const { generateDailyDigest } = require("../services/dailyDigestService");

const timers = new Map(); // guildId -> timeout

// ===== Leader lock settings =====
// If multiple bot instances exist, only ONE should schedule + send digests.
const LEADER_LOCK_ENABLED = String(process.env.DAILY_DIGEST_LEADER_LOCK || "1").trim() === "1";
const LEADER_LOCK_KEY = "daily_digest_scheduler_leader";

// ✅ NEW: retry leader lock (self-healing)
const LEADER_RETRY_MS = Number(process.env.DAILY_DIGEST_LEADER_RETRY_MS || 30000); // 30s

// Extra local spam-guard (per process)
const RECENT_SEND_GUARD_MS = Number(process.env.DAILY_DIGEST_RECENT_GUARD_MS || 3 * 60 * 1000); // 3 minutes
const lastRunByGuild = new Map(); // guildId -> { runKey, ts }

// ✅ NEW: catch-up window (restart-safe)
// If bot restarts within X minutes AFTER scheduled time, send immediately once.
const CATCHUP_MINUTES = Number(process.env.DAILY_DIGEST_CATCHUP_MINUTES || 10);

// ✅ NEW: debug logs
const DIGEST_DEBUG = String(process.env.DAILY_DIGEST_DEBUG || "").trim() === "1";

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

// ✅ Ensure settings table exists (prevents query failures on fresh DB)
const SETTINGS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS daily_digest_settings (
  guild_id        TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL,
  tz              TEXT NOT NULL DEFAULT 'UTC',
  hour            INTEGER NOT NULL DEFAULT 1,
  minute          INTEGER NOT NULL DEFAULT 0,
  hours_window    INTEGER NOT NULL DEFAULT 24,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS daily_digest_settings_enabled_idx
  ON daily_digest_settings (enabled);
`;

/* ===================== TIMEZONE HELPERS ===================== */

// Common aliases -> IANA timezones (DST-safe)
const TZ_ALIAS = {
  EST: "America/New_York",
  EDT: "America/New_York",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  MST: "America/Denver",
  MDT: "America/Denver",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  HST: "Pacific/Honolulu",
  AST: "America/Puerto_Rico",
};

function normalizeTz(tz) {
  const raw = String(tz || "").trim();
  if (!raw) return "UTC";
  const up = raw.toUpperCase();
  return TZ_ALIAS[up] || raw;
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function safeTimeZone(tz, guildIdForLog = "") {
  let t = normalizeTz(tz || "UTC");
  if (!isValidTimeZone(t)) {
    console.warn(`[DAILY_DIGEST] invalid tz "${tz}"${guildIdForLog ? ` for guild=${guildIdForLog}` : ""} — falling back to UTC`);
    t = "UTC";
  }
  return t;
}

/* ===================== LOCAL TIME PARTS ===================== */

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

function clampInt(n, min, max, d) {
  const x = Number(n);
  if (!Number.isFinite(x)) return d;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

/**
 * Finds next local-time match (hour/minute) by scanning forward minute-by-minute.
 * ✅ FIX: start from the NEXT minute boundary (never “same minute” re-trigger)
 */
function nextRunDelayMs({ tz, hour, minute }) {
  const now = new Date();
  const targetH = clampInt(hour, 0, 23, 0);
  const targetM = clampInt(minute, 0, 59, 0);

  // Start from next minute boundary (plus a tiny offset)
  const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 250;
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

/* ===================== DB LOADERS ===================== */

async function ensureSettingsTable(pg) {
  try {
    await pg.query(SETTINGS_TABLE_SQL);
  } catch (e) {
    console.warn("[DAILY_DIGEST] failed to ensure daily_digest_settings table:", e?.message || e);
  }
}

async function loadEnabledSettings(pg) {
  await ensureSettingsTable(pg);
  try {
    const r = await pg.query(`SELECT * FROM daily_digest_settings WHERE enabled = TRUE`);
    return r.rows || [];
  } catch (e) {
    console.warn("[DAILY_DIGEST] loadEnabledSettings failed:", e?.message || e);
    return [];
  }
}

/* ===================== PERMS ===================== */

async function canSend(guild, channel) {
  try {
    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    if (!me || !channel) return false;

    if (!channel.isTextBased?.()) return false;

    const perms = channel.permissionsFor(me);
    if (!perms) return false;

    return (
      perms.has(PermissionsBitField.Flags.ViewChannel) &&
      perms.has(PermissionsBitField.Flags.SendMessages) &&
      perms.has(PermissionsBitField.Flags.EmbedLinks)
    );
  } catch {
    return false;
  }
}

/* ===================== ADVISORY LOCKS ===================== */

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

/* ===================== RUN CLAIM TABLE ===================== */

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
  const h = clampInt(hour, 0, 23, 0);
  const m = clampInt(minute, 0, 59, 0);
  const ymd = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  return `${guildId}:${ymd}:${pad2(h)}:${pad2(m)}:${tz}`;
}

function recentlyRan(guildId, runKey) {
  const rec = lastRunByGuild.get(String(guildId));
  if (!rec) return false;
  if (rec.runKey === runKey) return true;
  if (Date.now() - rec.ts < RECENT_SEND_GUARD_MS) return true;
  return false;
}

function markRan(guildId, runKey) {
  lastRunByGuild.set(String(guildId), { runKey, ts: Date.now() });
}

/* ===================== DISCORD FETCH SAFE ===================== */

async function fetchGuildSafe(client, guildId) {
  const id = String(guildId);
  let guild = client.guilds.cache.get(id);
  if (guild) return guild;
  guild = await client.guilds.fetch(id).catch(() => null);
  return guild;
}

/* ===================== RUN ONCE ===================== */

async function runOnceForGuild(client, guildId, reason = "scheduled") {
  const pg = client?.pg;
  if (!pg?.query) return;

  let settings;
  try {
    const sres = await pg.query(`SELECT * FROM daily_digest_settings WHERE guild_id = $1 LIMIT 1`, [String(guildId)]);
    settings = sres.rows?.[0];
  } catch (e) {
    console.warn(`[DAILY_DIGEST] settings fetch failed guild=${guildId}:`, e?.message || e);
    return;
  }

  if (!settings?.enabled) {
    if (DIGEST_DEBUG) console.log(`[DAILY_DIGEST] skip guild=${guildId} (disabled/no settings)`);
    return;
  }

  const guild = await fetchGuildSafe(client, guildId);
  if (!guild) {
    console.warn(`[DAILY_DIGEST] skip guild=${guildId} (guild not found / not cached)`);
    return;
  }

  let channel =
    guild.channels.cache.get(String(settings.channel_id)) ||
    (await guild.channels.fetch(String(settings.channel_id)).catch(() => null));

  if (!channel) {
    console.warn(`[DAILY_DIGEST] skip guild=${guildId} (channel not found) channel_id=${settings.channel_id}`);
    return;
  }

  if (!(await canSend(guild, channel))) {
    console.warn(
      `[DAILY_DIGEST] skip guild=${guildId} (missing perms) channel_id=${settings.channel_id} ` +
        `(need ViewChannel + SendMessages + EmbedLinks)`
    );
    return;
  }

  const tz = safeTimeZone(settings.tz || "UTC", guildId);
  const hour = clampInt(settings.hour ?? 21, 0, 23, 21);
  const minute = clampInt(settings.minute ?? 0, 0, 59, 0);

  const runKey = makeRunKey({ guildId, tz, hour, minute, dateObj: new Date() });

  // ✅ In-process spam guard
  if (recentlyRan(guildId, runKey)) {
    if (DIGEST_DEBUG) console.log(`[DAILY_DIGEST] guard skip guild=${guildId} runKey=${runKey}`);
    return;
  }

  // ✅ Per-run advisory lock (locks THIS runKey across instances)
  const lockKey = `daily_digest_run:${runKey}`;
  const gotRunLock = await tryAdvisoryLock(pg, lockKey);
  if (!gotRunLock) {
    if (DIGEST_DEBUG) console.log(`[DAILY_DIGEST] run lock busy guild=${guildId} runKey=${runKey}`);
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
      markRan(guildId, runKey);
      if (DIGEST_DEBUG) console.log(`[DAILY_DIGEST] already sent guild=${guildId} runKey=${runKey}`);
      return;
    }

    const hoursWindow = clampInt(settings.hours_window ?? 24, 1, 168, 24);

    if (DIGEST_DEBUG) {
      console.log(
        `[DAILY_DIGEST] sending guild=${guildId} reason=${reason} tz=${tz} target=${pad2(hour)}:${pad2(minute)} window=${hoursWindow}h runKey=${runKey}`
      );
    }

    const embed = await generateDailyDigest({
      pg,
      guild,
      settings: { ...settings, tz }, // ensure normalized tz is used in embed display
      hours: hoursWindow,
    });

    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });

    markRan(guildId, runKey);
    console.log(`[DAILY_DIGEST] ✅ sent guild=${guildId} channel=${settings.channel_id} reason=${reason}`);
  } catch (e) {
    console.error(`[DAILY_DIGEST] run failed guild=${guildId}:`, e?.message || e);
  } finally {
    await unlockAdvisory(pg, lockKey);
  }
}

/* ===================== CATCH-UP (RESTART SAFE) ===================== */

async function maybeCatchUp(client, settings) {
  try {
    if (!settings?.enabled) return;

    const guildId = String(settings.guild_id);
    const tz = safeTimeZone(settings.tz || "UTC", guildId);
    const hour = clampInt(settings.hour ?? 21, 0, 23, 21);
    const minute = clampInt(settings.minute ?? 0, 0, 59, 0);

    const now = new Date();
    const p = tzPartsAt(tz, now);

    const nowMin = p.hour * 60 + p.minute;
    const targetMin = hour * 60 + minute;
    const diff = nowMin - targetMin;

    // only catch-up if after scheduled time (same local day) within window
    if (diff >= 0 && diff <= CATCHUP_MINUTES) {
      console.log(
        `[DAILY_DIGEST] catch-up triggered guild=${guildId} tz=${tz} now=${pad2(p.hour)}:${pad2(p.minute)} target=${pad2(hour)}:${pad2(minute)} diff=${diff}m`
      );
      await runOnceForGuild(client, guildId, `catchup(+${diff}m)`);
    } else if (DIGEST_DEBUG) {
      console.log(
        `[DAILY_DIGEST] no catch-up guild=${guildId} tz=${tz} now=${pad2(p.hour)}:${pad2(p.minute)} target=${pad2(hour)}:${pad2(minute)} diff=${diff}m window=${CATCHUP_MINUTES}m`
      );
    }
  } catch (e) {
    if (DIGEST_DEBUG) console.warn("[DAILY_DIGEST] catch-up check failed:", e?.message || e);
  }
}

/* ===================== SCHEDULING ===================== */

function clearGuildTimer(guildId) {
  const id = String(guildId);
  if (timers.has(id)) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  }
}

function scheduleGuild(client, settings) {
  const guildId = String(settings.guild_id);
  const tz = safeTimeZone(settings.tz || "UTC", guildId);
  const hour = clampInt(settings.hour ?? 21, 0, 23, 21);
  const minute = clampInt(settings.minute ?? 0, 0, 59, 0);

  clearGuildTimer(guildId);

  let delayMs = 60_000;
  try {
    delayMs = nextRunDelayMs({ tz, hour, minute });
  } catch (e) {
    delayMs = 60 * 60_000;
    console.warn(`[DAILY_DIGEST] nextRunDelayMs failed guild=${guildId} tz=${tz}:`, e?.message || e);
  }

  const t = setTimeout(async () => {
    await runOnceForGuild(client, guildId, "scheduled");

    // Reload settings and reschedule
    try {
      const pg = client?.pg;
      if (pg?.query) {
        const r = await pg.query(`SELECT * FROM daily_digest_settings WHERE guild_id = $1 LIMIT 1`, [guildId]);
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
    `[DAILY_DIGEST] scheduled guild=${guildId} tz=${tz} @ ${pad2(hour)}:${pad2(minute)} (in ~${Math.round(delayMs / 60000)}m)`
  );
}

async function scheduleAllEnabled(client) {
  const pg = client?.pg;
  if (!pg?.query) return;

  const settings = await loadEnabledSettings(pg);

  // Catch-up pass first (restart-safe)
  for (const s of settings) {
    // eslint-disable-next-line no-await-in-loop
    await maybeCatchUp(client, s);
  }

  for (const s of settings) scheduleGuild(client, s);

  console.log(`[DAILY_DIGEST] scheduled enabled guilds=${settings.length} catchup_window=${CATCHUP_MINUTES}m`);
}

/* ===================== LEADER ELECTION (SELF-HEALING) ===================== */

async function acquireLeaderAndStart(client) {
  const pg = client?.pg;
  if (!pg?.query) return;

  if (!LEADER_LOCK_ENABLED) {
    console.log("[DAILY_DIGEST] leader lock disabled — starting scheduler on this instance.");
    await scheduleAllEnabled(client);
    return;
  }

  const gotLeader = await tryAdvisoryLock(pg, LEADER_LOCK_KEY);
  if (gotLeader) {
    console.log("[DAILY_DIGEST] leader lock acquired — scheduler is active on this instance.");
    await scheduleAllEnabled(client);
    return;
  }

  console.warn("[DAILY_DIGEST] leader lock not acquired — another instance is scheduler. Will retry...");

  // Retry loop (only one per process)
  if (client.__dailyDigestLeaderRetryTimer) return;

  client.__dailyDigestLeaderRetryTimer = setInterval(async () => {
    try {
      const ok = await tryAdvisoryLock(pg, LEADER_LOCK_KEY);
      if (!ok) return;

      clearInterval(client.__dailyDigestLeaderRetryTimer);
      client.__dailyDigestLeaderRetryTimer = null;

      console.log("[DAILY_DIGEST] leader lock acquired (retry) — scheduler is active on this instance.");
      await scheduleAllEnabled(client);
    } catch (e) {
      if (DIGEST_DEBUG) console.warn("[DAILY_DIGEST] leader retry error:", e?.message || e);
    }
  }, Math.max(5000, LEADER_RETRY_MS));
}

/* ===================== START ===================== */

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
  await ensureSettingsTable(pg);

  // Prefer starting after Discord ready, but tolerate being called early.
  if (typeof client.isReady === "function" && !client.isReady()) {
    console.warn("[DAILY_DIGEST] client not ready yet — will start leader election on ready.");
    client.once("ready", async () => {
      await acquireLeaderAndStart(client);
    });
  } else {
    await acquireLeaderAndStart(client);
  }

  // expose helpers
  client.dailyDigestScheduler = {
    rescheduleGuild: async (guildId) => {
      const r = await pg.query(`SELECT * FROM daily_digest_settings WHERE guild_id = $1 LIMIT 1`, [String(guildId)]);
      const s = r.rows?.[0];
      if (s?.enabled) {
        await maybeCatchUp(client, s);
        scheduleGuild(client, s);
      } else {
        clearGuildTimer(guildId);
      }
    },
    runNow: async (guildId) => runOnceForGuild(client, guildId, "manual"),
    stop: async () => {
      for (const [gid, t] of timers.entries()) {
        clearTimeout(t);
        timers.delete(gid);
      }
      if (client.__dailyDigestLeaderRetryTimer) {
        clearInterval(client.__dailyDigestLeaderRetryTimer);
        client.__dailyDigestLeaderRetryTimer = null;
      }
      if (LEADER_LOCK_ENABLED) await unlockAdvisory(pg, LEADER_LOCK_KEY);
    },
  };

  console.log(
    `[DAILY_DIGEST] init complete. leader_lock=${LEADER_LOCK_ENABLED ? "on" : "off"} retry=${Math.round(
      LEADER_RETRY_MS / 1000
    )}s debug=${DIGEST_DEBUG ? "on" : "off"}`
  );
}

module.exports = { startDailyDigestScheduler };
