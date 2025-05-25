const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { JsonRpcProvider, Contract } = require('ethers');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const abi = ['function tokenURI(uint256 tokenId) view returns (string)'];

function roundRect(ctx, x, y, width, height, radius = 20) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
  ctx.clip();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flex')
    .setDescription('Flex a random NFT from a project')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Project name').setRequired(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    await interaction.deferReply();

    try {
      const res = await pg.query(`SELECT * FROM flex_projects WHERE name = $1`, [name]);
      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, network } = res.rows[0];
      const chain = network === 'base' ? 'base' : 'ethereum';
      const provider = new JsonRpcProvider(
        chain === 'base'
          ? 'https://mainnet.base.org'
          : 'https://eth.llamarpc.com'
      );

      const apiUrl = `https://api.reservoir.tools/tokens/v6?chain=${chain}&contract=${address}&limit=50&sortBy=floorAskPrice&includeTopBid=true&includeAttributes=true`;
      const headers = { 'x-api-key': process.env.RESERVOIR_API_KEY };

      const data = await fetch(apiUrl, { headers }).then(res => res.json());
      const tokens = data?.tokens?.filter(t => t.token?.tokenId) || [];

      if (tokens.length) {
        const token = tokens[Math.floor(Math.random() * tokens.length)].token;
        const tokenId = token.tokenId;
        const imageUrl = token.image || 'https://via.placeholder.com/400x400.png?text=NFT';

        const attributes = token.attributes || [];
        const traitLines = attributes.length
          ? attributes.map(attr => `• **${attr.key}**: ${attr.value}`).join('\n')
          : 'None found';

        const image = await loadImage(imageUrl);
        const canvas = createCanvas(480, 480);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        roundRect(ctx, 0, 0, 480, 480, 30);
        ctx.drawImage(image, 0, 0, 480, 480);
        const buffer = canvas.toBuffer('image/png');
        const attachment = new AttachmentBuilder(buffer, { name: 'flex.png' });

        const embed = new EmbedBuilder()
          .setTitle(`🖼️ Flexing: ${name} #${tokenId}`)
          .setDescription(`🎲 Randomly flexed from ${name}`)
          .setImage('attachment://flex.png')
          .setURL(`https://opensea.io/assets/${chain}/${address}/${tokenId}`)
          .setColor(network === 'base' ? 0x1d9bf0 : 0xf5851f)
          .addFields({ name: '🧬 Traits', value: traitLines, inline: false })
          .setFooter({ text: '🔧 Powered by PimpsDev' })
          .setTimestamp();

        return await interaction.editReply({ embeds: [embed], files: [attachment] });
      }

      // Fallback to tokenURI
      const contract = new Contract(address, abi, provider);
      const tokenIds = Array.from({ length: 20 }, (_, i) => i).sort(() => 0.5 - Math.random());

      for (const tokenIdNum of tokenIds) {
        try {
          const tokenId = tokenIdNum.toString();
          const uriRaw = await contract.tokenURI(tokenId);
          const uri = uriRaw.replace('ipfs://', 'https://ipfs.io/ipfs/');
          const meta = await fetch(uri).then(res => res.json());
          const imageUrl = meta?.image?.replace('ipfs://', 'https://ipfs.io/ipfs/') || null;

          const traits = (meta?.attributes || [])
            .map(attr => `• **${attr.trait_type}**: ${attr.value}`)
            .join('\n') || 'None found';

          if (imageUrl) {
            const image = await loadImage(imageUrl);
            const canvas = createCanvas(480, 480);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#0d1117';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            roundRect(ctx, 0, 0, 480, 480, 30);
            ctx.drawImage(image, 0, 0, 480, 480);
            const buffer = canvas.toBuffer('image/png');
            const attachment = new AttachmentBuilder(buffer, { name: 'flex.png' });

            const embed = new EmbedBuilder()
              .setTitle(`🖼️ Flexing: ${name} #${tokenId}`)
              .setDescription(`🎲 Random fallback flex from ${name}`)
              .setImage('attachment://flex.png')
              .setURL(`https://opensea.io/assets/${chain}/${address}/${tokenId}`)
              .setColor(network === 'base' ? 0x1d9bf0 : 0xf5851f)
              .addFields({ name: '🧬 Traits', value: traits, inline: false })
              .setFooter({ text: '🔧 Powered by PimpsDev' })
              .setTimestamp();

            return await interaction.editReply({ embeds: [embed], files: [attachment] });
          }
        } catch {
          continue;
        }
      }

      return interaction.editReply('⚠️ No NFTs could be flexed. Nothing minted or accessible yet.');
    } catch (err) {
      console.error('❌ Error in /flex:', err);
      await interaction.editReply('⚠️ Something went wrong while flexing.');
    }
  }
};




