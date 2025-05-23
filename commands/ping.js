const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_BOT_TOKEN or CLIENT_ID in env.');
  process.exit(1);
}

const commands = [];
const commandFiles = fs.readdirSync(path.join(__dirname, 'commands')).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON());
    console.log(`✅ Prepared /${command.data.name}`);
  } else {
    console.warn(`⚠️ Skipping ${file} — missing "data" or "execute"`);
  }
}

const rest = new REST({ version: '10' }).setToken(TOKEN);


(async () => {
  try {
    console.log('🔁 Registering slash commands globally...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered successfully!');
  } catch (err) {
    console.error('❌ Failed to register slash commands:', err);
  }
})();




