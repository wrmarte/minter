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
      // 🔒 IMMEDIATE defer
      await interaction.deferReply({ ephemeral: false });
      hasDeferred = true;

      const modules = {
        random: require('../services/flexrandom'),
        card: require('../services/flexcard'),
        plus: require('../services/flexplus'),
        duo: require('../services/flexduo')
      };

      const module = modules[sub];
      if (!module) throw new Error(`No handler found for subcommand: ${sub}`);

      await module.execute(interaction);

    } catch (err) {
      console.error(`❌ Flex /${interaction.options.getSubcommand()} error:`, err);

      // If already deferred, send editReply fallback
      if (hasDeferred) {
        try {
          await interaction.editReply('❌ Something went wrong while flexing.');
        } catch (fallbackErr) {
          console.warn('⚠️ Failed to send fallback error message:', fallbackErr.message);
        }
      }
    }
  }
};



