require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { Client: PgClient } = require('pg');
const fs = require('fs');
const path = require('path');

console.log("👀 Booting from:", __dirname);

// === Discord Client ===
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
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

// === Command Loader ===
client.commands = new Map();

try {
  const commandFiles = fs.readdirSync(path.join(__dirname, 'commands')).filter(file => file.endsWith('.js'));

  for (const file of commandFiles) {
    const command = require(`./commands/${file}`);

    if (command.data && command.execute) {
      client.commands.set(command.data.name, command);
      console.log(`✅ Loaded command: /${command.data.name}`);
    } else {
      console.warn(`⚠️ Skipped ${file} — missing .data or .execute`);
    }
  }
} catch (err) {
  console.error('❌ Error loading commands:', err);
}

// === Event Loader (now passes pg to each event) ===
const eventFiles = fs.readdirSync(path.join(__dirname, 'events')).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
  try {
    const registerEvent = require(`./events/${file}`);
    registerEvent(client, pg); // ✅ patched to pass pg
    console.log(`📡 Event loaded: ${file}`);
  } catch (err) {
    console.error(`❌ Failed to load event ${file}:`, err);
  }
}

// === Start the Bot ===
client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => {
    console.log(`✅ Logged in as ${client.user.tag}`);
  })
  .catch(err => {
    console.error('❌ Discord login failed:', err);
  });




