const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { JsonRpcProvider, Contract } = require('ethers');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const GIFEncoder = require('gifencoder');

const abi = ['function tokenURI(uint256 tokenId) view returns (string)', 'function totalSupply() view returns (uint256)'];

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
      const provider = new JsonRpcProvider(
        chain === 'base' ? 'https://mainnet.base.org' : 'https://eth.llamarpc.com'
      );

      let tokenId = tokenIdInput;
      if (!tokenId) {
        const contract = new Contract(address, abi, provider);
        const total = await contract.totalSupply();
        tokenId = Math.floor(Math.random() * Number(total));
      }

      const contract = new Contract(address, abi, provider);
      const uriRaw = await contract.tokenURI(tokenId);
      const uri = uriRaw.replace('ipfs://', 'https://ipfs.io/ipfs/');
      const meta = await fetch(uri).then(r => r.json());

      const imageUrl = (meta.image || meta.image_url || '').replace('ipfs://', 'https://ipfs.io/ipfs/');
      if (!imageUrl) return interaction.editReply('❌ Could not retrieve image.');

      const img = await loadImage(imageUrl);
      const size = 480;

      const encoder = new GIFEncoder(size, size);
      const canvas = createCanvas(size, size);
      const ctx = canvas.getContext('2d');

      const bufferChunks = [];
      encoder.createReadStream().on('data', chunk => bufferChunks.push(chunk));
      encoder.start();
      encoder.setRepeat(0);
      encoder.setDelay(60); // ms
      encoder.setQuality(10);

      for (let i = 0; i < 36; i++) {
        const angle = (i * 10 * Math.PI) / 180;
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, size, size);

        ctx.save();
        ctx.translate(size / 2, size / 2);
        ctx.rotate(angle);
        ctx.drawImage(img, -size / 2, -size / 2, size, size);
        ctx.restore();

        encoder.addFrame(ctx);
      }

      encoder.finish();
      const gifBuffer = Buffer.concat(bufferChunks);

      const attachment = new AttachmentBuilder(gifBuffer, { name: `spin-${name}-${tokenId}.gif` });

      await interaction.editReply({
        content: `🌀 Spinning NFT: **${name} #${tokenId}**`,
        files: [attachment]
      });

    } catch (err) {
      console.error('❌ Error in /flexspin:', err);
      return interaction.editReply('❌ Failed to generate spin. Check bot logs.');
    }
  }
};
