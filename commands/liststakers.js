// commands/liststakers.js
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { ethers } = require('ethers');

function normalizeAddr(a) { try { return ethers.getAddress(a); } catch { return null; } }
function shortAddr(a, n = 4) {
  const s = String(a || '');
  return s && s.startsWith('0x') ? `${s.slice(0, 6)}...${s.slice(-n)}` : s || 'N/A';
}
function fmtInt(n) { const x = Number(n) || 0; return x.toLocaleString(); }
function pct(n) { const x = Number(n); return Number.isFinite(x) ? `${x.toFixed(2)}%` : '—'; }

async function fetchProjects(pg, guildId, { contract, network }) {
  if (contract) {
    const res = await pg.query(
      `SELECT name, contract_address, network
         FROM staking_projects
        WHERE guild_id = $1 AND contract_address = $2 AND ($3::text IS NULL OR network = $3)
        ORDER BY name`,
      [guildId, contract.toLowerCase(), network || null]
    );
    return res.rows;
  }
  if (network) {
    const res = await pg.query(
      `SELECT name, contract_address, network
         FROM staking_projects
        WHERE guild_id = $1 AND network = $2
        ORDER BY name`,
      [guildId, network]
    );
    return res.rows;
  }
  const res = await pg.query(
    `SELECT name, contract_address, network
       FROM staking_projects
      WHERE guild_id = $1
      ORDER BY name`,
    [guildId]
  );
  return res.rows;
}

async function fetchStakerCounts(pg, { contract, network, wallet, limit, offset }) {
  if (wallet) {
    // Single wallet focus: return one row with the count + first/last timestamps
    const rowRes = await pg.query(
      `SELECT wallet_address,
              COUNT(*)::int AS cnt,
              MIN(staked_at) AS first_staked,
              MAX(staked_at) AS last_staked
         FROM staked_nfts
        WHERE contract_address = $1 AND network = $2 AND wallet_address = $3
        GROUP BY wallet_address`,
      [contract, network, wallet.toLowerCase()]
    );
    const totals = await pg.query(
      `SELECT COUNT(DISTINCT wallet_address) AS total_wallets,
              COUNT(*) AS total_tokens
         FROM staked_nfts
        WHERE contract_address = $1 AND network = $2`,
      [contract, network]
    );
    return {
      rows: rowRes.rows,
      totalWallets: Number(totals.rows[0]?.total_wallets || 0),
      totalTokens: Number(totals.rows[0]?.total_tokens || 0),
    };
  }

  // Paged list of all stakers: counts only
  const res = await pg.query(
    `SELECT wallet_address,
            COUNT(*)::int AS cnt,
            MIN(staked_at) AS first_staked,
            MAX(staked_at) AS last_staked
       FROM staked_nfts
      WHERE contract_address = $1 AND network = $2
      GROUP BY wallet_address
      ORDER BY cnt DESC, wallet_address ASC
      LIMIT $3 OFFSET $4`,
    [contract, network, limit, offset]
  );
  const totals = await pg.query(
    `SELECT COUNT(DISTINCT wallet_address) AS total_wallets,
            COUNT(*) AS total_tokens
       FROM staked_nfts
      WHERE contract_address = $1 AND network = $2`,
    [contract, network]
  );
  return {
    rows: res.rows,
    totalWallets: Number(totals.rows[0]?.total_wallets || 0),
    totalTokens: Number(totals.rows[0]?.total_tokens || 0),
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('liststakers')
    .setDescription('List stakers and the number of NFTs they have staked (counts only).')
    .addStringOption(o =>
      o.setName('contract')
        .setDescription('Filter to a specific NFT contract (0x...)')
        .setRequired(false))
    .addStringOption(o =>
      o.setName('network')
        .setDescription('Filter by network')
        .addChoices(
          { name: 'Base', value: 'base' },
          { name: 'Ethereum', value: 'eth' }
        )
        .setRequired(false))
    .addStringOption(o =>
      o.setName('wallet')
        .setDescription('Filter to a specific wallet (0x...)')
        .setRequired(false))
    .addIntegerOption(o =>
      o.setName('limit')
        .setDescription('Number of stakers to list per project (default 25, max 100)')
        .setMinValue(1).setMaxValue(100).setRequired(false))
    .addIntegerOption(o =>
      o.setName('page')
        .setDescription('Page number (starting at 1)')
        .setMinValue(1).setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const guildId = interaction.guild.id;

    const contractIn = interaction.options.getString('contract') || null;
    const network = (interaction.options.getString('network') || '').toLowerCase() || null;
    const walletIn = interaction.options.getString('wallet') || null;

    const limit = interaction.options.getInteger('limit') || 25;
    const page = interaction.options.getInteger('page') || 1;

    // Validate inputs
    let contract = null;
    if (contractIn) {
      contract = normalizeAddr(contractIn);
      if (!contract) {
        return interaction.reply({ ephemeral: true, content: '❌ Invalid `contract` address.' });
      }
    }
    let wallet = null;
    if (walletIn) {
      wallet = normalizeAddr(walletIn);
      if (!wallet) {
        return interaction.reply({ ephemeral: true, content: '❌ Invalid `wallet` address.' });
      }
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Load server projects (optionally filtered)
      const projects = await fetchProjects(pg, guildId, { contract, network });
      if (!projects.length) {
        return interaction.editReply('❌ No staking projects found for this server with the given filters.');
      }

      const offset = (page - 1) * limit;
      const embeds = [];
      let sumAcrossProjects = 0; // if wallet filter is used

      for (const p of projects) {
        const projName = p.name || 'Unnamed Project';
        const projContract = String(p.contract_address).toLowerCase();
        const projNetwork = (p.network || 'base').toLowerCase();

        const { rows, totalWallets, totalTokens } = await fetchStakerCounts(pg, {
          contract: projContract,
          network: projNetwork,
          wallet,
          limit,
          offset
        });

        // Build project section
        const lines = [];
        if (!rows.length) {
          lines.push('_No stakers found with current filters._');
        } else {
          rows.forEach((r, i) => {
            const idx = wallet ? 1 : (offset + i + 1);
            const addr = r.wallet_address;
            const cnt = Number(r.cnt || 0);
            const share = totalTokens > 0 ? (cnt / totalTokens) * 100 : 0;
            const since = r.first_staked ? new Date(r.first_staked).toLocaleDateString() : '—';
            lines.push(
              `**${idx}.** \`${shortAddr(addr)}\` — **${fmtInt(cnt)}** NFT(s) • ${pct(share)} of pool • since ${since}`
            );
            if (wallet) sumAcrossProjects += cnt;
          });
        }

        const embed = new EmbedBuilder()
          .setTitle(`👥 Stakers — ${projName}`)
          .setDescription(lines.join('\n'))
          .addFields(
            { name: 'Contract', value: `\`${projContract}\``, inline: true },
            { name: 'Network', value: `\`${projNetwork}\``, inline: true },
            { name: 'Page', value: `${page}`, inline: true },
            { name: 'Totals', value: `Stakers: **${fmtInt(totalWallets)}** • NFTs Staked: **${fmtInt(totalTokens)}**` }
          )
          .setColor(0x4fa3ff);

        if (wallet) {
          embed.setFooter({ text: `Filtered wallet: ${shortAddr(wallet)}` });
        }

        embeds.push(embed);
      }

      // Wallet-wide summary (across projects)
      if (wallet && projects.length > 1) {
        embeds.unshift(
          new EmbedBuilder()
            .setTitle('📋 Wallet Staking Summary')
            .setDescription(
              `Wallet: \`${shortAddr(wallet)}\`\nProjects scanned: **${projects.length}**\nTotal NFTs staked across projects: **${fmtInt(sumAcrossProjects)}**`
            )
            .setColor(0x00cc99)
        );
      }

      return interaction.editReply({ embeds: embeds.slice(0, 10) }); // Discord limit safeguard

    } catch (err) {
      console.error('❌ /liststakers error:', err);
      return interaction.editReply('⚠️ Failed to fetch staker list. Please try again.');
    }
  }
};
