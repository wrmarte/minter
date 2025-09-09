// commands/setvaultkey.js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { Wallet, ethers } = require('ethers');
const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';
const IV_LENGTH = 16;

function normalizeAddr(a) { try { return ethers.getAddress(a); } catch { return null; } }
function short(a) { const s = String(a || ''); return s ? `${s.slice(0,6)}...${s.slice(-4)}` : 'N/A'; }

// Accept raw, hex(64), base64 keys; otherwise derive via sha256 to 32 bytes
function keyTo32Bytes(keyStr) {
  const raw = String(keyStr || '');
  try { if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex'); } catch {}
  try { const b = Buffer.from(raw, 'base64'); if (b.length === 32) return b; } catch {}
  return crypto.createHash('sha256').update(raw).digest();
}
function encryptPrivateKey(pk) {
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY missing in env');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', keyTo32Bytes(ENCRYPTION_KEY), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(pk.trim(), 'utf8')), cipher.final()]);
  return `${iv.toString('hex')}:${enc.toString('hex')}`;
}

async function tableHasColumn(pg, table, column) {
  const q = `
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2
     LIMIT 1`;
  const r = await pg.query(q, [table, column]).catch(() => ({ rowCount: 0 }));
  return r.rowCount > 0;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setvaultkey')
    .setDescription('Securely store the private key for the staking vault (per contract).')
    .addStringOption(o =>
      o.setName('contract')
        .setDescription('NFT contract address for this staking setup (0x...)')
        .setRequired(false))
    .addStringOption(o =>
      o.setName('network')
        .setDescription('Chain network (defaults to Base)')
        .addChoices(
          { name: 'Base', value: 'base' },
          { name: 'Ethereum', value: 'eth' }
        )
        .setRequired(false))
    .addStringOption(o =>
      o.setName('private_key')
        .setDescription('Private key for the vault wallet (starts with 0x, 66 chars)')
        .setRequired(true))
    .addBooleanOption(o =>
      o.setName('update_wallet')
        .setDescription('Update the configured vault wallet to match this key if needed')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const guildId = interaction.guild.id;

    const privateKey = interaction.options.getString('private_key') || '';
    const contractIn = interaction.options.getString('contract') || null;
    const network = (interaction.options.getString('network') || 'base').toLowerCase();
    const updateWallet = interaction.options.getBoolean('update_wallet') || false;

    const isOwner = interaction.user.id === process.env.BOT_OWNER_ID;
    const hasPerms = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
    if (!isOwner && !hasPerms) {
      return interaction.reply({ content: '❌ Only server admins or the bot owner can use this command.', ephemeral: true });
    }

    // Validate key format
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      return interaction.reply({ content: '❌ Invalid private key. It must start with `0x` and be 66 characters long.', ephemeral: true });
    }
    if (!ENCRYPTION_KEY) {
      return interaction.reply({ content: '❌ Missing `ENCRYPTION_KEY` in environment.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Resolve target staking project for this guild
      let contract;
      if (contractIn) {
        const norm = normalizeAddr(contractIn);
        if (!norm) return interaction.editReply('❌ Invalid `contract` address.');
        contract = norm.toLowerCase();
        // Check that this guild actually has that project on this network
        const proj = await pg.query(
          `SELECT 1 FROM staking_projects WHERE guild_id = $1 AND contract_address = $2 AND network = $3 LIMIT 1`,
          [guildId, contract, network]
        );
        if (proj.rowCount === 0) {
          return interaction.editReply('❌ No staking project found for that contract on this server/network.');
        }
      } else {
        // If only one project exists for this guild+network, use it; otherwise require contract
        const found = await pg.query(
          `SELECT contract_address FROM staking_projects WHERE guild_id = $1 AND network = $2`,
          [guildId, network]
        );
        if (found.rowCount === 0) {
          return interaction.editReply('❌ This server has no staking project configured. Use `/addstaking` first.');
        }
        if (found.rowCount > 1) {
          const list = found.rows.map(r => '`' + r.contract_address + '`').slice(0, 10).join(', ');
          return interaction.editReply(`❌ Multiple projects found on \`${network}\`. Please specify \`contract\`.\nProjects: ${list}${found.rowCount > 10 ? '…' : ''}`);
        }
        contract = String(found.rows[0].contract_address).toLowerCase();
      }

      // Check column existence upfront
      const hasVaultCol = await tableHasColumn(pg, 'staking_config', 'vault_private_key');
      if (!hasVaultCol) {
        return interaction.editReply(
          '❌ Database missing column `staking_config.vault_private_key`.\n' +
          'Run this migration and try again:\n' +
          '```sql\nALTER TABLE staking_config\n  ADD COLUMN IF NOT EXISTS vault_private_key text;\n```'
        );
      }

      // Load current config for contract+network
      const cfgRes = await pg.query(
        `SELECT vault_wallet, token_contract FROM staking_config WHERE contract_address = $1 AND network = $2 LIMIT 1`,
        [contract, network]
      );
      if (cfgRes.rowCount === 0) {
        return interaction.editReply('❌ No staking configuration found for this contract/network. Use `/addstaking` first.');
      }
      const currentVaultWallet = cfgRes.rows[0].vault_wallet ? normalizeAddr(cfgRes.rows[0].vault_wallet) : null;

      // Derive address from provided private key
      let derivedAddress;
      try {
        const w = new Wallet(privateKey.trim());
        derivedAddress = normalizeAddr(w.address);
      } catch {
        return interaction.editReply('❌ Provided private key is invalid.');
      }

      // Ensure key matches configured vault wallet, or update if asked
      if (currentVaultWallet && derivedAddress !== currentVaultWallet) {
        if (!updateWallet) {
          return interaction.editReply(
            `❌ The key belongs to \`${short(derivedAddress)}\`, which does not match the configured vault ` +
            `\`${short(currentVaultWallet)}\`.\n` +
            `Re-run with \`update_wallet:true\` to update the vault wallet, or update the vault wallet via \`/updatestaking\` first.`
          );
        }
        // Update vault wallet to match the key
        await pg.query(
          `UPDATE staking_config SET vault_wallet = $1 WHERE contract_address = $2 AND network = $3`,
          [derivedAddress.toLowerCase(), contract, network]
        );
      }

      // Encrypt & store key
      const encrypted = encryptPrivateKey(privateKey);
      await pg.query(
        `UPDATE staking_config
            SET vault_private_key = $1
          WHERE contract_address = $2 AND network = $3`,
        [encrypted, contract, network]
      );

      return interaction.editReply(
        `✅ Vault key encrypted and stored for contract \`${contract}\` on \`${network}\`.\n` +
        `• Vault wallet: \`${short(derivedAddress)}\`${currentVaultWallet && derivedAddress !== currentVaultWallet ? ' (updated)' : ''}`
      );

    } catch (err) {
      console.error('❌ /setvaultkey error:', err);
      return interaction.editReply('❌ Failed to set vault key. Check logs for details.');
    }
  }
};




