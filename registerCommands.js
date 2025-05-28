const { REST, Routes } = require('discord.js');
require('dotenv').config();

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log('🧹 Clearing all global slash commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
    console.log('✅ All commands cleared.');
  } catch (error) {
    console.error('❌ Error clearing commands:', error);
  }
})();




