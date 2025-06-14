const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { Contract } = require('ethers');
const { getProvider } = require('../services/provider');
const { fetchMetadata } = require('../utils/fetchMetadata');

const GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/'
];

async function timeoutFetch(url, ms = 3000) {
  return await Promise.race([
    fetch(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
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
      opt.setName('tokenid')
        .setDescription('Token ID to flex (optional)')
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const tokenIdInput = interaction.options.getInteger('tokenid');
    const guildId = interaction.guild.id;

    await interaction.deferReply(); // ✅ Defer ASAP to prevent timeout

    try {
      const result = await pg.query(
        'SELECT * FROM flex_duo WHERE guild_id = $1 AND name = $2',
        [guildId, name]
      );

      if (!result.rows.length) {
        return interaction.editReply('❌ Duo not found. Use `/addflexduo` first.');
      }

      const { contract1, network1, contract2, network2 } = result.rows[0];

      const provider1 = await getProvider(network1);
      const provider2 = await getProvider(network2);

      const nft1 = new Contract(contract1, [
        'function tokenURI(uint256 tokenId) view returns (string)',
        'function totalSupply() view returns (uint256)'
      ], provider1);

      const nft2 = new Contract(contract2, [
        'function tokenURI(uint256 tokenId) view returns (string)'
      ], provider2);

      let tokenId = tokenIdInput;

      if (tokenId == null) {
        const total = Number(await nft1.totalSupply());
        if (!total || isNaN(total)) {
          return interaction.editReply('❌ No tokens minted yet.');
        }
        tokenId = Math.floor(Math.random() * total);
        if (tokenId === 0) tokenId = 1;
      }

      const meta1 = await fetchMetadata(contract1, tokenId, network1, provider1);
      const meta2 = await fetchMetadata(contract2, tokenId, network2, provider2);

      if (!meta1?.image || !meta2?.image) {
        return interaction.editReply(`❌ Token #${tokenId} not available on one or both chains. Try a different ID.`);
      }

      const imgUrl1 = meta1.image.startsWith('ipfs://')
        ? GATEWAYS.map(gw => gw + meta1.image.replace('ipfs://', ''))[0]
        : meta1.image;

      const imgUrl2 = meta2.image.startsWith('ipfs://')
        ? GATEWAYS.map(gw => gw + meta2.image.replace('ipfs://', ''))[0]
        : meta2.image;

      const [res1, res2] = await Promise.all([
        timeoutFetch(imgUrl1),
        timeoutFetch(imgUrl2)
      ]);

      if (!res1.ok || !res2.ok) {
        return interaction.editReply(`❌ Failed to load one or both images for token #${tokenId}`);
      }

      const img1 = await loadImage(Buffer.from(await res1.arrayBuffer()));
      const img2 = await loadImage(Buffer.from(await res2.arrayBuffer()));

      // Canvas settings
      const imgSize = 400;
      const spacing = 30;
      const labelHeight = 60;
      const padding = 40;
      const canvasWidth = imgSize * 2 + spacing + padding * 2;
      const canvasHeight = imgSize + labelHeight + padding * 2;

      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      const x1 = padding;
      const x2 = x1 + imgSize + spacing;
      const y = padding;

      ctx.drawImage(img1, x1, y, imgSize, imgSize);
      ctx.drawImage(img2, x2, y, imgSize, imgSize);

      ctx.fillStyle = '#eaeaea';
      ctx.font = '26px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(meta1?.name || `#${tokenId}`, x1 + imgSize / 2, y + imgSize + 40);
      ctx.fillText(meta2?.name || `#${tokenId}`, x2 + imgSize / 2, y + imgSize + 40);

      const buffer = canvas.toBuffer('image/png');
      const attachment = new AttachmentBuilder(buffer, { name: `duo-${tokenId}.png` });

      const embed = new EmbedBuilder()
        .setTitle(`🎭 Flex Duo: ${name.toUpperCase()} #${tokenId}`)
        .setDescription(tokenIdInput ? '🎯 Flexed specific token' : '🎲 Random flex duo')
        .setImage(`attachment://duo-${tokenId}.png`)
        .setColor(0x2e8b57)
        .setFooter({ text: '🧪 Powered by PimpsDev' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });

    } catch (err) {
      console.error('❌ FlexDuo Error:', err);
      if (!interaction.replied && !interaction.deferred) return;
      return interaction.editReply('❌ Something went wrong while flexing the duo. Try again.');
    }
  }
};




