const { SlashCommandBuilder, PermissionsBitField, ChannelType } = require('discord.js');

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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackmintplus')
    .setDescription('Show all mint/sale contracts tracked in this server (admins/bot owner only)'),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const guild = interaction.guild;
    const ownerId = process.env.BOT_OWNER_ID;

    // ✅ Allow Admins OR Bot Owner only
    const isAdmin = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
    const isOwner = interaction.user?.id === ownerId;
    if (!isAdmin && !isOwner) {
      return interaction.reply({
        content: '❌ Only server admins or the bot owner can use this command.',
        ephemeral: true
      });
    }

    try {
      await interaction.deferReply({ ephemeral: true });

      const res = await pg.query(
        `SELECT name, address, chain, channel_ids
         FROM contract_watchlist
         ORDER BY name NULLS LAST`
      );

      const lines = [];

      for (const row of res.rows) {
        const address = row.address || '';
        const name = row.name || 'Unknown';
        const chain = row.chain || 'unknown';

        // Normalize channel_ids to an array of strings
        const channels = Array.isArray(row.channel_ids)
          ? row.channel_ids
          : (row.channel_ids || '')
              .toString()
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);

        // Filter to channels that belong to THIS guild
        const guildChannelIds = channels.filter(cid => {
          const ch = interaction.client.channels.cache.get(cid);
          return ch && ch.guildId === guild.id;
        });

        if (guildChannelIds.length === 0) continue;

        // Channel mentions (limit to first 3)
        const mentions = [];
        for (const cid of guildChannelIds.slice(0, 3)) {
          const ch = interaction.client.channels.cache.get(cid);
          if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) {
            mentions.push(`<#${cid}>`);
          }
        }
        const extra = guildChannelIds.length > 3 ? ` +${guildChannelIds.length - 3} more` : '';
        const channelsDisplay = mentions.length ? mentions.join(' ') : `${guildChannelIds.length} channel(s)`;

        const label = `${chainEmoji(chain)} **${name}** • \`${shortAddr(address)}\` • ${channelsDisplay}${extra} • ${chain}`;
        lines.push(label);
      }

      if (lines.length === 0) {
        return interaction.editReply('🧼 No mint/sale contracts are currently tracked in this server.');
      }

      lines.sort((a, b) => a.localeCompare(b));
      const msg = `📡 **Tracked contracts in this server**\n` + lines.map(l => `• ${l}`).join('\n');
      return interaction.editReply(msg);
    } catch (err) {
      console.error('❌ Error in /untrackmintplus (list-only):', err);
      return interaction.editReply('⚠️ Failed to fetch the tracked contracts for this server.');
    }
  }
};




