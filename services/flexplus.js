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

async function fetchWithTimeout(url, ms = 3000) {
  return Promise.race([
    fetch(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
}

async function resolveImage(meta) {
  if (!meta?.image) return null;
  const tryUrls = meta.image.startsWith('ipfs://')
    ? GATEWAYS.map(gw => gw + meta.image.replace('ipfs://', ''))
    : [meta.image];

  const promises = tryUrls.map(async (url) => {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error('Bad response');
      const buf = Buffer.from(await res.arrayBuffer());
      return await loadImage(buf);
    } catch (err) {
      return null;
    }
  });

  const results = await Promise.all(promises);
  return results.find(img => img !== null) || null;
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

    let alreadyAcknowledged = false;
    try {
      await interaction.deferReply();
    } catch {
      alreadyAcknowledged = true;
    }

    try {
      const res = await pg.query(`SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2`, [
        interaction.guild.id,
        name
      ]);
      if (!res.rows.length) {
        if (!alreadyAcknowledged) {
          return await interaction.editReply('❌ Project not found. Use `/addflex` first.');
        } else return;
      }

      const { address, network } = res.rows[0];
      const chain = network;
      const provider = getProvider(chain);
      const contract = new Contract(address, ['function totalSupply() view returns (uint256)'], provider);

      let maxTokenId = 50;
      try {
        const supply = await contract.totalSupply();
        maxTokenId = parseInt(supply?.toString()) || 50;
      } catch {}

      const selectedIds = [];
      const metas = [];

      for (let tries = 0; tries < 200 && metas.length < 6; tries++) {
        const id = Math.floor(Math.random() * maxTokenId);
        if (selectedIds.includes(id)) continue;
        const meta = await fetchMetadata(address, id, chain, provider);
        const image = await resolveImage(meta);
        if (image) {
          selectedIds.push(id);
          metas.push({ id, image });
        }
      }

      const columns = 3, rows = 2, imgSize = 280, spacing = 20, padding = 40;
      const canvasWidth = columns * imgSize + (columns - 1) * spacing + padding * 2;
      const canvasHeight = rows * imgSize + (rows - 1) * spacing + padding * 2;
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < metas.length; i++) {
        const { image } = metas[i];
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
        .setColor(chain === 'base' ? 0x1d9bf0 : chain === 'eth' ? 0xf5851f : 0xff6600)
        .setFooter({ text: '🔧 Powered by PimpsDev' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (err) {
      console.error('❌ FlexPlus Ultra Error:', err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply('⚠️ Something went wrong while generating the collage.');
      }
    }
  }
};

