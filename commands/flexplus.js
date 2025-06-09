const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { fetchMetadata } = require('../utils/fetchMetadata');

// Helper to sanitize IPFS URLs
function fixIpfs(url) {
  if (!url) return null;

  return url
    .replace('ipfs://', 'https://ipfs.io/ipfs/')
    .replace('https://cloudflare-ipfs.com/ipfs/', 'https://ipfs.io/ipfs/')
    .replace('https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/');
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
      const res = await pg.query(
        `SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2`,
        [interaction.guild.id, name]
      );

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
      } else {
        // Chain like Apechain, fallback to tokenURI fetch
        const tokenIds = Array.from({ length: 50 }, (_, i) => i); // 0–49
        for (let tokenId of tokenIds) {
          const meta = await fetchMetadata(address, tokenId, chain);
          if (meta?.image) {
            nfts.push({
              token_id: tokenId,
              metadata: JSON.stringify(meta),
              token_uri: `ipfs://${tokenId}.json` // dummy, not used after fetch
            });
          }
        }
      }

      if (!nfts.length) {
        return interaction.editReply('⚠️ No NFTs found.');
      }

      const selected = nfts.sort(() => 0.5 - Math.random()).slice(0, 6);

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

      for (let i = 0; i < selected.length; i++) {
        const nft = selected[i];
        let meta = {};

        try {
          if (nft.metadata) {
            meta = JSON.parse(nft.metadata || '{}');
          }

          if ((!meta || !meta.image) && nft.token_uri) {
            const uri = fixIpfs(nft.token_uri);
            meta = await fetch(uri).then(res => res.json());
          }
        } catch (err) {
          console.warn(`❌ Meta fetch failed for ${nft.token_id}: ${err.message}`);
          continue;
        }

        let imgUrl = meta?.image || meta?.image_url;
        if (!imgUrl) continue;
        imgUrl = fixIpfs(imgUrl);

        try {
          const nftImage = await loadImage(imgUrl);
          const x = padding + (i % columns) * (imgSize + spacing);
          const y = padding + Math.floor(i / columns) * (imgSize + spacing);

          roundRect(ctx, x, y, imgSize, imgSize);
          ctx.drawImage(nftImage, x, y, imgSize, imgSize);
        } catch {
          continue;
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


















