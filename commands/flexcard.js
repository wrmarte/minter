const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildFlexCard } = require('../services/flexcardService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexcard')
    .setDescription('Generate a full NFT FlexCard from your projects')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Project name')
        .setRequired(true)
        .setAutocomplete(true) // ✅ Enable autocomplete like your flex.js
    )
    .addIntegerOption(opt =>
      opt.setName('tokenid')
        .setDescription('Token ID')
        .setRequired(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const tokenId = interaction.options.getInteger('tokenid');
    await interaction.deferReply();

    try {
      // Lookup contract from PostgreSQL by project name
      const res = await pg.query(`SELECT * FROM flex_projects WHERE name = $1`, [name]);
      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, display_name, name: storedName } = res.rows[0];
      const contractAddress = address;
      const collectionName = display_name || storedName;

      const imageBuffer = await buildFlexCard(contractAddress, tokenId, collectionName);
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'flexcard.png' });

      await interaction.editReply({ files: [attachment] });
    } catch (err) {
      console.error('❌ FlexCard error:', err);
      await interaction.editReply('❌ Failed to generate FlexCard. Please double-check token ID.');
    }
  }
};


