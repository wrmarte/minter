// commands/seereward.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { Contract, ethers } = require('ethers');
const { getProvider } = require('../services/providerM');

const MAX_DAILY_REWARD = Number.parseFloat(process.env.MAX_DAILY_REWARD || '500');

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

function shortAddr(a, n = 4) {
  if (!a) return 'N/A';
  const s = String(a);
  return s.length > 2 + n * 2 ? `${s.slice(0, 6)}...${s.slice(-n)}` : s;
}
function normalizeAddr(a) {
  try { return ethers.getAddress(a); } catch { return null; }
}
function fmtNum(n, dp = 6) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  return x.toFixed(dp).replace(/(?:\.0+|(\.\d*?)0+)$/, '$1'); // trim trailing zeros
}

async function getTokenMeta({ network, tokenContract }) {
  try {
    const provider = getProvider(network);
    if (!provider || !tokenContract) return { symbol: 'TOKEN', decimals: 18 };
    const erc20 = new Contract(tokenContract, ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([
      erc20.symbol().catch(() => 'TOKEN'),
      erc20.decimals().then(Number).catch(() => 18),
    ]);
    return { symbol, decimals: Number.isFinite(decimals) ? decimals : 18 };
  } catch {
    return { symbol: 'TOKEN', decimals: 18 };
  }
}

async function getScopedRewardLog(pg, { wallet, contract, network }) {
  // Prefer fully scoped; fallback to legacy wallet-only if needed
  try {
    const r = await pg.query(
      `SELECT total_rewards, last_claimed
         FROM reward_log
        WHERE wallet_address = $1 AND contract_address = $2 AND network = $3
        ORDER BY last_claimed DESC NULLS LAST
        LIMIT 1`,
      [wallet, contract, network]
    );
    if (r.rowCount) return r.rows[0];
  } catch {}
  try {
    const r2 = await pg.query(
      `SELECT total_rewards, last_claimed
         FROM reward_log
        WHERE wallet_address = $1
        ORDER BY last_claimed DESC NULLS LAST
        LIMIT 1`,
      [wallet]
    );
    if (r2.rowCount) return r2.rows[0];
  } catch {}
  return { total_rewards: 0, last_claimed: null };
}

function estimatePending({ perNftDaily, nftCount, lastClaimed }) {
  if (!Number.isFinite(perNftDaily) || perNftDaily <= 0 || nftCount <= 0) return 0;
  if (!lastClaimed) return 0; // matches payout (no retro if never claimed)
  const now = Date.now();
  const lastMs = new Date(lastClaimed).getTime();
  if (!Number.isFinite(lastMs) || lastMs >= now) return 0;
  const daysElapsed = (now - lastMs) / (1000 * 60 * 60 * 24);
  if (daysElapsed <= 0) return 0;
  const raw = perNftDaily * nftCount * daysElapsed;
  return Math.min(raw, MAX_DAILY_REWARD); // same cap used in payout
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('seereward')
    .setDescription('View your staking rewards and current staked NFTs.')
    .addStringOption(option =>
      option.setName('wallet')
        .setDescription('Your wallet address (0x...)')
        .setRequired(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const guildId = interaction.guild.id;

    const rawWallet = interaction.options.getString('wallet') || '';
    const wallet = normalizeAddr(rawWallet);
    if (!wallet) {
      return interaction.reply({ ephemeral: true, content: '❌ Invalid wallet address. Please provide a valid 0x address.' });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Fetch all staking projects for this server (support multiple)
      const projRes = await pg.query(
        `SELECT name, contract_address, network
           FROM staking_projects
          WHERE guild_id = $1`,
        [guildId]
      );
      if (projRes.rowCount === 0) {
        return interaction.editReply('❌ This server has no staking project configured.');
      }

      // Build per-project summaries
      const summaries = [];
      let totalEarnedAll = 0;
      let totalStakedAll = 0;

      for (const proj of projRes.rows) {
        const name = proj.name || 'Unnamed Project';
        const contract = String(proj.contract_address || '').toLowerCase();
        const network = (proj.network || 'base').toLowerCase();

        // Current staked tokens for this (wallet, contract, network)
        const stRes = await pg.query(
          `SELECT token_id
             FROM staked_nfts
            WHERE wallet_address = $1 AND contract_address = $2 AND network = $3
            ORDER BY token_id::numeric ASC NULLS LAST`,
          [wallet.toLowerCase(), contract, network]
        );
        const tokenIds = stRes.rows.map(r => String(r.token_id));
        const nftCount = tokenIds.length;

        // Staking config
        const cfgRes = await pg.query(
          `SELECT daily_reward, token_contract
             FROM staking_config
            WHERE contract_address = $1
            LIMIT 1`,
          [contract]
        );
        const cfg = cfgRes.rows[0] || {};
        const perNftDaily = Number.parseFloat(cfg.daily_reward || '0') || 0;
        const tokenContract = (cfg.token_contract || '').toLowerCase();

        // Rewards (scoped, with legacy fallback)
        const log = await getScopedRewardLog(pg, {
          wallet: wallet.toLowerCase(),
          contract,
          network
        });
        const totalEarned = Number(log?.total_rewards || 0) || 0;
        const lastClaimed = log?.last_claimed || null;

        // Token meta (symbol/decimals)
        const { symbol } = await getTokenMeta({ network, tokenContract });

        // Pending estimate using same math/cap as payout
        const pending = estimatePending({ perNftDaily, nftCount, lastClaimed });

        totalEarnedAll += totalEarned;
        totalStakedAll += nftCount;

        // Build a neat field per project
        const valueLines = [
          `Contract: \`${shortAddr(contract)}\` • Network: \`${network}\``,
          `Staked: **${nftCount}**`,
          `Daily Rate: **${fmtNum(perNftDaily)} ${symbol}/NFT/day**`,
          `Total Earned: **${fmtNum(totalEarned)} ${symbol}**`,
          `Pending (est): **${fmtNum(pending)} ${symbol}** (cap ${fmtNum(MAX_DAILY_REWARD)} ${symbol})`,
          `Last Claimed: ${lastClaimed ? new Date(lastClaimed).toLocaleString() : 'N/A'}`,
          tokenIds.length ? `Token IDs: ${tokenIds.slice(0, 20).join(', ')}${tokenIds.length > 20 ? '…' : ''}` : 'Token IDs: —'
        ];

        summaries.push({
          name: `🔹 ${name}`,
          value: valueLines.join('\n')
        });
      }

      // Compose embed
      const embed = new EmbedBuilder()
        .setTitle('📊 Staking Rewards')
        .setDescription(`Wallet: \`${shortAddr(wallet)}\`\nProjects: **${projRes.rowCount}**`)
        .addFields(summaries.slice(0, 24)) // Discord max fields
        .setFooter({ text: `Total staked across projects: ${totalStakedAll} • Total earned: ${fmtNum(totalEarnedAll)}` })
        .setColor(0x00cc99);

      return interaction.editReply({ embeds: [embed] });

    } catch (err) {
      console.error('❌ /seereward error:', err);
      return interaction.editReply('⚠️ Failed to fetch staking data. Please try again.');
    }
  }
};

