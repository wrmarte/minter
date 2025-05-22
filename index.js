require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { Client: PgClient } = require('pg');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const pg = new PgClient({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
pg.connect();

client.pg = pg;

// Register all events
const eventFiles = fs.readdirSync(path.join(__dirname, 'events'));
for (const file of eventFiles) {
  const event = require(`./events/${file}`);
  event(client);
}

// Start bot
client.login(process.env.DISCORD_BOT_TOKEN);
