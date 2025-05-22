const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const { getRealDexPriceForToken, getEthPriceFromToken } = require('../services/price');
const { shortWalletLink } = require('../utils/helpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mintest')
    .setDescription('Simulate a mint test'),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const channelId = interaction.channel.id;

    await interaction.deferReply({ ephemeral: true });

    const result = await pg.query(`SELECT * FROM contract_watchlist`);
    const filtered = result.rows.filter(row => row.channel_ids.includes(channelId));

    if (!filtered.length) {
      return interaction.editReply('❌ No tracked contracts for this channel.');
    }

    for (const { name, address, mint_price, mint_token, mint_token_symbol } of filtered) {
      const fakeQty = 3;
      const tokenAmount = mint_price * fakeQty;

      let ethValue = await getRealDexPriceForToken(tokenAmount, mint_token);
      if (!ethValue) {
        const fallback = await getEthPriceFromToken(mint_token);
        ethValue = fallback ? tokenAmount * fallback : null;
      }

      const embed = new EmbedBuilder()
        .setTitle(`🧪 Simulated Mint: ${name}`)
        .setDescription(`Minted by: ${shortWalletLink('0xFAKEWALLET123456789')}`)
        .addFields(
          { name: '🆔 Token IDs', value: '#1, #2, #3', inline: false },
          { name: `💰 Spent (${mint_token_symbol})`, value: tokenAmount.toFixed(4), inline: true },
          { name: `⇄ ETH Value`, value: ethValue ? `${ethValue.toFixed(4)} ETH` : 'N/A', inline: true },
          { name: '🔢 Total Minted', value: `${fakeQty}`, inline: true }
        )
        .setThumbnail('https://via.placeholder.com/400x400.png?text=Mint')
        .setColor(0x3498db)
        .setFooter({ text: 'Simulation Mode • Not Real' })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('🔗 View on OpenSea')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://opensea.io/assets/base/${address}/1`)
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
    }

    return interaction.editReply('✅ Mint test sent.');
  }
};
