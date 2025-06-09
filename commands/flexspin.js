const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { Contract } = require('ethers');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { getProvider } = require('../utils/provider');
const { fetchMetadata } = require('../utils/fetchMetadata');

const abi = [
  'function totalSupply() view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)'
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexspin')
    .setDescription('🎰 Spin to flex a random NFT from a project')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Project name (from /addflex)')
        .setAutocomplete(true)
        .setRequired(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase().trim();
    const guildId = interaction.guild.id;

    await interaction.deferReply();

    try {
      const res = await pg.query(`SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2`, [guildId, name]);

      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, network } = res.rows[0];
      const chain = network;
      const provider = getProvider(chain);
      const contract = new Contract(address, abi, provider);

      const totalSupply = await contract.totalSupply().then(x => x.toString());
      const tokenId = Math.floor(Math.random() * totalSupply);

      // Always use your hybrid fetchMetadata here
      const metadata = await fetchMetadata(address, tokenId, chain);
      if (!metadata || !metadata.image) {
        return interaction.editReply('⚠️ Could not load metadata.');
      }

      const imageUrl = metadata.image.startsWith('ipfs://')
        ? metadata.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
        : metadata.image;

      const image = await loadImage(imageUrl);
      const size = 512;
      const canvas = createCanvas(size, size);
      const ctx = canvas.getContext('2d');
      const files = [];

      const angles = [0, 0.25, 0.5, 0.75, 1].map(n => n * Math.PI);

      for (let i = 0; i < angles.length; i++) {
        ctx.clearRect(0, 0, size, size);
        ctx.save();
        ctx.translate(size / 2, size / 2);
        ctx.rotate(angles[i]);
        ctx.beginPath();
        ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(image, -size / 2, -size / 2, size, size);
        ctx.restore();

        const filePath = path.join('/tmp', `spin_frame_${i}_${Date.now()}.png`);
        fs.writeFileSync(filePath, canvas.toBuffer('image/png'));
        files.push(new AttachmentBuilder(filePath, { name: `spin_frame_${i}.png` }));
        setTimeout(() => fs.existsSync(filePath) && fs.unlinkSync(filePath), 120000);
      }

      await interaction.editReply({
        content: `🎰 **FlexSpin Reveal!** Here's your spin from **${name}** #${tokenId}`,
        files
      });

    } catch (err) {
      console.error('❌ FlexSpin error:', err);
      await interaction.editReply('⚠️ Something went wrong during /flexspin.');
    }
  }
};









