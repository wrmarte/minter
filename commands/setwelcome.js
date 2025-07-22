const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const BOT_OWNER_ID = process.env.BOT_OWNER_ID;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setwelcome')
    .setDescription('Enable or disable welcome messages in this server')
    .addBooleanOption(option =>
      option.setName('enabled')
        .setDescription('Enable or disable welcome messages')
        .setRequired(true)
    )
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Channel to send welcome messages')
        .setRequired(true)
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const isOwner = userId === BOT_OWNER_ID;
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

    if (!isOwner && !isAdmin) {
      return await interaction.reply({ content: '❌ You must be an admin or the bot owner to use this command.', ephemeral: true });
    }

    const enabled = interaction.options.getBoolean('enabled');
    const channel = interaction.options.getChannel('channel');
    const guildId = interaction.guild.id;
    const pg = interaction.client.pg;

    try {
      await pg.query(`
        INSERT INTO welcome_settings (guild_id, enabled, welcome_channel_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (guild_id) DO UPDATE SET enabled = $2, welcome_channel_id = $3
      `, [guildId, enabled, channel.id]);

      await interaction.reply({
        content: `✅ Welcome messages have been **${enabled ? 'enabled' : 'disabled'}** in <#${channel.id}>.`,
        ephemeral: true
      });
    } catch (err) {
      console.error(`❌ Failed to set welcome config for guild ${guildId}:`, err);
      await interaction.reply({ content: '❌ Failed to save settings.', ephemeral: true });
    }
  }
};

