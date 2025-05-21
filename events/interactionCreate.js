module.exports = async (interaction, commands, context) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, context);
  } catch (err) {
    console.error(`❌ Error executing /${interaction.commandName}:`, err);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: '❌ Error running command.' });
    } else {
      await interaction.reply({ content: '❌ Failed to run command.', ephemeral: true });
    }
  }
};
