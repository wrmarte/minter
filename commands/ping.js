const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Ping pong test'),

  async execute(interaction) {
    try {
      await interaction.reply({ content: '🏓 Pong!', ephemeral: true });
    } catch (err) {
      console.error('❌ Error in /ping:', err);
    }
  }
};

