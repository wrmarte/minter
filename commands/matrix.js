// commands/matrix.js
const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { Contract, Interface, ethers } = require('ethers');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const { safeRpcCall, getProvider } = require('../services/providerM');

/* ===================== Config ===================== */
const ENV_MAX = Math.max(1, Math.min(Number(process.env.MATRIX_MAX_AUTO || 100), 300));
const GRID_PRESETS = [
  { max: 25,  cols: 5,  tile: 160 },
  { max: 49,  cols: 7,  tile: 120 },
  { max: 64,  cols: 8,  tile: 110 },
  { max: 81,  cols: 9,  tile: 100 },
  { max: 100, cols: 10, tile: 96 },
  { max: 144, cols: 12, tile: 84 },   // extra dense if you bump MATRIX_MAX_AUTO
  { max: 196, cols: 14, tile: 74 },
  { max: 225, cols: 15, tile: 70 },
  { max: 256, cols: 16, tile: 64 },
  { max: 300, cols: 20, tile: 56 }
];
const GAP = 8;
const BG = '#0f1115';
const BORDER = '#1f2230';

/* ===================== Keep-Alive Agents ===================== */
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 128 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 128 });

/* ===================== Small Utils ===================== */
function throttle(ms) {
  let last = 0;
  return async (fn) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; await fn(); }
  };
}

async function runPool(limit, items, worker) {
  const ret = new Array(items.length);
  let i = 0;
  const next = async () => {
    const idx = i++;
    if (idx >= items.length) return;
    try { ret[idx] = await worker(items[idx], idx); }
    catch { ret[idx] = null; }
    return next();
  };
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(next));
  return ret;
}

/* ===================== IPFS helpers ===================== */
const IPFS_GATES = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/'
];
function toHttp(url) {
  if (!url || typeof url !== 'string') return url;
  if (!url.startsWith('ipfs://')) return url;
  const cid = url.replace('ipfs://', '');
  return IPFS_GATES.map(g => g + cid);
}
async function fetchJsonWithFallback(urlOrList, timeoutMs = 7000) {
  const urls = Array.isArray(urlOrList) ? urlOrList : [urlOrList];
  for (const u of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const agent = u.startsWith('http:') ? keepAliveHttp : keepAliveHttps;
      const res = await fetch(u, { signal: ctrl.signal, agent });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (data) return data;
    } catch {}
  }
  return null;
}

/* ===================== ENS resolution (with fallbacks) ===================== */
const ENS_CACHE = new Map(); // name -> { addr, ts }
const ENS_RPC_FALLBACKS = [
  'https://cloudflare-eth.com',
  'https://rpc.ankr.com/eth',
  'https://eth.llamarpc.com',
  'https://1rpc.io/eth',
  'https://ethereum-rpc.publicnode.com'
];
function withTimeout(promise, ms = 4000, reason = 'ENS timeout') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(reason)), ms))
  ]);
}
async function tryResolveWithCurrentProvider(name) {
  try {
    const prov = getProvider('eth');
    if (!prov) return null;
    const addr = await withTimeout(prov.resolveName(name), 4000);
    return addr || null;
  } catch { return null; }
}
async function tryResolveWithFallbacks(name) {
  for (const url of ENS_RPC_FALLBACKS) {
    try {
      const prov = new ethers.JsonRpcProvider(url);
      const addr = await withTimeout(prov.resolveName(name), 4000);
      if (addr) return addr;
    } catch {}
  }
  return null;
}
/** Returns { address, display } where display is the original ENS if provided */
async function resolveWalletInput(input) {
  // already an address?
  try { return { address: ethers.getAddress(input), display: null }; } catch {}
  // ENS?
  if (typeof input === 'string' && input.toLowerCase().endsWith('.eth')) {
    const key = input.toLowerCase();
    const cached = ENS_CACHE.get(key);
    if (cached && (Date.now() - cached.ts) < 10 * 60 * 1000) {
      return { address: cached.addr, display: key };
    }
    let addr = await tryResolveWithCurrentProvider(key);
    if (!addr) addr = await tryResolveWithFallbacks(key);
    if (addr) {
      const normalized = ethers.getAddress(addr);
      ENS_CACHE.set(key, { addr: normalized, ts: Date.now() });
      return { address: normalized, display: key };
    }
    throw new Error('ENS name could not be resolved (try a different provider or use 0x address).');
  }
  throw new Error('Invalid wallet or ENS name.');
}

/* ===================== Reservoir (ETH/Base) ===================== */
async function fetchOwnerTokensReservoirAll({ chain, contract, owner, maxWant = ENV_MAX }) {
  const chainHeader = chain === 'eth' ? 'ethereum' : chain === 'base' ? 'base' : null;
  if (!chainHeader) return { items: [], total: 0 };

  const headers = { 'Content-Type': 'application/json', 'x-reservoir-chain': chainHeader };
  if (process.env.RESERVOIR_API_KEY) headers['x-api-key'] = process.env.RESERVOIR_API_KEY;

  let continuation = null;
  const items = [];
  let safety = 16; // more pages to be thorough
  let total = 0;

  while (safety-- > 0 && items.length < maxWant) {
    const limit = Math.min(50, maxWant - items.length);
    const url = new URL(`https://api.reservoir.tools/users/${owner}/tokens/v10`);
    url.searchParams.set('collection', contract);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('includeTopBid', 'false');
    url.searchParams.set('sortBy', 'acquiredAt'); // recent first
    if (continuation) url.searchParams.set('continuation', continuation);

    try {
      const res = await fetch(url.toString(), { headers });
      if (!res.ok) break;
      const json = await res.json();
      const tokens = json?.tokens || [];
      continuation = json?.continuation || null;

      total = typeof json?.count === 'number'
        ? json.count
        : (total || (tokens.length < limit && !continuation ? items.length + tokens.length : 0));

      for (const t of tokens) {
        if (!t?.token?.tokenId) continue;
        items.push({
          tokenId: t.token.tokenId,
          image: t.token.image || null,
          name: t.token.name || `${t.token.contract} #${t.token.tokenId}`
        });
        if (items.length >= maxWant) break;
      }
      if (!continuation || tokens.length === 0) break;
    } catch {
      break;
    }
  }

  if (!total) total = items.length;
  return { items, total };
}

/* ===================== On-chain fallback (Base + Ape + backup) ===================== */
async function fetchOwnerTokensOnchainRolling({ chain, contract, owner, maxWant = ENV_MAX }) {
  const provider = getProvider(chain);
  if (!provider) return { items: [], total: 0 };

  const iface = new Interface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ]);

  const head = await safeRpcCall(chain, p => p.getBlockNumber()) || 0;

  // Tuned for Base so we look farther back than a few hours
  const isBase = chain === 'base';
  const WINDOW = isBase ? 50000 : 15000;
  const MAX_WINDOWS = isBase ? 80 : 12; // ~4M blocks on Base, ~180k elsewhere

  const owned = new Set();

  for (let i = 0; i < MAX_WINDOWS && owned.size < maxWant; i++) {
    const toBlock = head - i * WINDOW;
    const fromBlock = Math.max(0, toBlock - WINDOW + 1);
    if (toBlock <= 0) break;

    let logs = [];
    try {
      logs = await safeRpcCall(chain, p => p.getLogs({
        address: contract.toLowerCase(),
        topics: [ethers.id('Transfer(address,address,uint256)')],
        fromBlock, toBlock
      })) || [];
    } catch {
      continue;
    }

    for (const log of logs) {
      let parsed; try { parsed = iface.parseLog(log); } catch { continue; }
      const { from, to, tokenId } = parsed.args;
      const tid = tokenId.toString();
      if ((to || '').toLowerCase() === owner.toLowerCase()) owned.add(tid);
      if ((from || '').toLowerCase() === owner.toLowerCase()) owned.delete(tid);
    }
  }

  const all = Array.from(owned);
  const slice = all.slice(0, maxWant).map(id => ({ tokenId: id, image: null, name: `#${id}` }));
  return { items: slice, total: all.length || slice.length };
}

async function enrichImagesViaTokenURI({ chain, contract, items }) {
  const provider = getProvider(chain);
  if (!provider) return items;
  const iface = new Interface(['function tokenURI(uint256 tokenId) view returns (string)']);
  const nft = new Contract(contract, iface.fragments, provider);

  const out = [];
  for (const it of items) {
    if (it.image) { out.push(it); continue; }
    try {
      let uri = await safeRpcCall(chain, p => nft.connect(p).tokenURI(it.tokenId));
      if (!uri) { out.push(it); continue; }
      const meta = await fetchJsonWithFallback(uri.startsWith('ipfs://') ? toHttp(uri) : [uri]);
      let img = meta?.image;
      if (img && img.startsWith('ipfs://')) img = toHttp(img)[0];
      out.push({ ...it, image: img || null });
    } catch { out.push(it); }
  }
  return out;
}

/* ========= Merge helper (fills from on-chain if Reservoir is partial) ========= */
function dedupeByTokenId(list) {
  const seen = new Set();
  const out = [];
  for (const it of list) {
    const key = String(it.tokenId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/* ===================== Faster image path ===================== */
// Race multiple gateway URLs per image. First successful response wins.
async function downloadImage(urlOrList, timeoutMs = 8000) {
  const urls = (Array.isArray(urlOrList) ? urlOrList : [urlOrList]).filter(Boolean);
  if (!urls.length) return null;

  return await new Promise(async (resolve) => {
    let settled = false;
    const controllers = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controllers.forEach(c => c.abort());
      resolve(null);
    }, timeoutMs);

    let remaining = urls.length;

    const onDone = (buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controllers.forEach(c => c.abort());
      resolve(buf || null);
    };

    urls.forEach((u) => {
      const ctrl = new AbortController();
      controllers.push(ctrl);
      const agent = u.startsWith('http:') ? keepAliveHttp : keepAliveHttps;
      fetch(u, { signal: ctrl.signal, agent, headers: { 'Accept': 'image/*' } })
        .then(async res => {
          if (!res.ok) return null;
          const ab = await res.arrayBuffer();
          return Buffer.from(ab);
        })
        .then(buf => {
          if (buf) onDone(buf);
          else if (--remaining === 0) onDone(null);
        })
        .catch(() => {
          if (--remaining === 0) onDone(null);
        });
    });
  });
}

// Preload images in parallel with a small pool and optional progress callback
async function preloadImages(items, onProgress) {
  let done = 0;
  const update = onProgress || (() => Promise.resolve());

  const bufs = await runPool(8, items, async (it) => {
    if (!it.image) { done++; await update(done, items.length); return null; }
    const src = it.image.startsWith('ipfs://') ? toHttp(it.image) : [it.image];
    const buf = await downloadImage(src);
    done++; await update(done, items.length);
    return buf;
  });

  const imgs = await runPool(8, bufs, async (buf) => {
    if (!buf) return null;
    try { return await loadImage(buf); } catch { return null; }
  });

  return imgs; // index-aligned with items
}

/* ===================== Image composition ===================== */
function pickPreset(count) {
  for (const p of GRID_PRESETS) if (count <= p.max) return p;
  return GRID_PRESETS[GRID_PRESETS.length - 1];
}
async function composeGrid(items, preloadedImgs) {
  const count = items.length;
  const preset = pickPreset(count);
  const cols = preset.cols;
  const tile = preset.tile;
  const rows = Math.ceil(count / cols);
  const W = cols * tile + (cols + 1) * GAP;
  const H = rows * tile + (rows + 1) * GAP;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = GAP + c * (tile + GAP);
    const y = GAP + r * (tile + GAP);

    ctx.fillStyle = BORDER;
    ctx.fillRect(x - 1, y - 1, tile + 2, tile + 2);

    const img = preloadedImgs?.[i];
    if (!img) {
      ctx.fillStyle = '#161a24'; ctx.fillRect(x, y, tile, tile);
      ctx.fillStyle = '#4b4f63';
      ctx.font = `bold ${Math.max(14, Math.round(tile * 0.12))}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`#${items[i].tokenId}`, x + tile / 2, y + tile / 2);
      continue;
    }

    // cover-fit crop math (no temp canvas)
    const scale = Math.max(tile / img.width, tile / img.height);
    const sw = Math.floor(tile / scale);
    const sh = Math.floor(tile / scale);
    const sx = Math.floor((img.width  - sw) / 2);
    const sy = Math.floor((img.height - sh) / 2);

    ctx.drawImage(img, sx, sy, sw, sh, x, y, tile, tile);
  }

  return canvas.toBuffer('image/png');
}

/* ===================== DB / guild helpers ===================== */
function normalizeChannels(channel_ids) {
  if (Array.isArray(channel_ids)) return channel_ids.filter(Boolean).map(String);
  if (!channel_ids) return [];
  return channel_ids.toString().split(',').map(s => s.trim()).filter(Boolean);
}
async function getGuildTrackedProjects(pg, client, guildId) {
  const out = [];
  const res = await pg.query(`SELECT name, address, chain, channel_ids FROM contract_watchlist`);
  for (const row of res.rows || []) {
    const channels = normalizeChannels(row.channel_ids);
    let trackedHere = false;
    for (const cid of channels) {
      const ch = client.channels.cache.get(cid);
      if (ch?.guildId === guildId) { trackedHere = true; break; }
    }
    if (trackedHere) {
      out.push({
        name: row.name,
        address: (row.address || '').toLowerCase(),
        chain: (row.chain || 'base').toLowerCase()
      });
    }
  }
  return out;
}
async function resolveProjectForGuild(pg, client, guildId, projectInput) {
  const tracked = await getGuildTrackedProjects(pg, client, guildId);
  if (!tracked.length) return { error: '❌ This server is not tracking any projects.' };

  if (!projectInput) {
    if (tracked.length === 1) return { project: tracked[0] };
    return { error: 'ℹ️ Multiple projects are tracked here. Please choose a `project` (use autocomplete).' };
  }
  const [name, chain, address] = projectInput.split('|');
  if (!name || !chain || !address) return { error: '❌ Invalid project value. Use autocomplete.' };
  const match = tracked.find(p =>
    (p.name || '').toLowerCase() === name.toLowerCase() &&
    (p.chain || '') === chain.toLowerCase() &&
    (p.address || '') === address.toLowerCase()
  );
  if (!match) return { error: '❌ That project is not tracked in this server.' };
  return { project: match };
}

/* ===================== Slash Command ===================== */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('matrix')
    .setDescription('Render a grid of a wallet’s NFTs for a project tracked by this server (ENS + auto-dense)')
    .addStringOption(o =>
      o.setName('wallet')
        .setDescription('Wallet address or ENS (.eth)')
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName('project')
        .setDescription('Project (only from this server’s tracked list)')
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addIntegerOption(o =>
      o.setName('limit')
        .setDescription(`Max tiles (auto up to ${ENV_MAX} if omitted)`)
        .setMinValue(1)
        .setMaxValue(ENV_MAX)
        .setRequired(false)
    ),

  async autocomplete(interaction) {
    const pg = interaction.client.pg;
    const guildId = interaction.guild?.id;
    const focused = (interaction.options.getFocused() || '').toLowerCase();

    try {
      const tracked = await getGuildTrackedProjects(pg, interaction.client, guildId);
      const options = [];
      for (const row of tracked) {
        const name = row.name || 'Unnamed';
        if (focused && !name.toLowerCase().includes(focused)) continue;
        const emoji = row.chain === 'base' ? '🟦' : row.chain === 'eth' ? '🟧' : row.chain === 'ape' ? '🐵' : '❓';
        const short = row.address ? `${row.address.slice(0, 6)}...${row.address.slice(-4)}` : '0x????';
        const label = `${emoji} ${name} • ${short} • ${row.chain}`;
        const value = `${name}|${row.chain}|${row.address}`;
        options.push({ name: label.slice(0, 100), value });
        if (options.length >= 25) break;
      }
      await interaction.respond(options);
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    const pg = interaction.client.pg;
    const guildId = interaction.guild?.id;
    const walletInput = interaction.options.getString('wallet');
    const projectInput = interaction.options.getString('project') || '';
    const userLimit = interaction.options.getInteger('limit') || null;

    await interaction.deferReply({ ephemeral: false });

    // Initial status
    await interaction.editReply({ content: '⏳ Resolving wallet…' });

    // ENS or address
    let owner, ownerDisplay;
    try {
      const resolved = await resolveWalletInput(walletInput);
      owner = resolved.address;
      ownerDisplay = resolved.display || owner;
    } catch (e) {
      return interaction.editReply(`❌ ${e.message}`);
    }

    await interaction.editReply({ content: '🔎 Fetching tokens…' });

    // resolve project ONLY if tracked by this server
    const { project, error } = await resolveProjectForGuild(pg, interaction.client, guildId, projectInput);
    if (error) return interaction.editReply(error);

    const chain = (project.chain || 'base').toLowerCase();
    const contract = (project.address || '').toLowerCase();
    const maxWant = Math.min(userLimit || ENV_MAX, ENV_MAX);

    // Try Reservoir for ETH/Base (extended pagination)
    let items = [], totalOwned = 0, usedReservoir = false;
    if (chain === 'eth' || chain === 'base') {
      const resv = await fetchOwnerTokensReservoirAll({ chain, contract, owner, maxWant });
      items = resv.items;
      totalOwned = resv.total || items.length;
      usedReservoir = items.length > 0;
    }

    // If Reservoir looks partial (e.g., Base returns just a few), fill from on-chain
    if ((chain === 'base' || chain === 'eth') && items.length < maxWant) {
      const onch = await fetchOwnerTokensOnchainRolling({ chain, contract, owner, maxWant });
      const byId = new Map();
      for (const it of items) byId.set(String(it.tokenId), it);
      for (const it of onch.items) {
        const key = String(it.tokenId);
        if (!byId.has(key)) byId.set(key, it);
      }
      items = Array.from(byId.values()).slice(0, maxWant);
      totalOwned = Math.max(totalOwned, onch.total || 0, items.length);
    }

    // Fallback: on-chain rolling scan (also used for Ape)
    if (!items.length) {
      const onch = await fetchOwnerTokensOnchainRolling({ chain, contract, owner, maxWant });
      items = onch.items;
      totalOwned = onch.total || items.length;
    }

    if (!items.length) {
      return interaction.editReply(`❌ No ${project.name} NFTs found for \`${ownerDisplay}\` on ${chain}.`);
    }

    // Enrich images if needed
    if (items.some(i => !i.image)) {
      items = await enrichImagesViaTokenURI({ chain, contract, items });
    }

    // Progress updates during image preloading
    const throttled = throttle(1200);
    await interaction.editReply({ content: `🖼️ Rendering ${items.length} tiles… 0%` });

    const preloadedImgs = await preloadImages(items, async (done, total) => {
      const pct = Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
      await throttled(async () => {
        await interaction.editReply({ content: `🖼️ Rendering ${total} tiles… ${pct}%` });
      });
    });

    // Compose adaptive grid
    const gridBuf = await composeGrid(items, preloadedImgs);
    const file = new AttachmentBuilder(gridBuf, { name: `matrix_${project.name}_${owner.slice(0,6)}.png` });

    const desc = [
      `Owner: \`${ownerDisplay}\`${ownerDisplay.endsWith('.eth') ? `\nResolved: \`${owner}\`` : ''}`,
      `Chain: \`${chain}\``,
      `**Showing ${items.length} of ${totalOwned || items.length} owned**`,
      ...(chain === 'ape' && !usedReservoir ? ['*(ApeChain via on-chain scan)*'] : [])
    ].join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`🧩 ${project.name}`)
      .setDescription(desc)
      .setColor(0x66ccff)
      .setImage(`attachment://${file.name}`)
      .setFooter({ text: `Matrix view • Powered by PimpsDev` })
      .setTimestamp();

    await interaction.editReply({ content: null, embeds: [embed], files: [file] });
  }
};




