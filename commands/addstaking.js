const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { Contract, Wallet, ethers } = require('ethers');
const crypto = require('crypto');
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

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

/* ────────── utils ────────── */
function normalizeAddr(a){ try { return ethers.getAddress(a); } catch { return null; } }
function short(a){ const s=String(a||''); return s?`${s.slice(0,6)}...${s.slice(-4)}`:'N/A'; }
function keyTo32Bytes(keyStr){
  const raw=String(keyStr||'');
  try { if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw,'hex'); const b=Buffer.from(raw,'base64'); if (b.length===32) return b; } catch {}
  return crypto.createHash('sha256').update(raw).digest();
}
function encryptPrivateKey(pk){
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY missing in environment');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', keyTo32Bytes(ENCRYPTION_KEY), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(pk.trim(),'utf8')), cipher.final()]);
  return `${iv.toString('hex')}:${enc.toString('hex')}`;
}
async function assertErc721({ network, contract }){
  const provider = getProvider(network); if (!provider) throw new Error(`No RPC for ${network}`);
  const c = new Contract(contract, ERC721_ABI, provider);
  try { const ok = await safeRpcCall(network, p=>c.connect(p).supportsInterface(IFACE_ERC721)); if (ok) return; } catch {}
  try { await safeRpcCall(network, p=>c.connect(p).ownerOf(0)); } catch {}
}
async function getErc20Meta({ network, token }){
  const provider = getProvider(network); if (!provider) throw new Error(`No RPC for ${network}`);
  const t = new Contract(token, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    t.symbol().catch(()=> 'TOKEN'),
    t.decimals().then(Number).catch(()=> 18),
  ]);
  return { symbol, decimals: Number.isFinite(decimals)?decimals:18 };
}
// cache column existence checks
const colSupportCache = new Map();
async function tableHasColumn(pg, table, column){
  const key = `${table}:${column}`;
  if (colSupportCache.has(key)) return colSupportCache.get(key);
  const q = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = $1 AND column_name = $2
    LIMIT 1`;
  const r = await pg.query(q, [table, column]).catch(()=>({rowCount:0}));
  const has = r.rowCount > 0;
  colSupportCache.set(key, has);
  return has;
}

/* ────────── upserts ────────── */
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

async function upsertConfig(pg, { contract, network, dailyReward, vaultWallet, tokenContract, encVaultKey }) {
  const hasVaultCol = await tableHasColumn(pg, 'staking_config', 'vault_private_key');

  const sel = await pg.query(
    `SELECT 1 FROM staking_config WHERE contract_address = $1 AND network = $2 LIMIT 1`,
    [contract, network]
  );

  if (sel.rowCount) {
    const sets = [`daily_reward = $1`, `vault_wallet = $2`, `token_contract = $3`];
    const params = [dailyReward, vaultWallet, tokenContract];
    if (hasVaultCol && encVaultKey) { sets.push(`vault_private_key = $4`); params.push(encVaultKey); }
    params.push(contract, network);
    const sql = `UPDATE staking_config SET ${sets.join(', ')} WHERE contract_address = $${params.length-1} AND network = $${params.length}`;
    await pg.query(sql, params);
  } else {
    if (hasVaultCol) {
      await pg.query(
        `INSERT INTO staking_config (contract_address, network, daily_reward, vault_wallet, token_contract, vault_private_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [contract, network, dailyReward, vaultWallet, tokenContract, encVaultKey || null]
      );
    } else {
      await pg.query(
        `INSERT INTO staking_config (contract_address, network, daily_reward, vault_wallet, token_contract)
         VALUES ($1, $2, $3, $4, $5)`,
        [contract, network, dailyReward, vaultWallet, tokenContract]
      );
    }
  }

  return { storedVault: !!(encVaultKey && hasVaultCol), vaultColExists: hasVaultCol };
}

/* ────────── command ────────── */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('addstaking')
    .setDescription('Assign staking setup for this server’s NFT project.')
    .addStringOption(o=>o.setName('name').setDescription('Display name').setRequired(true))
    .addStringOption(o=>o.setName('contract').setDescription('NFT contract (ERC721)').setRequired(true))
    .addNumberOption(o=>o.setName('reward').setDescription('Daily reward per NFT').setRequired(true))
    .addStringOption(o=>o.setName('token_contract').setDescription('ERC20 token contract').setRequired(true))
    .addStringOption(o=>o.setName('vault_wallet').setDescription('Vault wallet (0x...)').setRequired(true))
    .addStringOption(o=>o.setName('vault_key').setDescription('Private key (optional; will be encrypted)').setRequired(false))
    .addStringOption(o=>o.setName('network').setDescription('Chain network').addChoices(
      { name:'Base', value:'base' }, { name:'Ethereum', value:'eth' }
    )),
  setDefaultMemberPermissions: PermissionFlagsBits.ManageGuild,

  async execute(interaction){
    const pg = interaction.client.pg;
    const guildId = interaction.guild.id;

    const name = interaction.options.getString('name').trim();
    const contractIn = interaction.options.getString('contract');
    const rewardNum = interaction.options.getNumber('reward');
    const tokenContractIn = interaction.options.getString('token_contract');
    const vaultWalletIn = interaction.options.getString('vault_wallet');
    const vaultKey = interaction.options.getString('vault_key') || null;
    const network = (interaction.options.getString('network') || 'base').toLowerCase();

    const isOwner = interaction.user.id === process.env.BOT_OWNER_ID;
    const hasPerms = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);

    const tierRes = await pg.query(`SELECT tier FROM premium_servers WHERE server_id = $1`, [guildId]);
    const tier = tierRes.rows[0]?.tier || 'free';
    if (!isOwner && tier !== 'premiumplus') {
      return interaction.reply({ content:'❌ This command requires **PremiumPlus** tier.', ephemeral:true });
    }
    if (!isOwner && !hasPerms) {
      return interaction.reply({ content:'❌ You must be a server admin to use this command.', ephemeral:true });
    }

    const contract = normalizeAddr(contractIn);
    const tokenContract = normalizeAddr(tokenContractIn);
    const vaultWallet = normalizeAddr(vaultWalletIn);
    if (!contract) return interaction.reply({ content:'❌ Invalid NFT contract address.', ephemeral:true });
    if (!tokenContract) return interaction.reply({ content:'❌ Invalid reward token contract address.', ephemeral:true });
    if (!vaultWallet) return interaction.reply({ content:'❌ Invalid vault wallet address.', ephemeral:true });
    if (!Number.isFinite(rewardNum) || rewardNum <= 0) {
      return interaction.reply({ content:'❌ `reward` must be a positive number.', ephemeral:true });
    }

    await interaction.deferReply({ ephemeral:true });

    try {
      const provider = getProvider(network);
      if (!provider) throw new Error(`No RPC provider configured for ${network}`);
      await assertErc721({ network, contract });

      const { symbol, decimals } = await getErc20Meta({ network, token: tokenContract });

      // optional vault key handling
      let encVaultKey = null;
      let vaultNote = '';
      if (vaultKey) {
        if (!ENCRYPTION_KEY) {
          return interaction.editReply('❌ You provided `vault_key`, but ENCRYPTION_KEY is missing in env.');
        }
        let derived;
        try {
          const w = new Wallet(vaultKey.trim());
          derived = normalizeAddr(w.address);
        } catch {
          return interaction.editReply('❌ Invalid `vault_key`. Make sure it is a valid private key (hex).');
        }
        if (derived !== vaultWallet) {
          return interaction.editReply(`❌ \`vault_key\` does not match the vault wallet (${short(vaultWallet)}).`);
        }
        encVaultKey = encryptPrivateKey(vaultKey.trim());
      }

      await upsertProject(pg, { guildId, name, contract: contract.toLowerCase(), network });
      const { storedVault, vaultColExists } = await upsertConfig(pg, {
        contract: contract.toLowerCase(),
        network,
        dailyReward: rewardNum,
        vaultWallet: vaultWallet.toLowerCase(),
        tokenContract: tokenContract.toLowerCase(),
        encVaultKey
      });

      if (encVaultKey && !vaultColExists) {
        vaultNote = '\n• ⚠️ Vault key NOT stored (DB column missing). Run:\n`ALTER TABLE staking_config ADD COLUMN IF NOT EXISTS vault_private_key text;`';
      } else if (storedVault) {
        vaultNote = ' • 🔐 key stored (encrypted)';
      }

      const lines = [
        `✅ **Staking setup saved**`,
        `• Project: **${name}**`,
        `• Network: \`${network}\``,
        `• NFT Contract: \`${contract}\``,
        `• Reward: \`${rewardNum} ${symbol}/day per NFT\``,
        `• Reward Token: \`${tokenContract}\` (symbol: ${symbol}, decimals: ${decimals})`,
        `• Vault: \`${short(vaultWallet)}\`${vaultNote}`
      ];
      return interaction.editReply(lines.join('\n'));

    } catch (err) {
      console.error('❌ /addstaking error:', err);
      return interaction.editReply('❌ Failed to save staking setup. Check logs for details.');
    }
  }
};






