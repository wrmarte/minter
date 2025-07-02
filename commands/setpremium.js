const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setpremium')
    .setDescription('Set the premium tier for a server (bot owner only)')
    .addStringOption(opt =>
      opt.setName('serverid')
        .setDescription('Optional server ID to upgrade (defaults to current server)')
        .setRequired(false)
    )
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

    const manualServerId = interaction.options.getString('serverid');
    const tier = interaction.options.getString('tier');

    const serverId = manualServerId || interaction.guild?.id;
    if (!serverId) {
      return interaction.reply({ content: '❌ No server context or server ID provided.', ephemeral: true });
    }

    let serverName = '(Unknown Server)';
    try {
      const guild = interaction.client.guilds.cache.get(serverId);
      if (guild) serverName = guild.name;
    } catch {
      // Keep default name
    }

    try {
      await interaction.client.pg.query(`
        INSERT INTO premium_servers (server_id, tier)
        VALUES ($1, $2)
        ON CONFLICT (server_id) DO UPDATE SET tier = EXCLUDED.tier
      `, [serverId, tier]);

      await interaction.reply({
        content: `✅ Server **${serverName}** (\`${serverId}\`) set to **${tier}** tier.`,
        ephemeral: true
      });
    } catch (err) {
      console.error('❌ Error in /setpremium:', err);
      await interaction.reply({ content: '⚠️ Failed to set tier.', ephemeral: true });
    }
  }
};




