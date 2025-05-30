const { flavorMap } = require('../utils/flavorMap');

module.exports = (client, pg) => {
  client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
      const { commandName, options } = interaction;
      const focused = options.getFocused(true);
      const guildId = interaction.guild?.id;
      const userId = interaction.user.id;
      const ownerId = process.env.BOT_OWNER_ID;

      if (!guildId && commandName !== 'exp') {
        console.warn('⚠️ Autocomplete interaction received without a guild context.');
        return await interaction.respond([]);
      }

      try {
        let rows = [];

        // Flex duo autocomplete
        if (commandName === 'flexduo' && focused.name === 'name') {
          const res = await pg.query(`SELECT name FROM flex_duo WHERE guild_id = $1`, [guildId]);
          rows = res.rows;
        }

        // Flex, flexplus, flexspin autocomplete
        if (
          (commandName === 'flex' ||
            commandName === 'flexplus' ||
            commandName === 'flexspin') &&
          focused.name === 'name'
        ) {
          const res = await pg.query(`SELECT name FROM flex_projects WHERE guild_id = $1`, [guildId]);
          rows = res.rows;
        }

        // EXP AUTOCOMPLETE 🔥
        if (commandName === 'exp' && focused.name === 'name') {
          const isOwner = userId === ownerId;

          // Built-in flavors
          const builtInChoices = Object.keys(flavorMap).map(name => ({
            name: `🔥 ${name} (Built-in)`,
            value: name
          }));

          let query, params;

          if (isOwner) {
            query = `SELECT DISTINCT name, guild_id FROM expressions`;
            params = [];
          } else {
            query = `SELECT DISTINCT name, guild_id FROM expressions WHERE guild_id = $1 OR guild_id IS NULL`;
            params = [guildId];
          }

          const res = await pg.query(query, params);

          // Group results
          const thisServer = [];
          const global = [];
          const otherServers = [];

          for (const row of res.rows) {
            if (!row.name) continue;

            if (row.guild_id === null) {
              global.push({ name: `🌐 ${row.name} (Global)`, value: row.name });
            } else if (row.guild_id === guildId) {
              thisServer.push({ name: `🏠 ${row.name} (This Server)`, value: row.name });
            } else {
              const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
              const guildName = guild ? guild.name : 'Other Server';
              otherServers.push({ name: `🛡️ ${row.name} (${guildName})`, value: row.name });
            }
          }

          // Merge all groups with polished ordering
          const combined = [
            ...builtInChoices,
            ...thisServer,
            ...global,
            ...otherServers
          ];

          const filtered = combined
            .filter(c => c.name.toLowerCase().includes(focused.value.toLowerCase()))
            .slice(0, 25);

          console.log(`🔁 Polished Autocomplete for /exp:`, filtered);
          return await interaction.respond(filtered);
        }

        // Default fallback for flex/flexplus/flexspin etc
        const choices = rows.map(row => row.name).filter(Boolean);
        const filtered = choices
          .filter(name => name.toLowerCase().includes(focused.value.toLowerCase()))
          .slice(0, 25);

        console.log(`🔁 Autocomplete for /${commandName}:`, filtered);
        return await interaction.respond(filtered.map(name => ({ name, value: name })));
      } catch (err) {
        console.error('❌ Autocomplete error:', err);
        try {
          return await interaction.respond([]);
        } catch (timeoutErr) {
          console.warn('⚠️ Autocomplete fallback timeout:', timeoutErr.message);
        }
      }
    }

    // 🧠 Slash command handler
    if (!interaction.isChatInputCommand()) return;

    console.log(`🎯 Received slash command: /${interaction.commandName}`);

    const command = client.commands.get(interaction.commandName);
    if (!command) {
      console.warn(`❌ No command found for: /${interaction.commandName}`);
      return;
    }

    try {
      const needsPg = command.execute.length > 1;
      if (needsPg) {
        await command.execute(interaction, { pg });
      } else {
        await command.execute(interaction);
      }
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



















