module.exports = (client, pg) => {
  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    console.log(`🎯 Received slash command: /${interaction.commandName}`);

    const command = client.commands.get(interaction.commandName);
    if (!command) {
      console.warn(`❌ No command found for: /${interaction.commandName}`);
      return;
    }

    try {
      // ✅ Pass pg to the command
      await command.execute(interaction, { pg });
    } catch (error) {
      console.error(`❌ Error executing /${interaction.commandName}:`, error);

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: '⚠️ Something went wrong.' });
        } else {
          await interaction.reply({ content: '⚠️ Error executing command.', ephemeral: true });
        }
      } catch (fallbackError) {
        console.error('⚠️ Failed to send error message:', fallbackError.message);
      }
    }
  });
};




