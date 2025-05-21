const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('selltest')
    .setDescription('Simulate a token-based sale alert'),

  async execute(interaction) {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle('🟨 Token Sale Detected (Test)')
      .setDescription(`
**Amount:** 1000  
**Token:** ADRIAN  
**Seller:** 0xSeller...123  
**Buyer:** 0xBuyer...456`)
      .setColor(0xf1c40f)
      .setFooter({ text: 'Powered by PimpsDev • Test Mode 💾' });

    await interaction.editReply({ embeds: [embed] });
  }
};


