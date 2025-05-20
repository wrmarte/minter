module.exports = async (interaction, commands, context) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, context);
  } catch (error) {
    console.error(`❌ Error running command /${interaction.commandName}:`, error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: '❌ Something went wrong.', ephemeral: true });
    } else {
      await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
    }
  }
};

