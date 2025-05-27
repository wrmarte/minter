// flexspin.js – Ultimate Visual Edition
const { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { randomInt } = require('crypto');
const { JsonRpcProvider, Contract } = require('ethers');

const abi = ['function totalSupply() view returns (uint256)', 'function tokenURI(uint256 tokenId) view returns (string)'];
const NETWORKS = {
  eth: 'https://eth.llamarpc.com',
  base: 'https://mainnet.base.org'
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexspin')
    .setDescription('Spin and flex a random NFT with epic visuals')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Flex project name')
        .setAutocomplete(true)
        .setRequired(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const guildId = interaction.guild.id;

    await interaction.deferReply();

    // 🎯 Fetch contract info
    const result = await pg.query('SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2', [guildId, name]);
    if (!result.rows.length) return interaction.editReply('❌ Project not found. Use `/addflex` first.');

    const project = result.rows[0];
    const provider = new JsonRpcProvider(NETWORKS[project.network]);
    const contract = new Contract(project.address, abi, provider);

    try {
      const total = await contract.totalSupply();
      const tokenId = randomInt(1, Number(total));
      const uri = await contract.tokenURI(tokenId);
      const metadata = await fetch(uri).then(r => r.json());
      const imageUrl = metadata.image || metadata.image_url;

      // 🎨 Canvas Spin
      const canvas = createCanvas(512, 512);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Simulate glowing pulse border
      ctx.shadowColor = '#0ff';
      ctx.shadowBlur = 30;
      ctx.strokeStyle = '#00ffff';
      ctx.lineWidth = 12;
      ctx.strokeRect(20, 20, 472, 472);

      // Load and draw NFT
      const nftImage = await loadImage(imageUrl);
      ctx.shadowBlur = 0;
      ctx.drawImage(nftImage, 36, 36, 440, 440);

      // Overlay rarity badge
      ctx.font = 'bold 28px Sans';
      ctx.fillStyle = '#ffffffdd';
      ctx.fillText('💎 RARE', 360, 50);

      const buffer = canvas.toBuffer('image/png');
      const filename = `spin_${Date.now()}.png`;
      const filepath = path.join(__dirname, `../temp/${filename}`);
      fs.writeFileSync(filepath, buffer);

      const attachment = new AttachmentBuilder(filepath);

      // Buttons
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('🔄 Reroll').setCustomId(`reroll_${name}`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setLabel('💾 Save').setCustomId(`save_${name}_${tokenId}`).setStyle(ButtonStyle.Secondary)
      );

      const embed = new EmbedBuilder()
        .setTitle('💫 Ultimate FlexSpin!')
        .setDescription(`Witness the rotation of rarity.
**${metadata.name}**
Token ID: #${tokenId}`)
        .setImage(`attachment://${filename}`)
        .setFooter({ text: '✨ Powered by PimpsDev' });

      await interaction.editReply({ embeds: [embed], files: [attachment], components: [buttons] });

      // Cleanup temp file
      setTimeout(() => fs.unlinkSync(filepath), 30000);
    } catch (err) {
      console.error('❌ FlexSpin error:', err);
      return interaction.editReply('⚠️ Failed to flexspin.');
    }
  }
};



