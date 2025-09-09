// commands/stake.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { Contract, Interface, ethers } = require('ethers');
const fetch = require('node-fetch');
const { getProvider, safeRpcCall } = require('../services/providerM');

/* ===================== Tunables ===================== */
const ENV_MAX_STAKE = Math.max(1, Math.min(Number(process.env.STAKE_MAX || 300), 1000)); // hard cap for safety
const LOG_WINDOW_BASE = Math.max(10000, Number(process.env.MATRIX_LOG_WINDOW_BASE || 200000));
const LOG_CONCURRENCY = Math.max(1, Number(process.env.MATRIX_LOG_CONCURRENCY || 4));
const VERIFY_CONCURRENCY = Math.max(4, Number(process.env.STAKE_VERIFY_CONCURRENCY || 8));
const VERIFY_LIMIT = Math.max(50, Number(process.env.STAKE_VERIFY_LIMIT || 400)); // cap ownerOf verifications

/* ===================== Small utils ===================== */
function padTopicAddress(addr) { return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0'); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
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

/* ===================== Standard detection ===================== */
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
    const ok = await safeRpcCall(chain, p => erc165.connect(p).supportsInterface('0x780e9d63'));
    return !!ok;
  } catch { return false; }
}

/* ===================== Reservoir (ETH/Base) ===================== */
async function fetchOwnerTokensReservoirAll({ chain, contract, owner, maxWant }) {
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
        items.push({ tokenId: String(t.token.tokenId) });
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

/* ===================== On-chain deep scan (logs) ===================== */
async function fetchOwnerTokens721Rolling({ chain, contract, owner, maxWant, deep = false }) {
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
    }));
    if (!deep && owned.size >= maxWant) break;
  }

  const all = Array.from(owned);
  return { items: all.slice(0, maxWant).map(id => ({ tokenId: id })), total: all.length || 0 };
}

/* ===================== Ownership (Matrix-grade) ===================== */
async function getOwnedTokenIdsMatrixLike({ chain, contract, owner, maxWant = ENV_MAX_STAKE }) {
  const std = await detectTokenStandard(chain, contract);
  if (!std.is721) {
    // staking system is 721-only (your payout uses ownerOf)
    return { tokenIds: [], total: 0, note: 'Not ERC721' };
  }

  // 1) Reservoir (ETH/Base)
  let items = [], total = 0;
  if (chain === 'eth' || chain === 'base') {
    const r = await fetchOwnerTokensReservoirAll({ chain, contract, owner, maxWant });
    items = r.items;
    total = r.total || items.length;
  }

  // 2) ERC721Enumerable
  if (items.length < maxWant) {
    const en = await fetchOwnerTokensEnumerable({ chain, contract, owner, maxWant });
    const byId = new Set(items.map(t => String(t.tokenId)));
    for (const it of en.items) { const k = String(it.tokenId); if (!byId.has(k)) items.push({ tokenId: k }); }
    total = Math.max(total, en.total || 0, items.length);
  }

  // 3) On-chain deep log scan (Base uses wider windows)
  if (items.length < maxWant) {
    const on = await fetchOwnerTokens721Rolling({ chain, contract, owner, maxWant, deep: chain === 'base' });
    const byId = new Set(items.map(t => String(t.tokenId)));
    for (const it of on.items) { const k = String(it.tokenId); if (!byId.has(k)) items.push({ tokenId: k }); }
    total = Math.max(total, on.total || 0, items.length);
  }

  const tokenIds = items.map(t => String(t.tokenId));
  return { tokenIds, total };
}

/* ===================== ownerOf verification pass ===================== */
async function verifyCurrentOwnership({ chain, contract, owner, tokenIds }) {
  const provider = getProvider(chain);
  if (!provider) return tokenIds;
  const nft = new Contract(contract, ['function ownerOf(uint256) view returns (address)'], provider);

  const toVerify = tokenIds.slice(0, VERIFY_LIMIT);
  const kept = new Set();

  await runPool(VERIFY_CONCURRENCY, toVerify, async (id) => {
    try {
      const who = await safeRpcCall(chain, p => nft.connect(p).ownerOf(id), {
        allowRevert: true,
        perCallTimeoutMs: 12000
      });
      if (who && String(who).toLowerCase() === owner.toLowerCase()) kept.add(String(id));
    } catch {}
  });

  // Keep verified + any beyond VERIFY_LIMIT (best-effort; optional strictness)
  const final = tokenIds.filter(id => kept.has(String(id)) || tokenIds.indexOf(id) >= VERIFY_LIMIT);
  return final;
}

/* ===================== Command ===================== */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('stake')
    .setDescription('Verify your NFTs for the server’s staking project and record them for rewards.')
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

    // Load staking project (one per server)
    const projRes = await pg.query(`SELECT * FROM staking_projects WHERE guild_id = $1 LIMIT 1`, [guildId]);
    if (projRes.rowCount === 0) {
      return interaction.editReply('❌ No staking contract is set for this server. Ask an admin to use `/addstaking`.');
    }
    const project = projRes.rows[0];
    const chain = (project.network || 'base').toLowerCase();
    const contract = String(project.contract_address || '').toLowerCase();

    // Normalize wallet (supports ENS if you have ETH provider; otherwise require 0x)
    let owner = walletIn;
    try { owner = ethers.getAddress(walletIn); } catch {
      // Try ENS via ETH provider if .eth
      if (walletIn.toLowerCase().endsWith('.eth')) {
        try {
          const ethProv = getProvider('eth');
          if (!ethProv) throw new Error('no eth provider');
          const resolved = await safeRpcCall('eth', p => p.resolveName(walletIn), { perCallTimeoutMs: 8000 });
          if (!resolved) throw new Error('ens-resolve-failed');
          owner = ethers.getAddress(resolved);
        } catch {
          return interaction.editReply('❌ Could not resolve ENS. Please provide a 0x wallet address.');
        }
      } else {
        return interaction.editReply('❌ Invalid wallet. Provide a 0x address or ENS (.eth).');
      }
    }

    // Ownership discovery (Matrix-grade)
    await interaction.editReply(`🔎 Verifying ownership for **${short(owner)}** on \`${chain}\`…`);
    const { tokenIds, total } = await getOwnedTokenIdsMatrixLike({
      chain, contract, owner, maxWant: ENV_MAX_STAKE
    });

    if (!tokenIds.length) {
      return interaction.editReply(`❌ No NFTs from this contract found for \`${short(owner)}\` (checked API, enumerable, and logs).`);
    }

    // On-chain verification pass (ownerOf) for current ownership
    await interaction.editReply(`🧪 Verifying current ownership on-chain (${Math.min(tokenIds.length, VERIFY_LIMIT)} checks)…`);
    const verifiedIds = await verifyCurrentOwnership({ chain, contract, owner, tokenIds });

    if (!verifiedIds.length) {
      return interaction.editReply(`❌ None of the discovered tokens are currently owned by \`${short(owner)}\` (on-chain check).`);
    }

    // Persist: compact (staked_wallets) + exploded (staked_nfts)
    try {
      // Compact upsert
      await pg.query(`
        INSERT INTO staked_wallets (wallet_address, contract_address, network, token_ids, staked_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (wallet_address, contract_address)
        DO UPDATE SET token_ids = EXCLUDED.token_ids, staked_at = NOW()
      `, [owner.toLowerCase(), contract, chain, verifiedIds]);

      // Exploded table refresh (used by your payout job)
      await pg.query(`
        DELETE FROM staked_nfts
        WHERE wallet_address = $1 AND contract_address = $2 AND network = $3
      `, [owner.toLowerCase(), contract, chain]);

      // Insert in chunks
      const chunk = 200;
      for (let i = 0; i < verifiedIds.length; i += chunk) {
        const slice = verifiedIds.slice(i, i + chunk);
        const values = slice.map((id, k) =>
          `($1,$2,$3,$${4 + k})`
        ).join(',');
        const params = [owner.toLowerCase(), contract, chain, ...slice.map(String)];
        await pg.query(
          `INSERT INTO staked_nfts (wallet_address, contract_address, network, token_id) VALUES ${values}
           ON CONFLICT DO NOTHING`,
          params
        );
      }
    } catch (e) {
      console.error('❌ /stake DB write error:', e);
      return interaction.editReply('⚠️ Verified, but failed to save staking records. Please try again.');
    }

    // Response
    const embed = new EmbedBuilder()
      .setTitle('✅ Staking Verified')
      .setColor(0x00cc99)
      .setDescription(`Project: **${project.name || 'Unnamed'}**`)
      .addFields(
        { name: 'Wallet', value: `\`${short(owner)}\``, inline: true },
        { name: 'Network', value: `\`${chain}\``, inline: true },
        { name: 'NFTs Found', value: `${tokenIds.length} (est. total: ${total || tokenIds.length})`, inline: true },
        { name: 'NFTs Verified Now', value: `${verifiedIds.length}`, inline: true },
        { name: 'Contract', value: `\`${contract}\`` }
      )
      .setFooter({ text: 'Ownership confirmed via API, enumerable, logs + on-chain ownerOf.' });

    return interaction.editReply({ embeds: [embed] });
  }
};



