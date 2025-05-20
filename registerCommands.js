require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');


const commands = [];
const commandFiles = fs.readdirSync(path.join(__dirname, 'commands')).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  if (command?.data) {
    commands.push(command.data.toJSON());
  }
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    const mode = process.argv[2]; // "guild" or "global"

    if (mode === 'guild') {
      console.log('🎯 Registering GUILD slash commands...');
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log(`✅ Registered ${commands.length} command(s) to guild ${process.env.GUILD_ID}`);
    } else {
      console.log('🌐 Registering GLOBAL slash commands...');
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log(`✅ Registered ${commands.length} command(s) globally`);
    }

  } catch (err) {
    console.error('❌ Slash command registration error:', err);
  }
})();


