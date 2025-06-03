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
        flags: 64
      });
    }

    await interaction.deferReply({ flags: 64 });

    let tokens = [];
    let nfts = [];

    // Fetch tokens
    try {
      if (isOwner) {
        const tokenRes = await pg.query('SELECT name, address, guild_id FROM tracked_tokens');
        tokens = tokenRes.rows;
      } else {
        const tokenRes = await pg.query('SELECT name, address, guild_id FROM tracked_tokens WHERE guild_id = $1', [guildId]);
        tokens = tokenRes.rows;
      }
    } catch (err) {
      console.error("Error fetching tokens:", err);
    }

    // Fetch NFTs
    try {
      const nftRes = await pg.query('SELECT name, address, channel_ids FROM contract_watchlist');
      nfts = nftRes.rows.flatMap(nft => {
        const channels = nft.channel_ids;
        if (!channels || channels.length === 0) return [];
        return channels.map(channelId => ({
          name: nft.name,
          address: nft.address,
          channel_id: channelId
        }));
      });
    } catch (err) {
      console.error("Error fetching NFTs:", err);
    }

    const servers = {};

    // Group tokens
    for (const token of tokens) {
      if (!servers[token.guild_id]) servers[token.guild_id] = { tokens: [], nfts: [] };
      servers[token.guild_id].tokens.push(token);
    }

    // Group NFTs with deduplication
    for (const nft of nfts) {
      const channel = interaction.client.channels.cache.get(nft.channel_id);
      const resolvedGuildId = channel?.guildId || 'unknown';
      if (!isOwner && resolvedGuildId !== guildId) continue;
      if (!servers[resolvedGuildId]) servers[resolvedGuildId] = { tokens: [], nfts: [] };

      const alreadyTracked = servers[resolvedGuildId].nfts.some(existing => existing.address.toLowerCase() === nft.address.toLowerCase());
      if (!alreadyTracked) {
        servers[resolvedGuildId].nfts.push(nft);
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('🛠️ Tracker Overview')
      .setColor(0x3498db);

    for (const [srvId, data] of Object.entries(servers)) {
      let serverName = `Unknown Server (${srvId})`;
      const guild = interaction.client.guilds.cache.get(srvId);
      if (guild) serverName = guild.name;

      const tokenList = data.tokens.length > 0
        ? data.tokens.map(t => `• **${t.name}**\n\`${t.address}\``).join('\n\n')
        : '• _No tokens tracked_';

      const nftList = data.nfts.length > 0
        ? data.nfts.map(n => `• **${n.name}**\n\`${n.address}\``).join('\n\n')
        : '• _No NFTs tracked_';

      embed.addFields(
        { name: `📍 **Server: ${serverName}**`, value: '\u200b' },
        { name: '💰 Tokens', value: tokenList },
        { name: '📦 NFTs', value: nftList }
      );
    }

    embed.setFooter({ text: 'Powered by PimpsDev 🧪' }).setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
};







