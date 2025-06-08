const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildFlexCard } = require('../services/flexcardService');
const { buildUltraFlexCard } = require('../services/ultraFlexService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexcard')
    .setDescription('Generate a FlexCard for any NFT.')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Project name')
        .setRequired(true)
        .setAutocomplete(true)  // 🔧 AUTOCOMPLETE fully restored ✅
    )
    .addIntegerOption(opt =>
      opt.setName('tokenid')
        .setDescription('Token ID')
        .setRequired(true)
    )
    .addBooleanOption(opt =>
      opt.setName('ultra')
        .setDescription('Use Ultra Flex mode (Admins only)')
        .setRequired(false)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const tokenId = interaction.options.getInteger('tokenid');
    const ultraRequested = interaction.options.getBoolean('ultra') || false;

    const userIsAdmin = (
      interaction.user.id === process.env.BOT_OWNER_ID ||
      interaction.member.permissions.has('Administrator')
    );

    await interaction.deferReply();

    try {
      const res = await pg.query(`SELECT * FROM flex_projects WHERE name = $1`, [name]);
      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, display_name, name: storedName } = res.rows[0];
      const contractAddress = address;
      const collectionName = display_name || storedName;

      // Permission check for Ultra
      if (ultraRequested && !userIsAdmin) {
        return interaction.editReply('🚫 You do not have permission to use Ultra Flex mode.');
      }

      // Select rendering engine
      const imageBuffer = ultraRequested
        ? await buildUltraFlexCard(contractAddress, tokenId, collectionName)
        : await buildFlexCard(contractAddress, tokenId, collectionName);

      const fileName = ultraRequested ? 'ultraflexcard.png' : 'flexcard.png';
      const attachment = new AttachmentBuilder(imageBuffer, { name: fileName });

      // ✅ CLEAN OUTPUT — image only, no embeds, no clutter ✅
      await interaction.editReply({ files: [attachment] });

    } catch (err) {
      console.error('❌ FlexCard error:', err);
      await interaction.editReply('❌ Failed to generate FlexCard.');
    }
  }
};







