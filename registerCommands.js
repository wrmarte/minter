require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ✅ Load all command modules from /commands
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

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    const clientId = process.env.CLIENT_ID;
    const guildId = process.env.TEST_GUILD_ID;

    if (!clientId) {
      console.error('❌ CLIENT_ID missing in .env');
      process.exit(1);
    }

    if (!guildId) {
      console.warn('⚠️ TEST_GUILD_ID missing — skipping guild deploy.');
    }

    // ✅ Phase 1: Clear Guild Commands First for Fast Development
    if (guildId) {
      console.log(`🗑️ Clearing guild commands for guild ID: ${guildId}...`);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
      console.log('✅ Guild commands cleared.');
    }

    // ✅ Phase 2: Clear Global Commands Separately
    console.log('🗑️ Clearing global commands...');
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log('✅ Global commands cleared.');

    // ✅ Wait briefly for sync
    console.log('⏳ Waiting 5 seconds to let Discord sync clear operations...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // ✅ Phase 3: Register Guild Commands First
    if (guildId) {
      console.log(`🔁 Registering ${commands.length} slash commands to guild: ${guildId}...`);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log('✅ Guild slash commands registered successfully!');
    }

    // ✅ Phase 4: Register Global Commands
    console.log(`🔁 Registering ${commands.length} global slash commands...`);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ Global slash commands registered!');

  } catch (error) {
    console.error('❌ Error registering slash commands:', error?.rawError || error);
  }
})();







