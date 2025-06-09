const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { fetchMetadata } = require('../utils/fetchMetadata');

function fixIpfs(url) {
  if (!url) return null;
  return url.startsWith('ipfs://')
    ? url.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/')
    : url;
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexplus')
    .setDescription('Flex a collage of 6 random NFTs from a project')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Project name')
        .setRequired(true)
        .setAutocomplete(true)
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
      const chain = network; // eth, base, ape

      let nfts = [];

      if (chain === 'eth' || chain === 'base') {
        const url = `https://deep-index.moralis.io/api/v2.2/nft/${address}?chain=${chain}&format=decimal&limit=50`;
        const headers = {
          accept: 'application/json',
          'X-API-Key': process.env.MORALIS_API_KEY
        };

        const moralisData = await fetch(url, { headers }).then(res => res.json());
        nfts = moralisData?.result || [];
      }

      if (!nfts.length) {
        return interaction.editReply('⚠️ No NFTs found via Moralis.');
      }

      const selected = nfts.sort(() => 0.5 - Math.random()).slice(0, 6);

      const imagePromises = selected.map(async (nft, i) => {
        let meta = {};
        try {
          if (nft.metadata) meta = JSON.parse(nft.metadata);
          else if (nft.token_uri) {
            const uri = fixIpfs(nft.token_uri);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3500);
            try {
              const response = await fetch(uri, { signal: controller.signal });
              meta = await response.json();
              clearTimeout(timeout);
            } catch {
              clearTimeout(timeout);
            }
          }
        } catch {}

        let imgUrl = meta?.image?.startsWith('ipfs://')
          ? fixIpfs(meta.image)
          : meta?.image || meta?.image_url;

        if (!imgUrl) return null;

        try {
          const img = await loadImage(imgUrl);
          return { img, index: i };
        } catch {
          return null;
        }
      });

      const loadedImages = (await Promise.all(imagePromises)).filter(Boolean);

      // Canvas layout
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

      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < loadedImages.length; i++) {
        const { img, index } = loadedImages[i];
        const x = padding + (index % columns) * (imgSize + spacing);
        const y = padding + Math.floor(index / columns) * (imgSize + spacing);

        ctx.save();
        roundRect(ctx, x, y, imgSize, imgSize);
        ctx.drawImage(img, x, y, imgSize, imgSize);
        ctx.restore();
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
















