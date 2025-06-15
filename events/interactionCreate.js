const { flavorMap } = require('../utils/flavorMap');
const { Contract } = require('ethers');
const fetch = require('node-fetch');
const { getProvider } = require('../services/provider');

module.exports = (client, pg) => {
  const guildNameCache = new Map();

  client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
      const { commandName, options } = interaction;
      const focused = options.getFocused(true);
      const guildId = interaction.guild?.id;
      const userId = interaction.user.id;
      const ownerId = process.env.BOT_OWNER_ID;
      const isOwner = userId === ownerId;

      try {
        let rows = [];

        // --- FLEXDUO ---
        if (commandName === 'flexduo' && focused.name === 'name') {
          const res = await pg.query(`SELECT name FROM flex_duo WHERE guild_id = $1`, [guildId]);
          rows = res.rows;
        }

        // --- FLEX FAMILY ---
        if (
          ['flex', 'flexplus', 'flexcard', 'flexspin'].includes(commandName) &&
          focused.name === 'name'
        ) {
          const res = await pg.query(`SELECT name FROM flex_projects WHERE guild_id = $1`, [guildId]);
          rows = res.rows;
        }

        // --- FLEX RANDOM TOKENID AUTOCOMPLETE ---
       if (commandName === 'flex') {
  const sub = interaction.options._hoistedOptions?.[0]?.name;

  if (sub === 'random' && focused.name === 'tokenid') {
    const subOptions = interaction.options._hoistedOptions?.[0]?.options || [];
    const nameOpt = subOptions.find(opt => opt.name === 'name');
    const projectName = nameOpt?.value;
    if (!projectName) return;

    const res = await pg.query(
      `SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2`,
      [guildId, projectName.toLowerCase()]
    );

    if (!res.rows.length) return;

    const { address, network } = res.rows[0];
    const chain = (network || 'base').toLowerCase();

    let tokenIds = [];

    if (chain === 'eth') {
      try {
        const resv = await fetch(
          `https://api.reservoir.tools/tokens/v6?collection=${address}&limit=100&sortBy=floorAskPrice`,
          { headers: { 'x-api-key': process.env.RESERVOIR_API_KEY } }
        );
        const data = await resv.json();
        tokenIds = data?.tokens?.map(t => t.token?.tokenId).filter(Boolean) || [];
      } catch {
        tokenIds = [];
      }
    } else {
      try {
        const provider = getProvider(chain);
        const contract = new Contract(address, ['function totalSupply() view returns (uint256)'], provider);
        const total = await contract.totalSupply();
        const totalNum = parseInt(total);
        tokenIds = Array.from({ length: Math.min(100, totalNum) }, (_, i) => (i + 1).toString());
      } catch {
        tokenIds = [];
      }
    }

    const filtered = tokenIds
      .filter(id => id.includes(focused.value))
      .slice(0, 25)
      .map(id => ({ name: `#${id}`, value: parseInt(id) }));

    return interaction.respond(filtered);
  }
}


        // --- EXP AUTOCOMPLETE ---
        if (commandName === 'exp' && focused.name === 'name') {
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
              let guildName = guildNameCache.get(row.guild_id);
              if (!guildName) {
                const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
                guildName = guild?.name ?? 'Other Server';
                guildNameCache.set(row.guild_id, guildName);
              }
              otherServers.push({ name: `🛡️ ${row.name} (${guildName})`, value: row.name });
            }
          }

          const combined = [...builtInChoices, ...thisServer, ...global, ...otherServers];

          const filtered = combined
            .filter(c => c.name.toLowerCase().includes(focused.value.toLowerCase()))
            .slice(0, 25);

          console.log(`🔁 Optimized Autocomplete for /exp:`, filtered);

          try {
            return await interaction.respond(filtered);
          } catch (err) {
            if (err.code === 10062) console.warn('⚠️ Autocomplete timeout: interaction expired.');
            else console.error('❌ Autocomplete respond error:', err);
            return;
          }
        }

        // --- DEFAULT AUTOCOMPLETE ---
        const choices = rows.map(row => row.name).filter(Boolean);
        const filtered = choices
          .filter(name => name.toLowerCase().includes(focused.value.toLowerCase()))
          .slice(0, 25);

        console.log(`🔁 Default Autocomplete for /${commandName}:`, filtered);

        try {
          return await interaction.respond(filtered.map(name => ({ name, value: name })));
        } catch (err) {
          if (err.code === 10062) console.warn('⚠️ Autocomplete timeout: interaction expired.');
          else console.error('❌ Autocomplete respond error:', err);
          return;
        }

      } catch (err) {
        console.error('❌ Autocomplete error:', err);
      }
    }

    // --- Slash Command Execution ---
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



