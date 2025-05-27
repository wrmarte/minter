const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

// Create /temp folder if it doesn't exist
const tempDir = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

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
      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found for this server. Use `/addflex` first.');
      }

      const { address, network } = res.rows[0];

      // Random token ID for display purposes
      const tokenId = Math.floor(Math.random() * 10000);
      const imageUrl = `https://api.reservoir.tools/render/${network}/${address}/${tokenId}`;

      const canvas = createCanvas(512, 512);
      const ctx = canvas.getContext('2d');

      const bg = '#000000';
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 512, 512);

      // Round rect mask
      const radius = 50;
      ctx.save();
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

      // Glowing ring
      ctx.beginPath();
      ctx.arc(256, 256, 240, 0, 2 * Math.PI);
      ctx.lineWidth = 20;
      ctx.strokeStyle = 'rgba(0,255,255,0.6)';
      ctx.shadowBlur = 30;
      ctx.shadowColor = '#0ff';
      ctx.stroke();

      const buffer = canvas.toBuffer('image/png');
      const filename = `spin_${Date.now()}.png`;
      const filepath = path.join(tempDir, filename);
      fs.writeFileSync(filepath, buffer);

      const attachment = new AttachmentBuilder(filepath).setName(filename);

      return interaction.editReply({
        content: `🎰 **Spin Flex:** \`${name}\` #${tokenId}\nReady to reveal...`,
        files: [attachment]
      });

    } catch (err) {
      console.error('❌ FlexSpin error:', err);
      return interaction.editReply('⚠️ Failed to spin NFT.');
    }
  }
};




