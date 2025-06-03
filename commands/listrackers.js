const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('listracker')
    .setDescription('🛠️ View currently tracked NFTs and Tokens (owner & server admins only)'),

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
      const tokenRes = await pg.query('SELECT name, address FROM tracked_tokens');
      tokens = tokenRes.rows;
    } catch (err) {
      console.error("Error fetching tokens:", err);
    }

    // Fetch NFTs (updated to flex_projects)
    try {
      const nftRes = await pg.query('SELECT name, contract_address FROM flex_projects');
      nfts = nftRes.rows;
    } catch (err) {
      console.error("Error fetching NFTs:", err);
    }

    const embed = new EmbedBuilder()
      .setTitle('🛠️ Current Trackers')
      .setColor(0x3498db)
      .addFields(
        {
          name: '💰 Tokens Tracked',
          value: tokens.length > 0 
            ? tokens.map(t => `• **${t.name}** — \`${t.address}\``).join('\n')
            : 'No tokens tracked.',
        },
        {
          name: '📦 NFTs Tracked',
          value: nfts.length > 0
            ? nfts.map(n => `• **${n.name}** — \`${n.contract_address}\``).join('\n')
            : 'No NFT contracts tracked.',
        }
      )
      .setFooter({ text: 'Powered by PimpsDev 🧪' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
};


