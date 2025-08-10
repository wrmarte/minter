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
  { max: 144, cols: 12, tile: 84 },
  { max: 196, cols: 14, tile: 74 },
  { max: 225, cols: 15, tile: 70 },
  { max: 256, cols: 16, tile: 64 },
  { max: 300, cols: 20, tile: 56 }
];
const GAP = 8;
const BG = '#0f1115';
const BORDER = '#1f2230';

// Deep-scan tuning (env overridable)
const LOG_WINDOW_BASE = Math.max(10000, Number(process.env.MATRIX_LOG_WINDOW_BASE || 200000));
const LOG_CONCURRENCY = Math.max(1, Number(process.env.MATRIX_LOG_CONCURRENCY || 4));

/* ===================== Keep-Alive Agents ===================== */
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 128 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 128 });

/* ===================== Small Utils ===================== */
function padTopicAddress(addr) {
  return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function bar(pct, len=16){
  const filled = clamp(Math.round((pct/100)*len), 0, len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}
function statusBlock(lines){
  return '```' + ['Matrix Status','─'.repeat(32),...lines].join('\n') + '```';
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

/* ===================== URL helpers (IPFS, Arweave, data) ===================== */
const IPFS_GATES = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://nftstorage.link/ipfs/',
  'https://cf-ipfs.com/ipfs/'
];
function ipfsToHttp(path) {
  const cidAndPath = path.replace(/^ipfs:\/\//, '');
  return IPFS_GATES.map(g => g + cidAndPath);
}
function arToHttp(u) {
  const id = u.replace(/^ar:\/\//, '');
  return ['https://arweave.net/' + id];
}
function isDataUrl(u) { return typeof u === 'string' && u.startsWith('data:'); }
function parseDataUrl(u) {
  try {
    const m = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(u);
    if (!m) return null;
    const mime = m[1] || 'text/plain';
    const isB64 = !!m[2];
    const data = m[3] || '';
    const buf = isB64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8');
    return { mime, buffer: buf };
  } catch { return null; }
}
function expandImageCandidates(u) {
  if (!u || typeof u !== 'string') return [];
  if (isDataUrl(u)) return [u];
  if (u.startsWith('ipfs://')) return ipfsToHttp(u);
  if (u.startsWith('ipfs:/')) return ipfsToHttp('ipfs://' + u.split('ipfs:/').pop());
  if (u.startsWith('ar://')) return arToHttp(u);
  const variants = [u];
  try {
    const url = new URL(u);
    if ((/ipfs/i).test(url.hostname) && url.pathname.includes('/ipfs/')) {
      const cidPath = url.pathname.slice(url.pathname.indexOf('/ipfs/') + 6);
      for (const g of IPFS_GATES) {
        try { variants.push(new URL(cidPath, g).href); } catch {}
      }
    }
  } catch {}
  return Array.from(new Set(variants));
}
// light magic-bytes check
function looksLikeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return false;
  const sig = buf.slice(0, 12).toString('hex');
  if (buf.slice(0,8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))) return true; // PNG
  if (buf.slice(0,3).equals(Buffer.from([0xFF,0xD8,0xFF]))) return true; // JPG
  if (buf.slice(0,3).equals(Buffer.from([0x47,0x49,0x46]))) return true; // GIF
  if (sig.startsWith('52494646') && sig.includes('57454250')) return true; // WEBP
  const head = buf.slice(0, 256).toString('utf8').trim().toLowerCase(); // SVG/XML
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return true;
  return false;
}

/* ===================== JSON fetch (IPFS + data URLs) ===================== */
async function fetchJsonWithFallback(urlOrList, timeoutMs = 8000) {
  const urls = Array.isArray(urlOrList) ? urlOrList : [urlOrList];
  for (const u of urls) {
    try {
      if (isDataUrl(u)) {
        const parsed = parseDataUrl(u);
        if (!parsed) continue;
        if (/json/.test(parsed.mime)) {
          try { return JSON.parse(parsed.buffer.toString('utf8')); } catch { continue; }
        }
        continue;
      }
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

/* ===================== ENS resolution ===================== */
const ENS_CACHE = new Map();
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
async function resolveWalletInput(input) {
  try { return { address: ethers.getAddress(input), display: null }; } catch {}
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
  let safety = 16;
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
    } catch { break; }
  }

  if (!total) total = items.length;
  return { items, total };
}

/* ===================== Detect standards (ERC721 / ERC1155) ===================== */
async function detectTokenStandard(chain, contract) {
  const provider = getProvider(chain);
  if (!provider) return { is721: false, is1155: false };
  const erc165 = new Contract(contract, ['function supportsInterface(bytes4) view returns (bool)'], provider);
  const out = { is721: false, is1155: false };
  try {
    const s721  = await safeRpcCall(chain, p => erc165.connect(p).supportsInterface('0x80ac58cd')); // ERC721
    const s1155 = await safeRpcCall(chain, p => erc165.connect(p).supportsInterface('0xd9b67a26')); // ERC1155
    out.is721 = !!s721;
    out.is1155 = !!s1155 && !s721; // prefer explicit split
  } catch {}
  return out;
}

/* ===================== Enumerable (ERC721 only) ===================== */
async function detectEnumerable(chain, contract) {
  const provider = getProvider(chain);
  if (!provider) return false;
  const erc165 = new Contract(contract, ['function supportsInterface(bytes4) view returns (bool)'], provider);
  try {
    const ok = await safeRpcCall(chain, p => erc165.connect(p).supportsInterface('0x780e9d63')); // ERC721Enumerable
    return !!ok;
  } catch { return false; }
}
async function fetchOwnerTokensEnumerable({ chain, contract, owner, maxWant = ENV_MAX }) {
  const provider = getProvider(chain);
  if (!provider) return { items: [], total: 0, enumerable: false };
  const nft = new Contract(contract, [
    'function balanceOf(address) view returns (uint256)',
    'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)'
  ], provider);

  try {
    const balRaw = await safeRpcCall(chain, p => nft.connect(p).balanceOf(owner));
    const bal = Number(balRaw?.toString?.() ?? balRaw ?? 0);
    if (!Number.isFinite(bal) || bal <= 0) return { items: [], total: 0, enumerable: true };

    const want = Math.min(bal, maxWant);
    const ids = [];
    for (let i = 0; i < want; i++) {
      try {
        const tid = await safeRpcCall(chain, p => nft.connect(p).tokenOfOwnerByIndex(owner, i));
        if (tid == null) break;
        ids.push(tid.toString());
      } catch { break; }
    }
    const items = ids.map(id => ({ tokenId: id, image: null, name: `#${id}` }));
    return { items, total: bal, enumerable: true };
  } catch {
    return { items: [], total: 0, enumerable: false };
  }
}

/* ===================== On-chain deep scan ===================== */
// ERC721: Transfer(address,address,uint256)
async function fetchOwnerTokens721Rolling({ chain, contract, owner, maxWant = ENV_MAX, deep = false, onProgress }) {
  const provider = getProvider(chain);
  if (!provider) return { items: [], total: 0 };
  const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
  const head = await safeRpcCall(chain, p => p.getBlockNumber()) || 0;

  const isBase = chain === 'base';
  const WINDOW = isBase ? LOG_WINDOW_BASE : 60000;
  const MAX_WINDOWS = deep ? 500 : (isBase ? 80 : 120);

  const topic0 = ethers.id('Transfer(address,address,uint256)');
  const topicTo   = padTopicAddress(owner);
  const topicFrom = padTopicAddress(owner);

  const windows = [];
  for (let i = 0; i < MAX_WINDOWS; i++) {
    const toBlock = head - i * WINDOW;
    const fromBlock = Math.max(0, toBlock - WINDOW + 1);
    if (toBlock <= 0) break;
    windows.push({ fromBlock, toBlock });
  }

  const owned = new Set();
  let processed = 0;
  const update = async () => { if (typeof onProgress === 'function') await onProgress(++processed, windows.length); };

  for (let i = 0; i < windows.length; i += LOG_CONCURRENCY) {
    const chunk = windows.slice(i, i + LOG_CONCURRENCY);
    await Promise.all(chunk.map(async ({ fromBlock, toBlock }) => {
      let inLogs = [], outLogs = [];
      try {
        inLogs = await safeRpcCall(chain, p => p.getLogs({ address: contract.toLowerCase(), topics: [topic0, null, topicTo], fromBlock, toBlock })) || [];
      } catch {}
      try {
        outLogs = await safeRpcCall(chain, p => p.getLogs({ address: contract.toLowerCase(), topics: [topic0, topicFrom, null], fromBlock, toBlock })) || [];
      } catch {}
      for (const log of inLogs) { let parsed; try { parsed = iface.parseLog(log); } catch { continue; } owned.add(parsed.args.tokenId.toString()); }
      for (const log of outLogs) { let parsed; try { parsed = iface.parseLog(log); } catch { continue; } owned.delete(parsed.args.tokenId.toString()); }
      await update();
    }));
    if (!deep && owned.size >= maxWant) break;
  }

  const all = Array.from(owned);
  const slice = all.slice(0, maxWant).map(id => ({ tokenId: id, image: null, name: `#${id}` }));
  return { items: slice, total: all.length || slice.length };
}

// ERC1155: TransferSingle / TransferBatch (ids in data)
async function fetchOwnerTokens1155Rolling({ chain, contract, owner, maxWant = ENV_MAX, deep = false, onProgress }) {
  const provider = getProvider(chain);
  if (!provider) return { items: [], total: 0 };
  const iface = new Interface([
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
  ]);
  const head = await safeRpcCall(chain, p => p.getBlockNumber()) || 0;

  const isBase = chain === 'base';
  const WINDOW = isBase ? LOG_WINDOW_BASE : 60000;
  const MAX_WINDOWS = deep ? 500 : (isBase ? 120 : 160);

  const topicSingle = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
  const topicBatch  = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');
  const topicFrom = padTopicAddress(owner);
  const topicTo   = padTopicAddress(owner);

  const windows = [];
  for (let i = 0; i < MAX_WINDOWS; i++) {
    const toBlock = head - i * WINDOW;
    const fromBlock = Math.max(0, toBlock - WINDOW + 1);
    if (toBlock <= 0) break;
    windows.push({ fromBlock, toBlock });
  }

  const balances = new Map(); // tokenId => BigInt
  let processed = 0;
  const update = async () => { if (typeof onProgress === 'function') await onProgress(++processed, windows.length); };

  const add = (id, delta) => {
    const key = id.toString();
    const cur = balances.get(key) || 0n;
    const next = cur + BigInt(delta);
    balances.set(key, next);
  };

  for (let i = 0; i < windows.length; i += LOG_CONCURRENCY) {
    const chunk = windows.slice(i, i + LOG_CONCURRENCY);
    await Promise.all(chunk.map(async ({ fromBlock, toBlock }) => {
      let sIn = [], sOut = [], bIn = [], bOut = [];
      try {
        sIn  = await safeRpcCall(chain, p => p.getLogs({ address: contract.toLowerCase(), topics: [topicSingle, null, null, topicTo],  fromBlock, toBlock })) || [];
      } catch {}
      try {
        sOut = await safeRpcCall(chain, p => p.getLogs({ address: contract.toLowerCase(), topics: [topicSingle, null, topicFrom, null], fromBlock, toBlock })) || [];
      } catch {}
      try {
        bIn  = await safeRpcCall(chain, p => p.getLogs({ address: contract.toLowerCase(), topics: [topicBatch,  null, null, topicTo],  fromBlock, toBlock })) || [];
      } catch {}
      try {
        bOut = await safeRpcCall(chain, p => p.getLogs({ address: contract.toLowerCase(), topics: [topicBatch,  null, topicFrom, null], fromBlock, toBlock })) || [];
      } catch {}

      for (const log of sIn)  { let parsed; try { parsed = iface.parseLog(log); } catch { continue; } add(parsed.args.id,  parsed.args.value); }
      for (const log of sOut) { let parsed; try { parsed = iface.parseLog(log); } catch { continue; } add(parsed.args.id, -parsed.args.value); }
      for (const log of bIn)  { let parsed; try { parsed = iface.parseLog(log); } catch { continue; }
        const ids = parsed.args.ids, vals = parsed.args.values;
        for (let i = 0; i < ids.length; i++) add(ids[i], vals[i]);
      }
      for (const log of bOut) { let parsed; try { parsed = iface.parseLog(log); } catch { continue; }
        const ids = parsed.args.ids, vals = parsed.args.values;
        for (let i = 0; i < ids.length; i++) add(ids[i], -vals[i]);
      }
      await update();
    }));
    // we can't early-stop reliably; continue to accumulate
  }

  const ownedIds = [];
  for (const [id, bal] of balances.entries()) if (bal > 0n) ownedIds.push(id);
  const slice = ownedIds.slice(0, maxWant).map(id => ({ tokenId: id, image: null, name: `#${id}` }));
  return { items: slice, total: ownedIds.length || slice.length };
}

/* ===================== Resolve tokenURI / uri (ERC721/1155) ===================== */
function idHex64(tokenId) {
  const bn = BigInt(tokenId);
  return bn.toString(16).padStart(64, '0');
}

async function resolveMetadataURI({ chain, contract, tokenId, is1155 }) {
  const provider = getProvider(chain);
  if (!provider) return null;
  if (is1155) {
    const c = new Contract(contract, ['function uri(uint256) view returns (string)'], provider);
    let uri = await safeRpcCall(chain, p => c.connect(p).uri(tokenId));
    if (!uri) return null;
    // {id} substitution per ERC1155 metadata standard
    uri = uri.replace(/\{id\}/gi, idHex64(tokenId));
    return uri.startsWith('ipfs://') ? ipfsToHttp(uri) : [uri];
  } else {
    const c = new Contract(contract, ['function tokenURI(uint256) view returns (string)'], provider);
    const uri = await safeRpcCall(chain, p => c.connect(p).tokenURI(tokenId));
    if (!uri) return null;
    return uri.startsWith('ipfs://') ? ipfsToHttp(uri) : [uri];
  }
}

/* ===================== Enrich images (with progress) ===================== */
async function enrichImages({ chain, contract, items, is1155, onProgress }) {
  let done = 0;
  const upd = () => onProgress?.(++done, items.length);

  const results = await runPool(8, items, async (it) => {
    if (it.image) { upd(); return it; }
    try {
      const uriList = await resolveMetadataURI({ chain, contract, tokenId: it.tokenId, is1155 });
      if (!uriList) { upd(); return it; }

      let meta = null;
      // try data: first among list
      if (isDataUrl(uriList[0])) {
        const parsed = parseDataUrl(uriList[0]);
        if (parsed && /json/.test(parsed.mime)) {
          try { meta = JSON.parse(parsed.buffer.toString('utf8')); } catch {}
        }
      }
      if (!meta) meta = await fetchJsonWithFallback(uriList);

      let img =
        meta?.image ||
        meta?.image_url ||
        meta?.imageUrl ||
        meta?.image_preview_url ||
        meta?.image_thumbnail_url ||
        null;

      if (!img && typeof meta?.animation_url === 'string' && /\.(gif|png|jpe?g|webp|avif)(\?|$)/i.test(meta.animation_url)) {
        img = meta.animation_url;
      }
      if (!img && typeof meta?.image_data === 'string') {
        const txt = meta.image_data.trim();
        if (txt.startsWith('<svg')) img = 'data:image/svg+xml;utf8,' + encodeURIComponent(txt);
      }

      let candidates = [];
      if (Array.isArray(img)) candidates = img.flatMap(expandImageCandidates);
      else if (typeof img === 'string') candidates = expandImageCandidates(img);

      upd();
      return { ...it, image: candidates.length ? candidates : null };
    } catch {
      upd();
      return it;
    }
  });

  return results;
}

/* ===================== Backfill missing images via Reservoir (progress) ===================== */
async function backfillImagesFromReservoir({ chain, contract, items, onProgress }) {
  const chainHeader = chain === 'eth' ? 'ethereum' : chain === 'base' ? 'base' : null;
  if (!chainHeader) return items;
  const headers = { 'Content-Type': 'application/json', 'x-reservoir-chain': chainHeader };
  if (process.env.RESERVOIR_API_KEY) headers['x-api-key'] = process.env.RESERVOIR_API_KEY;

  const targets = items.filter(it => !it.image).map(it => `${contract}:${it.tokenId}`);
  if (!targets.length) return items;

  const CHUNK = 50;
  const images = new Map();
  let done = 0;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    const url = new URL('https://api.reservoir.tools/tokens/v7');
    for (const t of chunk) url.searchParams.append('tokens', t);
    url.searchParams.set('includeAttributes', 'false');

    try {
      const res = await fetch(url.toString(), { headers });
      if (!res.ok) continue;
      const json = await res.json();
      const arr = json?.tokens || [];
      for (const r of arr) {
        const id = `${(r?.token?.contract || contract).toLowerCase()}:${r?.token?.tokenId}`;
        const img = r?.token?.image || r?.token?.media?.original || r?.token?.media?.imageUrl || null;
        if (img) images.set(id, img);
      }
    } catch {}
    done += chunk.length;
    onProgress?.(Math.min(done, targets.length), targets.length);
  }

  return items.map(it => {
    if (it.image) return it;
    const key = `${contract}:${it.tokenId}`;
    const found = images.get(key);
    if (!found) return it;
    return { ...it, image: expandImageCandidates(found) };
  });
}

/* ===================== Robust image loading ===================== */
async function loadImageWithCandidates(candidates, perTryMs = 8000) {
  // Try URL route first
  for (const u of candidates) {
    try {
      if (isDataUrl(u)) {
        const parsed = parseDataUrl(u);
        if (parsed && /^image\//.test(parsed.mime)) {
          const img = await loadImage(parsed.buffer);
          if (img && img.width > 0 && img.height > 0) return img;
        }
      } else {
        const img = await Promise.race([
          loadImage(u),
          new Promise(res => setTimeout(() => res(null), perTryMs))
        ]);
        if (img && img.width > 0 && img.height > 0) return img;
      }
    } catch {}
  }
  // Fallback: simple fetch of first viable URL
  for (const u of candidates) {
    if (isDataUrl(u)) continue;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), perTryMs);
      const agent = u.startsWith('http:') ? keepAliveHttp : keepAliveHttps;
      const res = await fetch(u, { signal: ctrl.signal, agent, headers: { 'Accept': 'image/*' } });
      clearTimeout(t);
      if (!res.ok) continue;
      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      if (!looksLikeImage(buf)) continue;
      const img = await loadImage(buf);
      if (img && img.width > 0 && img.height > 0) return img;
    } catch {}
  }
  return null;
}

async function preloadImages(items, onProgress) {
  let done = 0;
  const imgs = await runPool(8, items, async (it) => {
    const candidates =
      Array.isArray(it.image) ? it.image :
      (typeof it.image === 'string' ? expandImageCandidates(it.image) : []);
    const img = candidates && candidates.length ? await loadImageWithCandidates(candidates) : null;
    done++; onProgress?.(done, items.length);
    return img;
  });
  return imgs;
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
    if (!img || !img.width || !img.height) {
      ctx.fillStyle = '#161a24'; ctx.fillRect(x, y, tile, tile);
      ctx.fillStyle = '#c9d3e3';
      ctx.font = `bold ${Math.max(16, Math.round(tile * 0.16))}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`#${items[i]?.tokenId ?? '?'}`, x + tile / 2, y + tile / 2);
      continue;
    }

    const scale = Math.max(tile / img.width, tile / img.height);
    const sw = Math.max(1, Math.floor(tile / scale));
    const sh = Math.max(1, Math.floor(tile / scale));
    const sx = Math.max(0, Math.floor((img.width  - sw) / 2));
    const sy = Math.max(0, Math.floor((img.height - sh) / 2));

    ctx.drawImage(img, sx, sy, Math.min(sw, img.width), Math.min(sh, img.height), x, y, tile, tile);
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

    // Safe editor that won’t crash if the message is finalized
    let finalized = false;
    const safeEdit = async (payload) => { if (finalized) return; try { await interaction.editReply(payload); } catch {} };

    // Live status updater
    let status = { step: 'Resolving wallet…', scan: '', enrich: '', backfill: '', images: '0%' };
    const pushStatus = async () => {
      const lines = [
        `Wallet: ${status.step}`,
        status.scan && `Scan:     ${status.scan}`,
        status.enrich && `Metadata: ${status.enrich}`,
        status.backfill && `Backfill: ${status.backfill}`,
        `Images:   ${status.images}`
      ].filter(Boolean);
      await safeEdit({ content: statusBlock(lines) });
    };

    status.step = 'Resolving wallet…';
    await pushStatus();

    // ENS or address
    let owner, ownerDisplay;
    try {
      const resolved = await resolveWalletInput(walletInput);
      owner = resolved.address;
      ownerDisplay = resolved.display || owner;
    } catch (e) { return interaction.editReply(`❌ ${e.message}`); }

    status.step = 'Fetching tokens (API)…';
    await pushStatus();

    // resolve project ONLY if tracked by this server
    const { project, error } = await resolveProjectForGuild(pg, interaction.client, guildId, projectInput);
    if (error) return interaction.editReply(error);

    const chain = (project.chain || 'base').toLowerCase();
    const contract = (project.address || '').toLowerCase();
    const maxWant = Math.min(userLimit || ENV_MAX, ENV_MAX);

    // Detect standard
    const std = await detectTokenStandard(chain, contract);

    // Try Reservoir first
    let items = [], totalOwned = 0, usedReservoir = false;
    if (chain === 'eth' || chain === 'base') {
      const resv = await fetchOwnerTokensReservoirAll({ chain, contract, owner, maxWant });
      items = resv.items;
      totalOwned = resv.total || items.length;
      usedReservoir = items.length > 0;
    }

    // Enumerable fast path (ERC721 only)
    if (std.is721 && items.length < maxWant) {
      status.step = 'Fetching tokens (enumerable)…';
      await pushStatus();
      const en = await fetchOwnerTokensEnumerable({ chain, contract, owner, maxWant });
      const byId = new Map(items.map(it => [String(it.tokenId), it]));
      for (const it of en.items) { const k = String(it.tokenId); if (!byId.has(k)) byId.set(k, it); }
      items = Array.from(byId.values()).slice(0, maxWant);
      totalOwned = Math.max(totalOwned, en.total || 0, items.length);
    }

    // On-chain deep scan with progress
    if (items.length < maxWant) {
      let lastPct = -1;
      status.step = std.is1155 ? 'Deep scan (ERC1155)…' : (chain === 'base' ? 'Deep scan (Base)…' : 'Scanning logs…');
      status.scan = '0% [────────────────]';
      await pushStatus();

      const onScanProgress = async (done, total) => {
        const pct = clamp(Math.floor((done/total)*100), 0, 100);
        if (pct !== lastPct) { lastPct = pct; status.scan = `${pct}% [${bar(pct)}]`; await pushStatus(); }
      };

      const onch = std.is1155
        ? await fetchOwnerTokens1155Rolling({ chain, contract, owner, maxWant, deep: chain === 'base', onProgress: onScanProgress })
        : await fetchOwnerTokens721Rolling ({ chain, contract, owner, maxWant, deep: chain === 'base', onProgress: onScanProgress });

      const byId = new Map(items.map(it => [String(it.tokenId), it]));
      for (const it of onch.items) { const key = String(it.tokenId); if (!byId.has(key)) byId.set(key, it); }
      items = Array.from(byId.values()).slice(0, maxWant);
      totalOwned = Math.max(totalOwned, onch.total || 0, items.length);
      status.scan = 'done';
      await pushStatus();
    }

    if (!items.length) {
      return interaction.editReply(`❌ No ${project.name} NFTs found for \`${ownerDisplay}\` on ${chain}. (Checked ERC721/1155 paths)`);
    }

    // Enrich images (ERC721 tokenURI OR ERC1155 uri with {id}) + progress
    let lastEnPct = -1;
    status.step = 'Enriching images (metadata)…';
    status.enrich = '0% [────────────────]';
    await pushStatus();
    items = await enrichImages({
      chain, contract, items, is1155: std.is1155,
      onProgress: async (done, total) => {
        const pct = clamp(Math.floor((done/total)*100), 0, 100);
        if (pct !== lastEnPct) { lastEnPct = pct; status.enrich = `${pct}% [${bar(pct)}]`; await pushStatus(); }
      }
    });

    // Backfill missing images via Reservoir (progress)
    if (items.some(i => !i.image) && (chain === 'eth' || chain === 'base')) {
      let lastBF = -1;
      status.step = 'Backfilling images (Reservoir)…';
      status.backfill = '0% [────────────────]';
      await pushStatus();
      const totalMissing = items.filter(i => !i.image).length;
      items = await backfillImagesFromReservoir({
        chain, contract, items,
        onProgress: async (done /* chunk count */, total) => {
          const pct = totalMissing ? clamp(Math.floor((Math.min(done, totalMissing)/totalMissing)*100), 0, 100) : 100;
          if (pct !== lastBF) { lastBF = pct; status.backfill = `${pct}% [${bar(pct)}]`; await pushStatus(); }
        }
      });
      status.backfill = 'done';
      await pushStatus();
    }

    // Image preload with visible percent (robust loader)
    status.step = `Loading images (${items.length})…`;
    let imgPct = 0;
    status.images = `0% [${bar(0)}]`;
    await pushStatus();

    const preloadedImgs = await preloadImages(items, (done, total) => {
      imgPct = clamp(Math.floor((done/total)*100), 0, 100);
      status.images = `${imgPct}% [${bar(imgPct)}]`;
      (async () => { await safeEdit({ content: statusBlock([
        `Wallet: ${status.step}`,
        status.scan && `Scan:     ${status.scan}`,
        status.enrich && `Metadata: ${status.enrich}`,
        status.backfill && `Backfill: ${status.backfill}`,
        `Images:   ${status.images}`
      ].filter(Boolean)) }); })();
    });

    // Compose grid
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
    finalized = true;
  }
};









