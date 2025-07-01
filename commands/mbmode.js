const { SlashCommandBuilder } = require('discord.js');
const checkTierAccess = require('../utils/checkTierAccess');

const MODE_TIERS = {
  default: 'free',
  chill: 'premium',
  roast: 'premium',
  villain: 'premiumplus',
  motivator: 'premiumplus'
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mbmode')
    .setDescription('Set MuscleMB\'s personality mode (premium tiers apply)')
    .addStringOption(opt =>
      opt.setName('mode')
        .setDescription('Choose a mode')
        .setRequired(true)
        .addChoices(
          { name: 'default', value: 'default' },
          { name: 'chill', value: 'chill' },
          { name: 'roast', value: 'roast' },
          { name: 'villain', value: 'villain' },
          { name: 'motivator', value: 'motivator' }
        )
    ),

  async execute(interaction) {
    const mode = interaction.options.getString('mode');
    const requiredTier = MODE_TIERS[mode];
    const userId = interaction.user.id;
    const serverId = interaction.guild?.id;

    const hasAccess = await checkTierAccess(interaction.client.pg, mode, userId, serverId);

    if (!hasAccess) {
      return interaction.reply({
        content: `🔒 This mode requires **${requiredTier}** tier access.`,
        ephemeral: true
      });
    }

    try {
      await interaction.client.pg.query(`
        INSERT INTO mb_modes (server_id, mode)
        VALUES ($1, $2)
        ON CONFLICT (server_id) DO UPDATE SET mode = EXCLUDED.mode
      `, [serverId, mode]);

      await interaction.reply({
        content: `✅ MuscleMB is now in **${mode}** mode.`,
        ephemeral: false
      });

    } catch (err) {
      console.error('❌ Error setting MB mode:', err);
      await interaction.reply({ content: '⚠️ Failed to set mode.', ephemeral: true });
    }
  }
};
