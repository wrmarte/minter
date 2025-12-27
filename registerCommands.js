// registerCommands.js — single-scope registrar (prevents duplicates), with dedupe + optional purge
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// -----------------------------
// ENV
// -----------------------------
// COMMAND_SCOPE: "global" or "guild"
// TEST_GUILD_IDS: comma-separated guild IDs (required for guild scope; used to clear guild when switching to global).
// CLIENT_ID: your application (bot) id
// DISCORD_BOT_TOKEN: bot token
// PURGE_BOTH: if "true", clears BOTH global and provided guilds BEFORE registering (belt & suspenders)
const SCOPE = (process.env.COMMAND_SCOPE || 'global').toLowerCase(); // 'global' | 'guild'
const PURGE_BOTH = /^true$/i.test(process.env.PURGE_BOTH || 'false');

// Optional lock to avoid double-runs in CI
const LOCK_PATH = path.join(process.cwd(), '.register.lock');

function withLock(fn) {
  if (fs.existsSync(LOCK_PATH)) {
    console.log('🔒 Register lock present. Exiting to prevent duplicate registration.');
    process.exit(0);
  }
  fs.writeFileSync(LOCK_PATH, `${Date.now()}`);
  return fn().finally(() => {
    try { fs.unlinkSync(LOCK_PATH); } catch {}
  });
}

// -----------------------------
// Load commands from ./commands (relative to repo root)
// -----------------------------
const commands = [];
const commandsPath = path.join(process.cwd(), 'commands');
if (!fs.existsSync(commandsPath)) {
  console.error(`❌ Commands folder not found at ${commandsPath}`);
  process.exit(1);
}

const commandFiles = fs
  .readdirSync(commandsPath)
  .filter(file =>
    file.endsWith('.js') &&
    !file.startsWith('_') &&               // allow disabling by prefix
    !file.endsWith('.disabled.js')         // allow disabling by suffix
  );

if (!commandFiles.length) {
  console.warn('⚠️ No command files found in /commands');
  process.exit(1);
}

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  try {
    delete require.cache[require.resolve(filePath)];
    const command = require(filePath);

    if ('data' in command && 'execute' in command) {
      try {
        const json = command.data.toJSON();
        commands.push(json);
        console.log(`✅ Prepared /${json.name} from ${file}`);
      } catch (err) {
        console.warn(`⚠️ Skipped ${file}: error in data.toJSON()`, err?.message || err);
      }
    } else {
      console.warn(`⚠️ Skipped ${file}: missing "data" or "execute" export`);
    }
  } catch (e) {
    console.warn(`⚠️ Skipped ${file}: require() failed`, e?.message || e);
  }
}

if (commands.length === 0) {
  console.warn('⚠️ No valid commands found to register.');
  process.exit(1);
}

// -----------------------------
// Dedupe by name (safety)
// -----------------------------
const dedupedByName = Array.from(new Map(commands.map(c => [c.name, c])).values());
if (dedupedByName.length !== commands.length) {
  const removed = commands.length - dedupedByName.length;
  console.log(`🧹 Deduped command names: ${commands.length} -> ${dedupedByName.length} (removed ${removed})`);
}
console.log('📦 Final command list:', dedupedByName.map(c => `/${c.name}`).join(', ') || '—');

// -----------------------------
// REST Setup
// -----------------------------
const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.CLIENT_ID;
if (!token) {
  console.error('❌ DISCORD_BOT_TOKEN missing in .env');
  process.exit(1);
}
if (!clientId) {
  console.error('❌ CLIENT_ID missing in .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

const testGuildIds = (process.env.TEST_GUILD_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

withLock(async () => {
  try {
    console.log(`🔧 Scope: ${SCOPE}${PURGE_BOTH ? ' (PURGE_BOTH enabled)' : ''}`);

    // Optional hard purge both scopes first
    if (PURGE_BOTH) {
      try {
        console.log('🗑️ Purging GLOBAL commands (pre)…');
        await rest.put(Routes.applicationCommands(clientId), { body: [] });
        console.log('✅ Global purged.');
      } catch (e) {
        console.warn('⚠️ Pre-purge global failed:', e?.message || e);
      }
      if (testGuildIds.length) {
        for (const gid of testGuildIds) {
          try {
            console.log(`🗑️ Purging GUILD commands (pre) for ${gid}…`);
            await rest.put(Routes.applicationGuildCommands(clientId, gid), { body: [] });
            console.log(`✅ Guild ${gid} purged.`);
          } catch (e) {
            console.warn(`⚠️ Pre-purge guild ${gid} failed:`, e?.message || e);
          }
        }
      }
    }

    if (SCOPE === 'guild') {
      if (!testGuildIds.length) {
        console.error('❌ COMMAND_SCOPE=guild but TEST_GUILD_IDS is empty. Provide at least one guild ID.');
        process.exit(1);
      }

      // Clear GLOBAL to avoid dupes in those guilds
      try {
        console.log('🗑️ Clearing GLOBAL commands (so guild-only won’t duplicate)…');
        await rest.put(Routes.applicationCommands(clientId), { body: [] });
        console.log('✅ Global commands cleared.');
      } catch (e) {
        console.warn('⚠️ Could not clear global commands:', e?.message || e);
      }

      // Register per-guild
      for (const guildId of testGuildIds) {
        console.log(`📥 Registering ${dedupedByName.length} GUILD commands in ${guildId}…`);
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: dedupedByName });
        console.log(`✅ Guild ${guildId} commands registered.`);
      }

      console.log('🎉 Done (guild scope).');
      return;
    }

    // SCOPE === 'global'
    // Clear guild commands in test guilds (if provided), so global + guild don’t both show
    if (testGuildIds.length) {
      for (const guildId of testGuildIds) {
        try {
          console.log(`🗑️ Clearing guild commands for ${guildId} (prevent dupes vs global)…`);
          await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
          console.log(`✅ Guild ${guildId} commands cleared.`);
        } catch (e) {
          console.warn(`⚠️ Could not clear guild ${guildId}:`, e?.message || e);
        }
      }
    }

    // Register GLOBAL
    console.log(`📥 Registering ${dedupedByName.length} GLOBAL slash commands…`);
    await rest.put(Routes.applicationCommands(clientId), { body: dedupedByName });
    console.log('✅ Global slash commands registered!');

    console.log('🎉 Done (global scope).');
  } catch (error) {
    console.error('❌ Error registering slash commands:', error?.rawError || error);
    process.exit(1);
  }
})();
