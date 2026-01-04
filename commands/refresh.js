// commands/refresh.js
const { SlashCommandBuilder } = require('discord.js');
const { REST, Routes } = require('discord.js');

const EPHEMERAL_FLAG = 1 << 6; // 64

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

function diffNames(before, after) {
  const a = new Set((before || []).map(x => x?.name).filter(Boolean));
  const b = new Set((after || []).map(x => x?.name).filter(Boolean));
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

async function safeReply(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply({ content });
    }
    return await interaction.reply({ content, flags: EPHEMERAL_FLAG });
  } catch {
    try { return await interaction.followUp({ content, flags: EPHEMERAL_FLAG }); } catch {}
  }
}

async function safeEdit(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply({ content });
    }
    return await interaction.reply({ content, flags: EPHEMERAL_FLAG });
  } catch {
    try { return await interaction.followUp({ content, flags: EPHEMERAL_FLAG }); } catch {}
  }
}

/**
 * Discord API rule:
 * At any "options" array level, required=true options must come BEFORE optional ones.
 * This auto-normalizes options order recursively.
 */
function hasRequiredAfterOptional(options) {
  if (!Array.isArray(options) || !options.length) return false;
  let seenOptional = false;
  for (const opt of options) {
    const req = Boolean(opt?.required);
    if (!req) seenOptional = true;
    if (req && seenOptional) return true;
  }
  return false;
}

function reorderOptions(options) {
  if (!Array.isArray(options) || !options.length) return options;

  const required = [];
  const optional = [];

  for (const opt of options) {
    // Normalize nested options first
    if (opt && Array.isArray(opt.options)) {
      opt.options = reorderOptions(opt.options);
    }
    if (opt && Array.isArray(opt.choices)) {
      // choices order doesn't matter; leave
    }

    if (opt?.required === true) required.push(opt);
    else optional.push(opt);
  }

  return [...required, ...optional];
}

function normalizeCommandOptions(cmd) {
  if (!cmd || typeof cmd !== 'object') return { cmd, changed: false };

  let changed = false;

  // top-level options
  if (Array.isArray(cmd.options) && cmd.options.length) {
    // Recurse + reorder at this level
    const beforeBad = hasRequiredAfterOptional(cmd.options);
    cmd.options = reorderOptions(cmd.options);
    const afterBad = hasRequiredAfterOptional(cmd.options);

    if (beforeBad || afterBad === false) {
      if (beforeBad) changed = true;
    }

    // Also: ensure subcommand/group children are normalized
    for (const opt of cmd.options) {
      if (opt && Array.isArray(opt.options)) {
        const beforeChildBad = hasRequiredAfterOptional(opt.options);
        opt.options = reorderOptions(opt.options);
        if (beforeChildBad) changed = true;

        // deeper nesting
        for (const opt2 of opt.options || []) {
          if (opt2 && Array.isArray(opt2.options)) {
            const beforeDeepBad = hasRequiredAfterOptional(opt2.options);
            opt2.options = reorderOptions(opt2.options);
            if (beforeDeepBad) changed = true;
          }
        }
      }
    }
  }

  return { cmd, changed };
}

function normalizeAllCommands(commands) {
  const fixed = [];
  const out = [];

  for (let i = 0; i < commands.length; i++) {
    const original = commands[i];
    const name = original?.name || `#${i}`;
    const copy = JSON.parse(JSON.stringify(original)); // safe deep clone
    const { cmd, changed } = normalizeCommandOptions(copy);

    if (changed) fixed.push(name);
    out.push(cmd);
  }

  // Final safety: enforce top-level required ordering again
  for (const c of out) {
    if (Array.isArray(c.options)) c.options = reorderOptions(c.options);
  }

  return { commands: out, fixed };
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
    // ✅ optional for legacy schema compatibility
    .addStringOption(option =>
      option.setName('mode')
        .setDescription('What to do')
        .setRequired(false)
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
    const ownerId = String(process.env.BOT_OWNER_ID || '').trim();
    if (!ownerId || interaction.user.id !== ownerId) {
      return safeReply(interaction, '🚫 Owner only.');
    }

    const client = interaction.client;
    const token = process.env.DISCORD_BOT_TOKEN;

    const clientIdEnv = String(process.env.CLIENT_ID || '').trim();
    const clientId = clientIdEnv || String(client?.application?.id || '').trim();

    if (!token || !clientId) {
      return safeReply(interaction, '❌ Missing DISCORD_BOT_TOKEN or CLIENT_ID (or client.application.id not ready).');
    }

    // backwards compatible: old installed cmd might only have scope
    const scope = interaction.options.getString('scope') || 'both';
    const mode = interaction.options.getString('mode') || 'deploy';
    const confirm = Boolean(interaction.options.getBoolean('confirm'));

    const isPurge = (mode === 'purge' || mode === 'purge_deploy');
    if (isPurge && !confirm) {
      return safeReply(
        interaction,
        '⚠️ Purge requested.\nRe-run with `confirm=true`.\n\n' +
        'Tip: duplicates happen when commands are installed BOTH globally + guild.'
      );
    }

    const rest = new REST({ version: '10' }).setToken(token);

    // Pull commands from memory
    const raw = client.commands?.map?.(cmd => {
      try { return cmd.data.toJSON(); } catch { return null; }
    }).filter(Boolean) || [];

    const desiredRaw = toSafeArray(raw);

    if (!desiredRaw.length && mode !== 'purge') {
      return safeReply(interaction, '⚠️ No commands loaded in memory to register.');
    }

    // ✅ Normalize option ordering to satisfy Discord API rule
    const { commands: desiredCommands, fixed } = normalizeAllCommands(desiredRaw);

    const testGuildIds = parseCsvIds(process.env.TEST_GUILD_IDS, process.env.TEST_GUILD_ID);

    await safeReply(
      interaction,
      `⏳ Running \`${mode}\` for \`${scope}\`…\n` +
      (fixed.length ? `🧼 Auto-fixed option order on: ${fixed.slice(0, 12).join(', ')}${fixed.length > 12 ? '…' : ''}` : '🧼 Option order OK.')
    );

    const lines = [];
    const runGlobal = (scope === 'global' || scope === 'both');
    const runTest = (scope === 'test' || scope === 'both');

    try {
      // ---------- GLOBAL ----------
      if (runGlobal) {
        const before = await fetchGlobal(rest, clientId);

        if (mode === 'purge' || mode === 'purge_deploy') {
          await putGlobal(rest, clientId, []);
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
      if (runTest) {
        if (!testGuildIds.length) {
          lines.push('⚠️ No TEST_GUILD_ID(S) configured; skipped test scope.');
        } else {
          for (const guildId of testGuildIds) {
            const before = await fetchGuild(rest, clientId, guildId);

            if (mode === 'purge' || mode === 'purge_deploy') {
              await putGuild(rest, clientId, guildId, []);
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

      const tip =
        `\n**Fix duplicates:** they happen when the same commands exist in BOTH global + guild.\n` +
        `• Keep GLOBAL only → run: \`/refresh scope:test mode:purge confirm:true\`\n` +
        `• Keep TEST guild only → run: \`/refresh scope:global mode:purge confirm:true\`\n`;

      const summary = lines.join('\n').trim() || 'No output.';
      await safeEdit(interaction, `✅ Done: \`${mode}\` on \`${scope}\`\n\n${summary}${tip}`);
    } catch (err) {
      console.error('❌ Slash refresh failed:', err);
      await safeEdit(
        interaction,
        `❌ Command refresh failed.\n` +
        `Error: ${(err?.message || String(err)).slice(0, 260)}\n\n` +
        `If this still happens, tell me the command index mentioned in logs (like "33") and I’ll pinpoint the exact command file.`
      );
    }
  }
};
