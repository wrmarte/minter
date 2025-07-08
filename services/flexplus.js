// ✅ Ultra-Patch /flexplus.js — resilient fetch with retries
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { fetchMetadata } = require('../utils/fetchMetadata');
const { getProvider } = require('../services/provider');
const { Contract } = require('ethers');

const GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/'
];

const abi = ['function totalSupply() view returns (uint256)'];

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

async function timeoutFetch(url, ms = 3000) {
  return await Promise.race([
    fetch(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
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

    try {
      await interaction.deferReply({ ephemeral: false });
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
      const totalSupply = await contract.totalSupply().catch(() => 10000);
      const maxAttempts = 20;

      const validMetas = [];
      const triedIds = new Set();

      while (validMetas.length < 6 && triedIds.size < maxAttempts) {
        const randomId = Math.floor(Math.random() * totalSupply);
        if (triedIds.has(randomId)) continue;
        triedIds.add(randomId);

        const meta = await fetchMetadata(address, randomId, chain, provider);
        if (!meta?.image) continue;

        const imgUrl = meta.image.startsWith('ipfs://')
          ? GATEWAYS.map(gw => gw + meta.image.replace('ipfs://', ''))[0]
          : meta.image;

        try {
          const res = await timeoutFetch(imgUrl);
          if (!res.ok) continue;
          const arrayBuffer = await res.arrayBuffer();
          const nftImage = await loadImage(Buffer.from(arrayBuffer));
          validMetas.push({ image: nftImage, id: randomId });
        } catch (e) {
          continue;
        }
      }

      if (!validMetas.length) {
        return interaction.editReply('❌ No images found to flex.');
      }

      const columns = 3, rows = 2, imgSize = 280, spacing = 20, padding = 40;
      const canvasWidth = columns * imgSize + (columns - 1) * spacing + padding * 2;
      const canvasHeight = rows * imgSize + (rows - 1) * spacing + padding * 2;
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < validMetas.length; i++) {
        const { image } = validMetas[i];
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
        .setDescription(`Showing ${validMetas.length} randomly minted NFTs from ${name}`)
        .setImage('attachment://flexplus.png')
        .setColor(chain === 'base' ? 0x1d9bf0 : chain === 'eth' ? 0xf5851f : 0xff6600)
        .setFooter({ text: '🔧 Powered by PimpsDev' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });

    } catch (err) {
      console.error('❌ FlexPlus Ultra Error:', err);
      if (!interaction.replied) {
        await interaction.editReply('⚠️ Something went wrong while generating the collage.');
      }
    }
  }
};

