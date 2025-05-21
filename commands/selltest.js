const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('selltest')
    .setDescription('Simulate a token-based sale alert')
    .addStringOption(option =>
      option.setName('tokenid')
        .setDescription('Token ID of NFT sold')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('seller')
        .setDescription('Seller address')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('buyer')
        .setDescription('Buyer address')
        .setRequired(true))
    .addNumberOption(option =>
      option.setName('amount')
        .setDescription('Sale amount')
        .setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply();

    const tokenId = interaction.options.getString('tokenid');
    const seller = interaction.options.getString('seller');
    const buyer = interaction.options.getString('buyer');
    const amount = interaction.options.getNumber('amount');

    const embed = new EmbedBuilder()
      .setTitle('🟨 NFT Sold via Token!')
      .setDescription(`**Token ID:** #${tokenId}\n**Seller:** ${seller}\n**Buyer:** ${buyer}\n**Amount:** ${amount} Token`)
      .setColor(0xF1C40F)
      .setFooter({ text: 'Powered by PimpsDev' });

    await interaction.editReply({ embeds: [embed] });
  }
};


