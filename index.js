require('dotenv').config();
const { Client, GatewayIntentBits, Events, Collection, SlashCommandBuilder } = require('discord.js');

// ✅ Initialize bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ✅ Register commands in memory
client.commands = new Collection();

client.commands.set('ping', {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if bot responds'),
  async execute(interaction) {
    console.log('✅ Ping triggered!');
    await interaction.reply('🏓 Pong!');
  }
});

// ✅ On interaction create
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  console.log('🟢 Received interaction:', interaction.commandName);

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

// ✅ On bot ready
client.once(Events.ClientReady, () => {
  console.log(`🤖 Bot is ready as ${client.user.tag}`);
});

// ✅ Login with error handling
client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => console.log('✅ Successfully called client.login()'))
  .catch(err => console.error('❌ client.login() failed:', err));

