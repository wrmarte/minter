const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ✅ Load Railway-provided ENV variables
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const COMMANDS_PATH = path.join(__dirname, 'commands'); // or 'src/commands', etc

// ✅ Sanity check logs
console.log('TOKEN loaded:', TOKEN ? TOKEN.slice(0, 10) + '...' : '❌ MISSING');
console.log('CLIENT_ID:', CLIENT_ID || '❌ MISSING');
console.log('Reading commands from:', COMMANDS_PATH);

// ⛔ Exit early if env is missing
if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_BOT_TOKEN or CLIENT_ID in Railway env vars.');
  process.exit(1);
}

// 🔄 Load all commands
const commands = [];
const commandFiles = fs.readdirSync(COMMANDS_PATH).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(COMMANDS_PATH, file));
  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON());
  } else {
    console.warn(`⚠️ Skipping ${file} — missing data or execute.`);
  }
}

// 🚀 Register slash commands globally
const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('🔁 Registering global slash commands...');
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered successfully!');
  } catch (error) {
    console.error('❌ Error while registering commands:', error);
  }
})();

