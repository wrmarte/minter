require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { Client: PgClient } = require('pg');
const fs = require('fs');
const path = require('path');

console.log("👀 Booting from:", __dirname);

// === Discord Client ===
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// === PostgreSQL Setup ===
const pg = new PgClient({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
pg.connect();
client.pg = pg;

// ✅ Create Tables
pg.query(`CREATE TABLE IF NOT EXISTS contract_watchlist (
  name TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  mint_price NUMERIC NOT NULL,
  mint_token TEXT DEFAULT 'ETH',
  mint_token_symbol TEXT DEFAULT 'ETH',
  channel_ids TEXT[]
)`);

pg.query(`CREATE TABLE IF NOT EXISTS flex_projects (
  name TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  network TEXT NOT NULL
)`);

pg.query(`CREATE TABLE IF NOT EXISTS tracked_tokens (
  name TEXT,
  address TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  PRIMARY KEY (address, guild_id)
)`);

pg.query(`ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS channel_id TEXT`);

// === Command Loaders ===
client.commands = new Collection();        // Slash commands
client.prefixCommands = new Collection();  // !prefix commands

try {
  const commandFiles = fs.readdirSync(path.join(__dirname, 'commands')).filter(file => file.endsWith('.js'));

  for (const file of commandFiles) {
    const command = require(`./commands/${file}`);

    if (command.data && command.execute) {
      client.commands.set(command.data.name, command);
      console.log(`✅ Loaded command: /${command.data.name}`);
    } else if (command.name && command.execute) {
      client.prefixCommands.set(command.name, command);
      console.log(`✅ Loaded command: !${command.name}`);
    } else {
      console.warn(`⚠️ Skipped ${file} — missing structure`);
    }
  }
} catch (err) {
  console.error('❌ Error loading commands:', err);
}

// === Event Loader ===
const eventFiles = fs.readdirSync(path.join(__dirname, 'events')).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
  try {
    const registerEvent = require(`./events/${file}`);
    registerEvent(client, pg);
    console.log(`📡 Event loaded: ${file}`);
  } catch (err) {
    console.error(`❌ Failed to load event ${file}:`, err);
  }
}

// === Login Bot ===
client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => {
    console.log(`✅ Logged in as ${client.user.tag}`);
  })
  .catch(err => {
    console.error('❌ Discord login failed:', err);
  });






