const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const BOT_OWNER_ID = process.env.BOT_OWNER_ID;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unwelcome')
    .setDescription('Remove welcome configuration from this server'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const isOwner = userId === BOT_OWNER_ID;
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

    if (!isOwner && !isAdmin) {
      return await interaction.reply({ content: '❌ You must be an admin or the bot owner to use this command.', ephemeral: true });
    }

    const pg = interaction.client.pg;

    try {
      await pg.query(`DELETE FROM welcome_settings WHERE guild_id = $1`, [interaction.guild.id]);
      await interaction.reply({ content: `✅ Welcome settings removed for this server.`, ephemeral: true });
    } catch (err) {
      console.error('❌ Failed to remove welcome settings:', err);
      await interaction.reply({ content: '❌ Failed to remove settings.', ephemeral: true });
    }
  }
};
