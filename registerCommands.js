require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ✅ Load all slash commands from /commands
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
    const testGuildIds = process.env.TEST_GUILD_ID?.split(',').map(id => id.trim()).filter(Boolean);

    if (!clientId) {
      console.error('❌ CLIENT_ID missing in .env');
      process.exit(1);
    }

    // ✅ Clear Guild Commands
    if (testGuildIds?.length) {
      for (const guildId of testGuildIds) {
        console.log(`🗑️ Clearing guild commands for guild ID: ${guildId}...`);
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
        console.log(`✅ Guild commands cleared for ${guildId}`);
      }
    }

    // ✅ Clear Global Commands
    console.log('🗑️ Clearing global commands...');
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log('✅ Global commands cleared.');

    // ✅ Delay to allow Discord to sync clears
    console.log('⏳ Waiting 5 seconds for Discord sync...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // ✅ Register Guild Commands
    if (testGuildIds?.length) {
      for (const guildId of testGuildIds) {
        console.log(`📥 Registering ${commands.length} commands to guild ${guildId}...`);
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
        console.log(`✅ Guild slash commands registered to ${guildId}`);
      }
    }

    // ✅ Register Global Commands
    console.log(`📥 Registering ${commands.length} global slash commands...`);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ Global slash commands registered!');

  } catch (error) {
    console.error('❌ Error registering slash commands:', error?.rawError || error);
  }
})();













