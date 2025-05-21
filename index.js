require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { Client: PgClient } = require('pg');

// PostgreSQL
const pg = new PgClient({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
pg.connect().then(() => console.log('✅ Connected to PostgreSQL')).catch(console.error);

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

client.commands = new Collection();

const commandsPath = path.join(__dirname, 'minter', 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
    console.log(`📦 Loaded command: /${command.data.name}`);
  } else {
    console.warn(`⚠️ Skipped ${file}: missing 'data' or 'execute'`);
  }
}

client.once(Events.ClientReady, () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, { pg });
  } catch (error) {
    console.error(`❌ Error in /${interaction.commandName}:`, error);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: '❌ Command error.' });
    } else {
      await interaction.reply({ content: '❌ Failed to execute command.', ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => console.log('✅ Bot login successful'))
  .catch(err => console.error('❌ Bot login failed:', err));

