// commands/digest.js
const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");

const TZ_ALIAS = {
  // US common (DST-safe)
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

function pad2(n) {
  return String(n).padStart(2, "0");
}

// For a friendly confirmation line: what time is it *right now* in that tz?
function nowInTzLine(tz) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return dtf.format(new Date());
  } catch {
    return null;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("digest")
    .setDescription("Daily mint/sales digest automation")
    .addSubcommand((sc) =>
      sc
        .setName("setup")
        .setDescription("Enable daily digest for this server")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Channel to post daily digest")
            .setRequired(true)
        )
        .addIntegerOption((o) =>
          o.setName("hour").setDescription("Hour (0-23) in timezone").setRequired(true)
        )
        .addIntegerOption((o) =>
          o.setName("minute").setDescription("Minute (0-59)").setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName("tz")
            .setDescription("Timezone (IANA like America/New_York or alias like EST/PST)")
            .setRequired(false)
        )
    )
    .addSubcommand((sc) =>
      sc.setName("off").setDescription("Disable daily digest for this server")
    )
    .addSubcommand((sc) =>
      sc.setName("test").setDescription("Post a digest now (last 24h)")
    )
    .addSubcommand((sc) =>
      sc
        .setName("show")
        .setDescription("Show current digest configuration for this server")
    ),

  async execute(interaction, client) {
    if (!interaction.guildId) return;

    const isAdmin = interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator
    );
    const ownerId = String(process.env.BOT_OWNER_ID || "").trim();
    const isOwner = ownerId && interaction.user?.id === ownerId;

    if (!isAdmin && !isOwner) {
      return interaction.reply({ content: "Admin only.", ephemeral: true });
    }

    const pg = client?.pg;
    if (!pg?.query)
      return interaction.reply({ content: "DB not connected.", ephemeral: true });

    const sub = interaction.options.getSubcommand();

    // Ensure table exists (avoids setup failing if scheduler didn't create it yet)
    try {
      await pg.query(`
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
      `);
    } catch {}

    if (sub === "setup") {
      const channel = interaction.options.getChannel("channel", true);
      const hour = interaction.options.getInteger("hour", true);
      const minute = interaction.options.getInteger("minute") ?? 0;

      let tzInput = interaction.options.getString("tz") || "UTC";
      const tzNorm = normalizeTz(tzInput);

      if (hour < 0 || hour > 23)
        return interaction.reply({
          content: "Hour must be 0-23.",
          ephemeral: true,
        });
      if (minute < 0 || minute > 59)
        return interaction.reply({
          content: "Minute must be 0-59.",
          ephemeral: true,
        });

      if (!isValidTimeZone(tzNorm)) {
        return interaction.reply({
          content:
            `❌ Invalid timezone: **${tzInput}**.\n` +
            `Use an IANA timezone like **America/New_York** (recommended) or **UTC**.\n` +
            `You can also use aliases like **EST/CST/PST**.`,
          ephemeral: true,
        });
      }

      // hours_window support: keep existing if present, else default 24
      // (setup command does not change hours_window unless you add an option later)
      await pg.query(
        `
        INSERT INTO daily_digest_settings (guild_id, channel_id, enabled, tz, hour, minute, updated_at)
        VALUES ($1,$2,TRUE,$3,$4,$5,NOW())
        ON CONFLICT (guild_id)
        DO UPDATE SET
          channel_id = EXCLUDED.channel_id,
          enabled    = TRUE,
          tz         = EXCLUDED.tz,
          hour       = EXCLUDED.hour,
          minute     = EXCLUDED.minute,
          updated_at = NOW()
        `,
        [
          String(interaction.guildId),
          String(channel.id),
          String(tzNorm),
          Number(hour),
          Number(minute),
        ]
      );

      try {
        await client.dailyDigestScheduler?.rescheduleGuild?.(interaction.guildId);
      } catch {}

      const nowLine = nowInTzLine(tzNorm);
      const when = `${pad2(hour)}:${pad2(minute)}`;

      return interaction.reply({
        content:
          `✅ Daily digest enabled in <#${channel.id}> at **${when}** (**${tzNorm}**)` +
          (nowLine ? `\n🕒 Current time in **${tzNorm}**: **${nowLine}**` : ""),
        ephemeral: true,
      });
    }

    if (sub === "show") {
      try {
        const r = await pg.query(
          `SELECT * FROM daily_digest_settings WHERE guild_id = $1 LIMIT 1`,
          [String(interaction.guildId)]
        );
        const s = r.rows?.[0];
        if (!s) {
          return interaction.reply({
            content: "No digest config found for this server. Use `/digest setup`.",
            ephemeral: true,
          });
        }

        const tzNorm = normalizeTz(s.tz || "UTC");
        const tzOk = isValidTimeZone(tzNorm);
        const when = `${pad2(s.hour ?? 0)}:${pad2(s.minute ?? 0)}`;
        const nowLine = tzOk ? nowInTzLine(tzNorm) : null;

        return interaction.reply({
          content:
            `📌 Digest status: **${s.enabled ? "ENABLED" : "DISABLED"}**\n` +
            `Channel: <#${s.channel_id}>\n` +
            `Time: **${when}**\n` +
            `Timezone: **${tzOk ? tzNorm : `${s.tz} (INVALID)`}**\n` +
            `Window: **${s.hours_window ?? 24}h**` +
            (nowLine ? `\n🕒 Current time there: **${nowLine}**` : ""),
          ephemeral: true,
        });
      } catch (e) {
        return interaction.reply({
          content: `❌ Failed to load digest config: ${e?.message || e}`,
          ephemeral: true,
        });
      }
    }

    if (sub === "off") {
      await pg.query(
        `UPDATE daily_digest_settings SET enabled = FALSE, updated_at = NOW() WHERE guild_id = $1`,
        [String(interaction.guildId)]
      );

      try {
        await client.dailyDigestScheduler?.rescheduleGuild?.(interaction.guildId);
      } catch {}

      return interaction.reply({ content: "🛑 Daily digest disabled.", ephemeral: true });
    }

    if (sub === "test") {
      await interaction.reply({ content: "📊 Generating digest…", ephemeral: true });
      try {
        await client.dailyDigestScheduler?.runNow?.(interaction.guildId);
        return interaction.editReply({
          content: "✅ Posted digest to your configured channel.",
          ephemeral: true,
        });
      } catch (e) {
        return interaction.editReply({
          content: `❌ Failed: ${e?.message || e}`,
          ephemeral: true,
        });
      }
    }
  },
};

