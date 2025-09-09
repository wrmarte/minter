// commands/addstaking.js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { Contract, ethers } = require('ethers');
const { getProvider, safeRpcCall } = require('../services/providerM');

const ERC721_ABI = [
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];
const IFACE_ERC721 = '0x80ac58cd';

function normalizeAddr(a) { try { return ethers.getAddress(a); } catch { return null; } }
function short(a) { const s = String(a || ''); return s ? `${s.slice(0,6)}...${s.slice(-4)}` : 'N/A'; }

async function assertErc721({ network, contract }) {
  const provider = getProvider(network);
  if (!provider) throw new Error(`No RPC provider for network: ${network}`);
  const c = new Contract(contract, ERC721_ABI, provider);
  try {
    const ok = await safeRpcCall(network, p => c.connect(p).supportsInterface(IFACE_ERC721));
    if (ok) return;
  } catch {}
  // fallback probe (best-effort)
  try { await safeRpcCall(network, p => c.connect(p).ownerOf(0)); } catch {}
}

async function getErc20Meta({ network, token }) {
  const provider = getProvider(network);
  if (!provider) throw new Error(`No RPC provider for network: ${network}`);
  const t = new Contract(token, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    t.symbol().catch(() => 'TOKEN'),
    t.decimals().then(Number).catch(() => 18),
  ]);
  return { symbol, decimals: Number.isFinite(decimals) ? decimals : 18 };
}

async function upsertProject(pg, { guildId, name, contract, network }) {
  const sel = await pg.query(
    `SELECT 1 FROM staking_projects WHERE guild_id = $1 AND contract_address = $2 AND network = $3 LIMIT 1`,
    [guildId, contract, network]
  );
  if (sel.rowCount) {
    await pg.query(
      `UPDATE staking_projects SET name = $1 WHERE guild_id = $2 AND contract_address = $3 AND network = $4`,
      [name, guildId, contract, network]
    );
  } else {
    await pg.query(
      `INSERT INTO staking_projects (name, contract_address, network, guild_id)
       VALUES ($1, $2, $3, $4)`,
      [name, contract, network, guildId]
    );
  }
}

async function upsertConfig(pg, { contract, network, dailyReward, vaultWallet, tokenContract }) {
  const sel = await pg.query(
    `SELECT 1 FROM staking_config WHERE contract_address = $1 AND network = $2 LIMIT 1`,
    [contract, network]
  );
  if (sel.rowCount) {
    await pg.query(
      `UPDATE staking_config
          SET daily_reward = $1,
              vault_wallet = $2,
              token_contract = $3
        WHERE contract_address = $4 AND network = $5`,
      [dailyReward, vaultWallet, tokenContract, contract, network]
    );
  } else {
    await pg.query(
      `INSERT INTO staking_config (contract_address, network, daily_reward, vault_wallet, token_contract)
       VALUES ($1, $2, $3, $4, $5)`,
      [contract, network, dailyReward, vaultWallet, tokenContract]
    );
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('addstaking')
    .setDescription('Assign staking setup for this server’s NFT project.')
    .addStringOption(o =>
      o.setName('name')
        .setDescription('Display name for this staking project')
        .setRequired(true))
    .addStringOption(o =>
      o.setName('contract')
        .setDescription('NFT contract address (ERC721)')
        .setRequired(true))
    .addNumberOption(o =>
      o.setName('reward')
        .setDescription('Daily reward per NFT (e.g. 10)')
        .setRequired(true))
    .addStringOption(o =>
      o.setName('token_contract')
        .setDescription('ERC20 token contract for rewards')
        .setRequired(true))
    .addStringOption(o =>
      o.setName('vault_wallet')
        .setDescription('Vault wallet that holds reward tokens (0x...)')
        .setRequired(true))
    .addStringOption(o =>
      o.setName('network')
        .setDescription('Chain network')
        .addChoices(
          { name: 'Base', value: 'base' },
          { name: 'Ethereum', value: 'eth' }
        )
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const guildId = interaction.guild.id;

    const name = interaction.options.getString('name').trim();
    const contractIn = interaction.options.getString('contract');
    const rewardNum = interaction.options.getNumber('reward');
    const tokenContractIn = interaction.options.getString('token_contract');
    const vaultWalletIn = interaction.options.getString('vault_wallet');
    const network = (interaction.options.getString('network') || 'base').toLowerCase();

    const isOwner = interaction.user.id === process.env.BOT_OWNER_ID;
    const hasPerms = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);

    // PremiumPlus gate (matches your other commands)
    const tierRes = await pg.query(`SELECT tier FROM premium_servers WHERE server_id = $1`, [guildId]);
    const tier = tierRes.rows[0]?.tier || 'free';
    if (!isOwner && tier !== 'premiumplus') {
      return interaction.reply({ content: '❌ This command requires **PremiumPlus** tier.', ephemeral: true });
    }
    if (!isOwner && !hasPerms) {
      return interaction.reply({ content: '❌ You must be a server admin to use this command.', ephemeral: true });
    }

    // Validate inputs
    const contract = normalizeAddr(contractIn);
    const tokenContract = normalizeAddr(tokenContractIn);
    const vaultWallet = normalizeAddr(vaultWalletIn);
    if (!contract) return interaction.reply({ content: '❌ Invalid NFT contract address.', ephemeral: true });
    if (!tokenContract) return interaction.reply({ content: '❌ Invalid reward token contract address.', ephemeral: true });
    if (!vaultWallet) return interaction.reply({ content: '❌ Invalid vault wallet address.', ephemeral: true });
    if (!Number.isFinite(rewardNum) || rewardNum <= 0) {
      return interaction.reply({ content: '❌ `reward` must be a positive number.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Verify network + ERC721
      const provider = getProvider(network);
      if (!provider) throw new Error(`No RPC provider configured for network "${network}".`);
      await assertErc721({ network, contract });

      // Verify ERC20 details for nicer output
      const { symbol, decimals } = await getErc20Meta({ network, token: tokenContract });

      // Persist project + config (no vault key here)
      await upsertProject(pg, { guildId, name, contract: contract.toLowerCase(), network });
      await upsertConfig(pg, {
        contract: contract.toLowerCase(),
        network,
        dailyReward: rewardNum,
        vaultWallet: vaultWallet.toLowerCase(),
        tokenContract: tokenContract.toLowerCase()
      });

      // Success message + gentle nudge to set key
      const lines = [
        `✅ **Staking setup saved**`,
        `• Project: **${name}**`,
        `• Network: \`${network}\``,
        `• NFT Contract: \`${contract}\``,
        `• Reward: \`${rewardNum} ${symbol}/day per NFT\``,
        `• Reward Token: \`${tokenContract}\` (symbol: ${symbol}, decimals: ${decimals})`,
        `• Vault: \`${short(vaultWallet)}\``,
        `• Next: run \`/setvaultkey\` to securely store the private key for payouts.`
      ];
      return interaction.editReply(lines.join('\n'));

    } catch (err) {
      console.error('❌ /addstaking error:', err);
      return interaction.editReply('❌ Failed to save staking setup. Check logs for details.');
    }
  }
};







