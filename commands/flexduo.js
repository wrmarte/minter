const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
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
      console.log(`🔗 URIs:\n1️⃣ ${uri1}\n2️⃣ ${uri2}`);

      const meta1 = await fetch(uri1.replace('ipfs://', 'https://ipfs.io/ipfs/')).then(res => res.json());
      const meta2 = await fetch(uri2.replace('ipfs://', 'https://ipfs.io/ipfs/')).then(res => res.json());

      const image1 = meta1.image?.replace('ipfs://', 'https://ipfs.io/ipfs/');
      const image2 = meta2.image?.replace('ipfs://', 'https://ipfs.io/ipfs/');

      if (!image1 || !image2) {
        throw new Error('Missing image URLs in metadata');
      }

      const img1 = await loadImage(image1);
      const img2 = await loadImage(image2);

      const canvas = createCanvas(img1.width + img2.width + 60, Math.max(img1.height, img2.height) + 40);
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.drawImage(img1, 20, 20);
      ctx.drawImage(img2, img1.width + 40, 20);

      const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), {
        name: `duo-${tokenId}.png`
      });

      await interaction.editReply({
        content: `🧬 Duo Flex #${tokenId}`,
        files: [attachment]
      });

    } catch (err) {
      rotateProvider();
      console.error('❌ FlexDuo error:', err);
      return interaction.editReply('❌ Something went wrong flexing that duo.\nCheck bot logs for more.');
    }
  }
};

