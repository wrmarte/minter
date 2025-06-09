const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { Contract } = require('ethers');
const { getProvider } = require('../services/provider');

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
      const chain = network.toLowerCase();
      const provider = getProvider(chain);
      let nfts = [];

      // Moralis for ETH + BASE
      if (chain === 'eth' || chain === 'base') {
        const url = `https://deep-index.moralis.io/api/v2.2/nft/${address}?chain=${chain}&format=decimal&limit=50`;
        const headers = {
          accept: 'application/json',
          'X-API-Key': process.env.MORALIS_API_KEY
        };

        const moralisData = await fetch(url, { headers }).then(res => res.json());
        nfts = moralisData?.result || [];
      }

      // Fallback for APECHAIN (tokenURI loop)
      if (chain === 'ape') {
        const contract = new Contract(
          address,
          ['function totalSupply() view returns (uint256)'],
          provider
        );

        try {
          const total = await contract.totalSupply();
          const totalSupply = parseInt(total.toString());
          const max = Math.min(totalSupply, 50);

          for (let i = 0; i < max; i++) {
            nfts.push({ token_id: i.toString() });
          }
        } catch (err) {
          console.warn(`⚠️ Apechain totalSupply() failed: ${err.message}`);
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
      const canvas = createCanvas(gridWidth + padding * 2, gridHeight + padding * 2);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < selected.length; i++) {
        const nft = selected[i];
        let meta = {};
        let imgUrl = null;

        try {
          if (nft.metadata) {
            meta = JSON.parse(nft.metadata || '{}');
          } else if (nft.token_uri) {
            const uri = nft.token_uri.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
            meta = await fetch(uri).then(res => res.json());
          } else if (chain === 'ape') {
            const tokenId = nft.token_id;
            const contract = new Contract(address, ['function tokenURI(uint256) view returns (string)'], provider);
            const uri = await contract.tokenURI(tokenId);
            const fixed = uri.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/');
            meta = await fetch(fixed).then(res => res.json());
          }

          if (meta?.image) {
            imgUrl = meta.image.startsWith('ipfs://')
              ? meta.image.replace('ipfs://', 'https://cloudflare-ipfs.com/ipfs/')
              : meta.image;
          }
        } catch (err) {
          console.warn(`❌ Meta fetch failed for ${nft.token_id}: ${err.message}`);
          continue;
        }

        if (!imgUrl) continue;

        try {
          const nftImage = await loadImage(imgUrl);
          const x = padding + (i % columns) * (imgSize + spacing);
          const y = padding + Math.floor(i / columns) * (imgSize + spacing);

          ctx.save();
          roundRect(ctx, x, y, imgSize, imgSize);
          ctx.drawImage(nftImage, x, y, imgSize, imgSize);
          ctx.restore();
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

















