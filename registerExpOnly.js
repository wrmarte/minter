require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const command = new SlashCommandBuilder()
  .setName('exp')
  .setDescription('Show a visual experience vibe')
  .addStringOption(option =>
    option.setName('name')
      .setDescription('Name of the expression (e.g. "rich")')
      .setRequired(true)
      .setAutocomplete(true) // 🔥 THIS IS THE CRITICAL PART
  );

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log('🔁 Overwriting /exp command only...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: [command.toJSON()] }
    );
    console.log('✅ /exp command re-registered with autocomplete.');
  } catch (error) {
    console.error('❌ Failed to register /exp:', error);
  }
})();
