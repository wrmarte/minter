// commands/updatestaking.js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { Contract, Wallet, ethers } = require('ethers');
const crypto = require('crypto');
const { getProvider } = require('../services/providerM');

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

function normalizeAddr(a) {
  try { return ethers.getAddress(a); } catch { return null; }
}
function short(a) {
  const s = String(a || '');
  return s ? `${s.slice(0, 6)}...${s.slice(-4)}` : 'N/A';
}

// --- encryption helpers (AES-256-CBC) ---
function keyTo32Bytes(keyStr) {
  const raw = String(keyStr || '');
  try {
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex'); // hex-encoded 32 bytes
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch {}
  return crypto.createHash('sha256').update(raw).digest();
}
function encryptPrivateKey(pk) {
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY missing in environment');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', keyTo32Bytes(ENCRYPTION_KEY), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(pk.trim(), 'utf8')), cipher.final()]);
  return `${iv.toString('hex')}:${enc.toString('hex')}`;
}

async function getErc20Meta({ network, token }) {
  const provider = getProvider(network);
  if (!provider) throw new Error(`No RPC provider for network: ${network}`);
  const t = new Contract(token, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    t.symbol().catch(() => 'TOKEN'),
    t.decimals().then(Number).catch(() => 18)
  ]);
  return { symbol, decimals: Number.isFinite(decimals) ? decimals : 18 };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('updatestaking')
    .setDescription('Update the staking setup for this server’s NFT project.')
    .addStringOption(o =>
      o.setName('contract')
        .setDescription('NFT contract address (target to update)')
        .setRequired(true))
    .addStringOption(o =>
      o.setName('network')
        .setDescription('Chain network (defaults to Base)')
        .addChoices(
          { name: 'Base', value: 'base' },
          { name: 'Ethereum', value: 'eth' }
        )
        .setRequired(false))
    .addStringOption(o =>
      o.setName('name')
        .setDescription('New display name (optional)')
        .setRequired(false))
    .addNumberOption(o =>
      o.setName('reward')
        .setDescription('New daily reward per NFT (optional)')
        .setRequired(false))
    .addStringOption(o =>
      o.setName('token_contract')
        .setDescription('New ERC20 token contract for rewards (optional)')
        .setRequired(false))
    .addStringOption(o =>
      o.setName('vault_wallet')
        .setDescription('New vault wallet address (optional)')
        .setRequired(false))
    .addStringOption(o =>
      o.setName('vault_key')
        .setDescription('Private key for the vault wallet (optional; will be encrypted)')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const guildId = interaction.guild.id;

    const contractIn = interaction.options.getString('contract');
    const network = (interaction.options.getString('network') || 'base').toLowerCase();
    const name = interaction.options.getString('name') || null;
    const reward = interaction.options.getNumber('reward'); // may be null
    const tokenContractIn = interaction.options.getString('token_contract') || null;
    const vaultWalletIn = interaction.options.getString('vault_wallet') || null;
    const vaultKey = interaction.options.getString('vault_key') || null;

    const isOwner = interaction.user.id === process.env.BOT_OWNER_ID;
    const hasPerms = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);

    // PremiumPlus gate
    const tierRes = await pg.query(`SELECT tier FROM premium_servers WHERE server_id = $1`, [guildId]);
    const tier = tierRes.rows[0]?.tier || 'free';
    if (!isOwner && tier !== 'premiumplus') {
      return interaction.reply({
        content: '❌ This command requires **PremiumPlus** tier. Upgrade your server to unlock `/updatestaking`.',
        ephemeral: true
      });
    }
    if (!isOwner && !hasPerms) {
      return interaction.reply({ content: '❌ You must be a server admin to use this command.', ephemeral: true });
    }

    // Validate target
    const contract = normalizeAddr(contractIn);
    if (!contract) {
      return interaction.reply({ content: '❌ Invalid target NFT contract address.', ephemeral: true });
    }

    // Validate intended updates (addresses, numbers)
    const updates = {};
    if (name && name.trim()) updates.name = name.trim();

    if (reward != null) {
      if (!Number.isFinite(reward) || reward <= 0) {
        return interaction.reply({ content: '❌ `reward` must be a positive number.', ephemeral: true });
      }
      updates.daily_reward = reward;
    }

    let tokenContract = null;
    if (tokenContractIn) {
      tokenContract = normalizeAddr(tokenContractIn);
      if (!tokenContract) {
        return interaction.reply({ content: '❌ Invalid `token_contract` address.', ephemeral: true });
      }
      updates.token_contract = tokenContract.toLowerCase();
    }

    let vaultWallet = null;
    if (vaultWalletIn) {
      vaultWallet = normalizeAddr(vaultWalletIn);
      if (!vaultWallet) {
        return interaction.reply({ content: '❌ Invalid `vault_wallet` address.', ephemeral: true });
      }
      updates.vault_wallet = vaultWallet.toLowerCase();
    }

    // Early check: did user provide anything to update?
    if (Object.keys(updates).length === 0 && !vaultKey) {
      return interaction.reply({ content: 'ℹ️ No changes provided. Add at least one field to update.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Make sure the target project/config exists for this guild + network
      const projSel = await pg.query(
        `SELECT name FROM staking_projects WHERE guild_id = $1 AND contract_address = $2 AND network = $3 LIMIT 1`,
        [guildId, contract.toLowerCase(), network]
      );
      if (projSel.rowCount === 0) {
        return interaction.editReply('❌ No staking project found for that contract on this server/network.');
      }

      const cfgSel = await pg.query(
        `SELECT daily_reward, vault_wallet, token_contract, vault_private_key
           FROM staking_config
          WHERE contract_address = $1 AND network = $2
          LIMIT 1`,
        [contract.toLowerCase(), network]
      );
      if (cfgSel.rowCount === 0) {
        return interaction.editReply('❌ No staking configuration found. Use `/addstaking` first.');
      }
      const currentCfg = cfgSel.rows[0];

      // If token contract is changing, validate ERC-20 details on this network
      let tokenMeta = null;
      if (tokenContract) {
        tokenMeta = await getErc20Meta({ network, token: tokenContract.toLowerCase() })
          .catch(() => ({ symbol: 'TOKEN', decimals: 18 }));
      } else {
        // Keep current for display
        if (currentCfg.token_contract) {
          tokenMeta = await getErc20Meta({ network, token: String(currentCfg.token_contract).toLowerCase() })
            .catch(() => ({ symbol: 'TOKEN', decimals: 18 }));
        } else {
          tokenMeta = { symbol: 'TOKEN', decimals: 18 };
        }
      }

      // If vault key is provided, check it matches intended (new or existing) vault wallet
      let encVaultKey = null;
      if (vaultKey) {
        if (!ENCRYPTION_KEY) {
          return interaction.editReply('❌ You provided `vault_key`, but the bot is missing ENCRYPTION_KEY in environment.');
        }
        let expectWallet = vaultWallet || normalizeAddr(currentCfg.vault_wallet || '');
        if (!expectWallet) {
          return interaction.editReply('❌ Cannot validate `vault_key`: no vault wallet is set (provide `vault_wallet` in the same command).');
        }
        let derived;
        try {
          const w = new Wallet(vaultKey.trim());
          derived = normalizeAddr(w.address);
        } catch {
          return interaction.editReply('❌ Invalid `vault_key`. Make sure it is a valid private key (hex).');
        }
        if (derived !== expectWallet) {
          return interaction.editReply(`❌ The provided \`vault_key\` does not match the vault wallet (${short(expectWallet)}).`);
        }
        encVaultKey = encryptPrivateKey(vaultKey.trim());
      }

      // Apply updates
      // 1) staking_projects (name)
      if (updates.name) {
        await pg.query(
          `UPDATE staking_projects SET name = $1 WHERE guild_id = $2 AND contract_address = $3 AND network = $4`,
          [updates.name, guildId, contract.toLowerCase(), network]
        );
      }

      // 2) staking_config (daily_reward, token_contract, vault_wallet, vault_private_key)
      const setParts = [];
      const params = [];
      let p = 1;

      if (updates.daily_reward != null) { setParts.push(`daily_reward = $${p++}`); params.push(updates.daily_reward); }
      if (updates.token_contract)      { setParts.push(`token_contract = $${p++}`); params.push(updates.token_contract); }
      if (updates.vault_wallet)        { setParts.push(`vault_wallet = $${p++}`); params.push(updates.vault_wallet); }
      if (encVaultKey)                 { setParts.push(`vault_private_key = $${p++}`); params.push(encVaultKey); }

      if (setParts.length > 0) {
        params.push(contract.toLowerCase(), network);
        const q = `UPDATE staking_config SET ${setParts.join(', ')} WHERE contract_address = $${p++} AND network = $${p++}`;
        await pg.query(q, params);
      }

      // Build response
      const lines = ['✅ **Staking setup updated**'];
      lines.push(`• Network: \`${network}\``);
      lines.push(`• Contract: \`${contract}\``);
      if (updates.name) lines.push(`• Name: **${updates.name}**`);
      if (updates.daily_reward != null) lines.push(`• Daily Reward: **${updates.daily_reward} ${tokenMeta.symbol}/NFT/day**`);
      if (updates.token_contract) lines.push(`• Reward Token: \`${updates.token_contract}\` (symbol: ${tokenMeta.symbol}, decimals: ${tokenMeta.decimals})`);
      if (updates.vault_wallet) lines.push(`• Vault Wallet: \`${short(updates.vault_wallet)}\``);
      if (encVaultKey) lines.push('• 🔐 Vault key stored (encrypted)');

      if (lines.length === 3) lines.push('• (No visible field changes—did you only re-encrypt the key?)');

      return interaction.editReply(lines.join('\n'));

    } catch (err) {
      console.error('❌ /updatestaking error:', err);
      return interaction.editReply('❌ Failed to update staking setup. Check logs for details.');
    }
  }
};
