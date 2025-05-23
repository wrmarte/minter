const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Ping the bot'),

  async execute(interaction) {
    console.log('✅ /ping command hit');

    await interaction.reply({ content: '🏓 Pong!', ephemeral: true });
  }
};

