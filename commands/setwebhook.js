/**
 * /setwebhook
 * ------------------------------------------------------
 * Creates or updates the MB Relay webhook for this server
 * and stores it in Postgres.
 *
 * REQUIREMENTS:
 * - Bot has "Manage Webhooks"
 * - User has "Manage Webhooks"
 * - client.pg is a connected pg Pool
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setwebhook')
    .setDescription('Create or update the MB Relay webhook for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageWebhooks),

  async execute(interaction) {
    const { client, guild, channel, member } = interaction;

    // ─────────────────────────────────────────────
    // 1. Permission checks
    // ─────────────────────────────────────────────
    if (!member.permissions.has(PermissionFlagsBits.ManageWebhooks)) {
      return interaction.reply({
        content: '❌ You need **Manage Webhooks** permission.',
        ephemeral: true
      });
    }

    if (!client.pg) {
      return interaction.reply({
        content: '❌ Database not available.',
        ephemeral: true
      });
    }

    // ─────────────────────────────────────────────
    // 2. Defer reply (webhook creation can take a sec)
    // ─────────────────────────────────────────────
    await interaction.deferReply({ ephemeral: true });

    try {
      // ─────────────────────────────────────────────
      // 3. Delete old webhook if it exists
      // ─────────────────────────────────────────────
      const existing = await client.pg.query(
        'SELECT webhook_url FROM server_webhooks WHERE guild_id = $1',
        [guild.id]
      );

      if (existing.rowCount > 0) {
        try {
          const url = existing.rows[0].webhook_url;
          const id = url.split('/').slice(-2, -1)[0];
          const token = url.split('/').pop();

          const oldWebhook = await client.fetchWebhook(id, token);
          await oldWebhook.delete('Replacing MB Relay webhook');
        } catch (_) {
          // Ignore failures (webhook might already be deleted)
        }
      }

      // ─────────────────────────────────────────────
      // 4. Create new webhook
      // ─────────────────────────────────────────────
      const webhook = await channel.createWebhook({
        name: 'MB Relay',
        avatar: client.user.displayAvatarURL()
      });

      // ─────────────────────────────────────────────
      // 5. Store in database
      // ─────────────────────────────────────────────
      await client.pg.query(`
        INSERT INTO server_webhooks (guild_id, channel_id, webhook_url)
        VALUES ($1, $2, $3)
        ON CONFLICT (guild_id)
        DO UPDATE SET
          channel_id = EXCLUDED.channel_id,
          webhook_url = EXCLUDED.webhook_url
      `, [
        guild.id,
        channel.id,
        webhook.url
      ]);

      // ─────────────────────────────────────────────
      // 6. Confirmation embed
      // ─────────────────────────────────────────────
      const embed = new EmbedBuilder()
        .setColor(0x00ff9c)
        .setTitle('✅ MB Relay Webhook Set')
        .setDescription(
          `**Server:** ${guild.name}\n` +
          `**Channel:** <#${channel.id}>\n\n` +
          `All relay & sweep alerts will post here.`
        )
        .setFooter({ text: 'MuscleMB • Relay System' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

    } catch (err) {
      console.error('[setwebhook]', err);

      await interaction.editReply({
        content: '❌ Failed to create webhook. Check bot permissions.'
      });
    }
  }
};
