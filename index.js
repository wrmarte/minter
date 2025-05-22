// /minter/index.js

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { Client: PgClient } = require('pg');
const fs = require('fs');
const path = require('path');
console.log("👀 Current dir:", __dirname);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// === PostgreSQL Client ===
const { Client: PgClient } = require('pg');
const pg = new PgClient({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
pg.connect();

// ✅ Existing table
pg.query(`CREATE TABLE IF NOT EXISTS contract_watchlist (
  name TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  mint_price NUMERIC NOT NULL,
  mint_token TEXT DEFAULT 'ETH',
  mint_token_symbol TEXT DEFAULT 'ETH',
  channel_ids TEXT[]
)`);

// ✅ Add this block:
pg.query(`CREATE TABLE IF NOT EXISTS flex_projects (
  name TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  network TEXT NOT NULL
)`);


// === Command Loader ===
client.commands = new Map();
const commandFiles = fs.readdirSync(path.join(__dirname, 'commands')).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
  }
}

// === Event Loader ===
const eventFiles = fs.readdirSync(path.join(__dirname, 'events')).filter(file => file.endsWith('.js'));
for (const file of eventFiles) {
  const registerEvent = require(`./events/${file}`);
  registerEvent(client);
}

// === Start the bot ===
client.login(process.env.DISCORD_BOT_TOKEN);

