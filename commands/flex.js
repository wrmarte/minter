const { SlashCommandBuilder } = require('discord.js');

// Optional timeout helper
async function withTimeout(promise, ms = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('⏱️ Timeout')), ms))
  ]);
}

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
    try {
      await interaction.deferReply();

      const moduleMap = {
        random: '../services/flexrandom',
        card: '../services/flexcard',
        plus: '../services/flexplus',
        duo: '../services/flexduo'
      };

      const modulePath = moduleMap[sub];
      if (!modulePath) throw new Error(`❌ Unknown subcommand: ${sub}`);

      const handler = require(modulePath);
      return await withTimeout(handler.execute(interaction));

    } catch (err) {
      console.error(`❌ Flex ${interaction.options.getSubcommand()} error:`, err);

      if (!interaction.deferred && !interaction.replied) {
        try {
          await interaction.reply({ content: '❌ Something went wrong while flexing.', ephemeral: true });
        } catch (e) {
          console.warn('⚠️ Could not send error reply:', e.message);
        }
      }
    }
  }
};





