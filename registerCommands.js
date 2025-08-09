// registerCommands.js — single-scope registrar (prevents duplicates), with dedupe + optional lock
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// -----------------------------
// Config via ENV
// -----------------------------
// COMMAND_SCOPE: "global" or "guild"
// TEST_GUILD_IDS: comma-separated list for guild scope (or for clearing when switching to global)
// CLIENT_ID: your application (bot) id
// DISCORD_BOT_TOKEN: bot token
const SCOPE = (process.env.COMMAND_SCOPE || 'global').toLowerCase(); // 'global' | 'guild'

// Optional lock to avoid double-runs in CI
const LOCK_PATH = path.join(__dirname, '.register.lock');

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
// Load commands from ./commands
// -----------------------------
const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);

  if ('data' in command && 'execute' in command) {
    try {
      commands.push(command.data.toJSON());
      console.log(`✅ Prepared /${command.data.name}`);
    } catch (err) {
      console.warn(`⚠️ Skipped ${file}: error in toJSON`, err);
    }
  } else {
    console.warn(`⚠️ Skipped ${file}: missing "data" or "execute" export`);
  }
}

if (commands.length === 0) {
  console.warn('⚠️ No valid commands found to register.');
  process.exit(1);
}

// -----------------------------
// Dedupe by name (safety)
// -----------------------------
const dedupedByName = Array.from(
  new Map(commands.map(c => [c.name, c])).values()
);
if (dedupedByName.length !== commands.length) {
  console.log(`🧹 Deduped commands: ${commands.length} -> ${dedupedByName.length}`);
}

// -----------------------------
// REST Setup
// -----------------------------
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

withLock(async () => {
  try {
    const clientId = process.env.CLIENT_ID;
    if (!clientId) {
      console.error('❌ CLIENT_ID missing in .env');
      process.exit(1);
    }

    const testGuildIds = (process.env.TEST_GUILD_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    console.log(`🔧 Scope: ${SCOPE}`);

    if (SCOPE === 'guild') {
      if (!testGuildIds.length) {
        console.error('❌ COMMAND_SCOPE=guild but TEST_GUILD_IDS is empty. Provide at least one guild ID.');
        process.exit(1);
      }

      // Clear GLOBAL to avoid dupes in those guilds
      console.log('🗑️ Clearing GLOBAL commands (so guild-only won’t duplicate)...');
      await rest.put(Routes.applicationCommands(clientId), { body: [] });
      console.log('✅ Global commands cleared.');

      // Register per-guild
      for (const guildId of testGuildIds) {
        console.log(`📥 Registering ${dedupedByName.length} GUILD commands in ${guildId}...`);
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
        console.log(`🗑️ Clearing guild commands for ${guildId} (prevent dupes vs global)...`);
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
        console.log(`✅ Guild ${guildId} commands cleared.`);
      }
    }

    // Register GLOBAL
    console.log(`📥 Registering ${dedupedByName.length} GLOBAL slash commands...`);
    await rest.put(Routes.applicationCommands(clientId), { body: dedupedByName });
    console.log('✅ Global slash commands registered!');

    console.log('🎉 Done (global scope).');
  } catch (error) {
    console.error('❌ Error registering slash commands:', error?.rawError || error);
    process.exit(1);
  }
})();













