const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flex')
    .setDescription('Flex NFTs in various formats')
    .addSubcommand(sub =>
      sub.setName('random')
        .setDescription('Flex a random NFT from a project')
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('Project name')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addIntegerOption(opt =>
          opt.setName('tokenid')
            .setDescription('Token ID to flex (optional)')
            .setAutocomplete(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('card')
        .setDescription('Generate a FlexCard')
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('Project name')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addIntegerOption(opt =>
          opt.setName('tokenid')
            .setDescription('Token ID')
            .setRequired(true)
        )
        .addBooleanOption(opt =>
          opt.setName('ultra')
            .setDescription('Use UltraFlex mode')
        )
    )
    .addSubcommand(sub =>
      sub.setName('plus')
        .setDescription('Show a FlexPlus collage')
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('Project name')
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('duo')
        .setDescription('Display a side-by-side duo')
        .addStringOption(opt =>
          opt.setName('name')
            .setDescription('Duo name (set via /addflexduo)')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addIntegerOption(opt =>
          opt.setName('tokenid')
            .setDescription('Token ID to flex (optional)')
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    let hasDeferred = false;

    try {
      await interaction.deferReply();
      hasDeferred = true;

      let module;

      switch (sub) {
        case 'random':
          module = require('../services/flexrandom');
          break;
        case 'card':
          module = require('../services/flexcard');
          break;
        case 'plus':
          module = require('../services/flexplus');
          break;
        case 'duo':
          module = require('../services/flexduo');
          break;
        default:
          throw new Error('Unknown flex subcommand.');
      }

      await module.execute(interaction);

    } catch (err) {
      console.error(`❌ Flex /${sub} error:`, err);
      if (hasDeferred) {
        try {
          await interaction.editReply('❌ Something went wrong while executing this flex command.');
        } catch (innerErr) {
          console.warn('⚠️ Failed to send fallback error message:', innerErr.message);
        }
      }
    }
  }
};


