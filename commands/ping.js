const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Ping the bot'),

  async execute(interaction) {
    console.log('✅ /ping command triggered');

    try {
      await interaction.reply({ content: '🏓 Pong!', ephemeral: true });
    } catch (err) {
      console.error('❌ Error executing /ping:', err.message);

      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply('⚠️ Failed to pong.');
        } else {
          await interaction.reply({ content: '⚠️ Pong failed.', ephemeral: true });
        }
      } catch (nestedErr) {
        console.error('❌ Failed to send fallback ping error:', nestedErr.message);
      }
    }
  }
};


