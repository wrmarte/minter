const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { Contract } = require('ethers');
const { getProvider } = require('../services/provider');
const { fetchMetadata } = require('../utils/fetchMetadata');
const fetch = require('node-fetch');
const NodeCache = require("node-cache");

const metadataCache = new NodeCache({ stdTTL: 900 });

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
    try {
      await interaction.deferReply().catch(() => {});
    } catch (err) {
      console.warn('⚠️ Defer failed:', err.message);
      return;
    }

    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const tokenIdOption = interaction.options.getInteger('tokenid');

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

      if (!tokenId) {
        if (chain === 'eth') {
          try {
            const reservoirUrl = `https://api.reservoir.tools/tokens/v6?collection=${address}&limit=50&sortBy=floorAskPrice`;
            const headers = { 'x-api-key': process.env.RESERVOIR_API_KEY };
            const resvRes = await fetch(reservoirUrl, { headers });
            const resvData = await resvRes.json();
            const tokens = resvData?.tokens?.map(t => t?.token?.tokenId).filter(Boolean) || [];
            tokenId = tokens.length > 0
              ? tokens[Math.floor(Math.random() * tokens.length)]
              : Math.floor(Math.random() * 10000).toString();
          } catch {
            tokenId = Math.floor(Math.random() * 10000).toString();
          }
        } else {
          const totalSupply = await contract.totalSupply();
          tokenId = Math.floor(Math.random() * parseInt(totalSupply)).toString();
        }
      }

      const cacheKey = `${address}:${tokenId}:${chain}`;
      let metadata = metadataCache.get(cacheKey);
      if (!metadata) {
        metadata = await fetchMetadata(address, tokenId, chain);
        if (!metadata || !metadata.image) {
          return interaction.editReply('⚠️ Metadata not found or missing image.');
        }
        metadataCache.set(cacheKey, metadata);
      }

      const imageUrl = metadata.image?.startsWith('ipfs://')
        ? metadata.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
        : metadata.image;

      let image;
      try {
        const response = await fetch(imageUrl, { redirect: 'follow' });
        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        image = await loadImage(Buffer.from(arrayBuffer));
      } catch (err) {
        console.error(`❌ Image load error for ${tokenId}: ${imageUrl}`, err.message);
        return interaction.editReply('⚠️ Could not load NFT image.');
      }

      const traitsList = [];
      try {
        const rawTraits = Array.isArray(metadata?.attributes)
          ? metadata.attributes
          : Array.isArray(metadata?.traits)
            ? metadata.traits
            : [];

        rawTraits.forEach(t => {
          if (t?.trait_type && t?.value) {
            traitsList.push(`• **${t.trait_type}**: ${t.value}`);
          }
        });
      } catch (e) {
        console.warn(`⚠️ Trait parsing failed for #${tokenId}`);
      }

      const traits = traitsList.length ? traitsList.join('\n') : '⚠️ No traits found.';

      const canvasSize = 480;
      const canvas = createCanvas(canvasSize, canvasSize);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvasSize, canvasSize);

      const scale = Math.min(canvasSize / image.width, canvasSize / image.height);
      const scaledW = image.width * scale;
      const scaledH = image.height * scale;
      const x = (canvasSize - scaledW) / 2;
      const y = (canvasSize - scaledH) / 2;

      roundRect(ctx, 0, 0, canvasSize, canvasSize, 30);
      ctx.drawImage(image, x, y, scaledW, scaledH);
      const buffer = canvas.toBuffer('image/png');
      const attachment = new AttachmentBuilder(buffer, { name: 'flex.png' });

      const openseaUrl = chain === 'eth'
        ? `https://opensea.io/assets/ethereum/${address}/${tokenId}`
        : `https://opensea.io/assets/${chain}/${address}/${tokenId}`;

      const embed = new EmbedBuilder()
        .setTitle(`🖼️ Flexing: ${name} #${tokenId}`)
        .setDescription(tokenIdOption ? `🎯 Specific token flexed` : `🎲 Random token flexed`)
        .setImage('attachment://flex.png')
        .setURL(openseaUrl)
        .setColor(chain === 'base' ? 0x1d9bf0 : chain === 'eth' ? 0xf5851f : 0xff6600)
        .addFields({ name: '🧬 Traits', value: traits, inline: false })
        .setFooter({ text: `🔧 Powered by PimpsDev • ${chain.toUpperCase()}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });

    } catch (err) {
      console.error('❌ Flex command error:', err);
      await interaction.editReply('⚠️ Unexpected error while flexing.');
    }
  }
};
