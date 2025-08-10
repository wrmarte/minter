const { SlashCommandBuilder, EmbedBuilder, version: djsVersion } = require('discord.js');

// ✅ FIX: import from providerM (the file that exports safeRpcCall)
let providerApi;
try {
  providerApi = require('../services/providerM');
} catch {
  // fallback to old path if needed
  providerApi = require('../services/provider');
}
const { getProvider } = providerApi;
const safeCall = typeof providerApi.safeRpcCall === 'function'
  ? providerApi.safeRpcCall
  : async (chain, fn) => { // soft fallback if safeRpcCall isn't available
      try { const p = getProvider(chain); return p ? await fn(p) : null; } catch { return null; }
    };

// Mint processor listeners (optional modules handled safely)
let baseListeners = {}, ethListeners = {}, apeListeners = {};
try { baseListeners = require('../services/mintProcessorBase').contractListeners || {}; } catch {}
try { ethListeners  = require('../services/mintProcessorETH')?.contractListeners || {}; } catch {}
try { apeListeners  = require('../services/mintProcessorApe')?.contractListeners || {}; } catch {}

const { statSync } = require('fs');
const os = require('os');
const pkgVersion = require('../package.json').version;

let mintProcessorStartTime = Date.now();

function fmtUptime(ms) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return (d ? `${d}d ` : '') + `${h}h ${m}m`;
}
function fmtBytes(n) { return `${(n / 1024 / 1024).toFixed(1)} MB`; }
function statusEmoji(ok) { return ok ? '🟢' : '🔴'; }

async function chainStatus(chainKey, label) {
  const prov = getProvider(chainKey);
  const url = prov?._rpcUrl || '—';
  let live = false;
  let block = 'N/A';

  const blockNum = await safeCall(chainKey, p => p.getBlockNumber());
  if (typeof blockNum === 'number' && blockNum >= 0) {
    live = true;
    block = `#${blockNum.toLocaleString()}`;
  }
  return `${statusEmoji(live)} **${label}** — ${live ? 'Live' : 'Offline'} ${live ? `(${block})` : ''}\n↳ \`${url}\``;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('📊 Display full system health overview'),

  async execute(interaction) {
    const client = interaction.client;
    const pg = client.pg;

    await interaction.deferReply({ ephemeral: false }).catch(() => {});

    // DB status + latency
    let dbStatus = '🔴 Failed', dbLatency = 'N/A';
    try {
      const t0 = Date.now();
      await pg.query('SELECT 1');
      dbLatency = `${Date.now() - t0}ms`;
      dbStatus = '🟢 Connected';
    } catch {}

    // Chains
    const [ethLine, baseLine, apeLine] = await Promise.all([
      chainStatus('eth',  'Ethereum'),
      chainStatus('base', 'Base'),
      chainStatus('ape',  'ApeChain')
    ]);

    // Discord Gateway
    const wsOk = client.ws.status === 0;
    const discordStatus = `${statusEmoji(wsOk)} ${wsOk ? 'Connected' : 'Disconnected'}`;

    // Mint processors
    const baseCount = Object.keys(baseListeners || {}).length;
    const ethCount  = Object.keys(ethListeners  || {}).length;
    const apeCount  = Object.keys(apeListeners  || {}).length;
    const mintStatus = [
      `🧱 Base: ${baseCount > 0 ? `🟢 ${baseCount} active` : '🟠 idle'}`,
      `🟧 ETH: ${ethCount > 0 ? `🟢 ${ethCount} active` : '🟠 idle'}`,
      `🦍 Ape: ${apeCount > 0 ? `🟢 ${apeCount} active` : '🟠 idle'}`
    ].join(' • ');

    // Commands
    const loadedLocal = client.commands?.size || 0;
    let globalRegistered = 'N/A';
    try {
      const appCmds = await client.application.commands.fetch();
      globalRegistered = `${appCmds.size}`;
    } catch {}
    let guildRegistered = 'N/A';
    try {
      if (interaction.guild) {
        const guildCmds = await interaction.guild.commands.fetch();
        guildRegistered = `${guildCmds.size}`;
      }
    } catch {}

    // Guild count
    const totalGuilds = client.guilds.cache.size;

    // Counts
    const getCount = async (q) => {
      try { const r = await pg.query(q); return parseInt(r.rows[0]?.count || '0', 10); }
      catch { return 0; }
    };
    const [flexProjects, nftContracts, tokensTracked] = await Promise.all([
      getCount('SELECT COUNT(*) FROM flex_projects'),
      getCount('SELECT COUNT(*) FROM contract_watchlist'),
      getCount('SELECT COUNT(*) FROM tracked_tokens')
    ]);

    // Uptime
    const procUptime = fmtUptime(process.uptime() * 1000);
    const mintUptime = fmtUptime(Date.now() - mintProcessorStartTime);

    // Memory & CPU
    const mem = process.memoryUsage();
    const memoryUsage = `${fmtBytes(mem.rss)} RSS / ${fmtBytes(mem.heapUsed)} heap`;
    const cpuLoad = os.loadavg?.()[0]?.toFixed(2) ?? 'N/A';

    // Shard info
    const shardInfo = client.shard
      ? `ID ${client.shard.ids?.[0]} of ${client.shard.count}`
      : 'N/A';

    // Last event time
    let lastEventTime = 'N/A';
    try {
      const seenStats = statSync('./data/seen.json');
      lastEventTime = `<t:${Math.floor(seenStats.mtimeMs / 1000)}:R>`;
    } catch {}

    // Ping
    const ping = Math.max(0, Date.now() - interaction.createdTimestamp);

    const linesTop = [
      `🗄️ **Database** — ${dbStatus} *(latency: ${dbLatency})*`,
      `📶 **Discord Gateway** — ${discordStatus}`,
      `📡 **RPC Providers**`,
      ethLine, baseLine, apeLine,
      `⏱️ **Bot Ping** — ${ping}ms`,
    ];
    const linesMid = [
      `🧱 **Mint Processors** — ${mintStatus} *(Uptime: ${mintUptime})*`,
      `🌐 **Servers** — ${totalGuilds} guilds`,
      `🔑 **Slash Commands** — Local: **${loadedLocal}** • Global: **${globalRegistered}** • This Guild: **${guildRegistered}**`,
      `📦 **NFT Contracts Tracked** — ${nftContracts}`,
      `💰 **Tokens Tracked** — ${tokensTracked}`,
      `🎯 **Flex Projects** — ${flexProjects}`,
      `⏱️ **Last Event** — ${lastEventTime}`
    ];
    const linesSys = [
      `🧮 **Memory** — ${memoryUsage}`,
      `🖥️ **CPU Load (1m)** — ${cpuLoad}`,
      `🧪 **Bot Version** — v${pkgVersion}`,
      `🟣 **discord.js** — v${djsVersion}`,
      `🟢 **Node.js** — ${process.version}`,
      `🧩 **Shard** — ${shardInfo}`,
      `⏱️ **Total Uptime** — ${procUptime}`
    ];

    const embed = new EmbedBuilder()
      .setTitle('📊 Full System Status')
      .setColor(0x2ecc71)
      .setDescription([...linesTop, '', ...linesMid, '', ...linesSys].join('\n'))
      .setFooter({ text: 'Powered by PimpsDev 🧪' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] }).catch(() => {});
  }
};
















