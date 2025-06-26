const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');

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
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    let tokens = [];
    let nfts = [];
    const servers = {};

    // ✅ Fetch Tokens
    try {
      const tokenQuery = isOwner
        ? `SELECT name, address, guild_id FROM tracked_tokens`
        : `SELECT name, address, guild_id FROM tracked_tokens WHERE guild_id = $1`;
      const tokenRes = await pg.query(tokenQuery, isOwner ? [] : [guildId]);
      tokens = tokenRes.rows;
    } catch (err) {
      console.error('❌ Token fetch error:', err);
    }

    // ✅ Fetch NFTs (with full info)
    try {
      const nftQuery = isOwner
        ? `SELECT name, address, chain, guild_id, channel_ids FROM contract_watchlist`
        : `SELECT name, address, chain, guild_id, channel_ids FROM contract_watchlist WHERE guild_id = $1`;
      const nftRes = await pg.query(nftQuery, isOwner ? [] : [guildId]);

      for (const row of nftRes.rows) {
        const { name, address, chain, guild_id, channel_ids } = row;
        if (!servers[guild_id]) servers[guild_id] = { tokens: [], nfts: [] };

        servers[guild_id].nfts.push({
          name,
          address,
          chain,
          channels: channel_ids || []
        });
      }
    } catch (err) {
      console.error('❌ NFT fetch error:', err);
    }

    // ✅ Group Tokens by Server
    for (const token of tokens) {
      if (!servers[token.guild_id]) servers[token.guild_id] = { tokens: [], nfts: [] };
      servers[token.guild_id].tokens.push(token);
    }

    // ✅ Format Embed
    const embed = new EmbedBuilder()
      .setTitle('🛠️ Tracker Overview')
      .setColor(0x2ecc71);

    for (const [srvId, data] of Object.entries(servers)) {
      const guild = interaction.client.guilds.cache.get(srvId);
      const serverName = guild ? guild.name : `Unknown Server (${srvId})`;

      const tokenList = data.tokens.length
        ? data.tokens.map(t => `• **${t.name}**\n\`${t.address}\``).join('\n\n')
        : '• _No tokens tracked_';

      const nftList = data.nfts.length
        ? data.nfts.map(n => {
            const channels = n.channels.map(id => `<#${id}>`).join(', ') || '_No channels_';
            return `• **${n.name}** \`[${n.chain}]\`\n\`${n.address}\`\n📍 ${channels}`;
          }).join('\n\n')
        : '• _No NFTs tracked_';

      embed.addFields(
        { name: `📍 **Server: ${serverName}**`, value: '\u200b' },
        { name: '💰 Tokens', value: tokenList },
        { name: '📦 NFTs', value: nftList }
      );
    }

    embed.setFooter({ text: 'Powered by MuscleMB 💪' }).setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
};







