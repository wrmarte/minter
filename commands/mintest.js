const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mintest')
    .setDescription('Simulate a mint message for testing'),

  async execute(interaction) {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle('🧪 Mint Test')
      .setDescription('Simulated mint alert for testing display')
      .setFooter({ text: 'Powered by PimpsDev' })
      .setColor(0x3498db);

    await interaction.editReply({ embeds: [embed] });
  }
};
