require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Load helper services
require('./services/providerM');
require('./services/logScanner');

console.log("👀 Booting from:", __dirname);

/* ===================== Discord Client ===================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* ===================== Postgres (Resilient Pool) ===================== */
// Pool config works well on Railway/Neon/Supabase, etc.
// - For serverless PG: leave SSL on but don't verify the chain.
// - For local dev without SSL: set PGSSL_DISABLE=1 in .env
const pgConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL_DISABLE ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10_000),
  keepAlive: true,
  allowExitOnIdle: true,
};

function createPool() {
  const pool = new Pool(pgConfig);
  // Never crash the process on idle client error (ECONNRESET, etc.)
  pool.on('error', (err) => {
    console.error('⚠️ pg idle client error (ignored):', err?.code || err?.message);
  });
  return pool;
}

client.pg = createPool();

/** Self-healing healthcheck: if queries fail, rebuild pool */
(function wirePgHealth(bot, makePool) {
  let backoff = 10_000;        // 10s
  const maxBackoff = 60_000;   // 60s

  async function check() {
    try {
      await bot.pg.query('SELECT 1'); // cheap health probe
      backoff = 10_000;
    } catch (err) {
      console.warn('⚠️ pg healthcheck failed:', err?.code || err?.message, 'recreating pool…');
      try { await bot.pg.end().catch(() => {}); } catch {}
      bot.pg = makePool();
    }
    setTimeout(check, Math.min(backoff *= 1.5, maxBackoff));
  }
  setTimeout(check, backoff);
})(client, createPool);

/* ===================== DB Setup (Tables) ===================== */
// use the pool directly (no .connect() needed)
(async () => {
  try {
    await require('./db/initStakingTables')(client.pg);

    await client.pg.query(`CREATE TABLE IF NOT EXISTS contract_watchlist (
      name TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      mint_price NUMERIC NOT NULL,
      mint_token TEXT DEFAULT 'ETH',
      mint_token_symbol TEXT DEFAULT 'ETH',
      channel_ids TEXT[],
      chain TEXT DEFAULT 'base'
    )`);

    await client.pg.query(`CREATE TABLE IF NOT EXISTS tracked_tokens (
      name TEXT,
      address TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT,
      PRIMARY KEY (address, guild_id)
    )`);
    await client.pg.query(`ALTER TABLE tracked_tokens ADD COLUMN IF NOT EXISTS channel_id TEXT`);

    await client.pg.query(`CREATE TABLE IF NOT EXISTS flex_projects (
      name TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      network TEXT NOT NULL
    )`);

    await client.pg.query(`CREATE TABLE IF NOT EXISTS expressions (
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      guild_id TEXT,
      PRIMARY KEY (name, guild_id)
    )`);
    await client.pg.query(`ALTER TABLE expressions ADD COLUMN IF NOT EXISTS guild_id TEXT`);

    await client.pg.query(`CREATE TABLE IF NOT EXISTS premium_servers (
      server_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL DEFAULT 'free'
    )`);

    await client.pg.query(`CREATE TABLE IF NOT EXISTS premium_users (
      user_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL DEFAULT 'free'
    )`);

    await client.pg.query(`CREATE TABLE IF NOT EXISTS mb_modes (
      server_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'default'
    )`);

    await client.pg.query(`CREATE TABLE IF NOT EXISTS server_themes (
      server_id TEXT PRIMARY KEY,
      bg_color TEXT DEFAULT '#4e7442',
      accent_color TEXT DEFAULT '#294f30'
    )`);

    await client.pg.query(`CREATE TABLE IF NOT EXISTS welcome_settings (
      guild_id TEXT PRIMARY KEY,
      enabled BOOLEAN DEFAULT FALSE,
      welcome_channel_id TEXT
    )`);

    await client.pg.query(`CREATE TABLE IF NOT EXISTS dummy_info (
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      PRIMARY KEY (name, guild_id)
    )`);
  } catch (err) {
    console.error('❌ DB init error:', err);
  }
})();

/* ===================== Listeners (load after client.pg exists) ===================== */
try {
  require('./listeners/muscleMBListener')(client);
  require('./listeners/mbella')(client);
  require('./listeners/fftrigger')(client);
  require('./listeners/welcomeListener')(client);
  console.log('🎧 Listeners loaded.');
} catch (err) {
  console.error('❌ Error loading listeners:', err);
}

/* ===================== Commands ===================== */
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

/* ===================== Events ===================== */
try {
  const eventFiles = fs.readdirSync(path.join(__dirname, 'events')).filter(file => file.endsWith('.js'));
  for (const file of eventFiles) {
    const registerEvent = require(`./events/${file}`);
    registerEvent(client, client.pg);
    console.log(`📡 Event loaded: ${file}`);
  }
} catch (err) {
  console.error('❌ Error loading events:', err);
}

/* ===================== Services ===================== */
const { trackAllContracts } = require('./services/mintRouter');
trackAllContracts(client);

const processUnifiedBlock = require('./services/globalProcessor');
const { getProvider } = require('./services/providerM');

const globalScanner = setInterval(async () => {
  try {
    const latestBlock = await getProvider().getBlockNumber();
    await processUnifiedBlock(client, latestBlock - 5, latestBlock);
  } catch (err) {
    console.error("Global scanner error:", err);
  }
}, 15000); // every 15 sec

const autoRewardPayout = require('./services/autoRewardPayout');
const payoutTimer = setInterval(() => {
  console.log('💸 Running autoRewardPayout...');
  autoRewardPayout(client).catch(console.error);
}, 24 * 60 * 60 * 1000); // every 24 hours

if (process.env.APE_ENABLED === 'true') {
  console.log('🔄 Loading Mint Processor Ape...');
  require('./services/mintProcessorApe')(client);
} else {
  console.log('⛔ Mint Processor Ape disabled by config.');
}

/* ===================== Discord Login ===================== */
client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => console.log(`✅ Logged in as ${client.user.tag}`))
  .catch(err => console.error('❌ Discord login failed:', err));

/* ===================== Slash Commands Auto-Register ===================== */
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

/* ===================== Safety Nets & Graceful Shutdown ===================== */
// Don’t let a stray error kill the process
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED', reason);
});

// Graceful shutdown for Railway/containers
async function shutdown(sig) {
  try {
    console.log(`${sig} received. Shutting down…`);
    clearInterval(globalScanner);
    clearInterval(payoutTimer);
    try { await client.destroy(); } catch {}
    try { await client.pg.end(); } catch {}
  } finally {
    process.exit(0);
  }
}
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => shutdown(sig)));
























