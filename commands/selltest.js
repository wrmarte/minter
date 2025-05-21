const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { shortWalletLink } = require('../utils/helpers');
const { JsonRpcProvider, Contract } = require('ethers');
const fetch = require('node-fetch');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('selltest')
    .setDescription('Simulate a sale alert'),

  async execute(interaction) {
    const fake = {
      seller: '0xSELLERFAKE000000000000000000000000000000',
      buyer: '0xBUYERFAKE000000000000000000000000000000',
      tokenId: 123,
      amount: 0.0242,
      currency: 'ETH',
      contract: '0xc38e2ae060440c9269cceb8c0ea8019a66ce8927'
    };

    let imageUrl = 'https://via.placeholder.com/400x400.png?text=SOLD';
    const provider = new JsonRpcProvider(process.env.RPC_URL);

    try {
      const uri = await new Contract(fake.contract, ['function tokenURI(uint256) view returns (string)'], provider).tokenURI(fake.tokenId);
      const resolvedUri = uri.startsWith('ipfs://') ? uri.replace('ipfs://', 'https://ipfs.io/ipfs/') : uri;
      const meta = await fetch(resolvedUri).then(res => res.json());
      if (meta?.image) {
        imageUrl = meta.image.startsWith('ipfs://')
          ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
          : meta.image;
      }
    } catch (e) {
      console.warn(`⚠️ selltest image fetch failed: ${e.message}`);
    }

    const embed = new EmbedBuilder()
      .setTitle(`💸 Sale Alert – CryptoPimps #${fake.tokenId}`)
      .setDescription(`NFT has been sold!`)
      .addFields(
        { name: '👤 Seller', value: shortWalletLink(fake.seller), inline: true },
        { name: '🧑‍💻 Buyer', value: shortWalletLink(fake.buyer), inline: true },
        { name: `💰 Paid (${fake.currency})`, value: `${fake.amount}`, inline: true }
      )
      .setURL(`https://opensea.io/assets/base/${fake.contract}/${fake.tokenId}`)
      .setThumbnail(imageUrl)
      .setColor(0x66cc66)
      .setFooter({ text: `Simulated • Not real sale` })
      .setTimestamp();

    await interaction.channel.send({ embeds: [embed] });
    return interaction.reply({ content: '✅ Sent simulated sale alert.', ephemeral: true });
  }
};
