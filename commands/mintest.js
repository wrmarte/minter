const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { shortWalletLink } = require('../utils/helpers');
const { getRealDexPriceForToken, getEthPriceFromToken } = require('../utils/pricing');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mintest')
    .setDescription('Simulate a mint test'),

  async execute(interaction, { pg }) {
    const channelId = interaction.channel.id;
    const result = await pg.query(`SELECT * FROM contract_watchlist`);

    const contracts = result.rows.filter(row => row.channel_ids.includes(channelId));
    if (!contracts.length) {
      return interaction.reply('❌ No tracked contracts for this channel.');
    }

    for (const { name, address, mint_price, mint_token, mint_token_symbol } of contracts) {
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
          { name: '🆔 Token IDs', value: '#1, #2, #3' },
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

    return interaction.reply({ content: '✅ Mint test sent.', ephemeral: true });
  }
};
