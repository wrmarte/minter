const { REST, Routes } = require('discord.js');
const { clientId, guildId, token } = require('./config.json');
const flex = require('./commands/flex.js');

const commands = [flex.data.toJSON()]; // ONLY your new /flex command

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('🔁 Registering test commands...');
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId), // test it in your dev server only
      { body: commands },
    );
    console.log('✅ Test command /flex registered.');
  } catch (error) {
    console.error(error);
  }
})();
