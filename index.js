require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection, REST, Routes } = require('discord.js');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ---------- Auto-integrate PG knobs ----------
process.env.PGSSL_DISABLE      ??= '0';
process.env.PG_POOL_MAX        ??= '5';
process.env.PG_IDLE_TIMEOUT_MS ??= '30000';
process.env.PG_CONN_TIMEOUT_MS ??= '10000';

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is required.');
  process.exit(1);
}
if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN is required.');
  process.exit(1);
}

// ================= Core Services =================
require('./services/providerM');
require('./services/logScanner');

const { startPresenceTicker, stopPresenceTicker } = require('./services/presenceTicker');
const { startThirdPartySwapNotifierBase } = require('./services/thirdPartySwapNotifierBase');
const { startEngineSweepNotifierBase } = require('./services/engineSweepNotifierBase');

console.log('👀 Booting from:', __dirname);

// ================= Discord Client =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.GuildMember, Partials.User]
});

// ================= PostgreSQL =================
const wantSsl = !/^1|true$/i.test(process.env.PGSSL_DISABLE || '');
console.log(`📦 PG SSL: ${wantSsl ? 'ON' : 'OFF'} | Pool max=${process.env.PG_POOL_MAX}`);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS),
  ssl: wantSsl ? { rejectUnauthorized: false } : false
});

pool.on('error', err => {
  console.error('🛑 PG pool idle client error:', err?.message || err);
});

client.pg = pool;

// ================= Init DB =================
require('./db/initStakingTables')(pool).catch(console.error);

// ================= Commands =================
client.commands = new Collection();
client.prefixCommands = new Collection();

for (const file of fs.readdirSync(path.join(__dirname, 'commands')).filter(f => f.endsWith('.js'))) {
  const command = require(`./commands/${file}`);
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
    console.log(`✅ Loaded command: /${command.data.name}`);
  } else if (command.name && command.execute) {
    client.prefixCommands.set(command.name, command);
    console.log(`✅ Loaded command: !${command.name}`);
  }
}

// ================= Events =================
for (const file of fs.readdirSync(path.join(__dirname, 'events')).filter(f => f.endsWith('.js'))) {
  require(`./events/${file}`)(client, pool);
  console.log(`📡 Event loaded: ${file}`);
}

// ================= Listeners =================
require('./listeners/muscleMBListener')(client);
require('./listeners/mbella')(client);
require('./listeners/fftrigger')(client);
require('./listeners/battlePrefix')(client);
require('./listeners/welcomeListener')(client, pool);

// ================= Mint Router =================
const { trackAllContracts } = require('./services/mintRouter');
trackAllContracts(client);

// ================= Global Scanner =================
const processUnifiedBlock = require('./services/globalProcessor');
const { safeRpcCall } = require('./services/providerM');

const timers = { globalScan: null, rewardPayout: null };
let globalScanDelayMs = 15000;

async function runGlobalScanTick() {
  try {
    const provider = await safeRpcCall('base', p => p);
    if (!provider) throw new Error('No base provider');

    const latestBlock = await provider.getBlockNumber();
    await processUnifiedBlock(client, Math.max(latestBlock - 5, 0), latestBlock);
    globalScanDelayMs = 15000;
  } catch (err) {
    const msg = (err?.message || '').toLowerCase();
    if (msg.includes('rate')) {
      globalScanDelayMs = Math.min(globalScanDelayMs * 2, 180000);
      console.warn(`⏳ Rate-limited. Backing off to ${globalScanDelayMs}ms`);
    } else {
      console.error('Global scanner error:', err);
      globalScanDelayMs = Math.min(globalScanDelayMs + 5000, 60000);
    }
  } finally {
    timers.globalScan = setTimeout(runGlobalScanTick, globalScanDelayMs);
  }
}

timers.globalScan = setTimeout(runGlobalScanTick, 15000);

// ================= Auto Rewards =================
const autoRewardPayout = require('./services/autoRewardPayout');
timers.rewardPayout = setInterval(() => {
  console.log('💸 Running autoRewardPayout...');
  autoRewardPayout(client).catch(console.error);
}, 24 * 60 * 60 * 1000);

// ================= Ape =================
if (process.env.APE_ENABLED === 'true') {
  console.log('🔄 Loading Mint Processor Ape...');
  require('./services/mintProcessorApe')(client);
} else {
  console.log('⛔ Mint Processor Ape disabled.');
}

// ================= Login =================
client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => console.log(`✅ Logged in as ${client.user.tag}`))
  .catch(err => {
    console.error('❌ Discord login failed:', err);
    process.exit(1);
  });

// ================= Ready (ORDER MATTERS) =================
async function onClientReady() {
  if (client.__readyRan) return;
  client.__readyRan = true;

  console.log('🚀 Client ready — starting services');

  // 1️⃣ Swap notifier
  try { startThirdPartySwapNotifierBase(client); }
  catch (e) { console.warn('⚠️ swap notifier:', e?.message || e); }

  // 2️⃣ Engine sweep notifier (AFTER swaps + mint router)
  try { startEngineSweepNotifierBase(client); }
  catch (e) { console.warn('⚠️ engine sweep notifier:', e?.message || e); }

  // 3️⃣ Presence ticker (last)
  try { startPresenceTicker(client); }
  catch (e) { console.warn('⚠️ presence ticker:', e?.message || e); }
}

client.once('clientReady', onClientReady);
client.once('ready', onClientReady);

// ================= Safety =================
process.on('unhandledRejection', err => {
  console.error('🚨 Unhandled Rejection:', err);
});
process.on('uncaughtException', err => {
  console.error('🚨 Uncaught Exception:', err);
});

// ================= Shutdown =================
let shuttingDown = false;
async function gracefulShutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`🛑 Shutting down (${sig})`);
  try { if (timers.globalScan) clearTimeout(timers.globalScan); } catch {}
  try { if (timers.rewardPayout) clearInterval(timers.rewardPayout); } catch {}
  try { stopPresenceTicker(); } catch {}
  try { await client.destroy(); } catch {}
  try { await pool.end(); } catch {}

  process.exit(0);
}

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));



