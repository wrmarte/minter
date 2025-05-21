require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Events } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { Client: PgClient } = require('pg');

// ✅ PostgreSQL Setup
const pg = new PgClient({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pg.connect().then(() => console.log('✅ Connected to PostgreSQL')).catch(console.error);

// ✅ Discord Client Setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

// ✅ Slash Command Loader
client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands'); // Adjust if using /minter/commands
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
    console.log(`📦 Loaded command: /${command.data.name}`);
  } else {
    console.warn(`⚠️ Skipping ${file}: missing 'data' or 'execute'`);
  }
}

// ✅ Interaction Handler
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  console.log(`🟡 Command triggered: /${interaction.commandName}`); // 👈 ADD THIS

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    console.log(`⚙️ Running command: /${interaction.commandName}`);
    await command.execute(interaction, { pg });
  } catch (error) {
    console.error('❌ Error in command:', error);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: '❌ Command error' });
    } else {
      await interaction.reply({ content: '❌ Command crash', ephemeral: true });
    }
  }
});


// ✅ Bot Ready
client.once(Events.ClientReady, c => {
  console.log(`🤖 Logged in as ${c.user.tag}`);
});

// ✅ Start Bot
client.login(process.env.DISCORD_BOT_TOKEN);


