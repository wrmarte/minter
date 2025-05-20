const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { Contract, JsonRpcProvider } = require('ethers');
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

    try {
      // Get contract address for this channel
      const res = await pg.query(`
        SELECT contract_address FROM contract_watchlist
        WHERE $1 = ANY(channel_ids)
        LIMIT 1
      `, [channelId]);

      if (res.rows.length === 0) {
        return interaction.editReply('❌ No contract is tracked for this channel.');
      }

      const contractAddress = res.rows[0].contract_address;
      const provider = new JsonRpcProvider(process.env.RPC_URL);
      const contract = new Contract(contractAddress, abi, provider);

      const totalSupply = await contract.totalSupply();
      const tokenId = Math.floor(Math.random() * totalSupply.toNumber());

      const tokenURI = await contract.tokenURI(tokenId);
      const meta = await fetch(tokenURI).then(r => r.json());

      const image = meta.image || meta.image_url || null;
      const name = meta.name || `Token #${tokenId}`;
      const traits = meta.attributes?.map(attr => `${attr.trait_type}: ${attr.value}`).join(' | ') || 'No traits';
      const rarity = meta.rarity || '???';

      const surpriseEmojis = ['🔥', '💎', '🧊', '🌊', '⚡', '🐋', '🫧', '👑'];
      const emoji = surpriseEmojis[Math.floor(Math.random() * surpriseEmojis.length)];

      const embed = new EmbedBuilder()
        .setTitle(`${name} ${emoji}`)
        .setDescription(`**Traits:** ${traits}\n**Rarity:** ${rarity}`)
        .setImage(image)
        .setFooter({ text: `Token #${tokenId} • Contract: ${contractAddress}` });

      return interaction.editReply({ embeds: [embed] });

    } catch (err) {
      console.error('❌ Error in /flex:', err);
      return interaction.editReply('❌ Something went wrong while flexing this NFT.');
    }
  }
};


