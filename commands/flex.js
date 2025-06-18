const { SlashCommandBuilder } = require('discord.js');

// Optional timeout helper
async function withTimeout(promise, ms = 20000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('⏱️ Timeout')), ms)
    )
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
    const moduleMap = {
      random: '../services/flexrandom',
      card: '../services/flexcard',
      plus: '../services/flexplus',
      duo: '../services/flexduo'
    };

    try {
      // Defer immediately
      await interaction.deferReply({ ephemeral: false });

      const modulePath = moduleMap[sub];
      if (!modulePath) throw new Error(`❌ Unknown subcommand: ${sub}`);

      const handler = require(modulePath);
      await withTimeout(handler.execute(interaction), 25000); // 25s safety cap

    } catch (err) {
      console.error(`❌ Flex ${sub} error:`, err);

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({
            content: '❌ Something went wrong while flexing.'
          });
        } else {
          await interaction.reply({
            content: '❌ Flex failed before it could even start.',
            ephemeral: true
          });
        }
      } catch (fail) {
        console.warn('⚠️ Could not respond to interaction:', fail.message);
      }
    }
  }
};
