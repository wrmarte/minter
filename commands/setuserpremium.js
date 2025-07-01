const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setuserpremium')
    .setDescription('Set the premium tier for a user (bot owner only)')
    .addStringOption(opt =>
      opt.setName('user')
        .setDescription('User ID to upgrade')
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

    const userId = interaction.options.getString('user');
    const tier = interaction.options.getString('tier');

    try {
      await interaction.client.pg.query(`
        INSERT INTO premium_users (user_id, tier)
        VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET tier = EXCLUDED.tier
      `, [userId, tier]);

      // 🧠 Try to fetch actual username
      let userDisplay;
      try {
        const user = await interaction.client.users.fetch(userId);
        userDisplay = `${user.tag} (${userId})`;
      } catch {
        userDisplay = `<@${userId}>`;
      }

      await interaction.reply({
        content: `✅ User **${userDisplay}** set to **${tier}** tier.`,
        ephemeral: true
      });
    } catch (err) {
      console.error('❌ Error in /setuserpremium:', err);
      await interaction.reply({ content: '⚠️ Failed to set user tier.', ephemeral: true });
    }
  }
};
