module.exports = client => {
  client.on('interactionCreate', async interaction => {
    console.log('🎯 interaction received:', interaction.commandName); // Log which command hit

    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) {
      console.log(`❌ Command not found in map: ${interaction.commandName}`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`❌ Error executing /${interaction.commandName}:`, error);

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: '⚠️ Something went wrong.' });
        } else {
          await interaction.reply({ content: '⚠️ Error executing command.', ephemeral: true });
        }
      } catch (err) {
        console.error('⚠️ Failed to send error response:', err.message);
      }
    }
  });
};



