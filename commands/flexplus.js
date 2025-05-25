const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

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
      opt.setName('name').setDescription('Project name').setRequired(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    await interaction.deferReply();

    try {
      const res = await pg.query(`SELECT * FROM flex_projects WHERE name = $1`, [name]);
      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, network } = res.rows[0];
      const chain = network === 'base' ? 'base' : 'eth';

      const url = `https://deep-index.moralis.io/api/v2.2/nft/${address}?chain=${chain}&format=decimal&limit=50`;
      const headers = {
        accept: 'application/json',
        'X-API-Key': process.env.MORALIS_API_KEY
      };

      const moralisData = await fetch(url, { headers }).then(res => res.json());
      const nfts = moralisData?.result || [];

      if (!nfts.length) {
        return interaction.editReply('⚠️ No NFTs found via Moralis.');
      }

      const selected = nfts.sort(() => 0.5 - Math.random()).slice(0, 6);

      // 💎 Symmetrical layout
      const columns = 3;
      const rows = 2;
      const imgSize = 280;
      const spacing = 20;
      const padding = 40;

      const gridWidth = columns * imgSize + (columns - 1) * spacing;
      const gridHeight = rows * imgSize + (rows - 1) * spacing;

      const canvasWidth = gridWidth + padding * 2;
      const canvasHeight = gridHeight + padding * 2;

      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      // 🖤 Background
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 🧱 Draw grid centered
      for (let i = 0; i < selected.length; i++) {
        const nft = selected[i];
        let meta = {};
        try {
          if (nft.metadata) {
            meta = JSON.parse(nft.metadata || '{}');
          }
          if ((!meta || !meta.image) && nft.token_uri) {
            const uri = nft.token_uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
            meta = await fetch(uri).then(res => res.json());
          }
        } catch {}

        let img = null;
        if (meta.image) {
          img = meta.image.startsWith('ipfs://')
            ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
            : meta.image;
        } else if (meta.image_url) {
          img = meta.image_url.startsWith('ipfs://')
            ? meta.image_url.replace('ipfs://', 'https://ipfs.io/ipfs/')
            : meta.image_url;
        }

        if (!img) continue;

        let nftImage;
        try {
          nftImage = await loadImage(img);
        } catch {
          continue;
        }

        const x = padding + (i % columns) * (imgSize + spacing);
        const y = padding + Math.floor(i / columns) * (imgSize + spacing);

        // Draw only image with rounded corners, no border
        ctx.save();
        roundRect(ctx, x, y, imgSize, imgSize);
        ctx.drawImage(nftImage, x, y, imgSize, imgSize);
        ctx.restore();
      }

      const buffer = canvas.toBuffer('image/png');
      const attachment = new AttachmentBuilder(buffer, { name: 'flexplus.png' });

      const embed = new EmbedBuilder()
        .setTitle(`🖼️ Flex Collage: ${name}`)
        .setDescription(`Here's a random collage from ${name}`)
        .setImage('attachment://flexplus.png')
        .setColor(network === 'base' ? 0x1d9bf0 : 0xf5851f)
        .setFooter({ text: '🔧 Powered by PimpsDev' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (err) {
      console.error('❌ Error in /flexplus:', err);
      await interaction.editReply('⚠️ Something went wrong while generating the collage.');
    }
  }
};












