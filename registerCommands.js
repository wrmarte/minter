require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Load commands from /commands.
const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON());
    console.log(`✅ Prepared /${command.data.name}`);
  } else {
    console.warn(`⚠️ Skipped ${file}: missing "data" or "execute"`);
  }
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log('🔁 Registering slash commands globally...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered successfully!');
  } catch (error) {
    console.error('❌ Error registering slash commands:', error);
  }
})();



