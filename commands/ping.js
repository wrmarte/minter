const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if the bot is alive'),

  async execute(interaction) {
    try {
      await interaction.reply({ content: '🏓 Pong!', ephemeral: true });
    } catch (err) {
      console.error('❌ Error in /ping:', err.message);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply('⚠️ Pong failed.');
        } else {
          await interaction.reply({ content: '⚠️ Pong failed.', ephemeral: true });
        }
      } catch (nestedErr) {
        console.error('❌ Failed to send fallback reply:', nestedErr.message);
      }
    }
  }
};

