const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { JsonRpcProvider, Contract } = require('ethers');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const abi = [
  'function totalSupply() view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexspin')
    .setDescription('🎰 Spin to flex a random NFT from a project')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Project name (from /addflex)')
        .setAutocomplete(true)
        .setRequired(true)
    ),

  async execute(interaction, { pg }) {
    const name = interaction.options.getString('name').toLowerCase().trim();
    const guildId = interaction.guild.id;

    await interaction.deferReply();

    try {
      const res = await pg.query(`SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2`, [guildId, name]);
      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, network } = res.rows[0];
      let imageUrl = null;
      let tokenId = null;

      try {
        const reservoirUrl = `https://api.reservoir.tools/tokens/v6?collection=${address}&limit=1&sortBy=random&network=${network}`;
        const reservoirRes = await fetch(reservoirUrl, {
          headers: { 'x-api-key': process.env.RESERVOIR_API_KEY }
        });
        const json = await reservoirRes.json();
        const token = json?.tokens?.[0]?.token;
        if (token?.image && token?.tokenId) {
          imageUrl = token.image;
          tokenId = token.tokenId;
        }
      } catch (err) {
        console.warn('⚠️ Reservoir fallback triggered:', err.message);
      }

      if (!imageUrl) {
        try {
          const rpc = network === 'base' ? 'https://mainnet.base.org' : 'https://rpc.ankr.com/eth';
          const provider = new JsonRpcProvider(rpc);
          const contract = new Contract(address, abi, provider);
          const totalSupply = await contract.totalSupply().then(x => x.toString());
          tokenId = Math.floor(Math.random() * totalSupply);

          const moralisUrl = `https://deep-index.moralis.io/api/v2.2/nft/${address}/${tokenId}?chain=${network}&format=decimal`;
          const metadataRes = await fetch(moralisUrl, {
            headers: { 'X-API-Key': process.env.MORALIS_API_KEY }
          });
          const metadata = await metadataRes.json();
          const rawImage = metadata?.metadata ? JSON.parse(metadata.metadata)?.image : null;
          if (rawImage) {
            imageUrl = rawImage.replace('ipfs://', 'https://ipfs.io/ipfs/');
          }
        } catch (moralisError) {
          console.warn('⚠️ Moralis fallback failed:', moralisError.message);
        }
      }

      if (!imageUrl) {
        try {
          const rpc = network === 'base' ? 'https://mainnet.base.org' : 'https://rpc.ankr.com/eth';
          const provider = new JsonRpcProvider(rpc);
          const contract = new Contract(address, abi, provider);
          const tokenUri = await contract.tokenURI(tokenId);
          const fixedUri = tokenUri.replace('ipfs://', 'https://ipfs.io/ipfs/');
          const fallbackMeta = await fetch(fixedUri).then(res => res.json());
          imageUrl = fallbackMeta?.image?.replace('ipfs://', 'https://ipfs.io/ipfs/');
        } catch (err) {
          console.warn('⚠️ tokenURI fallback failed:', err.message);
        }
      }

      if (!imageUrl) {
        return interaction.editReply('⚠️ Could not load NFT image from any source.');
      }

      const image = await loadImage(imageUrl);
      const canvas = createCanvas(512, 512);
      const ctx = canvas.getContext('2d');
      const frameCount = 8;
      const angleStep = (Math.PI * 2) / frameCount;
      const filePath = path.join('/tmp', `spin_${Date.now()}.gif`);

      const { createWriteStream } = require('fs');
      const GIFEncoder = require('gifencoder');

      const encoder = new GIFEncoder(512, 512);
      encoder.createReadStream().pipe(createWriteStream(filePath));
      encoder.start();
      encoder.setRepeat(0);
      encoder.setDelay(100);
      encoder.setQuality(10);

      for (let i = 0; i < frameCount; i++) {
        ctx.clearRect(0, 0, 512, 512);
        ctx.save();
        ctx.translate(256, 256);
        ctx.rotate(i * angleStep);
        ctx.drawImage(image, -256, -256, 512, 512);
        ctx.restore();
        encoder.addFrame(ctx);
      }

      encoder.finish();

      const attachment = new AttachmentBuilder(filePath, { name: 'spin.gif' });
      await interaction.editReply({ content: `🎰 **FlexSpin!** Here's your NFT from **${name}** #${tokenId}`, files: [attachment] });

      setTimeout(() => fs.existsSync(filePath) && fs.unlinkSync(filePath), 60000);
    } catch (err) {
      console.error('❌ FlexSpin error:', err);
      await interaction.editReply('⚠️ Something went wrong during /flexspin.');
    }
  }
};








