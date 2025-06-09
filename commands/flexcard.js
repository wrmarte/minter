const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildFlexCard } = require('../services/flexcardService');
const { buildUltraFlexCard } = require('../services/ultraFlexService');
const { generateUltraFlexCard } = require('../utils/canvas/ultraFlexRenderer');
const { resolveENS } = require('../utils/ensResolver');  
const { shortenAddress } = require('../utils/inputCleaner'); 

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexcard')
    .setDescription('Generate a FlexCard for any NFT.')
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
        .setDescription('Use Ultra Flex mode (Bot Owner only)')
        .setRequired(false)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const tokenId = interaction.options.getInteger('tokenid');
    const ultraRequested = interaction.options.getBoolean('ultra') || false;

    const userIsOwner = (interaction.user.id === process.env.BOT_OWNER_ID);
    await interaction.deferReply();

    try {
      // 🔧 FIXED SQL query with correct backticks
      const res = await pg.query(`SELECT * FROM flex_projects WHERE name = $1`, [name]);

      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, display_name, name: storedName } = res.rows[0];
      const contractAddress = address;
      const collectionName = display_name || storedName;

      if (ultraRequested && !userIsOwner) {
        return interaction.editReply('🚫 Only the bot owner can use Ultra mode for now.');
      }

      // 🔧 Ultra Mode Logic (your functional version preserved)
      if (ultraRequested) {
        const { nftImageUrl, traits, owner, openseaUrl } = await buildUltraFlexCard(contractAddress, tokenId, collectionName);

        let ownerDisplay = await resolveENS(owner);
        if (!ownerDisplay) ownerDisplay = shortenAddress(owner);

        const imageBuffer = await generateUltraFlexCard({
          nftImageUrl,
          collectionName,
          tokenId,
          traits,
          owner: ownerDisplay,
          openseaUrl
        });

        const attachment = new AttachmentBuilder(imageBuffer, { name: 'ultraflexcard.png' });
        return interaction.editReply({ files: [attachment] });
      }

      // ✅ Regular Flex
      const imageBuffer = await buildFlexCard(contractAddress, tokenId, collectionName);
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'flexcard.png' });

      await interaction.editReply({ files: [attachment] });

    } catch (err) {
      console.error('❌ FlexCard error:', err);
      await interaction.editReply('❌ Failed to generate FlexCard.');
    }
  }
};











