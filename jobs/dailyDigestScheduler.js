// jobs/dailyDigestScheduler.js
const { PermissionsBitField } = require("discord.js");
const { generateDailyDigest } = require("../services/dailyDigestService");

const timers = new Map(); // guildId -> timeout

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

function nextRunDelayMs({ tz, hour, minute }) {
  const now = new Date();
  const targetH = Math.max(0, Math.min(23, Number(hour)));
  const targetM = Math.max(0, Math.min(59, Number(minute)));

  // scan forward minute-by-minute up to 48h, find first local-time match
  for (let addMin = 0; addMin <= 48 * 60; addMin++) {
    const test = new Date(now.getTime() + addMin * 60_000);
    const tp = tzPartsAt(tz, test);
    if (tp.hour === targetH && tp.minute === targetM) {
      const delay = test.getTime() - now.getTime();
      return Math.max(5_000, delay);
    }
  }

  // fallback 1 hour
  return 60 * 60_000;
}

async function loadEnabledSettings(pg) {
  const r = await pg.query(`SELECT * FROM daily_digest_settings WHERE enabled = TRUE`);
  return r.rows || [];
}

function canSend(guild, channel) {
  const me = guild.members.me;
  if (!me || !channel) return false;
  return (
    channel.isTextBased?.() &&
    channel.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages)
  );
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

  const channel = guild.channels.cache.get(String(settings.channel_id));
  if (!channel || !canSend(guild, channel)) return;

  try {
    const embed = await generateDailyDigest({
      pg,
      guild,
      settings,
      hours: 24,
    });

    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (e) {
    console.error(`[DAILY_DIGEST] run failed guild=${guildId}:`, e?.message || e);
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

    // Re-load settings & reschedule (handles changes)
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
      // if we can't reload, schedule again with same settings
      scheduleGuild(client, settings);
    }
  }, delayMs);

  timers.set(guildId, t);

  console.log(
    `[DAILY_DIGEST] scheduled guild=${guildId} tz=${tz} @ ${String(hour).padStart(
      2,
      "0"
    )}:${String(minute).padStart(2, "0")} (in ~${Math.round(delayMs / 60000)}m)`
  );
}

async function startDailyDigestScheduler(client) {
  const pg = client?.pg;
  if (!pg?.query) {
    console.warn("[DAILY_DIGEST] client.pg missing — scheduler not started.");
    return;
  }

  const settings = await loadEnabledSettings(pg);
  for (const s of settings) scheduleGuild(client, s);

  // Expose helpers for /digest command
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
    },
  };
}

module.exports = { startDailyDigestScheduler };
