const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { fetchMetadata } = require('../utils/fetchMetadata');
const { getProvider } = require('../services/provider');

const GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/'
];

async function timeoutFetch(url, ms = 3000) {
  return await Promise.race([
    fetch(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
}

function roundRect(ctx, x, y, width, height, radius = 20) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
  ctx.clip();
}

async function tryLoadImage(meta) {
  if (!meta?.image) return null;

  const ipfsHash = meta.image.replace('ipfs://', '');
  const urls = meta.image.startsWith('ipfs://')
    ? GATEWAYS.map(gw => gw + ipfsHash)
    : [meta.image];

  for (const url of urls) {
    try {
      const res = await timeoutFetch(url);
      if (!res.ok) continue;
      const arrayBuffer = await res.arrayBuffer();
      return await loadImage(Buffer.from(arrayBuffer));
    } catch (err) {
      console.warn(`🌐 Image failed: ${url}`);
    }
  }

  return null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexplus')
    .setDescription('Flex a collage of 6 random NFTs from a project')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Project name').setRequired(true).setAutocomplete(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
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
      const provider = getProvider(network);

      const desiredCount = 6;
      const maxTokenId = 150;
      const selectedIds = [];

      for (let attempts = 0; selectedIds.length < desiredCount && attempts < 50; attempts++) {
        const randomId = Math.floor(Math.random() * maxTokenId) + 1;
        if (selectedIds.includes(randomId)) continue;

        const meta = await fetchMetadata(address, randomId, network, provider);
        const image = await tryLoadImage(meta);
        if (image) selectedIds.push({ id: randomId, image });
        else console.warn(`❌ Token ${randomId} skipped (no image).`);
      }

      if (selectedIds.length === 0) {
        return interaction.editReply('⚠️ Could not load any NFT images to display.');
      }

      const columns = 3, rows = 2, imgSize = 280, spacing = 20, padding = 40;
      const canvasWidth = columns * imgSize + (columns - 1) * spacing + padding * 2;
      const canvasHeight = rows * imgSize + (rows - 1) * spacing + padding * 2;
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < selectedIds.length; i++) {
        const { image } = selectedIds[i];
        const x = padding + (i % columns) * (imgSize + spacing);
        const y = padding + Math.floor(i / columns) * (imgSize + spacing);
        roundRect(ctx, x, y, imgSize, imgSize);
        ctx.drawImage(image, x, y, imgSize, imgSize);
        ctx.restore();
      }

      const buffer = canvas.toBuffer('image/png');
      const attachment = new AttachmentBuilder(buffer, { name: 'flexplus.png' });

      const embed = new EmbedBuilder()
        .setTitle(`🖼️ Flex Collage: ${name}`)
        .setDescription(`Here's a random collage from ${name}`)
        .setImage('attachment://flexplus.png')
        .setColor(network === 'base' ? 0x1d9bf0 : network === 'eth' ? 0xf5851f : 0xff6600)
        .setFooter({ text: '🔧 Powered by PimpsDev' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });

    } catch (err) {
      console.error('❌ Error in /flexplus:', err);
      await interaction.editReply('⚠️ Something went wrong while generating the collage.');
    }
  }
};

