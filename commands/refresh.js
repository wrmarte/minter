const { SlashCommandBuilder } = require('discord.js');
const { REST, Routes } = require('discord.js');

function parseCsvIds(csv, fallback) {
  const list = (csv || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!list.length && fallback) list.push(fallback);
  return Array.from(new Set(list));
}

function toSafeArray(commands) {
  // Dedup by command name; stable order
  const map = new Map();
  for (const c of commands) {
    const name = c?.name;
    if (!name) continue;
    if (!map.has(name)) map.set(name, c);
  }
  return Array.from(map.values());
}

function diffCommands(oldList, newList) {
  const oldMap = new Map(oldList.map(c => [c.name, c]));
  const newMap = new Map(newList.map(c => [c.name, c]));

  const added = [];
  const removed = [];
  const updated = [];

  for (const name of newMap.keys()) {
    if (!oldMap.has(name)) {
      added.push(name);
    } else {
      // naive diff: compare JSON string (fast + good enough)
      const a = JSON.stringify(oldMap.get(name));
      const b = JSON.stringify(newMap.get(name));
      if (a !== b) updated.push(name);
    }
  }
  for (const name of oldMap.keys()) {
    if (!newMap.has(name)) removed.push(name);
  }

  return { added, updated, removed };
}

async function fetchGlobal(rest, clientId) {
  try {
    const data = await rest.get(Routes.applicationCommands(clientId));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function fetchGuild(rest, clientId, guildId) {
  try {
    const data = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('refresh')
    .setDescription('🔄 Refresh slash commands')
    .addStringOption(option =>
      option.setName('scope')
        .setDescription('Where to refresh commands')
        .setRequired(true)
        .addChoices(
          { name: 'Global', value: 'global' },
          { name: 'Test Guilds Only', value: 'test' },
          { name: 'Both', value: 'both' }
        )
    ),

  async execute(interaction) {
    // ✅ Restrict to owner
    if (interaction.user.id !== process.env.BOT_OWNER_ID) {
      return interaction.reply({ content: '🚫 You are not authorized to run this command.', ephemeral: true });
    }

    const client = interaction.client;
    const token = process.env.DISCORD_BOT_TOKEN;
    const clientId = process.env.CLIENT_ID;

    if (!token || !clientId) {
      return interaction.reply({
        content: '❌ Missing DISCORD_BOT_TOKEN or CLIENT_ID in environment.',
        ephemeral: true
      });
    }

    const scope = interaction.options.getString('scope');
    const rest = new REST({ version: '10' }).setToken(token);

    // Pull commands from memory and dedupe by name
    const raw = client.commands?.map?.(cmd => {
      try { return cmd.data.toJSON(); } catch { return null; }
    }).filter(Boolean) || [];
    const commands = toSafeArray(raw);

    if (!commands.length) {
      return interaction.reply({ content: '⚠️ No commands loaded in memory to register.', ephemeral: true });
    }

    // Collect test guild IDs
    const testGuildIds = parseCsvIds(process.env.TEST_GUILD_IDS, process.env.TEST_GUILD_ID);

    await interaction.reply({ content: `⏳ Refreshing commands for \`${scope}\`...`, ephemeral: true });

    const results = [];

    try {
      if (scope === 'global' || scope === 'both') {
        // Fetch current, diff, then PUT
        const existing = await fetchGlobal(rest, clientId);
        const { added, updated, removed } = diffCommands(existing.map(x => ({ name: x.name, ...x })), commands);
        await rest.put(Routes.applicationCommands(clientId), { body: commands });

        results.push(
          `🌐 **Global** – ${commands.length} total\n` +
          (added.length   ? `  • Added: ${added.join(', ')}\n`   : '') +
          (updated.length ? `  • Updated: ${updated.join(', ')}\n` : '') +
          (removed.length ? `  • Removed: ${removed.join(', ')}\n` : '') ||
          '  • No changes\n'
        );
      }

      if ((scope === 'test' || scope === 'both') && testGuildIds.length) {
        for (const guildId of testGuildIds) {
          const existing = await fetchGuild(rest, clientId, guildId);
          const { added, updated, removed } = diffCommands(existing.map(x => ({ name: x.name, ...x })), commands);
          await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });

          results.push(
            `🛠️ **Guild ${guildId}** – ${commands.length} total\n` +
            (added.length   ? `  • Added: ${added.join(', ')}\n`   : '') +
            (updated.length ? `  • Updated: ${updated.join(', ')}\n` : '') +
            (removed.length ? `  • Removed: ${removed.join(', ')}\n` : '') ||
            '  • No changes\n'
          );
        }
      } else if (scope !== 'global' && !testGuildIds.length) {
        results.push('⚠️ No TEST_GUILD_ID(S) configured; skipped test scope.');
      }

      const summary = results.join('\n').trim() || 'No changes.';
      await interaction.editReply(`✅ Refreshed commands for \`${scope}\`.\n\n${summary}`);
    } catch (err) {
      console.error('❌ Slash refresh failed:', err);
      await interaction.editReply('❌ Command refresh failed. Check logs.');
    }
  }
};


