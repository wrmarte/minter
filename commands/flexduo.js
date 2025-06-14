const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { Contract } = require('ethers');
const { getProvider } = require('../utils/provider');
const { fetchMetadata } = require('../utils/fetchMetadata');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function totalSupply() view returns (uint256)'
];

function getTodayFormatted() {
  return new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexduo')
    .setDescription('Display a side-by-side duo of NFTs')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Duo name')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(opt =>
      opt.setName('tokenid').setDescription('Token ID to flex (optional)')
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const tokenIdInput = interaction.options.getInteger('tokenid');
    const guildId = interaction.guild.id;

    try {
      // ✅ Load duo config
      const result = await pg.query(
        'SELECT * FROM flex_duo WHERE guild_id = $1 AND name = $2',
        [guildId, name]
      );

      if (!result.rows.length) {
        return interaction.editReply('❌ Duo not found. Use `/addflexduo` first.');
      }

      const { contract1, network1, contract2, network2 } = result.rows[0];

      const provider1 = getProvider(network1);
      const provider2 = getProvider(network2);

      const nft1 = new Contract(contract1, abi, provider1);
      const nft2 = new Contract(contract2, abi, provider2);

      let tokenId = tokenIdInput;

      if (tokenId == null) {
        const totalSupply = await nft1.totalSupply();
        const total = typeof totalSupply === 'number' ? totalSupply : Number(totalSupply);
        if (total === 0) return interaction.editReply('❌ No tokens minted yet.');
        tokenId = Math.floor(Math.random() * total);
      }

      // ✅ Use hybridized fetchMetadata for both
      const meta1 = await fetchMetadata(contract1, tokenId, network1);
      const meta2 = await fetchMetadata(contract2, tokenId, network2);

      const image1 = meta1?.image?.replace('ipfs://', 'https://ipfs.io/ipfs/');
      const image2 = meta2?.image?.replace('ipfs://', 'https://ipfs.io/ipfs/');
      if (!image1 || !image2) throw new Error('Missing image URLs in metadata');

      const img1 = await loadImage(image1);
      const img2 = await loadImage(image2);

      const targetWidth = 400;
      const targetHeight = 400;
      const canvasPadding = 30;
      const labelHeight = 50;

      const canvasWidth = targetWidth * 2 + canvasPadding * 3;
      const canvasHeight = targetHeight + labelHeight + canvasPadding * 2;

      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      const x1 = canvasPadding;
      const x2 = x1 + targetWidth + canvasPadding;
      const y = canvasPadding;

      ctx.drawImage(img1, x1, y, targetWidth, targetHeight);
      ctx.drawImage(img2, x2, y, targetWidth, targetHeight);

      ctx.fillStyle = '#ccc';
      ctx.font = '22px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(meta1?.name || `#${tokenId}`, x1 + targetWidth / 2, y + targetHeight + 35);
      ctx.fillText(meta2?.name || `#${tokenId}`, x2 + targetWidth / 2, y + targetHeight + 35);

      const buffer = canvas.toBuffer('image/png');
      const attachment = new AttachmentBuilder(buffer, { name: `duo-${tokenId}.png` });

      const embed = new EmbedBuilder()
        .setTitle(`🎭 ${name.toUpperCase()} Duo #${tokenId}`)
        .setDescription(tokenIdInput ? `🎯 Specific token flexed` : `🎲 Randomly flexed`)
        .setImage(`attachment://duo-${tokenId}.png`)
        .setColor(0x0099ff)
        .setFooter({ text: `Powered by PimpsDev • ${getTodayFormatted()}` });

      await interaction.editReply({ embeds: [embed], files: [attachment] });

    } catch (err) {
      console.error('❌ FlexDuo error:', err);
      return interaction.editReply('❌ Something went wrong flexing that duo.\nCheck bot logs for more.');
    }
  }
};







