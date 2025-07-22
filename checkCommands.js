require('dotenv').config();
const { REST, Routes } = require('discord.js');

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
const clientId = process.env.CLIENT_ID;
const guildId = process.env.TEST_GUILD_ID;

(async () => {
  try {
    console.log('🔍 Fetching registered slash commands...');
    const data = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
    if (data.length === 0) {
      console.log('❌ No slash commands are registered on this guild.');
    } else {
      console.log(`✅ ${data.length} commands found:`);
      for (const cmd of data) {
        console.log(`- /${cmd.name}`);
      }
    }
  } catch (err) {
    console.error('❌ Failed to fetch commands:', err?.rawError || err);
  }
})();
