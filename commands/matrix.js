// commands/matrix.js
const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { Contract, Interface, ethers } = require('ethers');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const {
  safeRpcCall: safeRpcCallMatrix,
  getProvider: getProviderMatrix,
  getLogsWindowed
} = require('../services/providerMatrix');


/* ===================== Config ===================== */
const ENV_MAX = Math.max(1, Math.min(Number(process.env.MATRIX_MAX_AUTO || 81), 400));

// Pagination caps
const DEFAULT_PAGE_SIZE = clamp(Number(process.env.MATRIX_PAGE_SIZE_DEFAULT || ENV_MAX), 1, 400);
const MAX_PAGE_SIZE = 400;
const MAX_PAGES_ALL = clamp(Number(process.env.MATRIX_MAX_PAGES_ALL || 5), 1, 10); // send at most 5 pages per run

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

const LOG_CONCURRENCY = Math.max(1, Number(process.env.MATRIX_LOG_CONCURRENCY || 3));
const METADATA_CONCURRENCY  = Math.max(4, Number(process.env.MATRIX_METADATA_CONCURRENCY || 10));
// Lower default fan-out to reduce gateway rate-limits; override via env if you want more
const IMAGE_CONCURRENCY     = Math.max(2, Number(process.env.MATRIX_IMAGE_CONCURRENCY || 6));

// Scan time budgets / deadlines so progress always completes
const WINDOW_TIMEOUT_MS_EVM  = Number(process.env.MATRIX_WINDOW_TIMEOUT_MS_EVM  || 9000);
const WINDOW_TIMEOUT_MS_BASE = Number(process.env.MATRIX_WINDOW_TIMEOUT_MS_BASE || 12000);
const SCAN_MAX_MS_SHALLOW    = Number(process.env.MATRIX_SCAN_MAX_MS_SHALLOW    || 25000);
const SCAN_MAX_MS_DEEP       = Number(process.env.MATRIX_SCAN_MAX_MS_DEEP       || 60000);

/* ===================== Keep-Alive Agents ===================== */
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 128 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 128 });
const UA = 'Mozilla/5.0 (compatible; MatrixBot/1.4; +https://github.com/pimpsdev)';

/* ===================== Small Utils ===================== */
function padTopicAddress(addr) { return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0'); }
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function bar(pct, len=16){ const filled = clamp(Math.round((pct/100)*len), 0, len); return '█'.repeat(filled) + '░'.repeat(len-filled); }
function statusBlock(lines){ return '```' + ['Matrix Status','─'.repeat(32),...lines].join('\n') + '```'; }
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
async function withDeadline(promise, ms, fallback) {
  return Promise.race([promise, new Promise(res => setTimeout(() => res(fallback), ms))]);
}

/* ===================== URL helpers ===================== */
const IPFS_GATES = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://gateway.ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://nftstorage.link/ipfs/',
  'https://cf-ipfs.com/ipfs/',
  'https://ipfs.filebase.io/ipfs/',
  'https://w3s.link/ipfs/',
  'https://4everland.io/ipfs/',
  'https://hardbin.com/ipfs/',
  'https://ipfs.infura.io/ipfs/'
];
function normalizeScheme(u) {
  if (typeof u !== 'string') return u;
  return u.replace(/^IPFS:\/\//i, 'ipfs://')
          .replace(/^AR:\/\//i,   'ar://');
}
function ipfsToHttp(input) {
  let path = input.replace(/^ipfs:\/\//i, '');
  path = path.replace(/^ipfs\//i, '');
  return IPFS_GATES.map(g => g + path);
}
function arToHttp(u) {
  const id = u.replace(/^ar:\/\//i, '');
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

// Improved: handle subdomain IPFS → path, rank candidates by image-likelihood, de-prioritize videos/json
function expandImageCandidates(raw) {
  let u = normalizeScheme(raw);
  if (typeof u === 'string') u = u.trim();
  if (!u || typeof u !== 'string') return [];

  if (isDataUrl(u)) return [u];
  if (/^ipfs:\/\//i.test(u)) return ipfsToHttp(u);
  if (/^ar:\/\//i.test(u))   return arToHttp(u);

  const out = new Set();
  const tryPush = (x) => { try { if (typeof x === 'string' && x) out.add(x); } catch {} };
  tryPush(u);

  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    const path = url.pathname || '/';

    // Already /ipfs/<cid> → replicate to all gateways
    const ipfsIndex = path.indexOf('/ipfs/');
    if (ipfsIndex >= 0) {
      const cidPath = path.slice(ipfsIndex + 6).replace(/^\/+/, '');
      for (const g of IPFS_GATES) tryPush(new URL(cidPath, g).href);
    }

    // Subdomain: <cid>.ipfs.<gateway>/rest → /ipfs/<cid>/rest on all gateways
    if (host.includes('.ipfs.')) {
      const sub = host.split('.ipfs.')[0]; // CID-ish
      const rest = path.replace(/^\/+/, '');
      const candidatePath = sub + (rest ? `/${rest}` : '');
      for (const g of IPFS_GATES) tryPush(g + candidatePath);
    }
  } catch {}

  const exRank = (s) => {
    const q = s.split('?')[0].toLowerCase();
    if (q.endsWith('.png'))  return 1;
    if (q.endsWith('.jpg') || q.endsWith('.jpeg')) return 2;
    if (q.endsWith('.gif'))  return 3;
    if (q.endsWith('.webp')) return 4;
    if (q.endsWith('.svg'))  return 5;
    if (q.endsWith('.avif')) return 6;
    if (q.endsWith('.json')) return 99;
    if (q.endsWith('.mp4') || q.endsWith('.webm') || q.endsWith('.mov')) return 100;
    return 50;
  };

  return Array.from(out).sort((a, b) => exRank(a) - exRank(b));
}

function looksLikeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return false;
  const sig = buf.slice(0, 12).toString('hex');
  if (buf.slice(0,8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))) return true; // PNG
  if (buf.slice(0,3).equals(Buffer.from([0xFF,0xD8,0xFF]))) return true; // JPG
  if (buf.slice(0,3).equals(Buffer.from([0x47,0x49,0x46]))) return true; // GIF
  if (sig.startsWith('52494646') && sig.includes('57454250')) return true; // WEBP
  const head = buf.slice(0, 256).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return true; // SVG served as text/xml
  return false;
}

/* ===================== JSON/HTML fetch helpers ===================== */
async function fetchJsonWithFallback(urlOrList, timeoutMs = 9000) {
  const urls = Array.isArray(urlOrList) ? urlOrList : [urlOrList];
  for (const u0 of urls) {
    const u = normalizeScheme(u0);
    try {
      if (isDataUrl(u)) {
        const parsed = parseDataUrl(u);
        if (!parsed) continue;
        if (/json/i.test(parsed.mime)) {
          try { return JSON.parse(parsed.buffer.toString('utf8')); } catch { continue; }
        }
        continue;
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const agent = u.startsWith('http:') ? keepAliveHttp : keepAliveHttps;
      const res = await fetch(u, {
        signal: ctrl.signal,
        agent,
        headers: {
          'Accept': 'application/json,*/*;q=0.8',
          'User-Agent': UA,
          'Connection': 'keep-alive'
        }
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (data) return data;
    } catch {}
  }
  return null;
}

// If an URL serves HTML, try to resolve <meta property="og:image"> or twitter:image
async function fetchOgImageFromHtml(url, timeoutMs = 7000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8', 'Connection': 'keep-alive' }
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

/* ===================== Deep metadata image extractor ===================== */
function collectAllImageCandidates(meta, limit = 60) {
  const out = new Set();
  const seen = new Set();
  const queue = [meta];
  let visits = 0;

  const pushUrl = (u) => {
    u = normalizeScheme(u);
    if (!u || typeof u !== 'string') return;
    if (u.startsWith('data:image')) { out.add(u); return; }
    if (/^(ipfs|ar):\/\//i.test(u) || /^https?:\/\//i.test(u)) out.add(u);
  };

  while (queue.length && out.size < limit && visits < 8000) {
    const cur = queue.shift();
    visits++;
    if (cur == null) continue;

    if (typeof cur === 'string') { pushUrl(cur); continue; }
    if (typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    const prioritize = [
      'image','image_url','imageUrl','imageURI','image_uri',
      'imagePreviewUrl','image_preview_url','thumbnail','thumbnail_url',
      'displayUri','artifactUri','animation_url','content','uri','url','src',
      'media','mediaUrl','original_media_url','metadata_image','image_data'
    ];
    for (const k of prioritize) if (k in cur) pushUrl(cur[k]);

    if (Array.isArray(cur)) {
      for (const v of cur) queue.push(v);
    } else {
      for (const [, v] of Object.entries(cur)) queue.push(v);
    }
  }

  const expanded = [];
  for (let u of out) {
    u = normalizeScheme(u);
    if (isDataUrl(u)) { expanded.push(u); continue; }
    if (/^ipfs:\/\//i.test(u)) { expanded.push(...ipfsToHttp(u)); continue; }
    if (/^ar:\/\//i.test(u))   { expanded.push(...arToHttp(u)); continue; }
    expanded.push(u);
  }
  return Array.from(new Set(expanded));
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
function withTimeoutENS(promise, ms = 4000, reason = 'ENS timeout') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(reason)), ms))
  ]);
}
async function tryResolveWithCurrentProvider(name) {
  try {
    const prov = getProviderMatrix('eth');
    if (!prov) return null;
    const addr = await withTimeoutENS(prov.resolveName(name), 4000);
    return addr || null;
  } catch { return null; }
}
async function tryResolveWithFallbacks(name) {
  for (const url of ENS_RPC_FALLBACKS) {
    try {
      const prov = new ethers.JsonRpcProvider(url);
      const addr = await withTimeoutENS(prov.resolveName(name), 4000);
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
function pickReservoirImage(t) {
  const tok = t?.token || t || {};
  const m = tok.media || {};
  return tok.image || m.imageUrl || m.thumbnail || m.small || m.medium || m.large || m.original || null;
}
async function fetchOwnerTokensReservoirAll({ chain, contract, owner, maxWant = ENV_MAX }) {
  const chainHeader = chain === 'eth' ? 'ethereum' : chain === 'base' ? 'base' : null;
  if (!chainHeader) return { items: [], total: 0 };

  const headers = { 'Content-Type': 'application/json', 'x-reservoir-chain': chainHeader };
  if (process.env.RESERVOIR_API_KEY) headers['x-api-key'] = process.env.RESERVOIR_API_KEY;

  let continuation = null;
  const items = [];
  let safety = 32; // allow more pages if we need more tokens for pagination
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
        const tok = t?.token;
        if (!tok?.tokenId) continue;
        const img = pickReservoirImage(t);
        items.push({
          tokenId: String(tok.tokenId),
          image: img ? expandImageCandidates(img) : null,
          name: tok.name || `${tok.contract} #${tok.tokenId}`
        });
        if (items.length >= maxWant) break;
      }
      if (!continuation || tokens.length === 0) break;
    } catch { break; }
  }

  if (!total) total = items.length;
  return { items, total };
}

// Reservoir redirect endpoints that 302 to a best-effort static preview
function reservoirRedirectCandidates(chain, contract, tokenId) {
  const id = `${contract}:${String(tokenId)}`;
  return [
    `https://api.reservoir.tools/redirect/tokens/${id}/image/v1`,
    `https://api.reservoir.tools/redirect/tokens/${id}/image`,
  ];
}

/* ===================== Standards & enumerable ===================== */
async function detectTokenStandard(chain, contract) {
  const provider = getProviderMatrix(chain);
  if (!provider) return { is721: false, is1155: false };
  const erc165 = new Contract(contract, ['function supportsInterface(bytes4) view returns (bool)'], provider);
  const out = { is721: false, is1155: false };
  try {
    const s721  = await safeRpcCallMatrix(chain, p => erc165.connect(p).supportsInterface('0x80ac58cd'));
    const s1155 = await safeRpcCallMatrix(chain, p => erc165.connect(p).supportsInterface('0xd9b67a26'));
    out.is721 = !!s721;
    out.is1155 = !!s1155 && !s721;
  } catch {}
  return out;
}
async function fetchOwnerTokensEnumerable({ chain, contract, owner, maxWant = ENV_MAX }) {
  const provider = getProviderMatrix(chain);
  if (!provider) return { items: [], total: 0, enumerable: false };
  const nft = new Contract(contract, [
    'function balanceOf(address) view returns (uint256)',
    'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)'
  ], provider);

  try {
    const balRaw = await safeRpcCallMatrix(chain, p => nft.connect(p).balanceOf(owner));
    const bal = Number(balRaw?.toString?.() ?? balRaw ?? 0);
    if (!Number.isFinite(bal) || bal <= 0) return { items: [], total: 0, enumerable: true };

    const want = Math.min(bal, maxWant);
    const ids = [];
    for (let i = 0; i < want; i++) {
      try {
        const tid = await safeRpcCallMatrix(chain, p => nft.connect(p).tokenOfOwnerByIndex(owner, i));
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

/* ===================== On-chain deep scans (windowed on Base) ===================== */
async function fetchOwnerTokens721Rolling({ chain, contract, owner, maxWant = ENV_MAX, deep = false, onProgress }) {
  const provider = getProviderMatrix(chain);
  if (!provider) return { items: [], total: 0 };
  const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
  const head = await safeRpcCallMatrix(chain, p => p.getBlockNumber()) || 0;

  const isBase = chain === 'base';
  const WINDOW = isBase ? 9500 : 60000;
  const LOG_CONC = isBase ? 1 : LOG_CONCURRENCY;
  const MAX_WINDOWS = deep ? 750 : (isBase ? 90 : 120);
  const WINDOW_TIMEOUT = isBase ? WINDOW_TIMEOUT_MS_BASE : WINDOW_TIMEOUT_MS_EVM;
  const BUDGET = deep ? SCAN_MAX_MS_DEEP : SCAN_MAX_MS_SHALLOW;
  const started = Date.now();

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

  outer: for (let i = 0; i < windows.length; i += LOG_CONC) {
    const chunk = windows.slice(i, i + LOG_CONC);
    await Promise.all(chunk.map(async ({ fromBlock, toBlock }) => {
      let inLogs = [], outLogs = [];
      try {
        const paramsIn  = { address: contract.toLowerCase(), topics: [topic0, null, topicTo] };
        const paramsOut = { address: contract.toLowerCase(), topics: [topic0, topicFrom, null] };

        if (isBase) {
          inLogs  = await withDeadline(getLogsWindowed(chain, paramsIn,  fromBlock, toBlock), WINDOW_TIMEOUT, []);
          outLogs = await withDeadline(getLogsWindowed(chain, paramsOut, fromBlock, toBlock), WINDOW_TIMEOUT, []);
        } else {
          inLogs  = await withDeadline(safeRpcCallMatrix(chain, p => p.getLogs({ ...paramsIn,  fromBlock, toBlock })), WINDOW_TIMEOUT, []) || [];
          outLogs = await withDeadline(safeRpcCallMatrix(chain, p => p.getLogs({ ...paramsOut, fromBlock, toBlock })), WINDOW_TIMEOUT, []) || [];
        }
      } catch {}

      for (const log of inLogs)  { let parsed; try { parsed = iface.parseLog(log); } catch { continue; } owned.add(parsed.args.tokenId.toString()); }
      for (const log of outLogs) { let parsed; try { parsed = iface.parseLog(log); } catch { continue; } owned.delete(parsed.args.tokenId.toString()); }
      await update();
    }));
    if (!deep && owned.size >= maxWant) break;
    if (Date.now() - started > BUDGET) break outer;
  }

  const all = Array.from(owned);
  const slice = all.slice(0, maxWant).map(id => ({ tokenId: id, image: null, name: `#${id}` }));
  return { items: slice, total: all.length || slice.length };
}

async function fetchOwnerTokens1155Rolling({ chain, contract, owner, maxWant = ENV_MAX, deep = false, onProgress }) {
  const provider = getProviderMatrix(chain);
  if (!provider) return { items: [], total: 0 };
  const iface = new Interface([
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
  ]);
  const head = await safeRpcCallMatrix(chain, p => p.getBlockNumber()) || 0;

  const isBase = chain === 'base';
  const WINDOW = isBase ? 9500 : 60000;
  const LOG_CONC = isBase ? 1 : LOG_CONCURRENCY;
  const MAX_WINDOWS = deep ? 750 : (isBase ? 90 : 160);
  const WINDOW_TIMEOUT = isBase ? WINDOW_TIMEOUT_MS_BASE : WINDOW_TIMEOUT_MS_EVM;
  const BUDGET = deep ? SCAN_MAX_MS_DEEP : SCAN_MAX_MS_SHALLOW;
  const started = Date.now();

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

  outer: for (let i = 0; i < windows.length; i += LOG_CONC) {
    const chunk = windows.slice(i, i + LOG_CONC);
    await Promise.all(chunk.map(async ({ fromBlock, toBlock }) => {
      let sIn = [], sOut = [], bIn = [], bOut = [];
      try {
        const paramsSingleIn  = { address: contract.toLowerCase(), topics: [topicSingle, null, null, topicTo] };
        const paramsSingleOut = { address: contract.toLowerCase(), topics: [topicSingle, null, topicFrom, null] };
        const paramsBatchIn   = { address: contract.toLowerCase(), topics: [topicBatch,  null, null, topicTo] };
        const paramsBatchOut  = { address: contract.toLowerCase(), topics: [topicBatch,  null, topicFrom, null] };

        if (isBase) {
          sIn  = await withDeadline(getLogsWindowed(chain, paramsSingleIn,  fromBlock, toBlock), WINDOW_TIMEOUT, []);
          sOut = await withDeadline(getLogsWindowed(chain, paramsSingleOut, fromBlock, toBlock), WINDOW_TIMEOUT, []);
          bIn  = await withDeadline(getLogsWindowed(chain, paramsBatchIn,   fromBlock, toBlock), WINDOW_TIMEOUT, []);
          bOut = await withDeadline(getLogsWindowed(chain, paramsBatchOut,  fromBlock, toBlock), WINDOW_TIMEOUT, []);
        } else {
          sIn  = await withDeadline(safeRpcCallMatrix(chain, p => p.getLogs({ ...paramsSingleIn,  fromBlock, toBlock })), WINDOW_TIMEOUT, []) || [];
          sOut = await withDeadline(safeRpcCallMatrix(chain, p => p.getLogs({ ...paramsSingleOut, fromBlock, toBlock })), WINDOW_TIMEOUT, []) || [];
          bIn  = await withDeadline(safeRpcCallMatrix(chain, p => p.getLogs({ ...paramsBatchIn,   fromBlock, toBlock })), WINDOW_TIMEOUT, []) || [];
          bOut = await withDeadline(safeRpcCallMatrix(chain, p => p.getLogs({ ...paramsBatchOut,  fromBlock, toBlock })), WINDOW_TIMEOUT, []) || [];
        }
      } catch {}

      for (const log of sIn)  { let parsed; try { parsed = iface.parseLog(log); } catch { continue; } add(parsed.args.id,  parsed.args.value); }
      for (const log of sOut) { let parsed; try { parsed = iface.parseLog(log); } catch { continue; } add(parsed.args.id, -parsed.args.value); }
      for (const log of bIn)  { let parsed; try { parsed = iface.parseLog(log); } catch { continue; }
        const ids = parsed.args.ids, vals = parsed.args.values;
        for (let i = 0; i < ids.length; i++) add(ids[i],  vals[i]);
      }
      for (const log of bOut) { let parsed; try { parsed = iface.parseLog(log); } catch { continue; }
        const ids = parsed.args.ids, vals = parsed.args.values;
        for (let i = 0; i < ids.length; i++) add(ids[i], -vals[i]);
      }
      await update();
    }));
    if (Date.now() - started > BUDGET) break outer;
  }

  const ownedIds = [];
  for (const [id, bal] of balances.entries()) if (bal > 0n) ownedIds.push(id);
  const slice = ownedIds.slice(0, maxWant).map(id => ({ tokenId: id, image: null, name: `#${id}` }));
  return { items: slice, total: ownedIds.length || slice.length };
}

/* ===================== Owner-token list fallbacks (Moralis / OpenSea) ===================== */
// Return {items, total}
async function fetchOwnerTokensMoralisList({ chain, contract, owner, maxWant = ENV_MAX }) {
  const key = process.env.MORALIS_API_KEY;
  const chainName = chain === 'base' ? 'base' : chain === 'eth' ? 'eth' : null;
  if (!key || !chainName) return { items: [], total: 0 };

  const headers = { 'accept': 'application/json', 'X-API-Key': key, 'User-Agent': UA };
  const items = [];
  let cursor = null;
  let pages = 0;

  while (items.length < maxWant && pages < 20) {
    try {
      const url = new URL(`https://deep-index.moralis.io/api/v2.2/${owner}/nft/${contract}`);
      url.searchParams.set('chain', chainName);
      url.searchParams.set('format', 'decimal');
      url.searchParams.set('limit', '100');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url.toString(), { headers });
      if (!res.ok) break;
      const j = await res.json();
      const arr = j?.result || j?.items || [];
      for (const r of arr) {
        const tid = r?.token_id || r?.tokenId || r?.token_id_decimals || null;
        if (!tid) continue;
        items.push({ tokenId: String(tid), image: null, name: `#${String(tid)}` });
        if (items.length >= maxWant) break;
      }
      cursor = j?.cursor || j?.next || null;
      pages++;
      if (!cursor || arr.length === 0) break;
    } catch { break; }
  }
  return { items, total: items.length };
}

async function fetchOwnerTokensOpenSeaList({ chain, contract, owner, maxWant = ENV_MAX }) {
  const key = process.env.OPENSEA_API_KEY;
  const chainKey = chain === 'base' ? 'base' : chain === 'eth' ? 'ethereum' : null;
  if (!key || !chainKey) return { items: [], total: 0 };

  const headers = { 'accept': 'application/json', 'x-api-key': key, 'User-Agent': UA };
  const items = [];
  let next = null;
  let pages = 0;

  while (items.length < maxWant && pages < 20) {
    try {
      const url = new URL(`https://api.opensea.io/api/v2/chain/${chainKey}/account/${owner}/nfts`);
      url.searchParams.set('limit', '50');
      url.searchParams.set('contract_address', contract);
      if (next) url.searchParams.set('next', next);
      const res = await fetch(url.toString(), { headers });
      if (!res.ok) break;
      const j = await res.json();
      const arr = j?.nfts || [];
      for (const n of arr) {
        const tid = n?.identifier || n?.token_id || n?.tokenId || null;
        if (!tid) continue;
        items.push({ tokenId: String(tid), image: null, name: n?.name || `#${String(tid)}` });
        if (items.length >= maxWant) break;
      }
      next = j?.next || null;
      pages++;
      if (!next || arr.length === 0) break;
    } catch { break; }
  }
  return { items, total: items.length };
}

/* ===================== Resolve tokenURI/uri (dual-probe with permutations) ===================== */
function idHex64Lower(tokenId) {
  return BigInt(tokenId).toString(16).padStart(64, '0');
}
function idHex64Upper(tokenId) {
  return idHex64Lower(tokenId).toUpperCase();
}
const RESOLVED_URI_CACHE = new Map();

function applyIdPermutations(u, tokenId) {
  const dec = String(BigInt(tokenId));
  const hex64 = idHex64Lower(tokenId);
  const hex64U = idHex64Upper(tokenId);
  const hex = BigInt(tokenId).toString(16);
  const hexU = hex.toUpperCase();

  const variants = new Set();
  if (/\{id\}/i.test(u)) {
    variants.add(u.replace(/\{id\}/gi, hex64));
    variants.add(u.replace(/\{id\}/gi, hex64U));
    variants.add(u.replace(/\{id\}/gi, hex));
    variants.add(u.replace(/\{id\}/gi, hexU));
    variants.add(u.replace(/\{id\}/gi, dec));
  } else {
    variants.add(u);
  }
  return Array.from(variants);
}

async function resolveMetadataURI({ chain, contract, tokenId, is1155Hint }) {
  const key = `${chain}:${contract}:${String(tokenId)}:${is1155Hint ? '1155' : 'auto'}`;
  const cached = RESOLVED_URI_CACHE.get(key);
  if (cached) return cached;

  const provider = getProviderMatrix(chain);
  if (!provider) return null;

  const c721  = new Contract(contract, ['function tokenURI(uint256) view returns (string)'], provider);
  const c1155 = new Contract(contract, ['function uri(uint256) view returns (string)'], provider);

  const order = is1155Hint ? ['1155','721'] : ['721','1155'];
  for (const mode of order) {
    try {
      if (mode === '721') {
        let uri = await safeRpcCallMatrix(chain, p => c721.connect(p).tokenURI(tokenId));
        if (!uri) throw new Error('no tokenURI');
        uri = normalizeScheme(uri);
        const list = /^ipfs:\/\//i.test(uri) ? ipfsToHttp(uri) : [uri];
        RESOLVED_URI_CACHE.set(key, list);
        return list;
      } else {
        let uri = await safeRpcCallMatrix(chain, p => c1155.connect(p).uri(tokenId));
        if (!uri) throw new Error('no uri');
        uri = normalizeScheme(uri);
        const variants = applyIdPermutations(uri, tokenId)
          .flatMap(x => /^ipfs:\/\//i.test(x) ? ipfsToHttp(x) : [x]);
        const dedup = Array.from(new Set(variants));
        RESOLVED_URI_CACHE.set(key, dedup);
        return dedup;
      }
    } catch {
      // try the other mode
    }
  }
  return null;
}

/* ===================== Image enrichment & backfills ===================== */
async function enrichImages({ chain, contract, items, is1155, onProgress }) {
  let done = 0;
  const upd = () => onProgress?.(++done, items.length);

  const results = await runPool(METADATA_CONCURRENCY, items, async (it) => {
    if (it.image) { upd(); return it; }
    try {
      const uriList = await resolveMetadataURI({
        chain, contract, tokenId: it.tokenId, is1155Hint: is1155
      });
      if (!uriList) { upd(); return it; }

      let meta = null;
      if (isDataUrl(uriList[0])) {
        const parsed = parseDataUrl(uriList[0]);
        if (parsed && /json/i.test(parsed.mime)) {
          try { meta = JSON.parse(parsed.buffer.toString('utf8')); } catch {}
        }
      }
      if (!meta) meta = await fetchJsonWithFallback(uriList, chain === 'base' ? 13000 : 9000);

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
      if (img) {
        candidates = Array.isArray(img) ? img.flatMap(expandImageCandidates) : expandImageCandidates(img);
      }
      if (!candidates.length && meta && typeof meta === 'object') {
        candidates = collectAllImageCandidates(meta);
      }

      upd();
      return { ...it, image: candidates.length ? candidates : null };
    } catch {
      upd();
      return it;
    }
  });

  return results;
}

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
        const guess = pickReservoirImage(r);
        if (guess) images.set(id, guess);
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

// Optional Moralis fallback (needs MORALIS_API_KEY)
async function backfillImagesFromMoralis({ chain, contract, items }) {
  const key = process.env.MORALIS_API_KEY;
  if (!key) return items;
  const chainName = chain === 'base' ? 'base' : chain === 'eth' ? 'eth' : null;
  if (!chainName) return items;

  const targets = items.filter(i => !i.image);
  if (!targets.length) return items;

  const headers = { 'accept': 'application/json', 'X-API-Key': key, 'User-Agent': UA };
  const out = [...items];

  const BATCH = 25;
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    await Promise.all(chunk.map(async (it) => {
      try {
        const url = new URL(`https://deep-index.moralis.io/api/v2.2/nft/${contract}/${it.tokenId}`);
        url.searchParams.set('chain', chainName);
        url.searchParams.set('format', 'decimal');
        const res = await fetch(url.toString(), { headers });
        if (!res.ok) return;
        const j = await res.json();
        const metaRaw = j?.normalized_metadata || j?.metadata;
        let img = null;
        if (metaRaw) {
          let meta = typeof metaRaw === 'string' ? (() => { try { return JSON.parse(metaRaw); } catch { return null; } })() : metaRaw;
          if (meta) {
            img = meta.image || meta.image_url || meta.imageUrl || meta.animation_url || meta.image_data || null;
            const cands = img ? expandImageCandidates(img) : collectAllImageCandidates(meta);
            if (cands?.length) {
              const idx = out.findIndex(x => x.tokenId === it.tokenId);
              if (idx >= 0) out[idx] = { ...out[idx], image: cands };
            }
          }
        }
        const timg = j?.media?.media_collection?.high?.url || j?.media?.original_media_url || j?.image || null;
        if (!img && timg) {
          const cands = expandImageCandidates(timg);
          const idx = out.findIndex(x => x.tokenId === it.tokenId);
          if (idx >= 0 && cands.length) out[idx] = { ...out[idx], image: cands };
        }
      } catch {}
    }));
  }
  return out;
}

// Optional OpenSea fallback (needs OPENSEA_API_KEY)
async function backfillImagesFromOpenSea({ chain, contract, items }) {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) return items;
  const chainKey = chain === 'base' ? 'base' : chain === 'eth' ? 'ethereum' : null;
  if (!chainKey) return items;

  const headers = { 'accept': 'application/json', 'x-api-key': key, 'User-Agent': UA };
  const targets = items.filter(i => !i.image);
  if (!targets.length) return items;

  const out = [...items];
  const BATCH = 18;
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    await Promise.all(chunk.map(async (it) => {
      try {
        const url = `https://api.opensea.io/api/v2/chain/${chainKey}/contract/${contract}/nfts/${it.tokenId}`;
        const res = await fetch(url, { headers });
        if (!res.ok) return;
        const j = await res.json();
        const nft = j?.nft || {};
        const img = nft?.image_url || nft?.display_image_url || nft?.metadata_url || null;
        if (img) {
          const cands = expandImageCandidates(img);
          if (cands.length) {
            const idx = out.findIndex(x => x.tokenId === it.tokenId);
            if (idx >= 0) out[idx] = { ...out[idx], image: cands };
          }
        }
      } catch {}
    }));
  }
  return out;
}

/* ===================== Robust image loading ===================== */
const IMG_PROXIES = [
  // remove if you don't want a proxy fallback:
  (u) => `https://images.weserv.nl/?url=${encodeURIComponent(u)}&output=png`
];

async function loadImageWithCandidates(candidates, perTryMs = 9000, isBaseChain = false) {
  const timeoutA = isBaseChain ? Math.max(perTryMs, 12000) : perTryMs;
  const timeoutB = isBaseChain ? Math.max(perTryMs, 16000) : Math.max(perTryMs, 11000);

  // 1) Try direct loadImage
  for (const u of candidates) {
    try {
      if (isDataUrl(u)) {
        const parsed = parseDataUrl(u);
        if (parsed && /^image\//i.test(parsed.mime)) {
          const img = await loadImage(parsed.buffer);
          if (img && img.width > 0 && img.height > 0) return img;
        }
      } else {
        const img = await Promise.race([ loadImage(u), new Promise(res => setTimeout(() => res(null), timeoutA)) ]);
        if (img && img.width > 0 && img.height > 0) return img;
      }
    } catch {}
  }

  // 2) Fetch → buffer decode (and rescue HTML via og:image)
  for (const u of candidates) {
    if (isDataUrl(u)) continue;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutB);
      const agent = u.startsWith('http:') ? keepAliveHttp : keepAliveHttps;
      const res = await fetch(u, {
        signal: ctrl.signal,
        agent,
        headers: { 'Accept': 'image/*,text/html;q=0.8', 'User-Agent': UA, 'Connection': 'keep-alive' }
      });
      clearTimeout(t);
      if (!res.ok) continue;

      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (ctype.includes('text/html')) {
        const og = await fetchOgImageFromHtml(u).catch(() => null);
        if (og) {
          const embedded = await loadImageWithCandidates([og], 7000, isBaseChain);
          if (embedded) return embedded;
        }
        continue;
      }

      // If AVIF, immediately try proxy transcode to PNG and load
      if (ctype.includes('image/avif') || u.toLowerCase().split('?')[0].endsWith('.avif')) {
        for (const xform of IMG_PROXIES) {
          const prox = xform(u);
          try {
            const ctrl2 = new AbortController();
            const t2 = setTimeout(() => ctrl2.abort(), isBaseChain ? 16000 : 11000);
            const agent2 = prox.startsWith('http:') ? keepAliveHttp : keepAliveHttps;
            const res2 = await fetch(prox, { signal: ctrl2.signal, agent: agent2, headers: { 'Accept': 'image/*', 'User-Agent': UA, 'Connection': 'keep-alive' } });
            clearTimeout(t2);
            if (!res2.ok) continue;
            const buf2 = Buffer.from(await res2.arrayBuffer());
            if (!looksLikeImage(buf2)) continue;
            const img2 = await loadImage(buf2);
            if (img2 && img2.width > 0 && img2.height > 0) return img2;
          } catch {}
        }
        continue;
      }

      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      if (!looksLikeImage(buf)) continue;
      const img = await loadImage(buf);
      if (img && img.width > 0 && img.height > 0) return img;
    } catch {}
  }

  // 3) Proxy fallback (optional)
  for (const u0 of candidates) {
    if (isDataUrl(u0)) continue;
    for (const xform of IMG_PROXIES) {
      const u = xform(u0);
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), isBaseChain ? 16000 : 11000);
        const agent = u.startsWith('http:') ? keepAliveHttp : keepAliveHttps;
        const res = await fetch(u, { signal: ctrl.signal, agent, headers: { 'Accept': 'image/*', 'User-Agent': UA, 'Connection': 'keep-alive' } });
        clearTimeout(t);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (!looksLikeImage(buf)) continue;
        const img = await loadImage(buf);
        if (img && img.width > 0 && img.height > 0) return img;
      } catch {}
    }
  }
  return null;
}
async function preloadImages(items, onProgress, isBaseChain = false) {
  let done = 0;
  const imgs = await runPool(IMAGE_CONCURRENCY, items, async (it) => {
    const candidates =
      Array.isArray(it.image) ? it.image :
      (typeof it.image === 'string' ? expandImageCandidates(it.image) : []);
    const img = candidates && candidates.length ? await loadImageWithCandidates(candidates, 9000, isBaseChain) : null;
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
      ctx.fillStyle = '#151a23'; ctx.fillRect(x, y, tile, tile);
      ctx.fillStyle = '#e2ebff';
      ctx.font = `bold ${Math.max(18, Math.round(tile * 0.18))}px sans-serif`;
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
    .setDescription('Render a grid of a wallet’s NFTs for a project tracked by this server (fast + robust images)')
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
        .setDescription(`Deprecated (use page_size). Max tiles per image`)
        .setMinValue(1)
        .setMaxValue(MAX_PAGE_SIZE)
        .setRequired(false)
    )
    .addIntegerOption(o =>
      o.setName('page_size')
        .setDescription(`Tiles per page (1-${MAX_PAGE_SIZE})`)
        .setMinValue(1)
        .setMaxValue(MAX_PAGE_SIZE)
        .setRequired(false)
    )
    .addIntegerOption(o =>
      o.setName('page')
        .setDescription('Page number (1 = first page)')
        .setMinValue(1)
        .setMaxValue(999)
        .setRequired(false)
    )
    .addBooleanOption(o =>
      o.setName('all')
        .setDescription('Render multiple pages (capped) in separate messages')
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
    const userLimit = interaction.options.getInteger('limit') || null; // deprecated
    const pageSizeOpt = interaction.options.getInteger('page_size');
    const pageOpt     = interaction.options.getInteger('page');
    const renderAll   = interaction.options.getBoolean('all') || false;

    await interaction.deferReply({ ephemeral: false });

    let finalized = false;
    const safeEdit = async (payload) => { if (finalized) return; try { await interaction.editReply(payload); } catch {} };

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

    const { project, error } = await resolveProjectForGuild(pg, interaction.client, guildId, projectInput);
    if (error) return interaction.editReply(error);

    const chain = (project.chain || 'base').toLowerCase();
    const contract = (project.address || '').toLowerCase();

    // Pagination inputs
    const pageSize = clamp(pageSizeOpt || userLimit || DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const page = clamp(pageOpt || 1, 1, 999);
    const pagesWanted = renderAll ? MAX_PAGES_ALL : 1;
    const endIndex = renderAll ? (pageSize * pagesWanted) : (page * pageSize);

    const std = await detectTokenStandard(chain, contract);

    // Try Reservoir first (fast path) — fetch enough for requested page(s)
    let items = [], totalOwned = 0, usedReservoir = false;
    if (chain === 'eth' || chain === 'base') {
      const resv = await fetchOwnerTokensReservoirAll({ chain, contract, owner, maxWant: endIndex });
      items = resv.items;
      totalOwned = resv.total || items.length;
      usedReservoir = items.length > 0;
    }

    // Enumerable ERC721 (fills more if needed)
    if (std.is721 && items.length < endIndex) {
      status.step = 'Fetching tokens (enumerable)…';
      await pushStatus();
      const en = await fetchOwnerTokensEnumerable({ chain, contract, owner, maxWant: endIndex });
      const byId = new Map(items.map(it => [String(it.tokenId), it]));
      for (const it of en.items) { const k = String(it.tokenId); if (!byId.has(k)) byId.set(k, it); }
      items = Array.from(byId.values()).slice(0, endIndex);
      totalOwned = Math.max(totalOwned, en.total || 0, items.length);
    }

    // On-chain deep scan only if needed (skip on Base if Reservoir gave us results)
    if (items.length < endIndex && !(chain === 'base' && usedReservoir)) {
      let lastPct = -1;
      status.step = std.is1155 ? 'Deep scan (ERC1155)…' : (chain === 'base' ? 'Deep scan (Base-safe)…' : 'Scanning logs…');
      status.scan = '0% [────────────────]';
      await pushStatus();

      const onScanProgress = async (done, total) => {
        const pct = clamp(Math.floor((done/total)*100), 0, 100);
        if (pct !== lastPct) { lastPct = pct; status.scan = `${pct}% [${bar(pct)}]`; await pushStatus(); }
      };

      const onch = std.is1155
        ? await fetchOwnerTokens1155Rolling({ chain, contract, owner, maxWant: endIndex, deep: false, onProgress: onScanProgress })
        : await fetchOwnerTokens721Rolling ({ chain, contract, owner, maxWant: endIndex, deep: false, onProgress: onScanProgress });

      const byId = new Map(items.map(it => [String(it.tokenId), it]));
      for (const it of onch.items) { const key = String(it.tokenId); if (!byId.has(key)) byId.set(key, it); }
      items = Array.from(byId.values()).slice(0, endIndex);
      totalOwned = Math.max(totalOwned, onch.total || 0, items.length);
      status.scan = lastPct >= 0 && lastPct < 100 ? 'done (partial)' : 'done';
      await pushStatus();

      // Deep-escalation if still nothing on Base
      if (chain === 'base' && items.length === 0) {
        status.step = std.is1155 ? 'Deep scan (ERC1155, full)…' : 'Deep scan (full window)…';
        status.scan = '0% [────────────────]';
        await pushStatus();
        let lastPct2 = -1;
        const onScanProgress2 = async (done, total) => {
          const pct = clamp(Math.floor((done/total)*100), 0, 100);
          if (pct !== lastPct2) { lastPct2 = pct; status.scan = `${pct}% [${bar(pct)}]`; await pushStatus(); }
        };
        const onch2 = std.is1155
          ? await fetchOwnerTokens1155Rolling({ chain, contract, owner, maxWant: endIndex, deep: true, onProgress: onScanProgress2 })
          : await fetchOwnerTokens721Rolling ({ chain, contract, owner, maxWant: endIndex, deep: true, onProgress: onScanProgress2 });
        const byId2 = new Map(items.map(it => [String(it.tokenId), it]));
        for (const it of onch2.items) { const k = String(it.tokenId); if (!byId2.has(k)) byId2.set(k, it); }
        items = Array.from(byId2.values()).slice(0, endIndex);
        totalOwned = Math.max(totalOwned, onch2.total || 0, items.length);
        status.scan = lastPct2 >= 0 && lastPct2 < 100 ? 'done (partial)' : 'done';
        await pushStatus();
      }
    }

    // Owner-token list fallbacks if still empty (helps for index gaps)
    if (items.length === 0) {
      status.step = 'Fetching tokens (Moralis)…';
      await pushStatus();
      const m = await fetchOwnerTokensMoralisList({ chain, contract, owner, maxWant: endIndex });
      items = m.items;
      totalOwned = Math.max(totalOwned, m.total || items.length);

      if (items.length === 0) {
        status.step = 'Fetching tokens (OpenSea)…';
        await pushStatus();
        const o = await fetchOwnerTokensOpenSeaList({ chain, contract, owner, maxWant: endIndex });
        items = o.items;
        totalOwned = Math.max(totalOwned, o.total || items.length);
      }
    }

    if (!items.length) {
      return interaction.editReply(`❌ No ${project.name} NFTs found for \`${ownerDisplay}\` on ${chain}.`);
    }

    // Determine which items to render (page or multiple pages)
    const startIndex = renderAll ? 0 : ((page - 1) * pageSize);
    const renderCount = renderAll ? (pageSize * pagesWanted) : pageSize;
    const renderItems = items.slice(startIndex, startIndex + renderCount);
    const totalPages = Math.max(1, Math.ceil((totalOwned || items.length) / pageSize));

    // Prefer fast backfill first (Reservoir CDN)
    if (renderItems.some(i => !i.image) && (chain === 'eth' || chain === 'base')) {
      let lastBF = -1;
      status.step = 'Backfilling images (Reservoir)…';
      status.backfill = '0% [────────────────]';
      await pushStatus();
      const totalMissing = renderItems.filter(i => !i.image).length;
      const backfilled = await backfillImagesFromReservoir({
        chain, contract, items: renderItems,
        onProgress: async (done) => {
          const pct = totalMissing ? clamp(Math.floor((Math.min(done, totalMissing)/totalMissing)*100), 0, 100) : 100;
          if (pct !== lastBF) { lastBF = pct; status.backfill = `${pct}% [${bar(pct)}]`; await pushStatus(); }
        }
      });
      for (let i=0;i<renderItems.length;i++) renderItems[i] = backfilled[i];
      status.backfill = 'done';
      await pushStatus();
    }

    // Enrich missing via tokenURI/uri (skip heavy on Base if we already have a lot)
    const needOnChainMeta = renderItems.some(i => !i.image);
    const shouldEnrichOnChain = needOnChainMeta && !(chain === 'base' && renderItems.filter(i => i.image).length >= Math.min(renderItems.length, 12));
    if (shouldEnrichOnChain) {
      let lastEnPct = -1;
      status.step = 'Enriching images (tokenURI/uri)…';
      status.enrich = '0% [────────────────]';
      await pushStatus();
      const enriched = await enrichImages({
        chain, contract, items: renderItems, is1155: std.is1155,
        onProgress: async (done, total) => {
          const pct = clamp(Math.floor((done/total)*100), 0, 100);
          if (pct !== lastEnPct) { lastEnPct = pct; status.enrich = `${pct}% [${bar(pct)}]`; await pushStatus(); }
        }
      });
      for (let i=0;i<renderItems.length;i++) renderItems[i] = enriched[i];
    }

    // Optional fallbacks
    if (renderItems.some(i => !i.image)) {
      status.step = 'Backfilling images (Moralis)…';
      await pushStatus();
      const m = await backfillImagesFromMoralis({ chain, contract, items: renderItems });
      for (let i=0;i<renderItems.length;i++) renderItems[i] = m[i];
    }
    if (renderItems.some(i => !i.image)) {
      status.step = 'Backfilling images (OpenSea)…';
      await pushStatus();
      const o = await backfillImagesFromOpenSea({ chain, contract, items: renderItems });
      for (let i=0;i<renderItems.length;i++) renderItems[i] = o[i];
    }

    // Reservoir redirect fallback for any still-missing images (ETH/Base)
    if ((chain === 'eth' || chain === 'base') && renderItems.some(i => !i.image)) {
      for (let i=0;i<renderItems.length;i++) {
        const it = renderItems[i];
        if (!it.image) renderItems[i] = { ...it, image: reservoirRedirectCandidates(chain, contract, it.tokenId) };
      }
    }

    // Image preload
    status.step = `Loading images (${renderItems.length})…`;
    let imgPct = 0;
    status.images = `0% [${bar(0)}]`;
    await pushStatus();

    let preloadedImgs = await preloadImages(renderItems, (done, total) => {
      imgPct = clamp(Math.floor((done/total)*100), 0, 100);
      status.images = `${imgPct}% [${bar(imgPct)}]`;
      (async () => { await safeEdit({ content: statusBlock([
        `Wallet: ${status.step}`,
        status.scan && `Scan:     ${status.scan}`,
        status.enrich && `Metadata: ${status.enrich}`,
        status.backfill && `Backfill: ${status.backfill}`,
        `Images:   ${status.images}`
      ].filter(Boolean)) }); })();
    }, chain === 'base');

    // Final rescue attempt per missing
    const missingIdx = [];
    for (let i = 0; i < renderItems.length; i++) if (!preloadedImgs[i]) missingIdx.push(i);
    if (missingIdx.length) {
      await Promise.all(missingIdx.map(async (i) => {
        try {
          const uriList = await resolveMetadataURI({ chain, contract, tokenId: renderItems[i].tokenId, is1155Hint: std.is1155 });
          const meta = uriList ? await fetchJsonWithFallback(uriList, chain === 'base' ? 13000 : 9000) : null;
          const cands = meta ? collectAllImageCandidates(meta) : [];
          if (cands.length) renderItems[i] = { ...renderItems[i], image: cands };
        } catch {}
      }));
      const recovered = await preloadImages(missingIdx.map(i => renderItems[i]), () => {}, chain === 'base');
      for (let k = 0; k < missingIdx.length; k++) {
        preloadedImgs[ missingIdx[k] ] = recovered[k] || preloadedImgs[ missingIdx[k] ];
      }
    }

    // Build pages to send
    const pages = [];
    for (let p = 0; p < (renderAll ? pagesWanted : 1); p++) {
      const slice = renderItems.slice(p * pageSize, (p + 1) * pageSize);
      if (!slice.length) break;
      const imgs = preloadedImgs.slice(p * pageSize, (p + 1) * pageSize);
      pages.push({ slice, imgs });
    }

    // Compose & send
    let first = true;
    const totalForFooter = totalOwned || items.length;
    const startPageNumber = renderAll ? 1 : page;
    for (let pi = 0; pi < pages.length; pi++) {
      const { slice, imgs } = pages[pi];
      const gridBuf = await composeGrid(slice, imgs);
      const file = new AttachmentBuilder(gridBuf, { name: `matrix_${project.name}_${owner.slice(0,6)}_p${startPageNumber + pi}.png` });

      const showingFrom = (renderAll ? (pi * pageSize + 1) : ((page - 1) * pageSize + 1));
      const showingTo   = (renderAll ? Math.min((pi + 1) * pageSize, renderItems.length) : Math.min(page * pageSize, totalForFooter));
      const pageNum = startPageNumber + pi;
      const pageTotal = totalPages;

      const desc = [
        `Owner: \`${ownerDisplay}\`${ownerDisplay.endsWith('.eth') ? `\nResolved: \`${owner}\`` : ''}`,
        `Chain: \`${chain}\``,
        `**Showing ${slice.length} (items ${showingFrom}-${showingTo}) of ${totalForFooter} owned**`,
        `Page ${pageNum}/${pageTotal}`
      ].join('\n');

      const embed = new EmbedBuilder()
        .setTitle(`🧩 ${project.name}`)
        .setDescription(desc)
        .setColor(0x66ccff)
        .setImage(`attachment://${file.name}`)
        .setFooter({ text: `Matrix view • Powered by PimpsDev` })
        .setTimestamp();

      if (first) {
        await interaction.editReply({ content: null, embeds: [embed], files: [file] });
        first = false;
      } else {
        await interaction.followUp({ embeds: [embed], files: [file] });
      }
    }

    finalized = true;
  }
};






