// ✅ /services/flexplus.js

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { fetchMetadata } = require('../utils/fetchMetadata');
const { getProvider } = require('../services/provider');

const GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/'
];

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

async function timeoutFetch(url, ms = 4000) {
  return await Promise.race([
    fetch(url, { timeout: ms }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
}

module.exports = {
  async execute(interaction, pg, name) {
    try {
      const res = await pg.query(
        `SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2`,
        [interaction.guild.id, name.toLowerCase()]
      );

      if (!res.rows.length) {
        return await interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, network } = res.rows[0];
      const chain = network;
      const maxTokenId = 50;
      const selectedIds = Array.from({ length: maxTokenId - 1 }, (_, i) => i + 1)
        .sort(() => 0.5 - Math.random())
        .slice(0, 6);

      const provider = getProvider(chain);
      const metas = await Promise.all(
        selectedIds.map(id => fetchMetadata(address, id, chain, provider))
      );

      const columns = 3, rows = 2, imgSize = 280, spacing = 20, padding = 40;
      const canvasWidth = columns * imgSize + (columns - 1) * spacing + padding * 2;
      const canvasHeight = rows * imgSize + (rows - 1) * spacing + padding * 2;
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await Promise.all(metas.map(async (meta, i) => {
        if (!meta?.image) return;

        const imgUrl = meta.image.startsWith('ipfs://')
          ? GATEWAYS.map(gw => gw + meta.image.replace('ipfs://', ''))[0]
          : meta.image;

        try {
          const response = await timeoutFetch(imgUrl, 5000);
          if (!response.ok) return;

          const arrayBuffer = await response.arrayBuffer();
          const nftImage = await loadImage(Buffer.from(arrayBuffer));

          const x = padding + (i % columns) * (imgSize + spacing);
          const y = padding + Math.floor(i / columns) * (imgSize + spacing);
          roundRect(ctx, x, y, imgSize, imgSize);
          ctx.drawImage(nftImage, x, y, imgSize, imgSize);
          ctx.restore();
        } catch (err) {
          console.warn(`⚠️ Failed to load image for token ${selectedIds[i]}:`, err.message);
        }
      }));

      const buffer = canvas.toBuffer('image/png');
      const attachment = new AttachmentBuilder(buffer, { name: 'flexplus.png' });

      const embed = new EmbedBuilder()
        .setTitle(`🖼️ Flex Collage: ${name}`)
        .setDescription(`Here's a random collage from ${name}`)
        .setImage('attachment://flexplus.png')
        .setColor(chain === 'base' ? 0x1d9bf0 : chain === 'eth' ? 0xf5851f : 0xff6600)
        .setFooter({ text: '🔧 Powered by PimpsDev' })
        .setTimestamp();

      return await interaction.editReply({ embeds: [embed], files: [attachment] });

    } catch (err) {
      console.error('❌ FlexPlus Ultra Error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '⚠️ Something went wrong with FlexPlus.', ephemeral: true });
      } else {
        await interaction.editReply('⚠️ Something went wrong while generating the collage.');
      }
    }
  }
};


