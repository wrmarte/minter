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
    const name = interaction.options.getString('name')?.toLowerCase();
    const tokenId = interaction.options.getInteger('tokenid');
    const pg = interaction.client.pg;

    if (!isOwner) {
      try {
        return await interaction.reply({
          content: '🚫 This command is restricted to the bot owner.',
          flags: 1 << 6 // ephemeral flag
        });
      } catch (err) {
        console.warn('⚠️ Failed to reply to non-owner:', err.message);
        return;
      }
    }

    try {
      await interaction.deferReply();

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

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('❌ Failed to generate FlexDev card.');
        } else {
          await interaction.reply({ content: '❌ Failed to generate FlexDev card.', ephemeral: true });
        }
      } catch (fallbackErr) {
        console.warn('⚠️ Failed to send fallback reply:', fallbackErr.message);
      }
    }
  }
};

