const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildUltraFlexCard } = require('../services/ultraFlexService');

// Dynamic import per chain
function getFlexService(chain) {
  switch (chain) {
    case 'base': return require('../services/flexcardBaseDevS');
    case 'eth': return require('../services/flexcardEthS');
    case 'ape': return require('../services/flexcardApeS');
    default: throw new Error(`Unsupported chain: ${chain}`);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
.setName('flexcarddev')
.setDescription('🧪 Dev version of FlexCard with extended metadata.')

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
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const tokenId = interaction.options.getInteger('tokenid');
    const ultraRequested = interaction.options.getBoolean('ultra') || false;
    const userIsOwner = interaction.user.id === process.env.BOT_OWNER_ID;

    try {
      // ✅ Respond quickly to avoid unknown interaction
      await interaction.deferReply(); // DO THIS FIRST

      // 🔍 Validate project
      const result = await pg.query(
        `SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2`,
        [interaction.guild.id, name]
      );

      if (!result.rows.length) {
        return await interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, display_name, name: storedName, network } = result.rows[0];
      const contractAddress = address;
      const collectionName = display_name || storedName;
      const chain = network.toLowerCase();

      if (ultraRequested && !userIsOwner) {
        return await interaction.editReply('🚫 Only the bot owner can use Ultra mode for now.');
      }

      // 📸 Generate FlexCard (NFT image, traits, etc.)
      const { buildFlexCard } = getFlexService(chain);
      const imageBuffer = ultraRequested
        ? await buildUltraFlexCard(contractAddress, tokenId, collectionName, chain)
        : await buildFlexCard(contractAddress, tokenId, collectionName, chain);

      // 📎 Send image
      const attachment = new AttachmentBuilder(imageBuffer, {
        name: ultraRequested ? 'ultraflexcard.png' : 'flexcard.png'
      });

      return await interaction.editReply({ files: [attachment] });

    } catch (err) {
      console.error('❌ FlexCard error:', err);
      try {
        await interaction.editReply('❌ Failed to generate FlexCard.');
      } catch (err2) {
        console.warn('⚠️ Could not send error message:', err2.message);
      }
    }
  }
};
