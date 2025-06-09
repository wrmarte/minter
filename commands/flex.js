const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { Contract } = require('ethers');
const { getProvider } = require('../services/provider');
const { fetchMetadata } = require('../utils/fetchMetadata');
const fetch = require('node-fetch');
const NodeCache = require("node-cache");

// ✅ Caching as before
const metadataCache = new NodeCache({ stdTTL: 900 });
const imageCache = new Map();

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

async function loadCachedImage(imageUrl) {
  if (imageCache.has(imageUrl)) return imageCache.get(imageUrl);
  const image = await loadImage(imageUrl);
  imageCache.set(imageUrl, image);
  return image;
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
      const res = await pg.query(
        `SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2`,
        [interaction.guild.id, name]
      );

      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, network } = res.rows[0];
      const chain = (network || 'base').toLowerCase();
      const provider = getProvider(chain);
      const contract = new Contract(address, abi, provider);
      let tokenId = tokenIdOption;

      // ✅ Hybrid token selection logic
      if (!tokenId) {
        if (chain === 'eth') {
          try {
            const reservoirUrl = `https://api.reservoir.tools/tokens/v6?collection=${address}&limit=50&sortBy=floorAskPrice`;
            const headers = { 'x-api-key': process.env.RESERVOIR_API_KEY };
            const resvRes = await fetch(reservoirUrl, { headers });
            const resvData = await resvRes.json();
            const tokens = resvData?.tokens?.map(t => t?.token?.tokenId).filter(Boolean) || [];

            if (tokens.length > 0) {
              tokenId = tokens[Math.floor(Math.random() * tokens.length)];
            } else {
              throw new Error('No tokens returned from Reservoir');
            }
          } catch {
            return interaction.editReply('⚠️ Could not fetch any minted tokens from Reservoir for this ETH project.');
          }
        } else {
          const totalSupply = await contract.totalSupply();
          if (parseInt(totalSupply) === 0) {
            return interaction.editReply('⚠️ No NFTs minted yet.');
          }
          tokenId = Math.floor(Math.random() * parseInt(totalSupply)).toString();
        }
      }

      const cacheKey = `${address}:${tokenId}:${chain}`;
      let metadata = metadataCache.get(cacheKey);
      if (!metadata) {
        metadata = await fetchMetadata(address, tokenId, chain);
        if (!metadata || !metadata.image) {
          return interaction.editReply('⚠️ Metadata not found for this token.');
        }
        metadataCache.set(cacheKey, metadata);
      }

      const imageUrl = metadata.image.startsWith('ipfs://')
        ? metadata.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
        : metadata.image;

      const traits = (metadata?.attributes || []).map(attr =>
        `• **${attr.trait_type}**: ${attr.value}`
      ).join('\n') || 'None found';

      const image = await loadCachedImage(imageUrl);
      const canvasSize = 480;
      const canvas = createCanvas(canvasSize, canvasSize);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvasSize, canvasSize);

      const { width, height } = image;
      const scale = Math.min(canvasSize / width, canvasSize / height);
      const scaledWidth = width * scale;
      const scaledHeight = height * scale;
      const offsetX = (canvasSize - scaledWidth) / 2;
      const offsetY = (canvasSize - scaledHeight) / 2;

      roundRect(ctx, 0, 0, canvasSize, canvasSize, 30);
      ctx.drawImage(image, offsetX, offsetY, scaledWidth, scaledHeight);
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
        .setColor(chain === 'base' ? 0x1d9bf0 : chain === 'ape' ? 0xff6600 : 0xf5851f)
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



