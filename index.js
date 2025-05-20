require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { Client: PgClient } = require('pg');
const fs = require('fs');
const path = require('path');

const trackContract = require('./services/trackContract.js');
const { TOKEN_NAME_TO_ADDRESS } = require('./utils/constants.js');
const onInteraction = require('./events/interactionCreate.js');
const onReady = require('./events/ready.js');

// ✅ Correctly initialized pg client
const pg = new PgClient({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pg.connect()
  .then(() => console.log('✅ Connected to PostgreSQL'))
  .catch(err => console.error('❌ PostgreSQL connection error:', err));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const commands = new Map();
const commandFiles = fs.readdirSync(path.join(__dirname, 'commands')).filter(f => f.endsWith('.js'));
for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  commands.set(command.data.name, command);
}

client.once('ready', () => onReady(client, pg, trackContract));
client.on('interactionCreate', interaction =>
  onInteraction(interaction, commands, { pg, trackContract, TOKEN_NAME_TO_ADDRESS })
);

client.login(process.env.DISCORD_BOT_TOKEN);

