// services/lurker/sources/approvals.js
// ======================================================
// LURKER: Approval-based "Listing Radar" (Railway-safe)
// - Watches ERC721 Approval events (includes tokenId)
// - Optional filter: only approvals to known marketplace operators
// - Returns "listing-like" objects for Lurker pipeline (traits + rarity + alerts)
//
// Why this works:
// - Listings are off-chain; OpenSea orderbook is blocked (522).
// - Approvals are on-chain and reachable via providerM.
//
// ENV (optional):
//   LURKER_APPROVAL_LOOKBACK_BLOCKS=2500          (default 2500)
//   LURKER_APPROVAL_MAX_BLOCKS_PER_TICK=1500      (default 1500) chunk logs
//   LURKER_APPROVAL_RECHECK_BLOCKS=600            (default 600) re-scan window
//   LURKER_APPROVAL_OPERATORS=seaport,opensea     (keywords or 0x... list)
//   LURKER_APPROVAL_ANY=0                         (default 0; if 1, accept any non-zero approved)
//   LURKER_APPROVAL_TIMEOUT_MS=25000              (default 25000)
//   LURKER_DEBUG=1                                (logs urls + some info)
// ======================================================

const { Interface } = require("ethers");
const { safeRpcCall } = require("../../providerM");

function s(v) { return String(v || "").trim(); }
function lower(v) { return s(v).toLowerCase(); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function debugOn() { return String(process.env.LURKER_DEBUG || "0").trim() === "1"; }

const ERC721_ABI = [
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
];
const iface = new Interface(ERC721_ABI);

const TOPIC_APPROVAL = iface.getEvent("Approval").topicHash;
const TOPIC_APPROVAL_FOR_ALL = iface.getEvent("ApprovalForAll").topicHash;

function defaultOperatorMap() {
  // NOTE: marketplace operator addresses change over time; defaults are conservative.
  // You can override with LURKER_APPROVAL_OPERATORS=0x...,0x...
  // Keywords below map to well-known addresses (Seaport is commonly reused across chains).
  return {
    seaport: "0x0000000000000068f116a894984e2db1123eb395", // Seaport 1.5 (commonly used)
    opensea: "0x0000000000000068f116a894984e2db1123eb395", // treat as seaport
    // blur: add later if you confirm operator/spender on your chain
  };
}

function parseOperatorList() {
  const any = String(process.env.LURKER_APPROVAL_ANY || "0").trim() === "1";
  const raw = s(process.env.LURKER_APPROVAL_OPERATORS || "");
  const map = defaultOperatorMap();

  if (!raw) return { any, operators: new Set() }; // empty set => no operator filter unless any=1

  const set = new Set();
  for (const part of raw.split(",").map(x => lower(x)).filter(Boolean)) {
    if (part.startsWith("0x") && part.length >= 42) {
      set.add(part);
      continue;
    }
    if (map[part]) set.add(lower(map[part]));
  }

  return { any, operators: set };
}

function mkTokenUrl(chain, contract, tokenId) {
  const c = lower(chain);
  const addr = lower(contract);
  const tid = s(tokenId);

  // OpenSea token pages (best-effort; harmless if user prefers another marketplace)
  if (c === "base") return `https://opensea.io/assets/base/${addr}/${tid}`;
  if (c === "eth" || c === "ethereum") return `https://opensea.io/assets/ethereum/${addr}/${tid}`;
  if (c === "ape" || c === "apechain") return `https://opensea.io/assets/${addr}/${tid}`; // fallback
  return `https://opensea.io/assets/${addr}/${tid}`;
}

function getState(client) {
  if (!client) return { lastBlocks: new Map() };
  if (!client.__lurkerApprovalState) {
    client.__lurkerApprovalState = { lastBlocks: new Map() };
  }
  return client.__lurkerApprovalState;
}

async function fetchApprovalLogs({ client, chain, contract }) {
  const addr = lower(contract);
  const c = lower(chain);

  const lookback = Math.max(200, num(process.env.LURKER_APPROVAL_LOOKBACK_BLOCKS, 2500));
  const maxSpan = Math.max(200, num(process.env.LURKER_APPROVAL_MAX_BLOCKS_PER_TICK, 1500));
  const recheck = Math.max(0, num(process.env.LURKER_APPROVAL_RECHECK_BLOCKS, 600));

  const st = getState(client);
  const key = `${c}:${addr}`;
  const last = st.lastBlocks.get(key) || 0;

  const blockNow = await safeRpcCall(c, async (provider) => {
    return await provider.getBlockNumber();
  });

  // fromBlock: prefer checkpoint minus recheck, but never older than lookback window
  const minFrom = Math.max(0, blockNow - lookback);
  const fromBlock = Math.max(minFrom, last ? Math.max(0, last - recheck) : minFrom);
  const toBlock = blockNow;

  if (debugOn()) {
    console.log(`[LURKER][approvals] ${c}:${addr.slice(0, 10)}.. blocks ${fromBlock} -> ${toBlock} (last=${last || "none"})`);
  }

  const logs = [];

  // Chunk scanning to avoid huge log calls
  let cur = fromBlock;
  while (cur <= toBlock) {
    const end = Math.min(toBlock, cur + maxSpan);

    const chunk = await safeRpcCall(c, async (provider) => {
      return await provider.getLogs({
        address: addr,
        fromBlock: cur,
        toBlock: end,
        topics: [[TOPIC_APPROVAL, TOPIC_APPROVAL_FOR_ALL]],
      });
    });

    if (Array.isArray(chunk) && chunk.length) logs.push(...chunk);
    cur = end + 1;
  }

  // advance checkpoint
  st.lastBlocks.set(key, toBlock);

  return { logs, blockNow };
}

function decodeLog(log) {
  try {
    const parsed = iface.parseLog(log);
    return { name: parsed?.name, args: parsed?.args || null };
  } catch {
    return null;
  }
}

function shouldAcceptApproval({ approved, operator, cfg }) {
  const approvedL = lower(approved);
  const operatorL = lower(operator);

  // If "any" is enabled, accept any non-zero approved/operator
  if (cfg.any) {
    if (approvedL && approvedL !== "0x0000000000000000000000000000000000000000") return true;
    if (operatorL) return true;
    return false;
  }

  // If operators list is empty and any=0, we accept non-zero approvals (but it can be noisy)
  if (!cfg.operators.size) {
    return approvedL !== "0x0000000000000000000000000000000000000000";
  }

  // Otherwise accept only if spender/operator is in list
  if (approvedL && cfg.operators.has(approvedL)) return true;
  if (operatorL && cfg.operators.has(operatorL)) return true;

  return false;
}

async function fetchListings({ client, chain, contract, limit = 25 }) {
  const c = lower(chain);
  const addr = lower(contract);

  const cfg = parseOperatorList();
  const out = await fetchApprovalLogs({ client, chain: c, contract: addr });
  const logs = Array.isArray(out.logs) ? out.logs : [];

  const listings = [];

  for (const lg of logs) {
    const dec = decodeLog(lg);
    if (!dec || !dec.name) continue;

    if (dec.name === "Approval") {
      const owner = dec.args?.owner;
      const approved = dec.args?.approved;
      const tokenId = dec.args?.tokenId != null ? String(dec.args.tokenId) : null;

      if (!tokenId) continue;
      if (!shouldAcceptApproval({ approved, operator: null, cfg })) continue;

      const listingId = s(lg.transactionHash) ? `${lg.transactionHash}:${lg.logIndex}` : `${addr}:${tokenId}:${lg.blockNumber}:${lg.logIndex}`;

      listings.push({
        source: "approvals",
        chain: c,
        contract: addr,
        listingId,
        tokenId,
        name: null,
        image: null,
        openseaUrl: mkTokenUrl(c, addr, tokenId),
        seller: s(owner) || null, // "who is preparing"
        rarityRank: null,
        rarityScore: null,
        traits: {},
        priceNative: null,
        priceCurrency: null,
        createdAt: null,
        raw: { log: lg, decoded: { type: "Approval", owner, approved, tokenId } },
      });
    }

    // Optional: ApprovalForAll (no tokenId) — we do NOT emit listings since it can't be rarity-filtered
    // but you can enable it later if you want "wallet approved collection" alerts.
  }

  // Sort newest first
  listings.sort((a, b) => {
    const ab = Number(a?.raw?.log?.blockNumber || 0);
    const bb = Number(b?.raw?.log?.blockNumber || 0);
    if (bb !== ab) return bb - ab;
    const ai = Number(a?.raw?.log?.logIndex || 0);
    const bi = Number(b?.raw?.log?.logIndex || 0);
    return bi - ai;
  });

  return { listings: listings.slice(0, Math.max(1, Math.min(50, Number(limit) || 25))) };
}

module.exports = { fetchListings };
