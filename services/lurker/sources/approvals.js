// services/lurker/sources/approvals.js
// ======================================================
// LURKER: Approval-based "Listing Radar" (Railway-safe)
// - Watches ERC721 Approval events (includes tokenId)
// - NEW: Watches ApprovalForAll(owner, operator, true) and then:
//        fetches wallet's tokenIds for that contract via Moralis
//        emits a few tokenIds into Lurker pipeline for rarity/traits filtering
//
// ENV (optional):
//   LURKER_APPROVAL_LOOKBACK_BLOCKS=2500          (default 2500)
//   LURKER_APPROVAL_MAX_BLOCKS_PER_TICK=1500      (default 1500) chunk logs
//   LURKER_APPROVAL_RECHECK_BLOCKS=600            (default 600) re-scan window
//   LURKER_APPROVAL_OPERATORS=seaport,opensea     (keywords or 0x... list)
//   LURKER_APPROVAL_ANY=0                         (default 0; if 1, accept any non-zero approved/operator)
//   LURKER_APPROVAL_INCLUDE_FOR_ALL=1             (default 1)
//   LURKER_APPROVAL_FORALL_MAX_TOKENS=5           (default 5) tokens emitted per ApprovalForAll
//   LURKER_APPROVAL_WALLET_LOOKUPS_PER_TICK=3     (default 3) Moralis wallet calls per tick
//   LURKER_APPROVAL_WALLET_COOLDOWN_MS=600000     (default 10 min) per wallet cooldown for ApprovalForAll
//   LURKER_DEBUG=1
// ======================================================

const { Interface } = require("ethers");
const { safeRpcCall } = require("../../providerM");
const { fetchWalletContractTokenIds } = require("../metadata/moralis");

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
  // You can override with LURKER_APPROVAL_OPERATORS=0x...,0x...
  return {
    seaport: "0x0000000000000068f116a894984e2db1123eb395",
    opensea: "0x0000000000000068f116a894984e2db1123eb395",
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

function includeForAll() {
  return String(process.env.LURKER_APPROVAL_INCLUDE_FOR_ALL || "1").trim() === "1";
}

function mkTokenUrl(chain, contract, tokenId) {
  const c = lower(chain);
  const addr = lower(contract);
  const tid = s(tokenId);

  if (c === "base") return `https://opensea.io/assets/base/${addr}/${tid}`;
  if (c === "eth" || c === "ethereum") return `https://opensea.io/assets/ethereum/${addr}/${tid}`;
  if (c === "ape" || c === "apechain") return `https://opensea.io/assets/${addr}/${tid}`;
  return `https://opensea.io/assets/${addr}/${tid}`;
}

function getState(client) {
  if (!client) return { lastBlocks: new Map(), walletCooldown: new Map() };
  if (!client.__lurkerApprovalState) {
    client.__lurkerApprovalState = {
      lastBlocks: new Map(),          // chain:contract -> last block scanned
      walletCooldown: new Map(),      // chain:contract:wallet -> lastMs
    };
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

  const minFrom = Math.max(0, blockNow - lookback);
  const fromBlock = Math.max(minFrom, last ? Math.max(0, last - recheck) : minFrom);
  const toBlock = blockNow;

  if (debugOn()) {
    console.log(`[LURKER][approvals] ${c}:${addr.slice(0, 10)}.. blocks ${fromBlock} -> ${toBlock} (last=${last || "none"})`);
  }

  const logs = [];

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

  st.lastBlocks.set(key, toBlock);

  return { logs, blockNow, fromBlock, toBlock };
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

  if (cfg.any) {
    if (approvedL && approvedL !== "0x0000000000000000000000000000000000000000") return true;
    if (operatorL && operatorL !== "0x0000000000000000000000000000000000000000") return true;
    return false;
  }

  if (!cfg.operators.size) {
    // no explicit operators configured -> accept non-zero spender/operator
    if (approvedL && approvedL !== "0x0000000000000000000000000000000000000000") return true;
    if (operatorL && operatorL !== "0x0000000000000000000000000000000000000000") return true;
    return false;
  }

  if (approvedL && cfg.operators.has(approvedL)) return true;
  if (operatorL && cfg.operators.has(operatorL)) return true;

  return false;
}

async function pickRarestTokenIdsIfPossible(client, chain, contract, tokenIds, maxN) {
  // If rarity DB has ranks, pick smallest rank; otherwise fallback to first N tokenIds.
  const pg = client?.pg;
  if (!pg?.query) return tokenIds.slice(0, maxN);

  // tokenIds are strings; DB stores token_id as TEXT.
  const ids = tokenIds.slice(0, 200); // safety cap
  if (!ids.length) return [];

  try {
    const r = await pg.query(
      `
      SELECT token_id, rank
      FROM lurker_rarity_tokens
      WHERE chain=$1 AND contract=$2 AND token_id = ANY($3)
      `,
      [lower(chain), lower(contract), ids]
    );

    const rows = r.rows || [];
    const rankMap = new Map();
    for (const row of rows) {
      const tid = s(row.token_id);
      const rk = row.rank != null ? Number(row.rank) : null;
      if (tid && Number.isFinite(rk)) rankMap.set(tid, rk);
    }

    // Sort: ranked first by rank asc, then unranked
    const sorted = [...ids].sort((a, b) => {
      const ra = rankMap.has(a) ? rankMap.get(a) : 1e18;
      const rb = rankMap.has(b) ? rankMap.get(b) : 1e18;
      if (ra !== rb) return ra - rb;
      // numeric-ish fallback
      const na = Number(a), nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });

    return sorted.slice(0, maxN);
  } catch {
    return tokenIds.slice(0, maxN);
  }
}

async function emitFromApprovalForAll({ client, chain, contract, owner, operator, log, cfg }) {
  if (!includeForAll()) return [];

  const st = getState(client);
  const cooldownMs = Math.max(30000, num(process.env.LURKER_APPROVAL_WALLET_COOLDOWN_MS, 600000));
  const key = `${lower(chain)}:${lower(contract)}:${lower(owner)}`;
  const now = Date.now();
  const lastMs = st.walletCooldown.get(key) || 0;

  if (now - lastMs < cooldownMs) {
    if (debugOn()) {
      const left = Math.ceil((cooldownMs - (now - lastMs)) / 1000);
      console.log(`[LURKER][approvals] ApprovalForAll cooldown owner=${lower(owner).slice(0, 10)}.. (${left}s left)`);
    }
    return [];
  }

  st.walletCooldown.set(key, now);

  const maxTokens = Math.max(1, Math.min(15, num(process.env.LURKER_APPROVAL_FORALL_MAX_TOKENS, 5)));

  // Moralis budget per tick is managed in fetchListings (walletLookupsThisTick)
  const tokenIds = await fetchWalletContractTokenIds({
    chain,
    wallet: owner,
    contract,
  });

  if (!tokenIds.length) return [];

  const chosen = await pickRarestTokenIdsIfPossible(client, chain, contract, tokenIds, maxTokens);

  // Emit “pseudo listings” for each chosen tokenId
  const out = [];
  for (const tid of chosen) {
    const listingId = s(log?.transactionHash)
      ? `${log.transactionHash}:${log.logIndex}:forall:${tid}`
      : `${lower(contract)}:${tid}:${log?.blockNumber || 0}:${log?.logIndex || 0}:forall`;

    out.push({
      source: "approvals_forall",
      chain: lower(chain),
      contract: lower(contract),
      listingId,
      tokenId: s(tid),
      name: null,
      image: null,
      openseaUrl: mkTokenUrl(chain, contract, tid),
      seller: s(owner) || null,
      rarityRank: null,
      rarityScore: null,
      traits: {},
      priceNative: null,
      priceCurrency: null,
      createdAt: null,
      raw: {
        log,
        decoded: { type: "ApprovalForAll", owner, operator, approved: true, chosenCount: chosen.length }
      },
    });
  }

  return out;
}

async function fetchListings({ client, chain, contract, limit = 25 }) {
  const c = lower(chain);
  const addr = lower(contract);
  const cfg = parseOperatorList();

  const out = await fetchApprovalLogs({ client, chain: c, contract: addr });
  const logs = Array.isArray(out.logs) ? out.logs : [];

  let approvalsDecoded = 0;
  let forAllDecoded = 0;

  // Wallet lookups budget per tick
  let walletLookupsThisTick = 0;
  const maxWalletLookups = Math.max(0, Math.min(10, num(process.env.LURKER_APPROVAL_WALLET_LOOKUPS_PER_TICK, 3)));

  const listings = [];

  for (const lg of logs) {
    const dec = decodeLog(lg);
    if (!dec || !dec.name) continue;

    if (dec.name === "Approval") {
      approvalsDecoded += 1;

      const owner = dec.args?.owner;
      const approved = dec.args?.approved;
      const tokenId = dec.args?.tokenId != null ? String(dec.args.tokenId) : null;

      if (!tokenId) continue;
      if (!shouldAcceptApproval({ approved, operator: null, cfg })) continue;

      const listingId = s(lg.transactionHash)
        ? `${lg.transactionHash}:${lg.logIndex}`
        : `${addr}:${tokenId}:${lg.blockNumber}:${lg.logIndex}`;

      listings.push({
        source: "approvals",
        chain: c,
        contract: addr,
        listingId,
        tokenId,
        name: null,
        image: null,
        openseaUrl: mkTokenUrl(c, addr, tokenId),
        seller: s(owner) || null,
        rarityRank: null,
        rarityScore: null,
        traits: {},
        priceNative: null,
        priceCurrency: null,
        createdAt: null,
        raw: { log: lg, decoded: { type: "Approval", owner, approved, tokenId } },
      });
    }

    if (dec.name === "ApprovalForAll") {
      forAllDecoded += 1;

      const owner = dec.args?.owner;
      const operator = dec.args?.operator;
      const approvedBool = Boolean(dec.args?.approved);

      if (!approvedBool) continue;
      if (!shouldAcceptApproval({ approved: null, operator, cfg })) continue;

      if (!includeForAll()) continue;
      if (walletLookupsThisTick >= maxWalletLookups) continue;

      try {
        walletLookupsThisTick += 1;
        const derived = await emitFromApprovalForAll({
          client,
          chain: c,
          contract: addr,
          owner: s(owner),
          operator: s(operator),
          log: lg,
          cfg,
        });
        if (derived.length) listings.push(...derived);
      } catch (e) {
        if (debugOn()) console.log(`[LURKER][approvals] ApprovalForAll wallet fetch failed: ${e?.message || e}`);
      }
    }
  }

  // Sort newest first by block/logIndex
  listings.sort((a, b) => {
    const ab = Number(a?.raw?.log?.blockNumber || 0);
    const bb = Number(b?.raw?.log?.blockNumber || 0);
    if (bb !== ab) return bb - ab;
    const ai = Number(a?.raw?.log?.logIndex || 0);
    const bi = Number(b?.raw?.log?.logIndex || 0);
    return bi - ai;
  });

  if (debugOn()) {
    console.log(`[LURKER][approvals] logs=${logs.length} decoded(Approval=${approvalsDecoded}, ForAll=${forAllDecoded}) emitted=${listings.length} walletLookups=${walletLookupsThisTick}/${maxWalletLookups}`);
  }

  return { listings: listings.slice(0, Math.max(1, Math.min(50, Number(limit) || 25))) };
}

module.exports = { fetchListings };

