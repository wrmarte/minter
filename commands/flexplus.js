const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { fetchMetadata } = require('../utils/fetchMetadata');

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
      const res = await pg.query(`SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2`, [
        interaction.guild.id,
        name
      ]);
      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, network } = res.rows[0];
      const chain = network;
      const maxTokenId = 50;
      const selectedIds = Array.from({ length: maxTokenId - 1 }, (_, i) => i + 1)
      .sort(() => 0.5 - Math.random())
      .slice(0, 6);


      const columns = 3, rows = 2, imgSize = 280, spacing = 20, padding = 40;
      const canvasWidth = columns * imgSize + (columns - 1) * spacing + padding * 2;
      const canvasHeight = rows * imgSize + (rows - 1) * spacing + padding * 2;
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < selectedIds.length; i++) {
        const tokenId = selectedIds[i];
        let meta = await fetchMetadata(address, tokenId, chain);
        if (!meta?.image) {
          console.warn(`❌ No image found for token ${tokenId}`);
          continue;
        }

        let imgUrl = meta.image.startsWith('ipfs://')
          ? GATEWAYS.map(gw => gw + meta.image.replace('ipfs://', '')).find(async url => {
              try {
                const res = await fetch(url, { method: 'HEAD', timeout: 3000 });
                return res.ok;
              } catch { return false; }
            })
          : meta.image;

        if (!imgUrl) continue;

        try {
          const nftImage = await loadImage(imgUrl);
          const x = padding + (i % columns) * (imgSize + spacing);
          const y = padding + Math.floor(i / columns) * (imgSize + spacing);
          roundRect(ctx, x, y, imgSize, imgSize);
          ctx.drawImage(nftImage, x, y, imgSize, imgSize);
          ctx.restore();
        } catch (err) {
          console.warn(`❌ Failed to load image for token ${tokenId}:`, err.message);
        }
      }

      const buffer = canvas.toBuffer('image/png');
      const attachment = new AttachmentBuilder(buffer, { name: 'flexplus.png' });

      const embed = new EmbedBuilder()
        .setTitle(`🖼️ Flex Collage: ${name}`)
        .setDescription(`Here's a random collage from ${name}`)
        .setImage('attachment://flexplus.png')
        .setColor(chain === 'base' ? 0x1d9bf0 : chain === 'eth' ? 0xf5851f : 0xff6600)
        .setFooter({ text: '🔧 Powered by PimpsDev' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (err) {
      console.error('❌ Error in /flexplus:', err);
      await interaction.editReply('⚠️ Something went wrong while generating the collage.');
    }
  }
};



















