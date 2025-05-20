const { REST, Routes } = require('discord.js');
const fs = require('fs');
require('dotenv').config();

// ✅ DEBUG LOGGING
console.log('Loaded TOKEN:', process.env.TOKEN?.slice(0, 10));
console.log('Loaded CLIENT_ID:', process.env.CLIENT_ID);

const commands = [];
const commandFiles = fs.readdirSync('./minter/commands').filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(`./minter/commands/${file}`);
  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON());
  } else {
    console.warn(`[⚠️] The command at ${file} is missing "data" or "execute".`);
  }
}

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log('🔁 Started refreshing application (/) commands...');

    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );

    console.log('✅ Successfully reloaded application (/) commands!');
  } catch (error) {
    console.error('❌ Error while reloading commands:', error);
  }
})();

