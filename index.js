client.on('ready', () => {
  console.log(`✅ Bot is ready as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  console.log('🟢 Received interaction:', interaction.commandName);
});

const { Client, GatewayIntentBits, Events, Collection, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// Load commands manually
client.commands = new Collection();

// ✅ Register /ping directly in memory
client.commands.set('ping', {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if bot responds'),
  async execute(interaction) {
    console.log('✅ Ping triggered!');
    await interaction.reply('🏓 Pong!');
  }
});

// ✅ Interaction handler
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    console.log(`⚙️ Executing /${interaction.commandName}`);
    await command.execute(interaction);
  } catch (err) {
    console.error('❌ Command error:', err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: '❌ Error running command.' });
    } else {
      await interaction.reply({ content: '❌ Could not run.', ephemeral: true });
    }
  }
});

// ✅ Ready log
client.once(Events.ClientReady, () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
