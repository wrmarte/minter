require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Load helper services
require('./services/providerM');
require('./services/logScanner');

console.log("👀 Booting from:", __dirname);

// ✅ Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ✅ Load listeners (order matters if you coordinate typing suppress, etc.)
require('./listeners/muscleMBListener')(client);
require('./listeners/mbella')(client);
require('./listeners/fftrigger')(client);
require('./listeners/welcomeListener')(client);

// ====================== PostgreSQL (pool) ======================
const wantSsl = !/^1|true$/i.test(process.env.PGSSL_DISABLE || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || '5'),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || '30000'),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || '10000'),
  ssl: wantSsl ? { rejectUnauthorized: false } : false
});

// Prevent unhandled 'error' on pool idle clients from crashing the process
pool.on('error', (err) => {
  console.error('🛑 PG pool idle client error:', err?.stack || err?.message || err);
});

client.pg = pool;

// ✅ Initialize staking-related tables
require('./db/initStakingTables')(pool).catch(console.error);

// ✅ Core bot tables
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS contract_watchlist (
      name TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      mint_price NUMERIC NOT NULL,
      mint_token TEXT DEFAULT 'ETH',
      mint_token_symbol TEXT DEFAULT 'ETH',
      channel_ids TEXT[],
      chain TEXT DEFAULT 'base'
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS tracked_tokens (
      name TEXT,
      address TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT,
      PRIMARY KEY (address, guild_id)
    )`);
    await pool.query(`ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS channel_id TEXT`);

    await pool.query(`CREATE TABLE IF NOT EXISTS flex_projects (
      name TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      network TEXT NOT NULL
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS expressions (
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      guild_id TEXT,
      PRIMARY KEY (name, guild_id)
    )`);
    await pool.query(`ALTER TABLE expressions ADD COLUMN IF NOT EXISTS guild_id TEXT`);

    await pool.query(`CREATE TABLE IF NOT EXISTS premium_servers (
      server_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL DEFAULT 'free'
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS premium_users (
      user_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL DEFAULT 'free'
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS mb_modes (
      server_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'default'
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS server_themes (
      server_id TEXT PRIMARY KEY,
      bg_color TEXT DEFAULT '#4e7442',
      accent_color TEXT DEFAULT '#294f30'
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS welcome_settings (
      guild_id TEXT PRIMARY KEY,
      enabled BOOLEAN DEFAULT FALSE,
      welcome_channel_id TEXT
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS dummy_info (
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      PRIMARY KEY (name, guild_id)
    )`);
  } catch (err) {
    console.error('❌ DB bootstrap error:', err);
  }
})();

// =================== Commands loader ===================
client.commands = new Collection();
client.prefixCommands = new Collection();

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
      console.warn(`⚠️ Skipped ${file} — missing .data/.name or .execute`);
    }
  }
} catch (err) {
  console.error('❌ Error loading commands:', err);
}

// =================== Events loader ===================
try {
  const eventFiles = fs.readdirSync(path.join(__dirname, 'events')).filter(file => file.endsWith('.js'));
  for (const file of eventFiles) {
    const registerEvent = require(`./events/${file}`);
    registerEvent(client, pool);
    console.log(`📡 Event loaded: ${file}`);
  }
} catch (err) {
  console.error('❌ Events load error:', err);
}

// =================== Services / timers ===================
const { trackAllContracts } = require('./services/mintRouter');
trackAllContracts(client);

const processUnifiedBlock = require('./services/globalProcessor');
const { getProvider } = require('./services/providerM');

// keep references so we can clear them on shutdown
const timers = {
  globalScan: null,
  rewardPayout: null
};

timers.globalScan = setInterval(async () => {
  try {
    const latestBlock = await getProvider().getBlockNumber();
    await processUnifiedBlock(client, latestBlock - 5, latestBlock);
  } catch (err) {
    console.error("Global scanner error:", err);
  }
}, 15000); // every 15 sec

const autoRewardPayout = require('./services/autoRewardPayout');
timers.rewardPayout = setInterval(() => {
  console.log('💸 Running autoRewardPayout...');
  autoRewardPayout(client).catch(console.error);
}, 24 * 60 * 60 * 1000); // every 24 hours

if (process.env.APE_ENABLED === 'true') {
  console.log('🔄 Loading Mint Processor Ape...');
  require('./services/mintProcessorApe')(client);
} else {
  console.log('⛔ Mint Processor Ape disabled by config.');
}

// =================== Discord login ===================
client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => console.log(`✅ Logged in as ${client.user.tag}`))
  .catch(err => console.error('❌ Discord login failed:', err));

// =================== Slash registration ===================
client.once('ready', async () => {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.CLIENT_ID;

  const testGuildIds = (process.env.TEST_GUILD_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(id => /^\d{17,20}$/.test(id));

  const rest = new REST({ version: '10' }).setToken(token);
  const commands = client.commands.map(cmd => cmd.data.toJSON());

  try {
    console.log('⚙️ Auto-registering slash commands...');

    for (const guildId of testGuildIds) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log(`✅ Registered ${commands.length} slash cmds in test guild (${guildId})`);
    }

    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`🌐 Registered ${commands.length} global slash cmds`);

  } catch (err) {
    console.error('❌ Failed to register slash commands:', err);
  }
});

// =================== Robust process handling ===================

// Catch async errors to avoid hard-crash
process.on('unhandledRejection', (err) => {
  console.error('🚨 Unhandled Rejection:', err?.stack || err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('🚨 Uncaught Exception:', err?.stack || err?.message || err);
});

// Graceful shutdown so NPM doesn’t print an error on SIGTERM (exit 0)
let shuttingDown = false;
async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 Shutting down (${reason})…`);

  // Stop timers
  try { if (timers.globalScan) clearInterval(timers.globalScan); } catch {}
  try { if (timers.rewardPayout) clearInterval(timers.rewardPayout); } catch {}

  // Close Discord (stops websocket cleanly)
  try { await client.destroy(); } catch (e) { console.warn('⚠️ Discord destroy:', e?.message || e); }

  // Close DB pool
  try { await pool.end(); } catch (e) { console.warn('⚠️ PG pool end:', e?.message || e); }

  // Exit success so npm doesn’t print an error block
  process.exit(0);
}

// Railway & many platforms send SIGTERM on redeploy/scale down
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT',  () => gracefulShutdown('SIGINT'));

// Failsafe: if shutdown stalls, force exit after 10s
process.once('SIGTERM', () => setTimeout(() => process.exit(0), 10000));
process.once('SIGINT',  () => setTimeout(() => process.exit(0), 10000));
