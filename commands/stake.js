// commands/stake.js
const { SlashCommandBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { Contract, Interface, ethers } = require('ethers');
const { getProvider, safeRpcCall } = require('../services/providerM');

const ERC721_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
];
const IFACE_ERC165_ENUM = '0x780e9d63'; // ERC721Enumerable

const DEFAULT_MAX_SCAN = Math.max(1000, Number(process.env.STAKE_MAX_SCAN || 1000));
const OWNEROF_CONCURRENCY = Math.max(4, Number(process.env.STAKE_OWNEROF_CONCURRENCY || 12));

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function bar(pct, len = 18) {
  const filled = clamp(Math.round((pct / 100) * len), 0, len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
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

function normalizeAddr(a) {
  try { return ethers.getAddress(a); } catch { return null; }
}

async function supportsEnumerable(network, contract) {
  const provider = getProvider(network);
  if (!provider) return false;
  const c = new Contract(contract, ERC721_ABI, provider);
  try {
    const ok = await safeRpcCall(network, (p) => c.connect(p).supportsInterface(IFACE_ERC165_ENUM));
    return !!ok;
  } catch { return false; }
}

async function enumerableTokensOfOwner(network, contract, owner, maxWant = 10000) {
  const provider = getProvider(network);
  const c = new Contract(contract, ERC721_ABI, provider);
  try {
    const balRaw = await safeRpcCall(network, (p) => c.connect(p).balanceOf(owner));
    const bal = Number(balRaw?.toString?.() ?? balRaw ?? 0);
    if (!Number.isFinite(bal) || bal <= 0) return [];
    const want = Math.min(bal, maxWant);
    const ids = [];
    for (let i = 0; i < want; i++) {
      try {
        const id = await safeRpcCall(network, (p) => c.connect(p).tokenOfOwnerByIndex(owner, i));
        ids.push(id.toString());
      } catch { break; }
    }
    return ids;
  } catch { return []; }
}

async function fetchOwnerTokensReservoir({ chain, contract, owner, maxWant = 5000 }) {
  const chainHeader = chain === 'base' ? 'base' : (chain === 'eth' || chain === 'ethereum') ? 'ethereum' : null;
  if (!chainHeader) return [];
  const headers = { 'Content-Type': 'application/json', 'x-reservoir-chain': chainHeader };
  if (process.env.RESERVOIR_API_KEY) headers['x-api-key'] = process.env.RESERVOIR_API_KEY;

  const ids = [];
  let continuation = null;
  let safety = 40; // 40 * 50 = 2k tokens; adjust if needed
  while (safety-- > 0 && ids.length < maxWant) {
    const limit = Math.min(50, maxWant - ids.length);
    const url = new URL(`https://api.reservoir.tools/users/${owner}/tokens/v10`);
    url.searchParams.set('collection', contract);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('includeTopBid', 'false');
    url.searchParams.set('sortBy', 'acquiredAt');
    if (continuation) url.searchParams.set('continuation', continuation);

    try {
      const r = await fetch(url.toString(), { headers });
      if (!r.ok) break;
      const j = await r.json();
      const arr = j?.tokens || [];
      continuation = j?.continuation || null;
      for (const t of arr) {
        if (t?.token?.tokenId) ids.push(String(t.token.tokenId));
        if (ids.length >= maxWant) break;
      }
      if (!continuation || arr.length === 0) break;
    } catch { break; }
  }
  return Array.from(new Set(ids));
}

async function bruteScanOwnerOf({ network, contract, owner, maxScan, progressCb }) {
  const ids = [];
  const provider = getProvider(network);
  const c = new Contract(contract, ERC721_ABI, provider);

  const range = Array.from({ length: maxScan }, (_, i) => i);
  let done = 0;
  await runPool(OWNEROF_CONCURRENCY, range, async (id) => {
    try {
      const who = await safeRpcCall(network, (p) => c.connect(p).ownerOf(id));
      if (who && String(who).toLowerCase() === owner.toLowerCase()) ids.push(String(id));
    } catch { /* non-existent or revert */ }
    done++;
    if (progressCb && (done % 25 === 0 || done === maxScan)) {
      const pct = Math.floor((done / maxScan) * 100);
      progressCb(pct);
    }
  });

  return ids.sort((a, b) => {
    const ai = BigInt(a), bi = BigInt(b);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

async function saveStake(pg, { wallet, contract, network, tokenIds }) {
  // Normalize rows in staked_nfts (one row per token), and keep staked_wallets in sync.
  const client = pg;
  const w = wallet.toLowerCase();
  const c = contract.toLowerCase();
  const n = network.toLowerCase();

  // Start a light transaction
  await client.query('BEGIN');
  try {
    // Delete rows no longer owned
    await client.query(
      `DELETE FROM staked_nfts
       WHERE wallet_address = $1 AND contract_address = $2 AND network = $3
         AND token_id <> ALL ($4)`,
      [w, c, n, tokenIds.length ? tokenIds : ['-1']]
    );

    // Upsert current set
    for (const tid of tokenIds) {
      await client.query(
        `INSERT INTO staked_nfts (wallet_address, contract_address, network, token_id, staked_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (wallet_address, contract_address, network, token_id)
         DO UPDATE SET staked_at = EXCLUDED.staked_at`,
        [w, c, n, tid]
      );
    }

    // Keep aggregated table (if you use it)
    await client.query(
      `INSERT INTO staked_wallets (wallet_address, contract_address, network, token_ids, staked_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (wallet_address, contract_address, network)
       DO UPDATE SET token_ids = EXCLUDED.token_ids, staked_at = EXCLUDED.staked_at`,
      [w, c, n, tokenIds]
    );

    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ saveStake failed:', e.message);
    return false;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stake')
    .setDescription('Find and record your NFTs from this server’s staking contract')
    .addStringOption(option =>
      option.setName('wallet')
        .setDescription('Your wallet address (0x...)')
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('max')
        .setDescription(`Max token IDs to brute-scan if needed (default ${DEFAULT_MAX_SCAN})`)
        .setMinValue(50)
        .setMaxValue(20000)
        .setRequired(false)
    ),

  async execute(interaction) {
    const rawWallet = interaction.options.getString('wallet') || '';
    const maxOpt = interaction.options.getInteger('max');
    const maxScan = Number.isInteger(maxOpt) ? maxOpt : DEFAULT_MAX_SCAN;
    const pg = interaction.client.pg;

    await interaction.deferReply({ ephemeral: true });

    const wallet = normalizeAddr(rawWallet);
    if (!wallet) {
      return interaction.editReply('❌ Invalid wallet address. Please provide a valid 0x address.');
    }

    // Load staking project for this guild
    const guildId = interaction.guild.id;
    const proj = await pg.query(`SELECT * FROM staking_projects WHERE guild_id = $1 LIMIT 1`, [guildId]);
    if (proj.rowCount === 0) {
      return interaction.editReply('❌ No staking contract is set for this server. Ask an admin to use `/addstaking`.');
    }

    const project = proj.rows[0];
    const contract = (project.contract_address || '').toLowerCase();
    const network = (project.network || 'base').toLowerCase();

    const provider = getProvider(network);
    if (!provider) {
      return interaction.editReply(`❌ No RPC provider configured for network \`${network}\`.`);
    }

    const nft = new Contract(contract, ERC721_ABI, provider);

    // Progress helper
    const setStatus = async (lines) => {
      await interaction.editReply('```' + ['Staking Scan', '────────────────────', ...lines].join('\n') + '```');
    };

    await setStatus([`Wallet: ${wallet}`, `Contract: ${contract} (${network})`, `Status: starting…`]);

    let foundIds = [];
    let method = 'unknown';

    // 1) Fast path: Reservoir
    if (network === 'base' || network === 'eth' || network === 'ethereum') {
      await setStatus([`Wallet: ${wallet}`, `Contract: ${contract} (${network})`, `Status: querying Reservoir…`]);
      try {
        const ids = await fetchOwnerTokensReservoir({ chain: network, contract, owner: wallet, maxWant: 5000 });
        if (ids.length) {
          foundIds = ids;
          method = 'reservoir';
        }
      } catch (e) {
        // ignore
      }
    }

    // 2) ERC721Enumerable fallback
    if (!foundIds.length) {
      await setStatus([`Wallet: ${wallet}`, `Contract: ${contract} (${network})`, `Status: checking enumerable…`]);
      try {
        const isEnum = await supportsEnumerable(network, contract);
        if (isEnum) {
          const ids = await enumerableTokensOfOwner(network, contract, wallet, 10000);
          if (ids.length) {
            foundIds = ids;
            method = 'enumerable';
          }
        }
      } catch {}
    }

    // 3) Brute ownerOf scan
    if (!foundIds.length) {
      let lastPct = -1;
      await setStatus([
        `Wallet: ${wallet}`,
        `Contract: ${contract} (${network})`,
        `Status: brute scanning 0..${maxScan - 1}`,
        `Progress: 0% [${bar(0)}]`
      ]);
      foundIds = await bruteScanOwnerOf({
        network, contract, owner: wallet.toLowerCase(), maxScan,
        progressCb: async (pct) => {
          if (pct === lastPct) return;
          lastPct = pct;
          await setStatus([
            `Wallet: ${wallet}`,
            `Contract: ${contract} (${network})`,
            `Status: brute scanning 0..${maxScan - 1}`,
            `Progress: ${pct}% [${bar(pct)}]`
          ]);
        }
      });
      method = 'ownerOf-scan';
    }

    if (!foundIds.length) {
      return interaction.editReply(`❌ No NFTs found for \`${wallet.slice(0,6)}...${wallet.slice(-4)}\` in this collection.`);
    }

    // Save results
    const ok = await saveStake(pg, {
      wallet: wallet.toLowerCase(),
      contract,
      network,
      tokenIds: foundIds
    });
    if (!ok) {
      return interaction.editReply('⚠️ Scan succeeded, but saving results failed (see logs).');
    }

    await interaction.editReply(
      `✅ Found **${foundIds.length}** NFT(s) for \`${wallet.slice(0,6)}...${wallet.slice(-4)}\` ` +
      `in this collection (method: ${method}).`
    );
  }
};


