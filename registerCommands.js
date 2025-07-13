require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Load all command modules from /commands
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
    console.log(`🔁 Registering ${commands.length} slash commands globally...`);
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered successfully!');

    // OPTIONAL: Uncomment this if testing on a specific dev guild only
    /*
    const guildId = process.env.TEST_GUILD_ID;
    if (guildId) {
      console.log(`🔁 Registering slash commands to guild: ${guildId}...`);
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
        { body: commands }
      );
      console.log('✅ Guild slash commands registered successfully!');
    }
    */

  } catch (error) {
    console.error('❌ Error registering slash commands:', error?.rawError || error);
  }
})();






