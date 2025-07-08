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

async function timeoutFetch(url, ms = 5000) {
  return await Promise.race([
    fetch(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
}

async function resolveImage(imageUrl) {
  const urls = imageUrl.startsWith('ipfs://')
    ? GATEWAYS.map(gw => gw + imageUrl.replace('ipfs://', ''))
    : [imageUrl];

  for (let url of urls) {
    try {
      const res = await timeoutFetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      return await loadImage(buf);
    } catch (err) {
      console.warn(`❌ Failed to load image from ${url}:`, err.message);
    }
  }
  return null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexduo')
    .setDescription('Display a side-by-side duo of NFTs')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Duo name (set via /addflexduo)')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(opt =>
      opt.setName('tokenid')
        .setDescription('Token ID to flex (optional)')
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name')?.toLowerCase();
    const tokenIdInput = interaction.options.getInteger('tokenid');
    const guildId = interaction.guild?.id;

    try {
      await interaction.deferReply({ ephemeral: false });
    } catch (err) {
      console.warn('⚠️ Interaction already acknowledged or expired.');
      return;
    }

    try {
      const result = await pg.query(
        'SELECT * FROM flex_duo WHERE guild_id = $1 AND name = $2',
        [guildId, name]
      );

      if (!result.rows.length) {
        return await interaction.editReply('❌ Duo not found. Use `/addflexduo` first.');
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
        tokenId = Math.max(1, Math.floor(Math.random() * total));
      }

      const [meta1, meta2] = await Promise.all([
        fetchMetadata(contract1, tokenId, network1, provider1),
        fetchMetadata(contract2, tokenId, network2, provider2)
      ]);

      if (!meta1?.image || !meta2?.image) {
        return await interaction.editReply(`❌ Token #${tokenId} not available on one or both chains.`);
      }

      const [img1, img2] = await Promise.all([
        resolveImage(meta1.image),
        resolveImage(meta2.image)
      ]);

      if (!img1 || !img2) {
        return await interaction.editReply(`❌ Failed to load images for token #${tokenId}`);
      }

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
      ctx.fillText(meta1?.name || `#${tokenId}`, x1 + imgSize / 2, y + imgSize + 35);
      ctx.fillText(meta2?.name || `#${tokenId}`, x2 + imgSize / 2, y + imgSize + 35);

      ctx.font = '20px sans-serif';
      ctx.fillStyle = '#aaaaaa';
      ctx.fillText(name.split(/[^a-z0-9]/i)[0] || 'Project 1', x1 + imgSize / 2, y + imgSize + 60);
      ctx.fillText(name.split(/[^a-z0-9]/i)[1] || 'Project 2', x2 + imgSize / 2, y + imgSize + 60);

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
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply('❌ Something went wrong. Try again later.');
      }
    }
  }
};



















