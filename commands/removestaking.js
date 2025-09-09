// commands/removestaking.js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { ethers } = require('ethers');

function normalizeAddr(a) {
  try { return ethers.getAddress(a); } catch { return null; }
}
function short(a) {
  const s = String(a || '');
  return s ? `${s.slice(0, 6)}...${s.slice(-4)}` : 'N/A';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removestaking')
    .setDescription('Remove a staking setup for this server’s NFT project.')
    .addStringOption(o =>
      o.setName('contract')
        .setDescription('NFT contract address to remove')
        .setRequired(true))
    .addStringOption(o =>
      o.setName('network')
        .setDescription('Chain network (defaults to Base)')
        .addChoices(
          { name: 'Base', value: 'base' },
          { name: 'Ethereum', value: 'eth' }
        )
        .setRequired(false))
    .addBooleanOption(o =>
      o.setName('purge')
        .setDescription('Also delete config and all stake data for this contract on this server')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const guildId = interaction.guild.id;

    const contractIn = interaction.options.getString('contract');
    const network = (interaction.options.getString('network') || 'base').toLowerCase();
    const purge = interaction.options.getBoolean('purge') || false;

    const isOwner = interaction.user.id === process.env.BOT_OWNER_ID;
    const hasPerms = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);

    // PremiumPlus gate
    const tierRes = await pg.query(`SELECT tier FROM premium_servers WHERE server_id = $1`, [guildId]);
    const tier = tierRes.rows[0]?.tier || 'free';
    if (!isOwner && tier !== 'premiumplus') {
      return interaction.reply({
        content: '❌ This command requires **PremiumPlus** tier. Upgrade your server to unlock `/removestaking`.',
        ephemeral: true
      });
    }
    if (!isOwner && !hasPerms) {
      return interaction.reply({ content: '❌ You must be a server admin to use this command.', ephemeral: true });
    }

    const contract = normalizeAddr(contractIn);
    if (!contract) {
      return interaction.reply({ content: '❌ Invalid NFT contract address.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Make sure this guild has that staking project
      const projSel = await pg.query(
        `SELECT name FROM staking_projects
          WHERE guild_id = $1 AND contract_address = $2 AND network = $3
          LIMIT 1`,
        [guildId, contract.toLowerCase(), network]
      );
      if (projSel.rowCount === 0) {
        return interaction.editReply('❌ No staking project found for that contract on this server/network.');
      }
      const projName = projSel.rows[0].name || 'Unnamed Project';

      await pg.query('BEGIN');

      // Remove the project row for this guild/network
      await pg.query(
        `DELETE FROM staking_projects
          WHERE guild_id = $1 AND contract_address = $2 AND network = $3`,
        [guildId, contract.toLowerCase(), network]
      );

      let infoLines = [
        `🗑️ Removed staking project **${projName}**`,
        `• Network: \`${network}\``,
        `• Contract: \`${contract}\``
      ];

      // Check if any other guilds still reference this contract+network
      const stillUsed = await pg.query(
        `SELECT 1 FROM staking_projects
          WHERE contract_address = $1 AND network = $2
          LIMIT 1`,
        [contract.toLowerCase(), network]
      );

      if (purge) {
        // Purge server data for this contract/network
        // Note: staked_* tables are per wallet+contract+network (no guild), so we delete for this contract+network
        const del1 = await pg.query(
          `DELETE FROM staked_nfts WHERE contract_address = $1 AND network = $2`,
          [contract.toLowerCase(), network]
        );
        const del2 = await pg.query(
          `DELETE FROM staked_wallets WHERE contract_address = $1 AND network = $2`,
          [contract.toLowerCase(), network]
        );

        // Try to remove reward logs only if columns exist; ignore errors if schema doesn't have them
        try {
          await pg.query(
            `DELETE FROM reward_log WHERE contract_address = $1 AND network = $2`,
            [contract.toLowerCase(), network]
          );
        } catch {/* ignore if columns not present */}
        try {
          await pg.query(
            `DELETE FROM reward_tx_log WHERE contract_address = $1 AND network = $2`,
            [contract.toLowerCase(), network]
          );
        } catch {/* ignore if columns not present */}

        // Remove config unconditionally on purge
        await pg.query(
          `DELETE FROM staking_config WHERE contract_address = $1 AND network = $2`,
          [contract.toLowerCase(), network]
        );

        infoLines.push(`• Purged: staked data (${del1.rowCount + del2.rowCount} rows) and config.`);
      } else {
        // If no other guild uses this contract+network, optionally clean orphaned config
        if (stillUsed.rowCount === 0) {
          // Leave config by default (could be re-added later). Comment next lines if you prefer auto-clean:
          // await pg.query(
          //   `DELETE FROM staking_config WHERE contract_address = $1 AND network = $2`,
          //   [contract.toLowerCase(), network]
          // );
          infoLines.push('• Note: config remains (no purge). Use `purge: true` to delete config and stake data.');
        }
      }

      await pg.query('COMMIT');
      return interaction.editReply(infoLines.join('\n'));

    } catch (err) {
      await pg.query('ROLLBACK').catch(() => {});
      console.error('❌ /removestaking error:', err);
      return interaction.editReply('❌ Failed to remove staking setup. Check logs for details.');
    }
  }
};
