const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('listracker')
    .setDescription('🛠️ View tracked NFTs and Tokens across all servers'),

  async execute(interaction) {
    const pg = interaction.client.pg;

    // Load owner ID from .env
    const ownerId = process.env.BOT_OWNER_ID;
    const isOwner = interaction.user.id === ownerId;

    // Check if user is server admin
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
      const tokenRes = await pg.query('SELECT name, address, guild_id FROM tracked_tokens');
      tokens = tokenRes.rows;
    } catch (err) {
      console.error("Error fetching tokens:", err);
    }

    // Fetch NFTs (using channel_ids to resolve guilds)
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

    // Build server map
    const servers = {};

    // Group tokens by guild
    for (const token of tokens) {
      if (!servers[token.guild_id]) servers[token.guild_id] = { tokens: [], nfts: [] };
      servers[token.guild_id].tokens.push(token);
    }

    // Group NFTs by resolving guild from channel, with deduplication
    for (const nft of nfts) {
      const channel = interaction.client.channels.cache.get(nft.channel_id);
      const guildId = channel?.guildId || 'unknown';
      if (!servers[guildId]) servers[guildId] = { tokens: [], nfts: [] };

      // Deduplicate NFTs by contract address per server
      const alreadyTracked = servers[guildId].nfts.some(existing => existing.address.toLowerCase() === nft.address.toLowerCase());
      if (!alreadyTracked) {
        servers[guildId].nfts.push(nft);
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('🛠️ Full Tracker Overview')
      .setColor(0x3498db);

    for (const [guildId, data] of Object.entries(servers)) {
      let serverName = `Unknown Server (${guildId})`;
      const guild = interaction.client.guilds.cache.get(guildId);
      if (guild) serverName = guild.name;

      const tokenList = data.tokens.length > 0
        ? data.tokens.map(t => `• **${t.name}** — \`${t.address}\``).join('\n')
        : 'No tokens.';

      const nftList = data.nfts.length > 0
        ? data.nfts.map(n => `• **${n.name}** — \`${n.address}\``).join('\n')
        : 'No NFTs.';

      embed.addFields(
        { name: `📍 Server: ${serverName}`, value: '\u200b' },
        { name: '💰 Tokens', value: tokenList },
        { name: '📦 NFTs', value: nftList }
      );
    }

    embed.setFooter({ text: 'Powered by PimpsDev 🧪' }).setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
};





