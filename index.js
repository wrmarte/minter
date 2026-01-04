require('dotenv').config();

/* ======================================================
   🚀 ONE-TIME SLASH COMMAND DEPLOY (SAFE GUARD)
   ------------------------------------------------------
   Run only when:
   RUN_DEPLOY=true
   Then REMOVE the env var after success..
====================================================== */
if (process.env.RUN_DEPLOY === 'true') {
  console.log('🚀 Running slash command deploy...');
  require('./registerCommands');
}

const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
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
const { startChannelTicker, stopChannelTicker } = require('./services/channelTicker'); // ✅ NEW: channel list ticker (renames channel)
const { startThirdPartySwapNotifierBase } = require('./services/thirdPartySwapNotifierBase');
const { startEngineSweepNotifierBase } = require('./services/engineSweepNotifierBase');

// ✅ ADRIAN SWEEP ENGINE (BALANCE-BASED, GLOBAL)
const { startSweepEngine } = require('./services/adrianSweepEngine');

// ✅ WEBHOOK AUTO (MB RELAY)
// IMPORTANT: This is what makes “MBella identity” possible (messages sent as webhook username/avatar)
const webhookAuto = require('./services/webhookAuto');

// Optional identity envs (used by helper below)
const MBELLA_NAME = (process.env.MBELLA_NAME || 'MBella').trim();
const MBELLA_AVATAR =
  (process.env.MBELLA_AVATAR_URL || process.env.MBELLA_AVATAR || process.env.MBELLA_PFP || '').trim() || null;

// Webhook name to find/use in channels (manual webhook must match this name if you want the bot to “see” it)
const MB_RELAY_WEBHOOK_NAME = (process.env.MB_RELAY_WEBHOOK_NAME || 'MB Relay').trim();

// Debug
const WEBHOOKAUTO_DEBUG = String(process.env.WEBHOOKAUTO_DEBUG || '').trim() === '1';

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

// ✅ Attach webhookAuto to client so ALL listeners can use it (this is the missing “integration” most of the time)
client.webhookAuto = webhookAuto;

// ✅ Convenience helper: send as MBella via webhookAuto (falls back to normal send if webhook fails)
// Listeners can call: await client.sendAsMBella(channel, { content, embeds })
client.sendAsMBella = async (channel, payload = {}) => {
  try {
    if (!channel) return false;

    // Always block mass mentions through relay
    const safePayload = {
      ...payload,
      allowedMentions: payload.allowedMentions || { parse: [] },
      // Force the webhook “display identity”
      username: payload.username || MBELLA_NAME,
      avatarURL: payload.avatarURL || (MBELLA_AVATAR || undefined),
    };

    const ok = await client.webhookAuto.sendViaWebhook(
      channel,
      safePayload,
      {
        // This is the webhook object name in Discord (used to discover manual webhooks too)
        name: MB_RELAY_WEBHOOK_NAME,
        // This only affects bot-owned webhooks (manual ones won’t be edited)
        avatarURL: MBELLA_AVATAR
      }
    );

    if (ok) return true;

    // Fallback: normal send (will show as bot user, not MBella)
    await channel.send(payload);
    return true;
  } catch {
    return false;
  }
};

if (WEBHOOKAUTO_DEBUG) {
  console.log(`🪝 webhookAuto DEBUG=1 | relayName="${MB_RELAY_WEBHOOK_NAME}" | mbella="${MBELLA_NAME}" | avatar=${MBELLA_AVATAR ? 'set' : 'none'}`);
}

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

// ✅ Quick boot diagnostic
try {
  console.log(`🧠 client.pg attached: ${Boolean(client.pg)} | hasQuery: ${Boolean(client.pg?.query)}`);
} catch {}

// ================= Init DB =================
require('./db/initStakingTables')(pool).catch(console.error);

// ✅ NEW: Init Daily Digest tables (safe migration) — does NOT affect Bella/Muscle
(async () => {
  try {
    const { runDailyDigestMigration } = require('./db/migrations/2026_01_03_daily_digest');
    if (typeof runDailyDigestMigration === 'function') {
      await runDailyDigestMigration(pool);
    } else {
      console.warn('⚠️ Daily Digest migration module found but missing runDailyDigestMigration()');
    }
  } catch (e) {
    // Don’t crash your bot if the file isn’t added yet — just warn.
    console.warn('⚠️ Daily Digest migration skipped/failed:', e?.message || e);
  }
})().catch(() => {});

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

  // ✅ INIT PER-SERVER WEBHOOK TABLE
  try {
    await client.pg.query(`
      CREATE TABLE IF NOT EXISTS guild_webhooks (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT,
        webhook_url TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ guild_webhooks table ready');
  } catch (e) {
    console.error('❌ Failed to init guild_webhooks table:', e);
  }

  // ✅ NEW: Start Daily Digest Scheduler (Automation #2)
  // Requires: jobs/dailyDigestScheduler.js (and digest tables exist; migration runs on boot above)
  try {
    const { startDailyDigestScheduler } = require('./jobs/dailyDigestScheduler');
    if (typeof startDailyDigestScheduler === 'function') {
      await startDailyDigestScheduler(client);
      console.log('✅ Daily Digest scheduler started');
    } else {
      console.warn('⚠️ dailyDigestScheduler module found but missing startDailyDigestScheduler()');
    }
  } catch (e) {
    console.warn('⚠️ Daily Digest scheduler not started:', e?.message || e);
  }

  // ✅ Quick diagnostic: confirm webhookAuto is attached
  try {
    if (!client.webhookAuto || typeof client.webhookAuto.sendViaWebhook !== 'function') {
      console.warn('⚠️ webhookAuto not attached or invalid. MB relay will NOT show as MBella.');
    } else {
      console.log('✅ webhookAuto attached (MB relay ready)');
    }
  } catch {}

  // 1️⃣ Third-party swap notifier
  try {
    startThirdPartySwapNotifierBase(client);
    console.log('✅ Third-party swap notifier started');
  } catch (e) {
    console.warn('⚠️ swap notifier:', e?.message || e);
  }

  // 2️⃣ ADRIAN SWEEP ENGINE (BALANCE SOURCE OF TRUTH)
  try {
    console.log('🧹 Starting ADRIAN sweep engine (balance-based)');
    await startSweepEngine(client);
    console.log('✅ ADRIAN sweep engine started');
  } catch (e) {
    console.warn('⚠️ ADRIAN sweep engine:', e?.message || e);
  }

  // ⏳ Delay legacy Engine Sweep notifier (kept intact)
  setTimeout(() => {
    try {
      console.log('🧹 Starting Engine Sweep notifier (delayed)');
      startEngineSweepNotifierBase(client);
      console.log('✅ Engine Sweep notifier started');
    } catch (e) {
      console.warn('⚠️ engine sweep notifier:', e?.message || e);
    }
  }, 5000);

  // 3️⃣ Presence ticker
  try {
    startPresenceTicker(client);
    console.log('✅ Presence ticker started');
  } catch (e) {
    console.warn('⚠️ presence ticker:', e?.message || e);
  }

  // 4️⃣ ✅ Channel-list ticker (renames configured channel(s))
  try {
    startChannelTicker(client);
    console.log('✅ Channel ticker started');
  } catch (e) {
    console.warn('⚠️ channel ticker:', e?.message || e);
  }
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
  try { stopChannelTicker(); } catch {} // ✅ NEW
  try { await client.destroy(); } catch {}
  try { await pool.end(); } catch {}

  process.exit(0);
}

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
