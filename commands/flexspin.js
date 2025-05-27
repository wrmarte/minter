const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { JsonRpcProvider, Contract } = require('ethers');

const tempDir = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const abi = ['function totalSupply() view returns (uint256)', 'function tokenURI(uint256) view returns (string)'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexspin')
    .setDescription('Spin a powerful NFT and flex its vibe!')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Flex project name')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async execute(interaction, { pg }) {
    const name = interaction.options.getString('name').toLowerCase().trim();
    const guildId = interaction.guild.id;

    await interaction.deferReply();

    try {
      const res = await pg.query(`SELECT * FROM flex_projects WHERE name = $1 AND guild_id = $2`, [name, guildId]);
      if (!res.rows.length) return interaction.editReply('❌ Project not found for this server. Use `/addflex` first.');

      const { address, network } = res.rows[0];

      let imageUrl = null;
      let tokenId = null;

      // --- Step 1: Try Reservoir first ---
      try {
        const reservoirUrl = `https://api.reservoir.tools/tokens/v6?collection=${address}&limit=1&sortBy=random&network=${network}`;
        const reservoirRes = await fetch(reservoirUrl, {
          headers: { 'x-api-key': process.env.RESERVOIR_API_KEY }
        });
        const json = await reservoirRes.json();
        const token = json?.tokens?.[0]?.token;
        if (token?.image && token?.tokenId) {
          imageUrl = token.image;
          tokenId = token.tokenId;
        }
      } catch (err) {
        console.warn('⚠️ Reservoir fallback triggered');
      }

      // --- Step 2: Moralis fallback if no image found ---
      if (!imageUrl) {
        const rpc = network === 'base' ? 'https://mainnet.base.org' : 'https://rpc.ankr.com/eth';
        const provider = new JsonRpcProvider(rpc);
        const contract = new Contract(address, abi, provider);
        const totalSupply = await contract.totalSupply().then(x => x.toString());
        tokenId = Math.floor(Math.random() * totalSupply);

        const moralisUrl = `https://deep-index.moralis.io/api/v2.2/nft/${address}/${tokenId}?chain=${network}&format=decimal`;
        const metadataRes = await fetch(moralisUrl, {
          headers: { 'X-API-Key': process.env.MORALIS_API_KEY }
        });
        const metadata = await metadataRes.json();
        const rawImage = metadata?.metadata ? JSON.parse(metadata.metadata).image : null;
        imageUrl = rawImage?.replace('ipfs://', 'https://ipfs.io/ipfs/') || null;
      }

      if (!imageUrl) return interaction.editReply('⚠️ Could not load NFT image from either API.');

      const canvas = createCanvas(512, 512);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 512, 512);

      ctx.save();
      const radius = 50;
      ctx.beginPath();
      ctx.moveTo(radius, 0);
      ctx.lineTo(512 - radius, 0);
      ctx.quadraticCurveTo(512, 0, 512, radius);
      ctx.lineTo(512, 512 - radius);
      ctx.quadraticCurveTo(512, 512, 512 - radius, 512);
      ctx.lineTo(radius, 512);
      ctx.quadraticCurveTo(0, 512, 0, 512 - radius);
      ctx.lineTo(0, radius);
      ctx.quadraticCurveTo(0, 0, radius, 0);
      ctx.closePath();
      ctx.clip();

      const nftImage = await loadImage(imageUrl);
      ctx.drawImage(nftImage, 0, 0, 512, 512);
      ctx.restore();

      ctx.beginPath();
      ctx.arc(256, 256, 240, 0, 2 * Math.PI);
      ctx.lineWidth = 20;
      ctx.strokeStyle = 'rgba(255,105,180,0.6)';
      ctx.shadowBlur = 30;
      ctx.shadowColor = '#ff69b4';
      ctx.stroke();

      const buffer = canvas.toBuffer('image/png');
      const filename = `spin_${Date.now()}.png`;
      const filepath = path.join(tempDir, filename);
      fs.writeFileSync(filepath, buffer);

      const attachment = new AttachmentBuilder(filepath).setName(filename);

      return interaction.editReply({
        content: `🎰 **Flex Spin:** \`${name}\` #${tokenId}\nLet it rip!`,
        files: [attachment]
      });

    } catch (err) {
      console.error('❌ FlexSpin error:', err);
      return interaction.editReply('⚠️ Failed to spin NFT.');
    }
  }
};





