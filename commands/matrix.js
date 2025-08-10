// commands/matrix.js
const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const { Contract, Interface, ethers } = require('ethers');
const fetch = require('node-fetch');

// ENV: RESERVOIR_API_KEY (optional but recommended)
// Uses your existing provider manager:
const { safeRpcCall, getProvider } = require('../services/providerM');

const MAX_TILES = 25;         // grid max (5x5)
const COLS = 5;               // columns in the grid
const GAP = 8;                // px gap between tiles
const TILE = 160;             // px thumbnail size
const BG = '#0f1115';         // background
const BORDER = '#1f2230';     // tile border

// IPFS helpers
const IPFS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/'
];
function toHttp(url) {
  if (!url || typeof url !== 'string') return url;
  if (!url.startsWith('ipfs://')) return url;
  const cid = url.replace('ipfs://', '');
  return IPFS.map(g => g + cid);
}
async function fetchJsonWithFallback(urlOrList, timeoutMs = 6000) {
  const urls = Array.isArray(urlOrList) ? urlOrList : [urlOrList];
  for (const u of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(u, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (data) return data;
    } catch {}
  }
  return null;
}

async function fetchOwnerTokensReservoir({ chain, contract, owner, limit }) {
  // Reservoir supports chain via header x-reservoir-chain, values: 'ethereum', 'base'
  const chainHeader = chain === 'eth' ? 'ethereum' : chain === 'base' ? 'base' : null;
  if (!chainHeader) return []; // skip for unsupported
  const url = `https://api.reservoir.tools/users/${owner}/tokens/v10?collection=${contract}&limit=${limit}&includeTopBid=false&sortBy=acquiredAt`;
  const headers = {
    'Content-Type': 'application/json',
    'x-reservoir-chain': chainHeader
  };
  if (process.env.RESERVOIR_API_KEY) headers['x-api-key'] = process.env.RESERVOIR_API_KEY;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const json = await res.json();
    const tokens = json?.tokens || [];
    return tokens.map(t => ({
      tokenId: t?.token?.tokenId,
      image: t?.token?.image || null,
      name: t?.token?.name || `${t?.token?.contract} #${t?.token?.tokenId}`
    })).filter(x => x.tokenId);
  } catch {
    return [];
  }
}

async function fetchOwnerTokensOnchain({ chain, contract, owner, limit }) {
  // Best-effort fallback: scan recent Transfer logs to find tokens held by owner.
  // Not perfect, but avoids requiring enumerable interface.
  const provider = getProvider(chain);
  if (!provider) return [];

  const iface = new Interface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ]);

  const latest = await safeRpcCall(chain, p => p.getBlockNumber()) || 0;
  const fromBlock = Math.max(0, latest - 8000); // window
  let logs = [];
  try {
    logs = await safeRpcCall(chain, p => p.getLogs({
      address: contract.toLowerCase(),
      topics: [ethers.id('Transfer(address,address,uint256)')],
      fromBlock, toBlock: latest
    })) || [];
  } catch {}

  const owned = new Set();
  for (const log of logs) {
    let parsed; try { parsed = iface.parseLog(log); } catch { continue; }
    const { from, to, tokenId } = parsed.args;
    const tid = tokenId.toString();
    if ((to || '').toLowerCase() === owner.toLowerCase()) owned.add(tid);
    if ((from || '').toLowerCase() === owner.toLowerCase()) owned.delete(tid);
  }
  return Array.from(owned).slice(0, limit).map(id => ({ tokenId: id, image: null, name: `#${id}` }));
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
    } catch {
      out.push(it);
    }
  }
  return out;
}

async function downloadImage(url, timeoutMs = 7000) {
  const urls = Array.isArray(url) ? url : [url];
  for (const u of urls) {
    if (!u) continue;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(u, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      return Buffer.from(buf);
    } catch {}
  }
  return null;
}

async function composeGrid(items, cols = COLS) {
  const count = Math.min(items.length, MAX_TILES);
  const rows = Math.ceil(count / cols);
  const W = cols * TILE + (cols + 1) * GAP;
  const H = rows * TILE + (rows + 1) * GAP;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // draw tiles
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = GAP + c * (TILE + GAP);
    const y = GAP + r * (TILE + GAP);

    // border
    ctx.fillStyle = BORDER;
    ctx.fillRect(x - 1, y - 1, TILE + 2, TILE + 2);

    const imgUrl = items[i].image;
    if (!imgUrl) {
      // placeholder
      ctx.fillStyle = '#161a24';
      ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = '#4b4f63';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`#${items[i].tokenId}`, x + TILE / 2, y + TILE / 2);
      continue;
    }

    try {
      const buf = await downloadImage(imgUrl);
      if (!buf) throw new Error('img dl fail');
      const img = await loadImage(buf);
      // cover-fit
      const ratio = Math.max(TILE / img.width, TILE / img.height);
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const ox = Math.floor((w - TILE) / 2);
      const oy = Math.floor((h - TILE) / 2);

      const tmp = createCanvas(w, h);
      const tctx = tmp.getContext('2d');
      tctx.drawImage(img, 0, 0, w, h);
      ctx.drawImage(tmp, ox * -1, oy * -1, w, h, x, y, TILE, TILE);
    } catch {
      // fallback box
      ctx.fillStyle = '#161a24';
      ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = '#4b4f63';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`#${items[i].tokenId}`, x + TILE / 2, y + TILE / 2);
    }
  }

  return canvas.toBuffer('image/png');
}

async function resolveProjectInGuild(pg, guildId, name) {
  // Prefer contract_watchlist entries for this guild
  // If `name` is provided, match it (case-insensitive); else return the only tracked, or null if multiple.
  const res = await pg.query(`SELECT name, address, chain FROM contract_watchlist`);
  const rows = res.rows || [];

  // Filter to those tracked in this guild (via channel_ids)
  const filtered = [];
  for (const r of rows) {
    const chans = Array.isArray(r.channel_ids) ? r.channel_ids : (r.channel_ids || '').toString().split(',').filter(Boolean);
    // We can’t easily map to guild without the client cache here; accept all rows for now and let autocomplete handle UI filter.
    filtered.push({ name: r.name, address: r.address, chain: (r.chain || 'base').toLowerCase(), channel_ids: chans });
  }

  if (name) {
    const n = name.toLowerCase();
    const row = filtered.find(x => (x.name || '').toLowerCase() === n);
    return row || null;
  }

  // No name provided: if there is exactly one distinct collection tracked overall, return it
  const uniqKey = new Set(filtered.map(x => `${x.address.toLowerCase()}|${x.chain}`));
  if (uniqKey.size === 1) {
    const r = filtered[0];
    return { name: r.name, address: r.address, chain: r.chain };
  }
  return null; // require explicit selection
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('matrix')
    .setDescription('Render a grid of a wallet’s NFTs for a tracked project')
    .addStringOption(o =>
      o.setName('wallet')
        .setDescription('Wallet address (0x...)')
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName('project')
        .setDescription('Project/collection name (if your server tracks more than one)')
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addIntegerOption(o =>
      o.setName('limit')
        .setDescription('Max tiles (default 25, max 30)')
        .setMinValue(1)
        .setMaxValue(30)
        .setRequired(false)
    ),

  async autocomplete(interaction) {
    const pg = interaction.client.pg;
    const focused = interaction.options.getFocused()?.toLowerCase?.() || '';
    try {
      const res = await pg.query(`SELECT name, address, chain, channel_ids FROM contract_watchlist`);
      const options = [];
      for (const row of res.rows) {
        const name = row.name || 'Unnamed';
        if (focused && !name.toLowerCase().includes(focused)) continue;
        const chain = (row.chain || 'base').toLowerCase();
        const emoji = chain === 'base' ? '🟦' : chain === 'eth' ? '🟧' : chain === 'ape' ? '🐵' : '❓';
        const addr = (row.address || '').toLowerCase();
        const short = addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '0x????';
        const label = `${emoji} ${name} • ${short} • ${chain}`;
        const val = `${name}|${chain}|${addr}`;
        options.push({ name: label.slice(0, 100), value: val });
        if (options.length >= 25) break;
      }
      await interaction.respond(options);
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    const pg = interaction.client.pg;
    const wallet = interaction.options.getString('wallet');
    const projectRaw = interaction.options.getString('project') || '';
    const limit = Math.min(interaction.options.getInteger('limit') || MAX_TILES, 30);
    const guildId = interaction.guild?.id;

    await interaction.deferReply({ ephemeral: false });

    // Basic addr validation
    let owner;
    try { owner = ethers.getAddress(wallet); }
    catch {
      return interaction.editReply('❌ Invalid wallet address.');
    }

    // Resolve project / contract + chain
    let project = null;
    if (projectRaw) {
      const [name, chain, address] = projectRaw.split('|');
      if (name && chain && address) {
        project = { name, chain, address };
      }
    }
    if (!project) {
      project = await resolveProjectInGuild(pg, guildId, interaction.options.getString('project'));
      if (!project) {
        return interaction.editReply('ℹ️ Please specify a `project` (your server tracks multiple). Try typing to use autocomplete.');
      }
    }

    const chain = (project.chain || 'base').toLowerCase();
    const contract = (project.address || '').toLowerCase();

    // Fetch owner tokens
    let items = await fetchOwnerTokensReservoir({ chain, contract, owner, limit });
    if (!items.length) {
      // fallback: quick onchain scan
      items = await fetchOwnerTokensOnchain({ chain, contract, owner, limit });
    }
    if (!items.length) {
      return interaction.editReply(`❌ No ${project.name} NFTs found for ${owner.slice(0,6)}...${owner.slice(-4)}.`);
    }

    // Enrich images via tokenURI if needed
    if (items.some(i => !i.image)) {
      items = await enrichImagesViaTokenURI({ chain, contract, items });
    }

    // Compose grid
    const grid = await composeGrid(items, COLS);
    const file = new AttachmentBuilder(grid, { name: `matrix_${project.name}_${owner.slice(0,6)}.png` });

    const title = `🧩 ${project.name} — ${items.length} token${items.length === 1 ? '' : 's'}`;
    const desc  = `Owner: \`${owner}\`\nChain: \`${chain}\``;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(desc)
      .setColor(0x66ccff)
      .setImage(`attachment://${file.name}`)
      .setFooter({ text: 'Matrix view • Powered by PimpsDev' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], files: [file] });
  }
};
