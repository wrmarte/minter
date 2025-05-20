require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const commands = [];
const commandPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandPath).filter(file => file.endsWith('.js'));

// Load command definitions
for (const file of commandFiles) {
  const command = require(path.join(commandPath, file));
  if (command?.data?.name) {
    commands.push(command.data.toJSON());
  } else {
    console.warn(`⚠️ Skipped invalid command file: ${file}`);
  }
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log('🔃 Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log(`✅ Registered ${commands.length} slash command(s).`);
  } catch (error) {
    console.error('❌ Error registering slash commands:', error);
  }
})();

