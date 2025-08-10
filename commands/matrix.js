// commands/matrix.js
const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { Contract, Interface, ethers } = require('ethers');
const fetch = require('node-fetch');
const { safeRpcCall, getProvider } = require('../services/providerM');

// ---------- Adaptive grid config ----------
const GRID_PRESETS = [
  // up toCount, cols, tilePx
  { max: 25,  cols: 5,  tile: 160 },
  { max: 49,  cols: 7,  tile: 120 },
  { max: 64,  cols: 8,  tile: 110 },
  { max: 81,  cols: 9,  tile: 100 },
  { max: 100, cols: 10, tile: 96 }
];
const MAX_AUTO = 100; // max tiles when auto-adapting
const GAP = 8;
const BG = '#0f1115';
const BORDER = '#1f2230';

// ---------- IPFS helpers ----------
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
      const res = await fetch(u, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (data) return data;
    } catch {}
  }
  return null;
}

// ---------- Reservoir (fast path, with continuation) ----------
async function fetchOwnerTokensReservoirAll({ chain, contract, owner, maxWant = MAX_AUTO }) {
  const chainHeader = chain === 'eth' ? 'ethereum' : chain === 'base' ? 'base' : null;
  if (!chainHeader) return { items: [], total: 0 };

  const headers = {
    'Content-Type': 'application/json',
    'x-reservoir-chain': chainHeader
  };
  if (process.env.RESERVOIR_API_KEY) headers['x-api-key'] = process.env.RESERVOIR_API_KEY;

  let continuation = null;
  const items = [];
  let safety = 6; // up to ~6 pages
  let total = 0;

  while (safety-- > 0 && items.length < maxWant) {
    const limit = Math.min(50, maxWant - items.length);
    const url = new URL(`https://api.reservoir.tools/users/${owner}/tokens/v10`);
    url.searchParams.set('collection', contract);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('includeTopBid', 'false');
    url.searchParams.set('sortBy', 'acquiredAt');
    if (continuation) url.searchParams.set('continuation', continuation);

    try {
      const res = await fetch(url.toString(), { headers });
      if (!res.ok) break;
      const json = await res.json();
      const tokens = json?.tokens || [];
      continuation = json?.continuation || null;
      total = typeof json?.count === 'number' ? json.count : (total || (tokens.length < limit && !continuation ? items.length + tokens.length : 0));

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

  // If Reservoir didn’t provide total, use items length as minimum
  if (!total) total = items.length;
  return { items, total };
}

// ---------- On-chain fallback (window scan) ----------
async function fetchOwnerTokensOnchainWindow({ chain, contract, owner, maxWant = MAX_AUTO }) {
  const provider = getProvider(chain);
  if (!provider) return { items: [], total: 0 };

  const iface = new Interface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ]);

  const latest = await safeRpcCall(chain, p => p.getBlockNumber()) || 0;
  const fromBlock = Math.max(0, latest - 12000); // ~2–3 hours window

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

async function downloadImage(url, timeoutMs = 8000) {
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

// ---------- Adaptive grid composition ----------
function pickPreset(count) {
  for (const p of GRID_PRESETS) if (count <= p.max) return p;
  return GRID_PRESETS[GRID_PRESETS.length - 1];
}

async function composeGrid(items) {
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

    const imgUrl = items[i].image;
    if (!imgUrl) {
      ctx.fillStyle = '#161a24'; ctx.fillRect(x, y, tile, tile);
      ctx.fillStyle = '#4b4f63';
      ctx.font = `bold ${Math.max(14, Math.round(tile * 0.12))}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`#${items[i].tokenId}`, x + tile / 2, y + tile / 2);
      continue;
    }

    try {
      const buf = await downloadImage(imgUrl);
      if (!buf) throw new Error('img dl fail');
      const img = await loadImage(buf);

      // cover-fit
      const ratio = Math.max(tile / img.width, tile / img.height);
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const ox = Math.floor((w - tile) / 2);
      const oy = Math.floor((h - tile) / 2);

      const tmp = createCanvas(w, h);
      const tctx = tmp.getContext('2d');
      tctx.drawImage(img, 0, 0, w, h);
      ctx.drawImage(tmp, -ox, -oy, w, h, x, y, tile, tile);
    } catch {
      ctx.fillStyle = '#161a24'; ctx.fillRect(x, y, tile, tile);
      ctx.fillStyle = '#4b4f63';
      ctx.font = `bold ${Math.max(14, Math.round(tile * 0.12))}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`#${items[i].tokenId}`, x + tile / 2, y + tile / 2);
    }
  }

  return canvas.toBuffer('image/png');
}

// ---------- DB / guild helpers ----------
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('matrix')
    .setDescription('Render a grid of a wallet’s NFTs for a project tracked by this server (auto dense)')
    .addStringOption(o =>
      o.setName('wallet')
        .setDescription('Wallet address (0x...)')
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
        .setDescription('Max tiles (auto up to 100 if omitted)')
        .setMinValue(1)
        .setMaxValue(100)
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
    const wallet = interaction.options.getString('wallet');
    const projectInput = interaction.options.getString('project') || '';
    const userLimit = interaction.options.getInteger('limit') || null;

    await interaction.deferReply({ ephemeral: false });

    // validate wallet
    let owner;
    try { owner = ethers.getAddress(wallet); }
    catch { return interaction.editReply('❌ Invalid wallet address.'); }

    // resolve project ONLY if tracked by this server
    const { project, error } = await resolveProjectForGuild(pg, interaction.client, guildId, projectInput);
    if (error) return interaction.editReply(error);

    const chain = (project.chain || 'base').toLowerCase();
    const contract = (project.address || '').toLowerCase();

    // Fetch items (Reservoir with paging; fallback to on-chain window)
    const maxWant = Math.min(userLimit || MAX_AUTO, MAX_AUTO);
    let items = [], totalOwned = 0;

    const resv = await fetchOwnerTokensReservoirAll({ chain, contract, owner, maxWant });
    items = resv.items; totalOwned = resv.total || items.length;

    if (!items.length) {
      const onch = await fetchOwnerTokensOnchainWindow({ chain, contract, owner, maxWant });
      items = onch.items; totalOwned = onch.total || items.length;
    }
    if (!items.length) {
      return interaction.editReply(`❌ No ${project.name} NFTs found for \`${owner}\` on ${chain}.`);
    }

    // Enrich images if needed
    if (items.some(i => !i.image)) {
      items = await enrichImagesViaTokenURI({ chain, contract, items });
    }

    // Compose adaptive grid
    const gridBuf = await composeGrid(items);
    const file = new AttachmentBuilder(gridBuf, { name: `matrix_${project.name}_${owner.slice(0,6)}.png` });

    const title = `🧩 ${project.name}`;
    const desc  = `Owner: \`${owner}\`\nChain: \`${chain}\`\n**Showing ${items.length} of ${totalOwned} owned**`;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(desc)
      .setColor(0x66ccff)
      .setImage(`attachment://${file.name}`)
      .setFooter({ text: 'Matrix view • Powered by PimpsDev (auto-dense)' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], files: [file] });
  }
};

