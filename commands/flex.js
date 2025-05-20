const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { Contract, Interface, JsonRpcProvider } = require('ethers');
const fetch = require('node-fetch');
const { shortWalletLink } = require('../utils/helpers');

const abi = [
  'function totalSupply() view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flex')
    .setDescription('Flex a random minted NFT from the tracked contract'),

  async execute(interaction, { pg }) {
    await interaction.deferReply();

    const channelId = interaction.channel.id;

    // 🔍 Find the contract tracked for this channel
    const res = await pg.query(`
      SELECT * FROM contract_watchlist
      WHERE $1 = ANY(channel_ids)
      LIMIT 1
    `, [channelId]);

    if (!res.rows.length) {
      return interaction.editReply({
        content: '❌ No contract is being tracked for this channel.',
      });
    }

    const contractData = res.rows[0];
    const provider = new JsonRpcProvider(process.env.RPC_URL);
    const contract = new Contract(contractData.address, abi, provider);

    let total = 0;
    try {
      total = await contract.totalSupply();
    } catch {
      total = 5000; // fallback cap
    }

    const maxAttempts = 15;
    for (let i = 0; i < maxAttempts; i++) {
      const tokenId = Math.floor(Math.random() * total);

      try {
        const owner = await contract.ownerOf(tokenId);
        let uri = await contract.tokenURI(tokenId);

        if (uri.startsWith('ipfs://')) {
          uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
        }

        const meta = await fetch(uri).then(r => r.json());

        const image = meta?.image?.startsWith('ipfs://')
          ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
          : meta.image;

        const embed = new EmbedBuilder()
          .setTitle(`🎯 Flexing #${tokenId}`)
          .setDescription(`Owner: ${shortWalletLink(owner)}`)
          .setImage(image || 'https://via.placeholder.com/400x400?text=NFT')
          .setColor(0xff0099)
          .setFooter({ text: `${contractData.name} • Powered by PimpsDev` })
          .setTimestamp();

        if (meta?.name || meta?.attributes) {
          embed.addFields(
            ...(meta.name ? [{ name: '🧬 Name', value: meta.name, inline: true }] : []),
            ...(meta.attributes?.length
              ? [{ name: '🧪 Traits', value: meta.attributes.map(attr => `${attr.trait_type}: ${attr.value}`).join('\n'), inline: false }]
              : [])
          );
        }

        return interaction.editReply({ embeds: [embed] });

      } catch {
        continue; // Try another tokenId
      }
    }

    return interaction.editReply({
      content: '😢 Could not find a minted token after several tries.',
    });
  }
};
