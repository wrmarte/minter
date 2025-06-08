const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildFlexCard } = require('../services/flexcardService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexcard')
    .setDescription('Generate a full NFT card for any token.')
    .addStringOption(opt => 
      opt.setName('name')
        .setDescription('Project name (optional, pulls contract from DB)')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('contract')
        .setDescription('Contract address (if not using name)')
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('token')
        .setDescription('Token ID')
        .setRequired(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name');
    const contractInput = interaction.options.getString('contract');
    const tokenId = interaction.options.getInteger('token');

    await interaction.deferReply();

    let contractAddress = contractInput;
    let collectionName = name;

    // If user provides name, lookup contract address from PostgreSQL
    if (name) {
      const res = await pg.query('SELECT * FROM flex_projects WHERE name = $1', [name.toLowerCase()]);
      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found. Use `/addflex` first or provide contract address.');
      }
      contractAddress = res.rows[0].contract;
      collectionName = res.rows[0].display_name || res.rows[0].name;
    }

    if (!contractAddress) {
      return interaction.editReply('❌ You must provide either a project name or a contract address.');
    }

    try {
      const imageBuffer = await buildFlexCard(contractAddress, tokenId, collectionName);
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'flexcard.png' });

      await interaction.editReply({ files: [attachment] });
    } catch (err) {
      console.error('❌ FlexCard error:', err);
      await interaction.editReply('❌ Failed to generate FlexCard. Please double-check contract and token ID.');
    }
  }
};
