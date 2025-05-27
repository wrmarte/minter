const {
  SlashCommandBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const fetch = require('node-fetch');
const { JsonRpcProvider, Contract } = require('ethers');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { writeFileSync, unlinkSync, mkdirSync, rmSync } = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function totalSupply() view returns (uint256)'
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexspin')
    .setDescription('Spin your NFT in a glorious animated flex')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Project name')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(opt =>
      opt.setName('tokenid')
        .setDescription('Token ID (optional)')
    ),

  async execute(interaction) {
    const isOwner = interaction.user.id === process.env.BOT_OWNER_ID;
    if (!isOwner) {
      return interaction.reply({
        content: '🚫 Only the bot owner can use this command.',
        ephemeral: true
      });
    }

    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const tokenIdInput = interaction.options.getInteger('tokenid');

    await interaction.deferReply();

    try {
      const res = await pg.query(`SELECT * FROM flex_projects WHERE name = $1 AND guild_id = $2`, [name, interaction.guild.id]);
      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, network } = res.rows[0];
      const chain = network === 'base' ? 'base' : 'eth';
      const provider = new JsonRpcProvider(chain === 'base' ? 'https://mainnet.base.org' : 'https://eth.llamarpc.com');

      let tokenId = tokenIdInput;
      const contract = new Contract(address, abi, provider);
      if (!tokenId) {
        const total = await contract.totalSupply();
        tokenId = Math.floor(Math.random() * Number(total));
      }

      const uriRaw = await contract.tokenURI(tokenId);
      const uri = uriRaw.replace('ipfs://', 'https://ipfs.io/ipfs/');
      const meta = await fetch(uri).then(r => r.json());

      const imageUrl = (meta.image || meta.image_url || '').replace('ipfs://', 'https://ipfs.io/ipfs/');
      if (!imageUrl) return interaction.editReply('❌ Could not retrieve image.');

      const img = await loadImage(imageUrl);
      const size = 480;
      const canvas = createCanvas(size, size);
      const ctx = canvas.getContext('2d');

      const tempDir = `./temp/spin-${Date.now()}`;
      mkdirSync(tempDir, { recursive: true });

      // Fetch rarity
      let rank = 'N/A';
      let score = 'N/A';
      try {
        const rarity = await fetch(`https://api.reservoir.tools/collections/${address}/tokens/${tokenId}/attributes?chain=${chain}`, {
          headers: { 'x-api-key': process.env.RESERVOIR_API_KEY }
        }).then(res => res.json());

        if (rarity?.rank) rank = `#${rarity.rank}`;
        if (rarity?.score) score = rarity.score.toFixed(2);
      } catch {
        console.warn(`⚠️ No rarity for ${name} #${tokenId}`);
      }

      const traits = meta.attributes?.map(attr =>
        `• **${attr.trait_type || attr.key}**: ${attr.value || attr.value}`
      ).join('\n') || 'None found';

      for (let i = 0; i < 36; i++) {
        const angle = (i * 10 * Math.PI) / 180;
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, size, size);

        // Glow border
        ctx.save();
        ctx.shadowColor = '#1d9bf0';
        ctx.shadowBlur = 24;
        ctx.translate(size / 2, size / 2);
        ctx.rotate(angle);
        ctx.drawImage(img, -size / 2, -size / 2, size, size);
        ctx.restore();

        // Rarity info
        ctx.fillStyle = 'white';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`${rank}`, size - 10, 30);
        ctx.fillText(`Score: ${score}`, size - 10, 52);

        // Traits reveal on final frame
        if (i === 35) {
          ctx.fillStyle = 'rgba(0,0,0,0.8)';
          ctx.fillRect(0, size - 140, size, 140);
          ctx.fillStyle = '#1db954';
          ctx.font = '18px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(`🧬 Traits`, 10, size - 115);
          ctx.fillStyle = 'white';
          ctx.font = '14px sans-serif';
          const lines = traits.split('\n');
          lines.forEach((line, index) => {
            ctx.fillText(line, 10, size - 90 + index * 18);
          });
        }

        const buffer = canvas.toBuffer('image/png');
        writeFileSync(path.join(tempDir, `frame${String(i).padStart(2, '0')}.png`), buffer);
      }

      const outputVideo = `./temp/spin-${Date.now()}.mp4`;
      execSync(`ffmpeg -y -framerate 12 -i ${tempDir}/frame%02d.png -c:v libx264 -pix_fmt yuv420p ${outputVideo}`);

      const attachment = new AttachmentBuilder(outputVideo, { name: `spin-${name}-${tokenId}.mp4` });

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('🔥 Rate')
          .setStyle(ButtonStyle.Primary)
          .setCustomId('rate_spin'),
        new ButtonBuilder()
          .setLabel('💾 Save')
          .setStyle(ButtonStyle.Secondary)
          .setCustomId('save_spin'),
        new ButtonBuilder()
          .setLabel('🚀 Boost')
          .setStyle(ButtonStyle.Success)
          .setCustomId('boost_spin')
      );

      await interaction.editReply({
        content: `🌀 **${name.toUpperCase()} #${tokenId}** spinning now...`,
        files: [attachment],
        components: [buttons]
      });

      rmSync(tempDir, { recursive: true, force: true });
      unlinkSync(outputVideo);

    } catch (err) {
      console.error('❌ Error in /flexspin:', err);
      return interaction.editReply('❌ Failed to generate spin. Check logs.');
    }
  }
};


