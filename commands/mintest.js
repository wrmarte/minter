const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mintest')
    .setDescription('Simulate a mint embed for testing'),

  async execute(interaction) {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle('🟢 Mint Detected (Test)')
      .setDescription(`**Token ID:** 1234\n**To:** 0xABC...DEF`)
      .setColor(0x2ecc71)
      .setFooter({ text: 'Powered by PimpsDev • Test Mode 💾' });

    await interaction.editReply({ embeds: [embed] });
  }
};
