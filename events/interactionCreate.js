module.exports = (client, pg) => {
  client.on('interactionCreate', async interaction => {
    // 🔍 Autocomplete support
    if (interaction.isAutocomplete()) {
      const { commandName, options } = interaction;
      const focused = options.getFocused(true);
      const guildId = interaction.guild?.id;

      if (!guildId) {
        console.warn('⚠️ Autocomplete interaction received without a guild context.');
        return await interaction.respond([]);
      }

      try {
        let rows = [];

        if (commandName === 'flexduo' && focused.name === 'name') {
          const res = await pg.query(
            `SELECT name FROM flex_duo WHERE guild_id = $1`,
            [guildId]
          );
          rows = res.rows;
        }

        if ((commandName === 'flex' || commandName === 'flexplus') && focused.name === 'name') {
          const res = await pg.query(
            `SELECT name FROM flex_projects WHERE guild_id = $1`,
            [guildId]
          );
          rows = res.rows;
        }

        const choices = rows.map(row => row.name);
        const filtered = choices
          .filter(name => name.toLowerCase().includes(focused.value.toLowerCase()))
          .slice(0, 25);

        console.log(`🔁 Autocomplete for /${commandName}:`, filtered);

        return await interaction.respond(filtered.map(name => ({ name, value: name })));
      } catch (err) {
        console.error('❌ Autocomplete error:', err);
        return await interaction.respond([]);
      }
    }

    // 🧠 Normal slash command handling
    if (!interaction.isChatInputCommand()) return;

    console.log(`🎯 Received slash command: /${interaction.commandName}`);

    const command = client.commands.get(interaction.commandName);
    if (!command) {
      console.warn(`❌ No command found for: /${interaction.commandName}`);
      return;
    }

    try {
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






