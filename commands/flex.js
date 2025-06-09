const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { Contract } = require('ethers');
const { getProvider } = require('../utils/provider');
const { fetchMetadata } = require('../utils/fetchMetadata');

const abi = [
  'function totalSupply() view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)'
];

function roundRect(ctx, x, y, width, height, radius = 20) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
  ctx.clip();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flex')
    .setDescription('Flex a random NFT or specific token ID from a project')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Project name')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(opt =>
      opt.setName('tokenid').setDescription('Token ID to flex (optional)')
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const tokenIdOption = interaction.options.getInteger('tokenid');
    await interaction.deferReply();

    try {
      const res = await pg.query(`SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2`, [
        interaction.guild.id,
        name
      ]);

      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, network } = res.rows[0];
      const chain = network;
      const provider = getProvider(chain);
      const contract = new Contract(address, abi, provider);

      let tokenId = tokenIdOption;

      if (!tokenId) {
        const totalSupply = await contract.totalSupply();
        tokenId = Math.floor(Math.random() * parseInt(totalSupply)).toString();
      }

      const metadata = await fetchMetadata(address, tokenId, chain);
      if (!metadata || !metadata.image) {
        return interaction.editReply('⚠️ Metadata not found for this token.');
      }

      const imageUrl = metadata.image.startsWith('ipfs://')
        ? metadata.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
        : metadata.image;

      const traits = (metadata?.attributes || []).map(attr =>
        `• **${attr.trait_type}**: ${attr.value}`
      ).join('\n') || 'None found';

      const image = await loadImage(imageUrl);
      const canvas = createCanvas(480, 480);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      roundRect(ctx, 0, 0, 480, 480, 30);
      ctx.drawImage(image, 0, 0, 480, 480);
      const buffer = canvas.toBuffer('image/png');
      const attachment = new AttachmentBuilder(buffer, { name: 'flex.png' });

      const chainDisplay = chain === 'base' ? 'Base' : chain === 'eth' ? 'Ethereum' : 'ApeChain';
      const openseaUrl = chain === 'eth'
        ? `https://opensea.io/assets/ethereum/${address}/${tokenId}`
        : `https://opensea.io/assets/${chain}/${address}/${tokenId}`;

      const embed = new EmbedBuilder()
        .setTitle(`🖼️ Flexing: ${name} #${tokenId}`)
        .setDescription(tokenIdOption ? `🎯 Specific token flexed` : `🎲 Random token flexed`)
        .setImage('attachment://flex.png')
        .setURL(openseaUrl)
        .setColor(network === 'base' ? 0x1d9bf0 : network === 'ape' ? 0xff6600 : 0xf5851f)
        .addFields({ name: '🧬 Traits', value: traits, inline: false })
        .setFooter({ text: `🔧 Powered by PimpsDev • ${chainDisplay}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });

    } catch (err) {
      console.error('❌ Error in /flex:', err);
      await interaction.editReply('⚠️ Something went wrong while flexing.');
    }
  }
};








