// commands/refresh.js
const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
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

function diffNames(existingList, desiredList) {
  const a = new Set((existingList || []).map(x => x?.name).filter(Boolean));
  const b = new Set((desiredList || []).map(x => x?.name).filter(Boolean));
  const added = [];
  const removed = [];
  for (const name of b) if (!a.has(name)) added.push(name);
  for (const name of a) if (!b.has(name)) removed.push(name);
  return { added, removed };
}

async function putGlobal(rest, clientId, body) {
  return await rest.put(Routes.applicationCommands(clientId), { body });
}

async function putGuild(rest, clientId, guildId, body) {
  return await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('refresh')
    .setDescription('🔄 Refresh / purge / reinstall slash commands (owner only)')
    .addStringOption(option =>
      option.setName('scope')
        .setDescription('Where to apply')
        .setRequired(true)
        .addChoices(
          { name: 'Global', value: 'global' },
          { name: 'Test Guilds Only', value: 'test' },
          { name: 'Both', value: 'both' }
        )
    )
    .addStringOption(option =>
      option.setName('mode')
        .setDescription('What to do')
        .setRequired(true)
        .addChoices(
          { name: 'Deploy (install/update)', value: 'deploy' },
          { name: 'Purge (delete commands)', value: 'purge' },
          { name: 'Purge + Deploy (clean reinstall)', value: 'purge_deploy' }
        )
    )
    .addBooleanOption(option =>
      option.setName('confirm')
        .setDescription('Required for purge actions')
        .setRequired(false)
    ),

  async execute(interaction) {
    // ✅ Restrict to owner (hard gate)
    const ownerId = String(process.env.BOT_OWNER_ID || '').trim();
    if (!ownerId || interaction.user.id !== ownerId) {
      return interaction.reply({ content: '🚫 Owner only.', ephemeral: true });
    }

    const client = interaction.client;
    const token = process.env.DISCORD_BOT_TOKEN;

    // CLIENT_ID can be env, else try client.application.id
    const clientIdEnv = String(process.env.CLIENT_ID || '').trim();
    const clientId = clientIdEnv || String(client?.application?.id || '').trim();

    if (!token || !clientId) {
      return interaction.reply({
        content: '❌ Missing DISCORD_BOT_TOKEN or CLIENT_ID (or client.application.id not ready).',
        ephemeral: true
      });
    }

    const scope = interaction.options.getString('scope', true);
    const mode = interaction.options.getString('mode', true);
    const confirm = Boolean(interaction.options.getBoolean('confirm'));

    const isPurge = (mode === 'purge' || mode === 'purge_deploy');
    if (isPurge && !confirm) {
      return interaction.reply({
        content:
          '⚠️ Purge requested. Re-run with `confirm=true` to proceed.\n' +
          'Tip: To fix “commands show twice”, use **mode = Purge + Deploy** with scope **test** (or purge global if you only want guild).',
        ephemeral: true
      });
    }

    const rest = new REST({ version: '10' }).setToken(token);

    // Pull commands from memory and dedupe by name
    const raw = client.commands?.map?.(cmd => {
      try { return cmd.data.toJSON(); } catch { return null; }
    }).filter(Boolean) || [];

    const desiredCommands = toSafeArray(raw);

    if (!desiredCommands.length && mode !== 'purge') {
      return interaction.reply({ content: '⚠️ No commands loaded in memory to register.', ephemeral: true });
    }

    // Collect test guild IDs
    const testGuildIds = parseCsvIds(process.env.TEST_GUILD_IDS, process.env.TEST_GUILD_ID);

    await interaction.reply({
      content: `⏳ Running \`${mode}\` for scope \`${scope}\`...\nApp: \`${clientId}\``,
      ephemeral: true
    });

    const lines = [];
    const runScopeGlobal = (scope === 'global' || scope === 'both');
    const runScopeTest = (scope === 'test' || scope === 'both');

    try {
      // ---------- GLOBAL ----------
      if (runScopeGlobal) {
        const before = await fetchGlobal(rest, clientId);

        if (mode === 'purge' || mode === 'purge_deploy') {
          await putGlobal(rest, clientId, []); // delete all global commands
        }
        if (mode === 'deploy' || mode === 'purge_deploy') {
          await putGlobal(rest, clientId, desiredCommands);
        }

        const after = await fetchGlobal(rest, clientId);
        const { added, removed } = diffNames(before, after);

        lines.push(
          `🌐 **Global**\n` +
          `• Before: ${before.length} | After: ${after.length}\n` +
          (added.length ? `• Added: ${added.join(', ')}\n` : '') +
          (removed.length ? `• Removed: ${removed.join(', ')}\n` : '')
        );
      }

      // ---------- TEST GUILDS ----------
      if (runScopeTest) {
        if (!testGuildIds.length) {
          lines.push('⚠️ No TEST_GUILD_ID(S) configured; skipped test scope.');
        } else {
          for (const guildId of testGuildIds) {
            const before = await fetchGuild(rest, clientId, guildId);

            if (mode === 'purge' || mode === 'purge_deploy') {
              await putGuild(rest, clientId, guildId, []); // delete all guild commands
            }
            if (mode === 'deploy' || mode === 'purge_deploy') {
              await putGuild(rest, clientId, guildId, desiredCommands);
            }

            const after = await fetchGuild(rest, clientId, guildId);
            const { added, removed } = diffNames(before, after);

            lines.push(
              `🛠️ **Guild ${guildId}**\n` +
              `• Before: ${before.length} | After: ${after.length}\n` +
              (added.length ? `• Added: ${added.join(', ')}\n` : '') +
              (removed.length ? `• Removed: ${removed.join(', ')}\n` : '')
            );
          }
        }
      }

      // Extra guidance for duplicates
      let tip = '';
      if (mode !== 'purge') {
        tip =
          `\n**Tip (fix duplicates):** If commands show twice, you probably have **Global + Guild** both installed.\n` +
          `• If you want GLOBAL only: run \`/refresh scope:test mode:purge confirm:true\`\n` +
          `• If you want TEST-GUILD only: run \`/refresh scope:global mode:purge confirm:true\`\n`;
      }

      const summary = lines.join('\n').trim() || 'No output.';
      await interaction.editReply(`✅ Done: \`${mode}\` on \`${scope}\`\n\n${summary}${tip}`);
    } catch (err) {
      console.error('❌ Slash refresh failed:', err);
      await interaction.editReply(
        '❌ Command refresh failed. Check logs.\n' +
        `Error: ${(err?.message || String(err)).slice(0, 180)}`
      );
    }
  }
};


