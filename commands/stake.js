// commands/stake.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { Contract, Interface, ethers } = require('ethers');
const fetch = require('node-fetch');
const { getProvider, safeRpcCall } = require('../services/providerM');

/* ===================== Tunables (env overridable) ===================== */
const ENV_MAX_STAKE         = Math.max(1, Math.min(Number(process.env.STAKE_MAX || 300), 1000));
const LOG_WINDOW_BASE       = Math.max(10000, Number(process.env.MATRIX_LOG_WINDOW_BASE || 200000));
const LOG_CONCURRENCY       = Math.max(1, Number(process.env.MATRIX_LOG_CONCURRENCY || 4));
const VERIFY_CONCURRENCY    = Math.max(4, Number(process.env.STAKE_VERIFY_CONCURRENCY || 10));
const RESERVOIR_API_KEY     = process.env.RESERVOIR_API_KEY || null;

/* ===================== UI helpers (Matrix-style status) ===================== */
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function bar(pct, len=16){
  const filled = clamp(Math.round((pct/100)*len), 0, len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}
function statusBlock(lines){
  return '```' + ['Stake Status','─'.repeat(32),...lines].join('\n') + '```';
}
async function runPool(limit, items, worker) {
  const ret = new Array(items.length);
  let i = 0;
  const next = async () => {
    const idx = i++; if (idx >= items.length) return;
    try { ret[idx] = await worker(items[idx], idx); } catch { ret[idx] = null; }
    return next();
  };
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(next));
  return ret;
}
function short(a){ const s=String(a||''); return s?`${s.slice(0,6)}...${s.slice(-4)}`:'N/A'; }
function padTopicAddress(addr) { return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0'); }

/* ===================== Standard / Enumerable detection ===================== */
async function detectTokenStandard(chain, contract) {
  const provider = getProvider(chain);
  if (!provider) return { is721: false, is1155: false };
  const erc165 = new Contract(contract, ['function supportsInterface(bytes4) view returns (bool)'], provider);
  const out = { is721: false, is1155: false };
  try {
    const s721  = await safeRpcCall(chain, p => erc165.connect(p).supportsInterface('0x80ac58cd'));
    const s1155 = await safeRpcCall(chain, p => erc165.connect(p).supportsInterface('0xd9b67a26'));
    out.is721 = !!s721;
    out.is1155 = !!s1155 && !s721;
  } catch {}
  return out;
}
async function detectEnumerable(chain, contract) {
  const provider = getProvider(chain);
  if (!provider) return false;
  const erc165 = new Contract(contract, ['function supportsInterface(bytes4) view returns (bool)'], provider);
  try {
    const ok = await safeRpcCall(chain, p => erc165.connect(p).supportsInterface('0x780e9d63')); // ERC721Enumerable
    return !!ok;
  } catch { return false; }
}

/* ===================== Reservoir (ETH/Base) ===================== */
async function fetchOwnerTokensReservoirAll({ chain, contract, owner, maxWant }) {
  const chainHeader = chain === 'eth' ? 'ethereum' : chain === 'base' ? 'base' : null;
  if (!chainHeader) return { items: [], total: 0 };

  const headers = { 'Content-Type': 'application/json', 'x-reservoir-chain': chainHeader };
  if (RESERVOIR_API_KEY) headers['x-api-key'] = RESERVOIR_API_KEY;

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
        const id = t?.token?.tokenId;
        if (id == null) continue;
        items.push({ tokenId: String(id) });
        if (items.length >= maxWant) break;
      }
      if (!continuation || tokens.length === 0) break;
    } catch { break; }
  }
  if (!total) total = items.length;
  return { items, total };
}

/* ===================== Enumerable fast path ===================== */
async function fetchOwnerTokensEnumerable({ chain, contract, owner, maxWant }) {
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
        ids.push(String(tid));
      } catch { break; }
    }
    return { items: ids.map(id => ({ tokenId: id })), total: bal, enumerable: true };
  } catch {
    return { items: [], total: 0, enumerable: false };
  }
}

/* ===================== Deep scan (logs) with progress ===================== */
async function fetchOwnerTokens721Rolling({ chain, contract, owner, maxWant, deep, onProgress }) {
  const provider = getProvider(chain);
  if (!provider) return { items: [], total: 0 };
  const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
  const head = await safeRpcCall(chain, p => p.getBlockNumber()) || 0;

  const isBase = chain === 'base';
  const WINDOW = isBase ? LOG_WINDOW_BASE : 60000;
  const MAX_WINDOWS = deep ? 500 : (isBase ? 80 : 120);

  const topic0   = ethers.id('Transfer(address,address,uint256)');
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

  for (let i = 0; i < windows.length; i += LOG_CONCURRENCY) {
    const chunk = windows.slice(i, i + LOG_CONCURRENCY);
    await Promise.all(chunk.map(async ({ fromBlock, toBlock }) => {
      let inLogs = [], outLogs = [];
      try {
        inLogs = await safeRpcCall(chain, p => p.getLogs({ address: contract, topics: [topic0, null, topicTo], fromBlock, toBlock }));
      } catch {}
      try {
        outLogs = await safeRpcCall(chain, p => p.getLogs({ address: contract, topics: [topic0, topicFrom, null], fromBlock, toBlock }));
      } catch {}
      for (const log of inLogs || []) { let parsed; try { parsed = iface.parseLog(log); } catch { continue; } owned.add(parsed.args.tokenId.toString()); }
      for (const log of outLogs || []) { let parsed; try { parsed = iface.parseLog(log); } catch { continue; } owned.delete(parsed.args.tokenId.toString()); }
      processed++;
      if (onProgress) {
        const pct = clamp(Math.floor((processed/windows.length)*100), 0, 100);
        await onProgress(pct);
      }
    }));
    if (!deep && owned.size >= maxWant) break;
  }

  const all = Array.from(owned);
  return { items: all.slice(0, maxWant).map(id => ({ tokenId: id })), total: all.length || 0 };
}

/* ===================== Matrix-like ownership orchestrator ===================== */
async function getOwnedTokenIdsMatrixLike({ chain, contract, owner, maxWant, onScanStatus }) {
  const std = await detectTokenStandard(chain, contract);
  if (!std.is721) return { tokenIds: [], total: 0, note: 'Not ERC721' };

  // 1) Reservoir API
  onScanStatus && (await onScanStatus('API', 'fetching…'));
  let items = [], total = 0;
  if (chain === 'eth' || chain === 'base') {
    const r = await fetchOwnerTokensReservoirAll({ chain, contract, owner, maxWant });
    items = r.items;
    total = r.total || items.length;
  }
  onScanStatus && (await onScanStatus('API', `found: ${items.length}`));

  // 2) Enumerable
  if (items.length < maxWant) {
    onScanStatus && (await onScanStatus('Enumerable', 'checking…'));
    const en = await fetchOwnerTokensEnumerable({ chain, contract, owner, maxWant });
    const seen = new Set(items.map(i => i.tokenId));
    for (const it of en.items) if (!seen.has(it.tokenId)) items.push(it);
    total = Math.max(total, en.total || 0, items.length);
    onScanStatus && (await onScanStatus('Enumerable', `found: +${items.length - seen.size}`));
  }

  // 3) Deep log scan
  if (items.length < maxWant) {
    onScanStatus && (await onScanStatus('DeepScan', '0%'));
    const onProgress = async (pct) => onScanStatus && onScanStatus('DeepScan', `${pct}% [${bar(pct)}]`);
    const on = await fetchOwnerTokens721Rolling({
      chain, contract, owner, maxWant, deep: chain === 'base', onProgress
    });
    const seen = new Set(items.map(i => i.tokenId));
    for (const it of on.items) if (!seen.has(it.tokenId)) items.push(it);
    total = Math.max(total, on.total || 0, items.length);
    onScanStatus && (await onScanStatus('DeepScan', 'done'));
  }

  return { tokenIds: items.map(i => i.tokenId), total };
}

/* ===================== On-chain verification (ownerOf) with progress ===================== */
async function verifyCurrentOwnership({ chain, contract, owner, tokenIds, onVerifyStatus }) {
  const provider = getProvider(chain);
  if (!provider) return [];
  const nft = new Contract(contract, ['function ownerOf(uint256) view returns (address)'], provider);

  let done = 0;
  const keep = new Set();

  await runPool(VERIFY_CONCURRENCY, tokenIds, async (id) => {
    try {
      const who = await safeRpcCall(chain, p => nft.connect(p).ownerOf(id), {
        allowRevert: true,
        perCallTimeoutMs: 12000
      });
      if (who && String(who).toLowerCase() === owner.toLowerCase()) keep.add(String(id));
    } catch {}
    done++;
    const pct = clamp(Math.floor((done/tokenIds.length)*100), 0, 100);
    onVerifyStatus && onVerifyStatus(`${pct}% [${bar(pct)}] (${done}/${tokenIds.length})`);
  });

  return tokenIds.filter(id => keep.has(String(id)));
}

/* ===================== Command ===================== */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('stake')
    .setDescription('Verify your NFTs for the server’s staking project (Matrix-grade scan with progress).')
    .addStringOption(o =>
      o.setName('wallet')
        .setDescription('Your wallet address (0x… or ENS .eth)')
        .setRequired(true)
    ),

  async execute(interaction) {
    const walletIn = (interaction.options.getString('wallet') || '').trim();
    const guildId = interaction.guild.id;
    const pg = interaction.client.pg;

    await interaction.deferReply({ ephemeral: true });

    // Safe editor (won’t crash if finalized)
    let finalized = false;
    const safeEdit = async (payload) => { if (finalized) return; try { await interaction.editReply(payload); } catch {} };

    // Live status
    const status = { step: 'Resolving…', api: '', enumerable: '', scan: '', verify: '' };
    const pushStatus = async () => {
      const lines = [
        `Step: ${status.step}`,
        status.api && `API:       ${status.api}`,
        status.enumerable && `Enumerable:${status.enumerable}`,
        status.scan && `DeepScan:  ${status.scan}`,
        status.verify && `Verify:    ${status.verify}`
      ].filter(Boolean);
      await safeEdit({ content: statusBlock(lines) });
    };

    // Load staking project (first for this guild)
    const projRes = await pg.query(`SELECT * FROM staking_projects WHERE guild_id = $1 LIMIT 1`, [guildId]);
    if (projRes.rowCount === 0) {
      finalized = true;
      return interaction.editReply('❌ No staking contract is set for this server. Ask an admin to use `/addstaking`.');
    }
    const project = projRes.rows[0];
    const chain = (project.network || 'base').toLowerCase();
    const contract = String(project.contract_address || '').toLowerCase();

    // Resolve wallet (0x or ENS)
    status.step = 'Resolving wallet…';
    await pushStatus();
    let owner = walletIn;
    try { owner = ethers.getAddress(walletIn); } catch {
      if (walletIn.toLowerCase().endsWith('.eth')) {
        try {
          const resolved = await safeRpcCall('eth', p => p.resolveName(walletIn), { perCallTimeoutMs: 8000 });
          if (!resolved) throw new Error('ens-resolve-failed');
          owner = ethers.getAddress(resolved);
        } catch {
          finalized = true;
          return interaction.editReply('❌ Could not resolve ENS. Please provide a 0x wallet address.');
        }
      } else {
        finalized = true;
        return interaction.editReply('❌ Invalid wallet. Provide a 0x address or ENS (.eth).');
      }
    }

    // Detect standard
    status.step = 'Detecting standard…';
    await pushStatus();
    const std = await detectTokenStandard(chain, contract);
    if (!std.is721) {
      finalized = true;
      return interaction.editReply('❌ This staking flow supports ERC721 only.');
    }

    // Matrix-like discovery with progress
    status.step = 'Discovering ownership…';
    await pushStatus();
    const onScanStatus = async (phase, msg) => {
      if (phase === 'API') status.api = msg;
      else if (phase === 'Enumerable') status.enumerable = msg;
      else if (phase === 'DeepScan') status.scan = msg;
      await pushStatus();
    };

    const { tokenIds, total } = await getOwnedTokenIdsMatrixLike({
      chain, contract, owner, maxWant: ENV_MAX_STAKE, onScanStatus
    });

    if (!tokenIds.length) {
      finalized = true;
      return interaction.editReply(`❌ No NFTs found for \`${short(owner)}\` (checked API, enumerable, and logs).`);
    }

    // On-chain verification (ownerOf) with progress
    status.step = 'Verifying on-chain (ownerOf)…';
    status.verify = '0% [' + bar(0) + ']';
    await pushStatus();
    const verifiedIds = await verifyCurrentOwnership({
      chain, contract, owner, tokenIds,
      onVerifyStatus: async (msg) => { status.verify = msg; await pushStatus(); }
    });

    if (!verifiedIds.length) {
      finalized = true;
      return interaction.editReply(`❌ None of the discovered tokens are currently owned by \`${short(owner)}\` (on-chain check).`);
    }

    // Persist: compact (staked_wallets) + exploded (staked_nfts)
    status.step = 'Saving records…';
    await pushStatus();
    try {
      await pg.query(`
        INSERT INTO staked_wallets (wallet_address, contract_address, network, token_ids, staked_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (wallet_address, contract_address)
        DO UPDATE SET token_ids = EXCLUDED.token_ids, staked_at = NOW()
      `, [owner.toLowerCase(), contract, chain, verifiedIds]);

      await pg.query(`
        DELETE FROM staked_nfts
        WHERE wallet_address = $1 AND contract_address = $2 AND network = $3
      `, [owner.toLowerCase(), contract, chain]);

      const CHUNK = 200;
      for (let i = 0; i < verifiedIds.length; i += CHUNK) {
        const slice = verifiedIds.slice(i, i + CHUNK);
        const values = slice.map((_, k) => `($1,$2,$3,$${4 + k})`).join(',');
        const params = [owner.toLowerCase(), contract, chain, ...slice.map(String)];
        await pg.query(
          `INSERT INTO staked_nfts (wallet_address, contract_address, network, token_id) VALUES ${values}
           ON CONFLICT DO NOTHING`,
          params
        );
      }
    } catch (e) {
      console.error('❌ /stake DB write error:', e);
      finalized = true;
      return interaction.editReply('⚠️ Verified, but failed to save staking records. Please try again.');
    }

    // Final summary
    status.step = 'Done 🎉';
    await pushStatus();
    const embed = new EmbedBuilder()
      .setTitle('✅ Staking Verified')
      .setColor(0x00cc99)
      .setDescription(`Project: **${project.name || 'Unnamed'}**`)
      .addFields(
        { name: 'Wallet', value: `\`${short(owner)}\``, inline: true },
        { name: 'Network', value: `\`${chain}\``, inline: true },
        { name: 'NFTs Found (pre-verify)', value: `${tokenIds.length} (est. total: ${total || tokenIds.length})`, inline: true },
        { name: 'NFTs Verified Now', value: `${verifiedIds.length}`, inline: true },
        { name: 'Contract', value: `\`${contract}\`` }
      )
      .setFooter({ text: 'Ownership confirmed via API, enumerable, logs + on-chain ownerOf.' });

    finalized = true;
    return interaction.editReply({ content: null, embeds: [embed] });
  }
};



