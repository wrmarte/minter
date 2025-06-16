const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildFlexCard } = require('../services/flexcardBaseDevS');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexdev')
    .setDescription('Developer test FlexCard with experimental features (Owner only).')
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
    ),

 async execute(interaction) {
  const isOwner = interaction.user.id === process.env.BOT_OWNER_ID;

  // Defer as early as possible to prevent timeout (before any DB calls)
  await interaction.deferReply({ ephemeral: false }).catch(() => {});

  if (!isOwner) {
    return await interaction.editReply({
      content: '🚫 This command is restricted to the bot owner.'
    });
  }

  const pg = interaction.client.pg;
  const name = interaction.options.getString('name')?.toLowerCase();
  const tokenId = interaction.options.getInteger('tokenid');

  try {
    const result = await pg.query(
      `SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2`,
      [interaction.guild.id, name]
    );

    if (!result.rows.length) {
      return await interaction.editReply('❌ Project not found. Use `/addflex` first.');
    }

    const { address, display_name, name: storedName } = result.rows[0];
    const contractAddress = address;
    const collectionName = display_name || storedName;

    const imageBuffer = await buildFlexCard(contractAddress, tokenId, collectionName);
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'flexdev.png' });

    return await interaction.editReply({ files: [attachment] });

  } catch (err) {
    console.error('❌ FlexDev error:', err);

    if (interaction.deferred || interaction.replied) {
      try {
        await interaction.editReply('❌ Failed to generate FlexDev card.');
      } catch (innerErr) {
        console.warn('⚠️ Failed to send error reply:', innerErr.message);
      }
    } else {
      try {
        await interaction.reply('❌ Failed to generate FlexDev card.');
      } catch (innerErr) {
        console.warn('⚠️ Failed to send fallback reply:', innerErr.message);
      }
    }
  }
}
