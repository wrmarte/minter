// commands/untrackmintplus.js
const {
  SlashCommandBuilder,
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

function shortAddr(addr = '') {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '';
}
function chainEmoji(chain) {
  const c = (chain || '').toLowerCase();
  if (c === 'base') return '🟦';
  if (c === 'eth' || c === 'ethereum') return '🟧';
  if (c === 'ape' || c === 'apechain') return '🐵';
  return '❓';
}
function normalizeChannels(channel_ids) {
  return Array.isArray(channel_ids)
    ? channel_ids
    : (channel_ids || '').toString().split(',').map(s => s.trim()).filter(Boolean);
}

/** Build the display + buttons for contracts tracked in THIS guild */
async function buildListForGuild(interaction, rows) {
  const guildId = interaction.guild.id;
  const client = interaction.client;

  // Filter to contracts that have at least one channel in this guild.
  const items = [];
  for (const row of rows) {
    const address = row.address || '';
    const name = row.name || 'Unknown';
    const chain = row.chain || 'unknown';
    const channels = normalizeChannels(row.channel_ids);

    const guildChannelIds = channels.filter(cid => {
      const ch = client.channels.cache.get(cid);
      return ch && ch.guildId === guildId;
    });
    if (guildChannelIds.length === 0) continue;

    // For label, we’ll show up to 3 mentions and count more.
    const mentions = [];
    for (const cid of guildChannelIds.slice(0, 3)) {
      const ch = client.channels.cache.get(cid);
      if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) {
        mentions.push(`<#${cid}>`);
      }
    }
    const extra = guildChannelIds.length > 3 ? ` +${guildChannelIds.length - 3} more` : '';
    const channelsDisplay = mentions.length ? mentions.join(' ') : `${guildChannelIds.length} channel(s)`;

    const label = `${chainEmoji(chain)} **${name}** • \`${shortAddr(address)}\` • ${channelsDisplay}${extra} • ${chain}`;
    const customId = `untrackmintplus:${encodeURIComponent(name)}|${encodeURIComponent(chain)}`;

    items.push({ label, customId });
  }

  if (items.length === 0) {
    return { content: '🧼 No mint/sale contracts are currently tracked in this server.', components: [] };
  }

  // Sort for stable view
  items.sort((a, b) => a.label.localeCompare(b.label));

  // Build up to 25 buttons (Discord limit). 5 per row.
  const rowsUI = [];
  for (let i = 0; i < Math.min(items.length, 25); i += 5) {
    const slice = items.slice(i, i + 5);
    const row = new ActionRowBuilder();
    slice.forEach(item => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(item.customId)
          .setLabel('Untrack')
          .setStyle(ButtonStyle.Danger)
      );
    });
    rowsUI.push(row);
  }

  const listStr = '📡 **Tracked contracts in this server**\n' + items.map(i => `• ${i.label}`).join('\n');
  return { content: listStr, components: rowsUI };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackmintplus')
    .setDescription('Show and untrack mint/sale contracts in this server (admins/bot owner only)'),

  // Slash command: show list with buttons
  async execute(interaction) {
    const pg = interaction.client.pg;
    const ownerId = process.env.BOT_OWNER_ID;

    const isAdmin = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
    const isOwner = interaction.user?.id === ownerId;
    if (!isAdmin && !isOwner) {
      return interaction.reply({
        content: '❌ Only server admins or the bot owner can use this command.',
        ephemeral: true,
      });
    }

    try {
      await interaction.deferReply({ ephemeral: true });
      const res = await pg.query(
        `SELECT name, address, chain, channel_ids
         FROM contract_watchlist
         ORDER BY name NULLS LAST`
      );

      const view = await buildListForGuild(interaction, res.rows);
      return interaction.editReply({ content: view.content, components: view.components });
    } catch (err) {
      console.error('❌ Error in /untrackmintplus (list):', err);
      return interaction.editReply('⚠️ Failed to fetch the tracked contracts for this server.');
    }
  },

  // Button handler: untrack for THIS guild only (remove its channels; delete row if none left)
  async handleButton(interaction) {
    const pg = interaction.client.pg;
    const ownerId = process.env.BOT_OWNER_ID;

    const isAdmin = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
    const isOwner = interaction.user?.id === ownerId;
    if (!isAdmin && !isOwner) {
      return interaction.reply({ content: '❌ Admins or bot owner only.', ephemeral: true });
    }

    const guildId = interaction.guild.id;

    // customId format: untrackmintplus:NAME|CHAIN (URL-encoded)
    const raw = interaction.customId.replace('untrackmintplus:', '');
    const [encName, encChain] = raw.split('|');
    const name = decodeURIComponent(encName || '').trim();
    const chain = decodeURIComponent(encChain || '').trim().toLowerCase();

    try {
      await interaction.deferReply({ ephemeral: true });

      // Find all rows for name+chain
      const sel = await pg.query(
        `SELECT name, address, chain, channel_ids
         FROM contract_watchlist
         WHERE name = $1 AND LOWER(chain) = $2`,
        [name, chain]
      );

      if (sel.rowCount === 0) {
        await interaction.editReply(`❌ No tracked contract named **${name}** on \`${chain}\`.`);
        return;
      }

      // Remove channels that belong to THIS guild. If any row ends up empty -> delete it.
      let anyChanged = false;
      for (const row of sel.rows) {
        const channels = normalizeChannels(row.channel_ids);
        if (channels.length === 0) continue;

        // Partition channels by guild
        const remaining = [];
        const client = interaction.client;
        for (const cid of channels) {
          const ch = client.channels.cache.get(cid);
          if (!ch || ch.guildId === guildId) {
            // drop channels for this guild (or invalid channels)
            continue;
          }
          remaining.push(cid);
        }

        if (remaining.length === channels.length) {
          // no channels removed for this row
          continue;
        }

        anyChanged = true;

        if (remaining.length === 0) {
          await pg.query(
            `DELETE FROM contract_watchlist
             WHERE name = $1 AND LOWER(chain) = $2 AND channel_ids = $3`,
            [row.name, row.chain.toLowerCase(), row.channel_ids]
          );
        } else {
          await pg.query(
            `UPDATE contract_watchlist
             SET channel_ids = $1
             WHERE name = $2 AND LOWER(chain) = $3 AND channel_ids = $4`,
            [remaining.join(','), row.name, row.chain.toLowerCase(), row.channel_ids]
          );
        }
      }

      if (!anyChanged) {
        await interaction.editReply(`ℹ️ **${name}** on \`${chain}\` wasn’t tracked in this server (nothing to remove).`);
      } else {
        await interaction.editReply(`🗑️ Untracked **${name}** on \`${chain}\` for this server.`);
      }

      // Rebuild the list and update the original list message if it exists
      try {
        const res = await pg.query(
          `SELECT name, address, chain, channel_ids
           FROM contract_watchlist
           ORDER BY name NULLS LAST`
        );
        const view = await buildListForGuild(interaction, res.rows);

        // If the user originally invoked the command and got a list, they'll still be on this ephemeral thread.
        await interaction.followUp({ content: view.content, components: view.components, ephemeral: true });
      } catch (e) {
        // Silent fail if we can't rebuild
      }
    } catch (err) {
      console.error('❌ Error in /untrackmintplus button:', err);
      return interaction.editReply('⚠️ Failed to untrack for this server.');
    }
  },
};




