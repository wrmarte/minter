const { SlashCommandBuilder } = require('discord.js');
const checkTierAccess = require('../utils/checkTierAccess');

const MODE_TIERS = {
  default: 'free',
  chill: 'premium',
  roast: 'premium',
  villain: 'premiumplus',
  motivator: 'premiumplus',
  drill: 'premium',
  oracle: 'premiumplus',
  lover: 'premium',
  troll: 'premium',
  zen: 'premiumplus',
  coder: 'premium',
  random: 'premiumplus'
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
          { name: 'motivator', value: 'motivator' },
          { name: 'drill', value: 'drill' },
          { name: 'oracle', value: 'oracle' },
          { name: 'lover', value: 'lover' },
          { name: 'troll', value: 'troll' },
          { name: 'zen', value: 'zen' },
          { name: 'coder', value: 'coder' },
          { name: 'random', value: 'random' }
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
