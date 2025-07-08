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

async function timeoutFetch(url, ms = 6000) {
  return await Promise.race([
    fetch(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
}

function fixIpfs(url) {
  if (!url) return null;
  return url.startsWith('ipfs://') ? GATEWAYS[0] + url.replace('ipfs://', '') : url;
}

async function resolveImage(meta) {
  const imageUrl = fixIpfs(meta?.image);
  if (!imageUrl) return null;

  try {
    const res = await timeoutFetch(imageUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return await loadImage(buf);
  } catch (err) {
    console.warn(`❌ Failed to load image from ${imageUrl}:`, err.message);
    return null;
  }
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
        let total = 0;
        try {
          const raw = await nft1.totalSupply();
          total = parseInt(raw.toString()) || 50;
        } catch {}

        for (let i = 0; i < 100; i++) {
          const candidate = Math.floor(Math.random() * total);
          const meta1 = await fetchMetadata(contract1, candidate, network1, provider1);
          const meta2 = await fetchMetadata(contract2, candidate, network2, provider2);
          const img1 = await resolveImage(meta1);
          const img2 = await resolveImage(meta2);
          if (img1 && img2) {
            tokenId = candidate;
            break;
          }
        }

        if (tokenId == null) {
          return await interaction.editReply('❌ Could not find a valid token to flex.');
        }
      }

      const meta1 = await fetchMetadata(contract1, tokenId, network1, provider1);
      const meta2 = await fetchMetadata(contract2, tokenId, network2, provider2);

      const img1 = await resolveImage(meta1);
      const img2 = await resolveImage(meta2);

      if (!img1 || !img2) {
        return await interaction.editReply(`❌ Token #${tokenId} not available on one or both chains.`);
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

      return await interaction.editReply({ embeds: [embed], files: [attachment] });

    } catch (err) {
      console.error('❌ FlexDuo Error:', err);
      try {
        return await interaction.editReply('❌ Something went wrong. Try again later.');
      } catch (e) {
        console.warn('⚠️ Could not edit reply due to expired interaction.');
      }
    }
  }
};
