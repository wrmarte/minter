const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { JsonRpcProvider, Contract } = require('ethers');
const fetch = require('node-fetch');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function totalSupply() view returns (uint256)'
];

const baseRpcs = [
  'https://mainnet.base.org',
  'https://base.publicnode.com',
  'https://1rpc.io/base',
  'https://base.llamarpc.com',
  'https://base.meowrpc.com'
];

let rpcIndex = 0;
let provider = new JsonRpcProvider(baseRpcs[rpcIndex]);

function rotateProvider() {
  rpcIndex = (rpcIndex + 1) % baseRpcs.length;
  provider = new JsonRpcProvider(baseRpcs[rpcIndex]);
  console.warn(`🔁 RPC switched to: ${baseRpcs[rpcIndex]}`);
}

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
      opt.setName('name').setDescription('Duo name').setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const guildId = interaction.guild.id;

    try {
      const result = await pg.query(
        'SELECT * FROM flex_duo WHERE guild_id = $1 AND name = $2',
        [guildId, name]
      );

      if (!result.rows.length) {
        return interaction.editReply('❌ Duo not found. Use `/addflexduo` first.');
      }

      const { contract1, contract2 } = result.rows[0];
      console.log(`📦 Using contracts:\n1️⃣ ${contract1}\n2️⃣ ${contract2}`);

      const nft1 = new Contract(contract1, abi, provider);
      const nft2 = new Contract(contract2, abi, provider);

      const totalSupply = await nft1.totalSupply();
      const total = typeof totalSupply === 'number' ? totalSupply : Number(totalSupply);

      if (total === 0) {
        return interaction.editReply('❌ No tokens minted yet.');
      }

      const tokenId = Math.floor(Math.random() * total);
      console.log(`🎯 Token ID: ${tokenId}`);

      const uri1 = await nft1.tokenURI(tokenId);
      const uri2 = await nft2.tokenURI(tokenId);

      const meta1 = await fetch(uri1.replace('ipfs://', 'https://ipfs.io/ipfs/')).then(res => res.json());
      const meta2 = await fetch(uri2.replace('ipfs://', 'https://ipfs.io/ipfs/')).then(res => res.json());

      const image1 = meta1.image?.replace('ipfs://', 'https://ipfs.io/ipfs/');
      const image2 = meta2.image?.replace('ipfs://', 'https://ipfs.io/ipfs/');

      if (!image1 || !image2) {
        throw new Error('Missing image URLs in metadata');
      }

      const img1 = await loadImage(image1);
      const img2 = await loadImage(image2);

      // Adjusted canvas for better spacing
      const canvasPadding = 50;
      const labelHeight = 40;
      const width = img1.width + img2.width + canvasPadding * 2;
      const height = Math.max(img1.height, img2.height) + labelHeight * 2;

      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');

      // Background
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);

      // Title text on top
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 30px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${name.toUpperCase()} DUO #${tokenId}`, width / 2, 40);

      // Draw images
      const imgY = labelHeight + 10;
      ctx.drawImage(img1, canvasPadding, imgY);
      ctx.drawImage(img2, canvasPadding + img1.width + canvasPadding, imgY);

      // Token labels under images
      ctx.fillStyle = '#dddddd';
      ctx.font = '22px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`#${tokenId}`, canvasPadding + img1.width / 2, imgY + img1.height + 30);
      ctx.fillText(`#${tokenId}`, canvasPadding * 2 + img1.width + img2.width / 2, imgY + img2.height + 30);

      const buffer = canvas.toBuffer('image/png');
      const attachment = new AttachmentBuilder(buffer, { name: `duo-${tokenId}.png` });

      const embed = new EmbedBuilder()
        .setTitle(`🎭 ${name.toUpperCase()} Duo #${tokenId}`)
        .setImage(`attachment://duo-${tokenId}.png`)
        .setColor(0x0099ff)
        .setFooter({ text: `Powered by PimpsDev • ${getTodayFormatted()}` });

      await interaction.editReply({ embeds: [embed], files: [attachment] });

    } catch (err) {
      rotateProvider();
      console.error('❌ FlexDuo error:', err);
      return interaction.editReply('❌ Something went wrong flexing that duo.\nCheck bot logs for more.');
    }
  }
};




