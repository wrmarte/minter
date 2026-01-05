// jobs/dailyDigestScheduler.js
const { PermissionsBitField, EmbedBuilder } = require("discord.js");
const { generateDailyDigest } = require("../services/dailyDigestService");

/* ======================================================
   ✅ OPTIONAL: Digest DB Debug Snapshot (scheduled)
   ------------------------------------------------------
   Runs SQL sanity checks on digest_events and prints to logs
   (and optionally posts an embed to Discord).

   ENVS:
   - DIGEST_DEBUG_SCHEDULE=off|daily|weekly|monthly
   - DIGEST_DEBUG_AT=HH:MM                (default 06:10)
   - DIGEST_DEBUG_TZ=UTC|America/New_York (default UTC)
   - DIGEST_DEBUG_DAY_OF_WEEK=0-6         (weekly only; 0=Sun)
   - DIGEST_DEBUG_DAY_OF_MONTH=1-28       (monthly only; recommend 1-28)
   - DIGEST_DEBUG_HOURS=24
   - DIGEST_DEBUG_LIMIT=25
   - DIGEST_DEBUG_GUILDS=gid1,gid2        (optional; otherwise uses enabled digest settings guilds)
   - DIGEST_DEBUG_MAX_GUILDS=5            (safety cap if DIGEST_DEBUG_GUILDS not set)
   - DIGEST_DEBUG_POST_TO_DISCORD=0|1     (default 0)
   - DIGEST_DEBUG_CHANNEL_ID=...          (optional; if posting, overrides per-guild digest channel)
====================================================== */

// ===== Leader lock settings =====
// If multiple bot instances exist, only ONE should schedule + send digests.
const LEADER_LOCK_ENABLED =
  String(process.env.DAILY_DIGEST_LEADER_LOCK || "1").trim() === "1";
const LEADER_LOCK_KEY = "daily_digest_scheduler_leader";

// ✅ retry leader lock (self-healing)
const LEADER_RETRY_MS = Number(
  process.env.DAILY_DIGEST_LEADER_RETRY_MS || 30000
); // 30s

// ✅ Tick scheduler (more reliable than setTimeout)
const TICK_MS = Number(process.env.DAILY_DIGEST_TICK_MS || 20000); // 20s
const SETTINGS_REFRESH_MS = Number(
  process.env.DAILY_DIGEST_SETTINGS_REFRESH_MS || 60000
); // 60s

// Extra local spam-guard (per process)
const RECENT_SEND_GUARD_MS = Number(
  process.env.DAILY_DIGEST_RECENT_GUARD_MS || 3 * 60 * 1000
); // 3 minutes
const lastRunByGuild = new Map(); // guildId -> { runKey, ts }

// ✅ catch-up window (restart-safe)
// If bot restarts within X minutes AFTER scheduled time, send immediately once.
const CATCHUP_MINUTES = Number(process.env.DAILY_DIGEST_CATCHUP_MINUTES || 10);

// ✅ debug logs
const DIGEST_DEBUG = String(process.env.DAILY_DIGEST_DEBUG || "").trim() === "1";

/* ===================== DIGEST DB DEBUG CONFIG ===================== */

const DIGEST_DB_DEBUG_SCHEDULE = String(
  process.env.DIGEST_DEBUG_SCHEDULE || "off"
)
  .trim()
  .toLowerCase(); // off|daily|weekly|monthly

const DIGEST_DB_DEBUG_AT = String(process.env.DIGEST_DEBUG_AT || "06:10").trim(); // HH:MM
const DIGEST_DB_DEBUG_TZ_RAW = String(process.env.DIGEST_DEBUG_TZ || "UTC").trim();
const DIGEST_DB_DEBUG_DAY_OF_WEEK = Number(process.env.DIGEST_DEBUG_DAY_OF_WEEK || "1"); // weekly only; default Monday
const DIGEST_DB_DEBUG_DAY_OF_MONTH = Number(process.env.DIGEST_DEBUG_DAY_OF_MONTH || "1"); // monthly only
const DIGEST_DB_DEBUG_HOURS = Number(process.env.DIGEST_DEBUG_HOURS || "24");
const DIGEST_DB_DEBUG_LIMIT = Number(process.env.DIGEST_DEBUG_LIMIT || "25");
const DIGEST_DB_DEBUG_POST_TO_DISCORD =
  String(process.env.DIGEST_DEBUG_POST_TO_DISCORD || "0").trim() === "1";
const DIGEST_DB_DEBUG_CHANNEL_ID = String(process.env.DIGEST_DEBUG_CHANNEL_ID || "").trim();

const DIGEST_DB_DEBUG_GUILDS = String(process.env.DIGEST_DEBUG_GUILDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DIGEST_DB_DEBUG_MAX_GUILDS = Number(
  process.env.DIGEST_DEBUG_MAX_GUILDS ||
    (DIGEST_DB_DEBUG_GUILDS.length ? 9999 : 5)
);

// In-process anti-spam for debug runner (separate from digest guard)
const DEBUG_LOCAL_GUARD_MS = Number(
  process.env.DIGEST_DEBUG_RECENT_GUARD_MS || 2 * 60 * 1000
);
const lastDebugRunByKey = new Map(); // runKey -> ts

// Safe optional require (do NOT crash if file missing)
let getDigestDebugSnapshot = null;
try {
  // NOTE: Linux/Railway is case-sensitive.
  const mod = require("../services/digestDebug");
  if (mod && typeof mod.getDigestDebugSnapshot === "function") {
    getDigestDebugSnapshot = mod.getDigestDebugSnapshot;
  } else if (DIGEST_DEBUG) {
    console.warn("[DAILY_DIGEST] digestDebug loaded but missing getDigestDebugSnapshot()");
  }
} catch {
  // It's optional; skip silently unless digest debug is enabled.
  if (DIGEST_DB_DEBUG_SCHEDULE !== "off") {
    console.warn(
      "[DAILY_DIGEST] digestDebug module missing at ../services/digestDebug — scheduled debug will be skipped."
    );
  }
}

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

// ✅ Debug runs table (survives restarts; prevents duplicate debug snapshot)
const DEBUG_RUNS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS digest_debug_runs (
  run_key     TEXT PRIMARY KEY,
  schedule    TEXT NOT NULL,
  tz          TEXT NOT NULL,
  hour        INT  NOT NULL,
  minute      INT  NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
    console.warn(
      `[DAILY_DIGEST] invalid tz "${tz}"${
        guildIdForLog ? ` for guild=${guildIdForLog}` : ""
      } — falling back to UTC`
    );
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

  // Some environments can emit hour "24" at midnight; normalize to 0.
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
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

function parseHHMM(hhmm) {
  const s = String(hhmm || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hour: 6, minute: 10, ok: false };
  const h = clampInt(m[1], 0, 23, 6);
  const mi = clampInt(m[2], 0, 59, 10);
  return { hour: h, minute: mi, ok: true };
}

/* ===================== DB LOADERS ===================== */

async function ensureSettingsTable(pg) {
  try {
    await pg.query(SETTINGS_TABLE_SQL);
  } catch (e) {
    console.warn(
      "[DAILY_DIGEST] failed to ensure daily_digest_settings table:",
      e?.message || e
    );
  }
}

async function loadEnabledSettings(pg) {
  await ensureSettingsTable(pg);
  try {
    const r = await pg.query(
      `SELECT * FROM daily_digest_settings WHERE enabled = TRUE`
    );
    return r.rows || [];
  } catch (e) {
    console.warn("[DAILY_DIGEST] loadEnabledSettings failed:", e?.message || e);
    return [];
  }
}

/* ===================== PERMS ===================== */

async function canSend(guild, channel) {
  try {
    const me =
      guild.members.me || (await guild.members.fetchMe().catch(() => null));
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
    const r = await pg.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
      [String(keyText)]
    );
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
    console.warn(
      "[DAILY_DIGEST] failed to ensure daily_digest_runs table:",
      e?.message || e
    );
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

/* ===================== DEBUG RUN CLAIM TABLE ===================== */

async function ensureDebugRunsTable(pg) {
  try {
    await pg.query(DEBUG_RUNS_TABLE_SQL);
  } catch (e) {
    console.warn(
      "[DAILY_DIGEST] failed to ensure digest_debug_runs table:",
      e?.message || e
    );
  }
}

async function claimDebugRunKey(pg, runKey, meta) {
  try {
    const r = await pg.query(
      `INSERT INTO digest_debug_runs (run_key, schedule, tz, hour, minute)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (run_key) DO NOTHING
       RETURNING run_key`,
      [
        String(runKey),
        String(meta.schedule),
        String(meta.tz),
        Number(meta.hour),
        Number(meta.minute),
      ]
    );
    return Boolean(r.rowCount);
  } catch (e) {
    if (DIGEST_DEBUG)
      console.warn("[DAILY_DIGEST] claimDebugRunKey failed:", e?.message || e);
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

async function runOnceForGuild(client, guildId, reason = "scheduled", opts = {}) {
  const pg = client?.pg;
  if (!pg?.query) return;

  const force = Boolean(opts.force);

  let settings;
  try {
    const sres = await pg.query(
      `SELECT * FROM daily_digest_settings WHERE guild_id = $1 LIMIT 1`,
      [String(guildId)]
    );
    settings = sres.rows?.[0];
  } catch (e) {
    console.warn(
      `[DAILY_DIGEST] settings fetch failed guild=${guildId}:`,
      e?.message || e
    );
    return;
  }

  if (!settings?.enabled) {
    if (DIGEST_DEBUG)
      console.log(`[DAILY_DIGEST] skip guild=${guildId} (disabled/no settings)`);
    return;
  }

  const guild = await fetchGuildSafe(client, guildId);
  if (!guild) {
    console.warn(
      `[DAILY_DIGEST] skip guild=${guildId} (guild not found / not cached)`
    );
    return;
  }

  let channel =
    guild.channels.cache.get(String(settings.channel_id)) ||
    (await guild.channels.fetch(String(settings.channel_id)).catch(() => null));

  if (!channel) {
    console.warn(
      `[DAILY_DIGEST] skip guild=${guildId} (channel not found) channel_id=${settings.channel_id}`
    );
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

  // Scheduled runKey is stable; manual runs use a unique runKey so /digest test always posts.
  const runKey = force
    ? `manual:${guildId}:${Date.now()}`
    : makeRunKey({ guildId, tz, hour, minute, dateObj: new Date() });

  // ✅ In-process spam guard
  if (!force && recentlyRan(guildId, runKey)) {
    if (DIGEST_DEBUG)
      console.log(`[DAILY_DIGEST] guard skip guild=${guildId} runKey=${runKey}`);
    return;
  }

  // ✅ Per-run advisory lock (locks THIS runKey across instances)
  const lockKey = `daily_digest_run:${runKey}`;
  const gotRunLock = await tryAdvisoryLock(pg, lockKey);
  if (!gotRunLock) {
    if (DIGEST_DEBUG)
      console.log(
        `[DAILY_DIGEST] run lock busy guild=${guildId} runKey=${runKey}`
      );
    return;
  }

  try {
    // ✅ Persistent run claim (prevents repeats across restarts/instances)
    // For manual runs, we still claim (unique key) to avoid double-send if two instances handle same command.
    const claimed = await claimRunKey(pg, runKey, {
      guild_id: guildId,
      channel_id: settings.channel_id,
      tz,
      hour,
      minute,
    });

    if (!claimed) {
      // Should be rare for manual; common for scheduled repeats
      markRan(guildId, runKey);
      if (DIGEST_DEBUG)
        console.log(
          `[DAILY_DIGEST] already sent guild=${guildId} runKey=${runKey}`
        );
      return;
    }

    const hoursWindow = clampInt(settings.hours_window ?? 24, 1, 168, 24);

    if (DIGEST_DEBUG) {
      console.log(
        `[DAILY_DIGEST] sending guild=${guildId} reason=${reason} tz=${tz} target=${pad2(
          hour
        )}:${pad2(minute)} window=${hoursWindow}h runKey=${runKey}`
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
    console.log(
      `[DAILY_DIGEST] ✅ sent guild=${guildId} channel=${settings.channel_id} reason=${reason}`
    );
  } catch (e) {
    console.error(
      `[DAILY_DIGEST] run failed guild=${guildId}:`,
      e?.message || e
    );
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
        `[DAILY_DIGEST] catch-up triggered guild=${guildId} tz=${tz} now=${pad2(
          p.hour
        )}:${pad2(p.minute)} target=${pad2(hour)}:${pad2(minute)} diff=${diff}m`
      );
      await runOnceForGuild(client, guildId, `catchup(+${diff}m)`);
    } else if (DIGEST_DEBUG) {
      console.log(
        `[DAILY_DIGEST] no catch-up guild=${guildId} tz=${tz} now=${pad2(
          p.hour
        )}:${pad2(p.minute)} target=${pad2(hour)}:${pad2(
          minute
        )} diff=${diff}m window=${CATCHUP_MINUTES}m`
      );
    }
  } catch (e) {
    if (DIGEST_DEBUG)
      console.warn("[DAILY_DIGEST] catch-up check failed:", e?.message || e);
  }
}

/* ===================== DIGEST DB DEBUG: DUE CHECK ===================== */

function debugScheduleEnabled() {
  return (
    DIGEST_DB_DEBUG_SCHEDULE === "daily" ||
    DIGEST_DB_DEBUG_SCHEDULE === "weekly" ||
    DIGEST_DB_DEBUG_SCHEDULE === "monthly"
  );
}

function makeDebugRunKey({ schedule, tz, hour, minute, dateObj }) {
  const p = tzPartsAt(tz, dateObj);
  const ymd = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  return `digest_debug:${schedule}:${ymd}:${pad2(hour)}:${pad2(minute)}:${tz}`;
}

function debugDueNow() {
  if (!debugScheduleEnabled()) return { due: false };

  const tz = safeTimeZone(DIGEST_DB_DEBUG_TZ_RAW || "UTC", "");
  const { hour, minute } = parseHHMM(DIGEST_DB_DEBUG_AT);

  const now = new Date();
  const p = tzPartsAt(tz, now);

  if (!(p.hour === hour && p.minute === minute)) {
    return { due: false, tz, hour, minute, parts: p };
  }

  if (DIGEST_DB_DEBUG_SCHEDULE === "weekly") {
    const want = clampInt(DIGEST_DB_DEBUG_DAY_OF_WEEK, 0, 6, 1);

    // JS getDay() is in server TZ, not target TZ.
    // So we approximate day-of-week from the *target local date* by constructing a UTC date from y/m/d.
    // This gives a stable weekday mapping for the local calendar date.
    const utc = new Date(Date.UTC(p.year, p.month - 1, p.day));
    const dow = utc.getUTCDay(); // 0=Sun..6=Sat
    if (dow !== want) return { due: false, tz, hour, minute, parts: p, dow };
  }

  if (DIGEST_DB_DEBUG_SCHEDULE === "monthly") {
    const dom = clampInt(DIGEST_DB_DEBUG_DAY_OF_MONTH, 1, 28, 1);
    if (p.day !== dom) return { due: false, tz, hour, minute, parts: p };
  }

  const runKey = makeDebugRunKey({
    schedule: DIGEST_DB_DEBUG_SCHEDULE,
    tz,
    hour,
    minute,
    dateObj: now,
  });

  return { due: true, tz, hour, minute, parts: p, runKey };
}

function debugLocalGuard(runKey) {
  const k = String(runKey || "");
  if (!k) return false;
  const last = lastDebugRunByKey.get(k);
  if (!last) return false;
  return Date.now() - last < DEBUG_LOCAL_GUARD_MS;
}

function markDebugLocal(runKey) {
  lastDebugRunByKey.set(String(runKey || ""), Date.now());
}

/* ===================== DIGEST DB DEBUG: RUNNER ===================== */

function pickDebugGuildIds(settingsRows) {
  if (DIGEST_DB_DEBUG_GUILDS.length) return DIGEST_DB_DEBUG_GUILDS;

  const ids = Array.from(
    new Set((settingsRows || []).map((s) => String(s.guild_id)).filter(Boolean))
  );

  // Safety cap when not explicitly provided
  const cap = Number.isFinite(DIGEST_DB_DEBUG_MAX_GUILDS)
    ? Math.max(1, DIGEST_DB_DEBUG_MAX_GUILDS)
    : 5;

  return ids.slice(0, cap);
}

async function sendDebugEmbedToChannel(channel, snap, meta) {
  try {
    if (!channel?.isTextBased?.()) return false;

    const by = (snap.bySubType || [])
      .slice(0, 10)
      .map((r) => `• ${r.sub_type}: ${r.n}`)
      .join("\n");

    const recent = (snap.recentTokenish || [])
      .slice(0, 8)
      .map((r) => {
        const sub = r.sub_type || "-";
        const eth = r.amount_eth != null ? Number(r.amount_eth).toString() : "-";
        const usd = r.amount_usd != null ? Number(r.amount_usd).toString() : "-";
        const tx = r.tx_hash ? String(r.tx_hash).slice(0, 10) + "…" : "-";
        return `• ${sub} ${eth} ETH ($${usd}) tx:${tx}`;
      })
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle("Digest DB Debug Snapshot")
      .setDescription(
        `Schedule: **${meta.schedule}** @ **${pad2(meta.hour)}:${pad2(
          meta.minute
        )} ${meta.tz}**\nWindow: **${meta.hours}h** • Limit: **${meta.limit}**`
      )
      .addFields(
        { name: "Counts by sub_type (top)", value: by || "N/A", inline: false },
        {
          name: "Recent token-ish (token_id IS NULL)",
          value: recent || "N/A",
          inline: false,
        }
      )
      .setFooter({ text: "MB Digest Debug • from DB" });

    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch {
    return false;
  }
}

async function runDigestDbDebugTick(client, settingsRows) {
  const pg = client?.pg;
  if (!pg?.query) return;
  if (!debugScheduleEnabled()) return;

  // Only leader should run scheduled debug (prevents multiple instances spamming)
  if (LEADER_LOCK_ENABLED && !client.__dailyDigestIsLeader) return;

  const due = debugDueNow();
  if (!due?.due) return;

  if (!getDigestDebugSnapshot) {
    console.warn(
      "[DAILY_DIGEST] digestDebug module not available — skipping scheduled DB debug snapshot."
    );
    return;
  }

  if (debugLocalGuard(due.runKey)) {
    if (DIGEST_DEBUG)
      console.log(`[DAILY_DIGEST] debug local guard skip runKey=${due.runKey}`);
    return;
  }

  // Per-run advisory lock (cross-instance) even though leader-only, for safety
  const lockKey = `digest_debug_run:${due.runKey}`;
  const got = await tryAdvisoryLock(pg, lockKey);
  if (!got) return;

  try {
    await ensureDebugRunsTable(pg);

    const claimed = await claimDebugRunKey(pg, due.runKey, {
      schedule: DIGEST_DB_DEBUG_SCHEDULE,
      tz: due.tz,
      hour: due.hour,
      minute: due.minute,
    });

    if (!claimed) {
      markDebugLocal(due.runKey);
      if (DIGEST_DEBUG)
        console.log(`[DAILY_DIGEST] debug already ran runKey=${due.runKey}`);
      return;
    }

    const guildIds = pickDebugGuildIds(settingsRows);
    const hours = clampInt(DIGEST_DB_DEBUG_HOURS, 1, 168, 24);
    const limit = clampInt(DIGEST_DB_DEBUG_LIMIT, 1, 200, 25);

    console.log(
      `[DAILY_DIGEST] 🧪 Digest DB Debug (${DIGEST_DB_DEBUG_SCHEDULE}) runKey=${due.runKey} guilds=${guildIds.length} window=${hours}h limit=${limit} postToDiscord=${
        DIGEST_DB_DEBUG_POST_TO_DISCORD ? "1" : "0"
      }`
    );

    for (const gid of guildIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const snap = await getDigestDebugSnapshot(client, gid, hours, limit);

        console.log(`\n[DIGEST_DEBUG] guild=${gid} bySubType (last ${hours}h)`);
        console.table(snap.bySubType || []);

        console.log(
          `[DIGEST_DEBUG] guild=${gid} recentTokenish (token_id IS NULL)`
        );
        console.table(
          (snap.recentTokenish || []).map((r) => ({
            ts: r.ts,
            type: r.event_type,
            sub: r.sub_type,
            chain: r.chain,
            contract: (r.contract || "").slice(0, 10),
            eth: r.amount_eth,
            usd: r.amount_usd,
            buyer: (r.buyer || "").slice(0, 10),
            seller: (r.seller || "").slice(0, 10),
            tx: (r.tx_hash || "").slice(0, 12),
          }))
        );

        // Optional: post an embed into Discord
        if (DIGEST_DB_DEBUG_POST_TO_DISCORD) {
          const guild = await fetchGuildSafe(client, gid);
          if (!guild) continue;

          let channel = null;

          // Override: explicit channel id env (single channel target)
          if (DIGEST_DB_DEBUG_CHANNEL_ID) {
            channel =
              guild.channels.cache.get(DIGEST_DB_DEBUG_CHANNEL_ID) ||
              // eslint-disable-next-line no-await-in-loop
              (await guild.channels
                .fetch(DIGEST_DB_DEBUG_CHANNEL_ID)
                .catch(() => null));
          } else {
            // Otherwise: use that guild's daily digest channel_id
            const s = (settingsRows || []).find(
              (x) => String(x.guild_id) === String(gid)
            );
            if (s?.channel_id) {
              channel =
                guild.channels.cache.get(String(s.channel_id)) ||
                // eslint-disable-next-line no-await-in-loop
                (await guild.channels
                  .fetch(String(s.channel_id))
                  .catch(() => null));
            }
          }

          if (channel && (await canSend(guild, channel))) {
            // eslint-disable-next-line no-await-in-loop
            await sendDebugEmbedToChannel(channel, snap, {
              schedule: DIGEST_DB_DEBUG_SCHEDULE,
              tz: due.tz,
              hour: due.hour,
              minute: due.minute,
              hours,
              limit,
            });
          }
        }
      } catch (e) {
        console.warn(
          "[DAILY_DIGEST] digest debug failed for guild",
          gid,
          e?.message || e
        );
      }
    }

    markDebugLocal(due.runKey);
  } catch (e) {
    console.warn("[DAILY_DIGEST] digest debug tick failed:", e?.message || e);
  } finally {
    await unlockAdvisory(pg, lockKey);
  }
}

/* ===================== LEADER TICK LOOP (RELIABLE SCHEDULING) ===================== */

function isDueNow(settings) {
  const guildId = String(settings.guild_id);
  const tz = safeTimeZone(settings.tz || "UTC", guildId);
  const hour = clampInt(settings.hour ?? 21, 0, 23, 21);
  const minute = clampInt(settings.minute ?? 0, 0, 59, 0);

  const now = new Date();
  const p = tzPartsAt(tz, now);

  return {
    due: p.hour === hour && p.minute === minute,
    tz,
    hour,
    minute,
    parts: p,
  };
}

async function fetchEnabledSettingsCached(client, force = false) {
  const pg = client?.pg;
  if (!pg?.query) return [];

  const now = Date.now();
  const cache = client.__dailyDigestSettingsCache || { ts: 0, rows: [] };

  if (!force && cache.rows?.length && now - cache.ts < SETTINGS_REFRESH_MS) {
    return cache.rows;
  }

  const rows = await loadEnabledSettings(pg);
  client.__dailyDigestSettingsCache = { ts: now, rows };
  return rows;
}

async function leaderTick(client) {
  try {
    const pg = client?.pg;
    if (!pg?.query) return;

    const settings = await fetchEnabledSettingsCached(client, false);

    // 1) Run scheduled daily digests
    for (const s of settings) {
      if (!s?.enabled) continue;

      const dueInfo = isDueNow(s);
      if (!dueInfo.due) continue;

      // We only run once per scheduled key; DB claim + advisory lock guarantees.
      // eslint-disable-next-line no-await-in-loop
      await runOnceForGuild(client, String(s.guild_id), "scheduled-tick");
    }

    // 2) Run scheduled DB debug snapshot (daily/weekly/monthly)
    await runDigestDbDebugTick(client, settings);
  } catch (e) {
    if (DIGEST_DEBUG)
      console.warn("[DAILY_DIGEST] leaderTick error:", e?.message || e);
  }
}

function startLeaderLoop(client) {
  if (client.__dailyDigestLeaderTickTimer) {
    clearInterval(client.__dailyDigestLeaderTickTimer);
    client.__dailyDigestLeaderTickTimer = null;
  }

  client.__dailyDigestLeaderTickTimer = setInterval(() => {
    leaderTick(client).catch(() => {});
  }, Math.max(5000, TICK_MS));

  if (DIGEST_DEBUG) {
    console.log(
      `[DAILY_DIGEST] leader tick loop started: every ${Math.round(
        Math.max(5000, TICK_MS) / 1000
      )}s (settings refresh ${Math.round(SETTINGS_REFRESH_MS / 1000)}s)`
    );
  }
}

/* ===================== LEADER ELECTION (SELF-HEALING) ===================== */

async function acquireLeaderAndStart(client) {
  const pg = client?.pg;
  if (!pg?.query) return;

  if (!LEADER_LOCK_ENABLED) {
    client.__dailyDigestIsLeader = true;
    console.log(
      "[DAILY_DIGEST] leader lock disabled — starting scheduler on this instance."
    );

    // Prime cache + catch-up once
    const settings = await fetchEnabledSettingsCached(client, true);
    for (const s of settings) {
      // eslint-disable-next-line no-await-in-loop
      await maybeCatchUp(client, s);
    }

    startLeaderLoop(client);
    return;
  }

  const gotLeader = await tryAdvisoryLock(pg, LEADER_LOCK_KEY);
  if (gotLeader) {
    client.__dailyDigestIsLeader = true;
    console.log(
      "[DAILY_DIGEST] leader lock acquired — scheduler is active on this instance."
    );

    // Prime cache + catch-up once
    const settings = await fetchEnabledSettingsCached(client, true);
    for (const s of settings) {
      // eslint-disable-next-line no-await-in-loop
      await maybeCatchUp(client, s);
    }

    startLeaderLoop(client);
    return;
  }

  client.__dailyDigestIsLeader = false;
  console.warn(
    "[DAILY_DIGEST] leader lock not acquired — another instance is scheduler. Will retry..."
  );

  // Retry loop (only one per process)
  if (client.__dailyDigestLeaderRetryTimer) return;

  client.__dailyDigestLeaderRetryTimer = setInterval(async () => {
    try {
      const ok = await tryAdvisoryLock(pg, LEADER_LOCK_KEY);
      if (!ok) return;

      clearInterval(client.__dailyDigestLeaderRetryTimer);
      client.__dailyDigestLeaderRetryTimer = null;

      client.__dailyDigestIsLeader = true;
      console.log(
        "[DAILY_DIGEST] leader lock acquired (retry) — scheduler is active on this instance."
      );

      const settings = await fetchEnabledSettingsCached(client, true);
      for (const s of settings) {
        // eslint-disable-next-line no-await-in-loop
        await maybeCatchUp(client, s);
      }

      startLeaderLoop(client);
    } catch (e) {
      if (DIGEST_DEBUG)
        console.warn("[DAILY_DIGEST] leader retry error:", e?.message || e);
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

  // ✅ also ensure debug runs table (safe even if schedule is off)
  await ensureDebugRunsTable(pg);

  // Prefer starting after Discord ready, but tolerate being called early.
  if (typeof client.isReady === "function" && !client.isReady()) {
    console.warn(
      "[DAILY_DIGEST] client not ready yet — will start leader election on ready."
    );
    client.once("ready", async () => {
      await acquireLeaderAndStart(client);
    });
  } else {
    await acquireLeaderAndStart(client);
  }

  // expose helpers
  client.dailyDigestScheduler = {
    rescheduleGuild: async (guildId) => {
      try {
        // invalidate cache so leader sees changes quickly
        client.__dailyDigestSettingsCache = { ts: 0, rows: [] };

        // optional: catchup check if leader
        const r = await pg.query(
          `SELECT * FROM daily_digest_settings WHERE guild_id = $1 LIMIT 1`,
          [String(guildId)]
        );
        const s = r.rows?.[0];
        if (s?.enabled && client.__dailyDigestIsLeader) {
          await maybeCatchUp(client, s);
        }
      } catch {}
    },

    // Manual run: always posts (unique runKey), works even on follower instance
    runNow: async (guildId) =>
      runOnceForGuild(client, guildId, "manual", { force: true }),

    // Manual debug snapshot (logs + optional Discord post)
    debugNow: async () => {
      try {
        const settings = await fetchEnabledSettingsCached(client, true);
        await runDigestDbDebugTick(client, settings);
      } catch {}
    },

    stop: async () => {
      try {
        if (client.__dailyDigestLeaderTickTimer) {
          clearInterval(client.__dailyDigestLeaderTickTimer);
          client.__dailyDigestLeaderTickTimer = null;
        }
      } catch {}

      try {
        if (client.__dailyDigestLeaderRetryTimer) {
          clearInterval(client.__dailyDigestLeaderRetryTimer);
          client.__dailyDigestLeaderRetryTimer = null;
        }
      } catch {}

      try {
        if (LEADER_LOCK_ENABLED) await unlockAdvisory(pg, LEADER_LOCK_KEY);
      } catch {}
    },
  };

  const dbgAt = parseHHMM(DIGEST_DB_DEBUG_AT);
  const dbgTz = safeTimeZone(DIGEST_DB_DEBUG_TZ_RAW || "UTC", "");

  console.log(
    `[DAILY_DIGEST] init complete. leader_lock=${
      LEADER_LOCK_ENABLED ? "on" : "off"
    } retry=${Math.round(LEADER_RETRY_MS / 1000)}s tick=${Math.round(
      Math.max(5000, TICK_MS) / 1000
    )}s debug=${DIGEST_DEBUG ? "on" : "off"} | db_debug_schedule=${
      DIGEST_DB_DEBUG_SCHEDULE
    } at=${pad2(dbgAt.hour)}:${pad2(dbgAt.minute)} tz=${dbgTz} post=${
      DIGEST_DB_DEBUG_POST_TO_DISCORD ? "on" : "off"
    }`
  );
}

module.exports = { startDailyDigestScheduler };

