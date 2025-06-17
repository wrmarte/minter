const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildFlexCard } = require('../services/flexcardBaseDevS');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexdev')
    .setDescription('Developer debug for Flex metadata')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Project name')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('tokenid')
        .setDescription('Token ID')
        .setRequired(true)
    ),
  async execute(interaction) {
    try {
      await interaction.deferReply({ ephemeral: true }); // ✅ defer early

      const name = interaction.options.getString('name');
      const tokenId = interaction.options.getInteger('tokenid');

      // your logic...
      const extras = await fetchMetadataExtras(contractAddress, tokenId, network);
      console.log('📦 MetadataExtras:', extras);

      await interaction.editReply({ content: `✅ Metadata fetched: \`\`\`${JSON.stringify(extras, null, 2)}\`\`\`` });
    } catch (err) {
      console.error('❌ FlexDev error:', err);
      if (!interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({ content: '❌ Unexpected error occurred.', ephemeral: true });
        } catch (e) {
          console.warn('⚠️ Failed to send fallback reply:', e.message);
        }
      }
    }
  }
};
