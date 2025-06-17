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
  let replied = false;
  try {
    await interaction.deferReply({ ephemeral: true }); // ✅ Defer early
    replied = true;

    const name = interaction.options.getString('name');
    const tokenId = interaction.options.getInteger('tokenid');

    // 🔍 Simulate fetchExtras
    const extras = await fetchMetadataExtras('0xc38e2ae060440c9269cceb8c0ea8019a66ce8927', tokenId, 'base');

    console.log('📦 MetadataExtras:', extras);

    await interaction.editReply({
      content: `✅ Metadata fetched for #${tokenId}:\n\`\`\`json\n${JSON.stringify(extras, null, 2)}\n\`\`\``
    });
  } catch (err) {
    console.error('❌ FlexDev error:', err);

    // 🔁 Fallback reply if not already replied
    if (!replied && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: '❌ Unexpected error occurred during /flexdev.', ephemeral: true });
      } catch (fallbackErr) {
        console.warn('⚠️ Failed to send fallback reply:', fallbackErr.message);
      }
    }
  }
}
