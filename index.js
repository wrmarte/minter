require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection, REST, Routes } = require('discord.js');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ---------- Auto-integrate PG knobs & required envs ----------
process.env.PGSSL_DISABLE      ??= '0';      // 0 = SSL ON (hosted PG), 1 = SSL OFF (local dev)
process.env.PG_POOL_MAX        ??= '5';
process.env.PG_IDLE_TIMEOUT_MS ??= '30000';
process.env.PG_CONN_TIMEOUT_MS ??= '10000';

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is required. Set it in your env or .env file.');
  process.exit(1);
}
if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN is required. Set it in your env or .env file.');
  process.exit(1);
}

// Helper services
require('./services/providerM');
require('./services/logScanner');

// ⬇️ NEW: presence ticker (BTC/ETH in member list)
const { startPresenceTicker, stopPresenceTicker } = require('./services/presenceTicker');

console.log("👀 Booting from:", __dirname);

// ✅ Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // REQUIRED for guildMemberAdd welcome events
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.GuildMember, Partials.User] // Helps when joins arrive as partials
});

// ====================== PostgreSQL (pool) ======================
const wantSsl = !/^1|true$/i.test(process.env.PGSSL_DISABLE || '');
console.log(`📦 PG SSL: ${wantSsl ? 'ON' : 'OFF'} | Pool max=${process.env.PG_POOL_MAX}`);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS),
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

    // 🔧 Ensure new welcome columns exist (safe to run every boot)
    await pool.query(`
      ALTER TABLE welcome_settings
        ADD COLUMN IF NOT EXISTS dm_enabled BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS delete_after_sec INTEGER,
        ADD COLUMN IF NOT EXISTS message_template TEXT,
        ADD COLUMN IF NOT EXISTS image_url TEXT,
        ADD COLUMN IF NOT EXISTS ping_role_id TEXT
    `);

    await pool.query(`
      UPDATE welcome_settings
      SET message_template = COALESCE(
        message_template,
        '👋 Welcome {user_mention} to **{server}**!\nYou’re member #{member_count}. Make yourself at home 💎'
      )
    `);

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

// =================== Listeners (after DB ready) ===================
require('./listeners/muscleMBListener')(client);
require('./listeners/mbella')(client);
require('./listeners/fftrigger')(client);
require('./listeners/welcomeListener')(client, pool); // pass PG to the welcome listener

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
  .catch(err => {
    console.error('❌ Discord login failed:', err);
    process.exit(1);
  });

// =================== Slash registration + presence ticker ===================

// --- Normalizer: ensure required options come first (recursively) ---
function sortOptions(options = []) {
  if (!Array.isArray(options)) return options;
  const required = [];
  const optional = [];

  for (const opt of options) {
    // type: 1 = SUB_COMMAND, 2 = SUB_COMMAND_GROUP
    if (opt.type === 1 || opt.type === 2) {
      if (Array.isArray(opt.options)) {
        opt.options = sortOptions(opt.options);
      }
      // Subcommands must not have "required"
      if ('required' in opt) delete opt.required;
      optional.push(opt); // subcommands are not "required" options
    } else {
      (opt.required ? required : optional).push(opt);
    }
  }
  return [...required, ...optional];
}

function normalizeCommandJSON(cmdJson) {
  if (Array.isArray(cmdJson?.options)) {
    cmdJson.options = sortOptions(cmdJson.options);
  }
  return cmdJson;
}

async function onClientReady() {
  if (client.__readyRan) return; // guard against double-run
  client.__readyRan = true;

  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.CLIENT_ID;

  if (!clientId) {
    console.warn('⚠️ CLIENT_ID not set — skipping slash command registration.');
  } else {
    const testGuildIds = (process.env.TEST_GUILD_IDS || '')
      .split(',')
      .map(id => id.trim())
      .filter(id => /^\d{17,20}$/.test(id));

    const rest = new REST({ version: '10' }).setToken(token);

    // Build JSON and normalize options ordering for Discord validation
    const commands = client.commands
      .map(cmd => {
        const json = cmd.data?.toJSON?.();
        return json ? normalizeCommandJSON(json) : null;
      })
      .filter(Boolean);

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
  }

  // ⬇️ Start the presence ticker (BTC/ETH)
  try { startPresenceTicker(client); } catch (e) { console.warn('⚠️ presence ticker start:', e?.message || e); }
}

// Use both names; DJS v14 warns about future rename. Guard prevents double exec.
client.once('clientReady', onClientReady);
client.once('ready', onClientReady);

// =================== Robust process handling ===================

// Catch async errors to avoid hard-crash
process.on('unhandledRejection', (err) => {
  console.error('🚨 Unhandled Rejection:', err?.stack || err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('🚨 Uncaught Exception:', err?.stack || err?.message || err);
});

// Graceful shutdown so Node exits cleanly
let shuttingDown = false;
async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 Shutting down (${reason})…`);

  try { if (timers.globalScan) clearInterval(timers.globalScan); } catch {}
  try { if (timers.rewardPayout) clearInterval(timers.rewardPayout); } catch {}
  try { stopPresenceTicker(); } catch {}

  try { await client.destroy(); } catch (e) { console.warn('⚠️ Discord destroy:', e?.message || e); }
  try { await pool.end(); } catch (e) { console.warn('⚠️ PG pool end:', e?.message || e); }

  process.exit(0);
}

function armSignal(sig) {
  process.once(sig, () => {
    gracefulShutdown(sig);
    setTimeout(() => process.exit(0), 10000); // failsafe
  });
}

armSignal('SIGTERM');
armSignal('SIGINT');

/*
.env knobs for the presence ticker:

TICKER_ENABLED=true
TICKER_MODE=rotate           # rotate | pair
TICKER_INTERVAL_MS=60000
TICKER_SOURCE=coingecko      # coingecko | coincap
TICKER_ASSETS=btc,eth
*/


