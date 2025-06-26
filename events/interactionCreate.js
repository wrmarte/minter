const { flavorMap } = require('../utils/flavorMap');
const { Contract } = require('ethers');
const fetch = require('node-fetch');
const { getProvider } = require('../services/provider');
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

      const safeRespond = async (choices) => {
        try {
          if (!interaction.responded) {
            await interaction.respond(choices);
          }
        } catch (err) {
          if (err.code === 10062) console.warn('⚠️ Autocomplete expired: interaction dropped');
          else if (err.code === 40060) console.warn('⚠️ Autocomplete already acknowledged');
          else console.error('❌ Autocomplete respond error:', err);
        }
      };

      try {
        const subcommand = interaction.options.getSubcommand(false);

        if (commandName === 'flex') {
          if (subcommand === 'duo' && focused.name === 'name') {
            const res = await pg.query(`SELECT name FROM flex_duo WHERE guild_id = $1`, [guildId]);
            const duoNames = res.rows
              .map(row => row.name)
              .filter(Boolean)
              .filter(name => name.toLowerCase().includes(focused.value.toLowerCase()))
              .slice(0, 25)
              .map(name => ({ name, value: name }));
            return await safeRespond(duoNames);
          }

          if (['random', 'card', 'plus'].includes(subcommand) && focused.name === 'name') {
            const res = await pg.query(`SELECT name FROM flex_projects WHERE guild_id = $1`, [guildId]);
            const projectNames = res.rows
              .map(row => row.name)
              .filter(Boolean)
              .filter(name => name.toLowerCase().includes(focused.value.toLowerCase()))
              .slice(0, 25)
              .map(name => ({ name, value: name }));
            return await safeRespond(projectNames);
          }

          if (subcommand === 'random' && focused.name === 'tokenid') {
            const nameOpt = options.get('name')?.value;
            if (!nameOpt) return;

            const res = await pg.query(
              `SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2`,
              [guildId, nameOpt.toLowerCase()]
            );
            if (!res.rows.length) return;

            const { address, network } = res.rows[0];
            const chain = (network || 'base').toLowerCase();

            let tokenIds = [];

            if (chain === 'eth') {
              try {
                const resv = await fetch(`https://api.reservoir.tools/tokens/v6?collection=${address}&limit=100&sortBy=floorAskPrice`, {
                  headers: { 'x-api-key': process.env.RESERVOIR_API_KEY }
                });
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

            return await safeRespond(filtered);
          }
        }

        if (commandName === 'flexdev' && focused.name === 'name') {
          const res = await pg.query(`SELECT name FROM flex_projects WHERE guild_id = $1`, [guildId]);
          const projectNames = res.rows
            .map(row => row.name)
            .filter(Boolean)
            .filter(name => name.toLowerCase().includes(focused.value.toLowerCase()))
            .slice(0, 25)
            .map(name => ({ name, value: name }));
          return await safeRespond(projectNames);
        }

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
          const thisServer = [], global = [], otherServers = [];

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

          return await safeRespond(filtered);
        }

        if (commandName === 'untrackmintplus' && focused.name === 'contract') {
          const guildId = interaction.guild?.id;
          if (!guildId) return await safeRespond([]);

          try {
            const res = await pg.query(`SELECT name, address, chain, channel_ids FROM contract_watchlist`);
            const options = [];

            for (const row of res.rows) {
              if (!row.name || typeof row.name !== 'string') continue;
              if (!row.name.toLowerCase().includes(focused.value.toLowerCase())) continue;

              const chain = row.chain || 'unknown';
              const emoji = chain === 'base' ? '🟦' : chain === 'eth' ? '🟧' : chain === 'ape' ? '🐵' : '❓';

              const channels = Array.isArray(row.channel_ids)
                ? row.channel_ids
                : (row.channel_ids || '').toString().split(',').filter(Boolean);

              let matchedChannel = null;
              for (const cid of channels) {
                const channel = interaction.client.channels.cache.get(cid);
                if (channel?.guild?.id === guildId) {
                  matchedChannel = channel.name;
                  break;
                }
              }

              if (!matchedChannel) continue;

              const display = `${emoji} ${row.name} • #${matchedChannel} • ${chain}`;
              const value = `${row.name}|${chain}`;

              options.push({
                name: display.slice(0, 100),
                value,
                _sortChain: chain === 'base' ? 0 : chain === 'eth' ? 1 : 2
              });

              if (options.length >= 50) break;
            }

            const sorted = options
              .sort((a, b) => a._sortChain - b._sortChain)
              .slice(0, 25)
              .map(({ name, value }) => ({ name, value }));

            return await safeRespond(sorted);
          } catch (err) {
            console.warn('⚠️ Autocomplete /untrackmintplus error:', err.message);
            return await safeRespond([]);
          }
        }

      } catch (err) {
        console.error('❌ Autocomplete error:', err);
      }
    }

    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

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

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const content = message.content.trim().toLowerCase();
    if (!content.startsWith('musclemb ')) return;

    const userMsg = message.content.slice('musclemb'.length).trim();
    if (!userMsg) return message.reply('💬 Say something for MuscleMB to chew on, bro.');

    await message.channel.sendTyping();

    try {
      let completion;
      try {
        completion = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [
            {
              role: 'system',
              content:
                'You are MuscleMB — an uncensored, degen AI who lifts heavy, flips JPEGs, and drops spicy alpha. Speak like a savage crypto bro who gives raw advice, gym tips, and meme wisdom. Be witty, wild, and brutally real.',
            },
            { role: 'user', content: userMsg },
          ],
          temperature: 0.95,
        });
      } catch (gpt4err) {
        console.warn('⚠️ GPT-4 unavailable, using GPT-3.5 instead.');
        completion = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content:
                'You are MuscleMB — an uncensored, degen AI who lifts heavy, flips JPEGs, and drops spicy alpha. Speak like a savage crypto bro who gives raw advice, gym tips, and meme wisdom. Be witty, wild, and brutally real.',
            },
            { role: 'user', content: userMsg },
          ],
          temperature: 0.95,
        });
      }

      const aiReply = completion.choices[0].message.content;
      await message.reply(aiReply);
    } catch (err) {
      console.error('❌ MuscleMB (text trigger) error:', err.message);
      await message.reply('⚠️ MuscleMB blacked out from too much alpha. Try again later.');
    }
  });
};


