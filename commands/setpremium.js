const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setpremium')
    .setDescription('Set the premium tier for a server (bot owner only)')
    .addStringOption(opt =>
      opt.setName('server')
        .setDescription('Server ID to upgrade')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('tier')
        .setDescription('Tier to assign')
        .setRequired(true)
        .addChoices(
          { name: 'free', value: 'free' },
          { name: 'premium', value: 'premium' },
          { name: 'premiumplus', value: 'premiumplus' }
        )
    ),

  async execute(interaction) {
    if (interaction.user.id !== process.env.BOT_OWNER_ID) {
      return interaction.reply({ content: '❌ Only the bot owner can use this.', ephemeral: true });
    }

    const serverId = interaction.options.getString('server');
    const tier = interaction.options.getString('tier');

    try {
      await interaction.client.pg.query(`
        INSERT INTO premium_servers (server_id, tier)
        VALUES ($1, $2)
        ON CONFLICT (server_id) DO UPDATE SET tier = EXCLUDED.tier
      `, [serverId, tier]);

      const guild = interaction.client.guilds.cache.get(serverId);
      const serverName = guild ? guild.name : '(Unknown Server)';
      const status = guild ? '✅ Bot is in this server' : '❌ Bot is NOT in this server';

      await interaction.reply({
        content: `🎖️ Tier updated!\n\n**Server:** ${serverName} \`${serverId}\`\n**Tier:** ${tier}\n**Status:** ${status}`,
        ephemeral: true
      });
    } catch (err) {
      console.error('❌ Error in /setpremium:', err);
      await interaction.reply({ content: '⚠️ Failed to set tier.', ephemeral: true });
    }
  }
};


