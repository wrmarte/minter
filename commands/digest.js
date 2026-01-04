// commands/digest.js
const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("digest")
    .setDescription("Daily mint/sales digest automation")
    .addSubcommand(sc =>
      sc.setName("setup")
        .setDescription("Enable daily digest for this server")
        .addChannelOption(o =>
          o.setName("channel").setDescription("Channel to post daily digest").setRequired(true)
        )
        .addIntegerOption(o =>
          o.setName("hour").setDescription("Hour (0-23) in timezone").setRequired(true)
        )
        .addIntegerOption(o =>
          o.setName("minute").setDescription("Minute (0-59)").setRequired(false)
        )
        .addStringOption(o =>
          o.setName("tz").setDescription("IANA timezone (e.g. UTC, America/New_York)").setRequired(false)
        )
    )
    .addSubcommand(sc =>
      sc.setName("off")
        .setDescription("Disable daily digest for this server")
    )
    .addSubcommand(sc =>
      sc.setName("test")
        .setDescription("Post a digest now (last 24h)")
    ),

  async execute(interaction, client) {
    if (!interaction.guildId) return;

    const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
    const ownerId = String(process.env.BOT_OWNER_ID || "").trim();
    const isOwner = ownerId && interaction.user?.id === ownerId;

    if (!isAdmin && !isOwner) {
      return interaction.reply({ content: "Admin only.", ephemeral: true });
    }

    const pg = client?.pg;
    if (!pg?.query) return interaction.reply({ content: "DB not connected.", ephemeral: true });

    const sub = interaction.options.getSubcommand();

    if (sub === "setup") {
      const channel = interaction.options.getChannel("channel", true);
      const hour = interaction.options.getInteger("hour", true);
      const minute = interaction.options.getInteger("minute") ?? 0;
      const tz = interaction.options.getString("tz") || "UTC";

      if (hour < 0 || hour > 23) return interaction.reply({ content: "Hour must be 0-23.", ephemeral: true });
      if (minute < 0 || minute > 59) return interaction.reply({ content: "Minute must be 0-59.", ephemeral: true });

      await pg.query(
        `
        INSERT INTO daily_digest_settings (guild_id, channel_id, enabled, tz, hour, minute, updated_at)
        VALUES ($1,$2,TRUE,$3,$4,$5,NOW())
        ON CONFLICT (guild_id)
        DO UPDATE SET channel_id=EXCLUDED.channel_id, enabled=TRUE, tz=EXCLUDED.tz, hour=EXCLUDED.hour, minute=EXCLUDED.minute, updated_at=NOW()
        `,
        [String(interaction.guildId), String(channel.id), String(tz), Number(hour), Number(minute)]
      );

      try {
        await client.dailyDigestScheduler?.rescheduleGuild?.(interaction.guildId);
      } catch {}

      return interaction.reply({
        content: `✅ Daily digest enabled in <#${channel.id}> at **${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}** (**${tz}**)`,
        ephemeral: true,
      });
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
        return interaction.editReply({ content: "✅ Posted digest to your configured channel.", ephemeral: true });
      } catch (e) {
        return interaction.editReply({ content: `❌ Failed: ${e?.message || e}`, ephemeral: true });
      }
    }
  },
};
