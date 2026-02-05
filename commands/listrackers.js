// commands/listracker.js
const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');

const EPHEMERAL_FLAG = 1 << 6; // 64

function shortAddr(addr = '') {
  const a = String(addr || '').trim();
  if (!a) return '';
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

function chainEmoji(chain) {
  switch (String(chain || '').toLowerCase()) {
    case 'base': return '🟦';
    case 'eth':
    case 'ethereum': return '🟧';
    case 'ape':
    case 'apechain': return '🐵';
    default: return '❓';
  }
}

function chainExplorer(chain) {
  const c = String(chain || '').toLowerCase();
  if (c === 'base') return 'https://basescan.org/address/';
  if (c === 'eth' || c === 'ethereum') return 'https://etherscan.io/address/';
  if (c === 'ape' || c === 'apechain') return 'https://apescan.io/address/';
  return null;
}

function linkAddr(addr, chain) {
  const base = chainExplorer(chain);
  const a = String(addr || '').trim();
  if (!a) return '`N/A`';
  if (!base) return `\`${a}\``;
  return `[${shortAddr(a)}](${base}${a})`;
}

function normalizeChannels(channel_ids) {
  if (Array.isArray(channel_ids)) return channel_ids.filter(Boolean).map(String);
  if (!channel_ids) return [];
  return String(channel_ids).split(',').map(s => s.trim()).filter(Boolean);
}

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean).map(String))];
}

// Format channel mentions with truncation to avoid huge blocks
function formatChannelMentions(chIds, maxMentions = 8) {
  const ids = uniq(chIds);
  if (!ids.length) return '_No channels_';
  const shown = ids.slice(0, maxMentions).map(id => `<#${id}>`);
  const extra = ids.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} +${extra} more` : shown.join(', ');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('listracker')
    .setDescription('🛠️ View tracked NFTs and Tokens (server-scoped, full for owner)'),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const ownerId = process.env.BOT_OWNER_ID;
    const isOwner = interaction.user.id === ownerId;
    const guildId = interaction.guild.id;

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);

    if (!isOwner && !isAdmin) {
      return interaction.reply({
        content: '❌ You are not authorized to use this command.',
        flags: EPHEMERAL_FLAG
      });
    }

    await interaction.deferReply({ flags: EPHEMERAL_FLAG });

    let tokens = [];
    const servers = {}; // guildId -> { tokens: [], nfts: [] }

    // ---------------- Tokens ----------------
    try {
      const tokenQuery = isOwner
        ? `SELECT name, address, guild_id FROM tracked_tokens`
        : `SELECT name, address, guild_id FROM tracked_tokens WHERE guild_id = $1`;

      const tokenRes = await pg.query(tokenQuery, isOwner ? [] : [guildId]);
      tokens = tokenRes.rows || [];
    } catch (err) {
      console.error('❌ Token fetch error:', err);
    }

    // ---------------- NFTs (Watchlist) ----------------
    try {
      const nftRes = await pg.query(`SELECT name, address, chain, channel_ids FROM contract_watchlist`);
      for (const row of (nftRes.rows || [])) {
        const name = row?.name || 'Unnamed';
        const address = String(row?.address || '').trim();
        const chain = String(row?.chain || 'base').toLowerCase();

        const channels = normalizeChannels(row?.channel_ids);
        if (!channels.length) continue;

        // Determine which guild(s) these channels belong to
        for (const channelId of channels) {
          const channel = interaction.client.channels.cache.get(channelId);
          const resolvedGuildId = channel?.guildId;
          if (!resolvedGuildId) continue;

          if (!isOwner && resolvedGuildId !== guildId) continue;

          if (!servers[resolvedGuildId]) servers[resolvedGuildId] = { tokens: [], nfts: [] };

          // Avoid dupes by address+chain within the server bucket
          const exists = servers[resolvedGuildId].nfts.some(n =>
            String(n.address || '').toLowerCase() === address.toLowerCase() &&
            String(n.chain || '').toLowerCase() === chain
          );

          if (!exists) {
            servers[resolvedGuildId].nfts.push({
              name,
              address,
              chain,
              channels
            });
          }
        }
      }
    } catch (err) {
      console.error('❌ NFT fetch error:', err);
    }

    // Add tokens into servers (owner sees all; others are already filtered)
    for (const token of tokens) {
      const gid = token.guild_id;
      if (!gid) continue;
      if (!isOwner && gid !== guildId) continue;
      if (!servers[gid]) servers[gid] = { tokens: [], nfts: [] };
      servers[gid].tokens.push(token);
    }

    // If nothing
    const serverEntries = Object.entries(servers);
    if (!serverEntries.length) {
      const empty = new EmbedBuilder()
        .setTitle('🛠️ Tracker Overview')
        .setDescription('No trackers found for your scope.')
        .setColor(0x2ecc71)
        .setFooter({ text: 'Powered by MuscleMB 💪' })
        .setTimestamp();

      return interaction.editReply({ embeds: [empty], flags: EPHEMERAL_FLAG });
    }

    // Sort servers by name
    serverEntries.sort((a, b) => {
      const ga = interaction.client.guilds.cache.get(a[0])?.name || a[0];
      const gb = interaction.client.guilds.cache.get(b[0])?.name || b[0];
      return ga.localeCompare(gb);
    });

    // Build embeds (one per server, plus overflow pages if needed)
    const embeds = [];
    for (const [srvId, data] of serverEntries) {
      const guild = interaction.client.guilds.cache.get(srvId);
      const serverName = guild ? guild.name : `Unknown Server (${srvId})`;

      // Sort lists
      const tokenList = (data.tokens || []).slice().sort((x, y) => String(x.name || '').localeCompare(String(y.name || '')));
      const nftList = (data.nfts || []).slice().sort((x, y) => String(x.name || '').localeCompare(String(y.name || '')));

      const baseEmbed = new EmbedBuilder()
        .setTitle(`🛠️ Tracker Overview — ${serverName}`)
        .setColor(0x2ecc71)
        .setFooter({ text: 'Powered by MuscleMB 💪' })
        .setTimestamp();

      baseEmbed.setDescription(
        `**Totals:** 💰 Tokens **${tokenList.length}** • 📦 NFTs **${nftList.length}**`
      );

      // Build sections as chunks that fit field limits
      const tokenLines = tokenList.length
        ? tokenList.map(t => `• **${t.name || 'Token'}** — \`${shortAddr(t.address)}\``)
        : ['• _No tokens tracked_'];

      const nftLines = nftList.length
        ? nftList.map(n => {
            const chText = formatChannelMentions(n.channels, 8);
            return `• ${chainEmoji(n.chain)} **${n.name || 'NFT'}** — ${linkAddr(n.address, n.chain)}\n  📍 ${chText}`;
          })
        : ['• _No NFTs tracked_'];

      // Helper: add as multiple fields if needed
      const addChunkedField = (embed, title, lines) => {
        const text = lines.join('\n');
        const chunks = text.match(/[\s\S]{1,1024}/g) || ['_Empty_'];
        chunks.forEach((chunk, idx) => {
          embed.addFields({
            name: idx === 0 ? title : `${title} (cont.)`,
            value: chunk
          });
        });
      };

      addChunkedField(baseEmbed, '💰 Tokens', tokenLines);
      addChunkedField(baseEmbed, '📦 NFTs', nftLines);

      // Discord hard limit: 25 fields per embed. If we exceed, split.
      const fields = baseEmbed.data.fields || [];
      if (fields.length <= 25) {
        embeds.push(baseEmbed);
      } else {
        // Split into multiple embeds, preserving header/desc
        const header = {
          title: baseEmbed.data.title,
          description: baseEmbed.data.description,
          color: baseEmbed.data.color,
          footer: baseEmbed.data.footer,
          timestamp: baseEmbed.data.timestamp
        };

        let page = new EmbedBuilder()
          .setTitle(header.title)
          .setDescription(header.description)
          .setColor(header.color)
          .setFooter(header.footer)
          .setTimestamp();

        let count = 0;
        for (const f of fields) {
          if (count >= 25) {
            embeds.push(page);
            page = new EmbedBuilder()
              .setTitle(`${header.title} (cont.)`)
              .setDescription(header.description)
              .setColor(header.color)
              .setFooter(header.footer)
              .setTimestamp();
            count = 0;
          }
          page.addFields(f);
          count++;
        }
        embeds.push(page);
      }
    }

    // If too many embeds (Discord limit per message is 10), trim and warn
    if (embeds.length > 10) {
      const trimmed = embeds.slice(0, 10);
      trimmed[trimmed.length - 1].addFields({
        name: '⚠️ Truncated',
        value: `Too many trackers to display in one response. Showing first 10 pages.`,
      });
      return interaction.editReply({ embeds: trimmed, flags: EPHEMERAL_FLAG });
    }

    return interaction.editReply({ embeds, flags: EPHEMERAL_FLAG });
  }
};









