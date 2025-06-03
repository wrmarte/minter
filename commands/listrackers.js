const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('listracker')
    .setDescription('🛠️ View currently tracked NFTs and Tokens (admin only)'),

  async execute(interaction) {
    const pg = interaction.client.pg;

    // OPTIONAL: Only allow owner (if you want, otherwise comment this out)
    const ownerId = 'YOUR_DISCORD_USER_ID';
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: '❌ You are not authorized to use this command.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    let tokens = [];
    let nfts = [];

    // Fetch tokens
    try {
      const tokenRes = await pg.query('SELECT name, address FROM tracked_tokens');
      tokens = tokenRes.rows;
    } catch (err) {
      console.error("Error fetching tokens:", err);
    }

    // Fetch NFTs
    try {
      const nftRes = await pg.query('SELECT contract_address FROM contract_watchlist');
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
            ? nfts.map(n => `• \`${n.contract_address}\``).join('\n')
            : 'No NFT contracts tracked.',
        }
      )
      .setFooter({ text: 'Powered by PimpsDev 🧪' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
};
