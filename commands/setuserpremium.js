const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setuserpremium')
    .setDescription('Set the premium tier for a user (bot owner only)')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Select the user (autocomplete supported)')
        .setRequired(true)
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

    const user = interaction.options.getUser('user');
    const tier = interaction.options.getString('tier');

    try {
      await interaction.client.pg.query(`
        INSERT INTO premium_users (user_id, tier)
        VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET tier = EXCLUDED.tier
      `, [user.id, tier]);

      await interaction.reply({
        content: `🎟️ Tier updated for user: **${user.tag}** (\`${user.id}\`)\n**Tier:** ${tier}`,
        ephemeral: true
      });

    } catch (err) {
      console.error('❌ Error in /setuserpremium:', err);
      await interaction.reply({ content: '⚠️ Failed to set user tier.', ephemeral: true });
    }
  }
};


