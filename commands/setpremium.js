const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setpremium')
    .setDescription('Set the premium tier for a server (bot owner only)')
    .addStringOption(opt =>
      opt.setName('tier')
        .setDescription('Tier to assign')
        .setRequired(true)
        .addChoices(
          { name: 'Free', value: 'free' },
          { name: 'Premium', value: 'premium' },
          { name: 'Premium Plus', value: 'premiumplus' }
        )
    )
    .addStringOption(opt =>
      opt.setName('servername')
        .setDescription('Optional server name (or use in server)')
        .setRequired(false)
    ),

  async execute(interaction) {
    if (interaction.user.id !== process.env.BOT_OWNER_ID) {
      return interaction.reply({ content: '❌ Only the bot owner can use this.', ephemeral: true });
    }

    const tier = interaction.options.getString('tier');
    const inputName = interaction.options.getString('servername');

    let targetGuild = null;

    if (inputName) {
      const match = interaction.client.guilds.cache.find(g =>
        g.name.toLowerCase().includes(inputName.toLowerCase())
      );
      if (match) targetGuild = match;
    }

    if (!targetGuild && interaction.guild) {
      targetGuild = interaction.guild;
    }

    if (!targetGuild) {
      return interaction.reply({
        content: '❌ Could not find a matching server. Make sure the bot is in that server.',
        ephemeral: true
      });
    }

    try {
      await interaction.client.pg.query(`
        INSERT INTO premium_servers (server_id, tier)
        VALUES ($1, $2)
        ON CONFLICT (server_id) DO UPDATE SET tier = EXCLUDED.tier
      `, [targetGuild.id, tier]);

      await interaction.reply({
        content: `✅ Server **${targetGuild.name}** (\`${targetGuild.id}\`) set to **${tier}** tier.`,
        ephemeral: true
      });

    } catch (err) {
      console.error('❌ Error in /setpremium:', err);
      await interaction.reply({ content: '⚠️ Failed to set tier.', ephemeral: true });
    }
  }
};






