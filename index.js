require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { Client: PgClient } = require('pg');
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

// ✅ Load MuscleMB trigger
require('./listeners/muscleMBListener')(client);
require('./listeners/mbella')(client);


// ✅ Load FF Trigger listener
require('./listeners/fftrigger')(client);

// ✅ Load Welcome Listener
require('./listeners/welcomeListener')(client);

// ✅ PostgreSQL connection
const pg = new PgClient({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
pg.connect();
client.pg = pg;

// ✅ Initialize staking-related tables
require('./db/initStakingTables')(pg).catch(console.error);

// ✅ Core bot tables
pg.query(`CREATE TABLE IF NOT EXISTS contract_watchlist (
  name TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  mint_price NUMERIC NOT NULL,
  mint_token TEXT DEFAULT 'ETH',
  mint_token_symbol TEXT DEFAULT 'ETH',
  channel_ids TEXT[],
  chain TEXT DEFAULT 'base'
)`);

pg.query(`CREATE TABLE IF NOT EXISTS tracked_tokens (
  name TEXT,
  address TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  PRIMARY KEY (address, guild_id)
)`);
pg.query(`ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS channel_id TEXT`);

pg.query(`CREATE TABLE IF NOT EXISTS flex_projects (
  name TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  network TEXT NOT NULL
)`);

pg.query(`CREATE TABLE IF NOT EXISTS expressions (
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  guild_id TEXT,
  PRIMARY KEY (name, guild_id)
)`);
pg.query(`ALTER TABLE expressions ADD COLUMN IF NOT EXISTS guild_id TEXT`);

pg.query(`CREATE TABLE IF NOT EXISTS premium_servers (
  server_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'free'
)`);

pg.query(`CREATE TABLE IF NOT EXISTS premium_users (
  user_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'free'
)`);

pg.query(`CREATE TABLE IF NOT EXISTS mb_modes (
  server_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'default'
)`);

pg.query(`CREATE TABLE IF NOT EXISTS server_themes (
  server_id TEXT PRIMARY KEY,
  bg_color TEXT DEFAULT '#4e7442',
  accent_color TEXT DEFAULT '#294f30'
)`);

pg.query(`CREATE TABLE IF NOT EXISTS welcome_settings (
  guild_id TEXT PRIMARY KEY,
  enabled BOOLEAN DEFAULT FALSE,
  welcome_channel_id TEXT
)`);

pg.query(`CREATE TABLE IF NOT EXISTS dummy_info (
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  PRIMARY KEY (name, guild_id)
)`);

// ✅ Load slash & prefix commands
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

// ✅ Load event handlers
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

// ✅ Mint/Sale Trackers
const { trackAllContracts } = require('./services/mintRouter');
trackAllContracts(client);

// ✅ Global Token Scanner
const processUnifiedBlock = require('./services/globalProcessor');
const { getProvider } = require('./services/providerM');

setInterval(async () => {
  try {
    const latestBlock = await getProvider().getBlockNumber();
    await processUnifiedBlock(client, latestBlock - 5, latestBlock);
  } catch (err) {
    console.error("Global scanner error:", err);
  }
}, 15000); // every 15 sec

// ✅ Auto Reward Payout System
const autoRewardPayout = require('./services/autoRewardPayout');
setInterval(() => {
  console.log('💸 Running autoRewardPayout...');
  autoRewardPayout(client).catch(console.error);
}, 24 * 60 * 60 * 1000); // every 24 hours

// ✅ Conditional Mint Processor Ape Loader
if (process.env.APE_ENABLED === 'true') {
  console.log('🔄 Loading Mint Processor Ape...');
  require('./services/mintProcessorApe')(client);
} else {
  console.log('⛔ Mint Processor Ape disabled by config.');
}

// ✅ Login to Discord
client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => console.log(`✅ Logged in as ${client.user.tag}`))
  .catch(err => console.error('❌ Discord login failed:', err));

// ✅ Auto-register slash commands on bot ready
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























