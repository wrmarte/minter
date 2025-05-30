const { flavorMap } = require('../utils/flavorMap');  // ✅ pulling from external now

module.exports = (client, pg) => {
  client.on('interactionCreate', async interaction => {

    // 🔍 Autocomplete support
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

        if (commandName === 'flexduo' && focused.name === 'name') {
          const res = await pg.query(`SELECT name FROM flex_duo WHERE guild_id = $1`, [guildId]);
          rows = res.rows;
        }

        if (
          (commandName === 'flex' ||
           commandName === 'flexplus' ||
           commandName === 'flexspin') &&
          focused.name === 'name'
        ) {
          const res = await pg.query(`SELECT name FROM flex_projects WHERE guild_id = $1`, [guildId]);
          rows = res.rows;
        }

        if (commandName === 'exp' && focused.name === 'name') {
          // Build native flavorMap options
          const flavorChoices = Object.keys(flavorMap).map(name => ({
            name: `${name}  (🔥 Built-in)`,
            value: name
          }));

          let query, params;
          const isOwner = userId === ownerId;

          if (isOwner) {
            query = `SELECT DISTINCT name, guild_id FROM expressions`;
            params = [];
          } else {
            query = `SELECT DISTINCT name, guild_id FROM expressions WHERE guild_id = $1 OR guild_id IS NULL`;
            params = [guildId];
          }

          const res = await pg.query(query, params);
          const dbChoices = await Promise.all(res.rows.map(async row => {
            let tagIcon, tagLabel;

            if (row.guild_id === null) {
              tagIcon = '🌐'; tagLabel = 'Global';
            } else if (row.guild_id === guildId) {
              tagIcon = '🏠'; tagLabel = 'This Server';
            } else {
              const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
              if (guild) {
                tagIcon = '🛡️';
                tagLabel = guild.name.length > 20 ? guild.name.slice(0, 20) + '…' : guild.name;
              } else {
                tagIcon = '🛡️';
                tagLabel = 'Other Server';
              }
            }

            return {
              name: `${row.name}  (${tagIcon} ${tagLabel})`,
              value: row.name
            };
          }));

          const combined = [...flavorChoices, ...dbChoices];

          const filtered = combined
            .filter(c => c.name.toLowerCase().includes(focused.value.toLowerCase()))
            .slice(0, 25);

          console.log(`🔁 Professional Autocomplete for /exp:`, filtered);
          return await interaction.respond(filtered);
        }

        // Normal autocomplete fallback
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


















