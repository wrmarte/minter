const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { JsonRpcProvider, Contract } = require('ethers');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)'
];

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
      const chain = (network === 'base') ? 'base' : 'ethereum';
      const provider = new JsonRpcProvider(
        chain === 'base'
          ? 'https://mainnet.base.org'
          : 'https://eth.llamarpc.com'
      );

      const apiUrl = `https://api.reservoir.tools/tokens/v6?chain=${chain}&contract=${address}&limit=50&sortBy=floorAskPrice`;
      const headers = { 'x-api-key': process.env.RESERVOIR_API_KEY };

      const data = await fetch(apiUrl, { headers }).then(res => res.json());

      const tokens = data?.tokens?.filter(t => t.token?.tokenId) || [];

      if (!tokens.length) {
        // Fallback to tokenURI scraping
        const contract = new Contract(address, abi, provider);
        const tokenIds = Array.from({ length: 20 }, (_, i) => i).sort(() => 0.5 - Math.random());

        for (const tokenIdNum of tokenIds) {
          try {
            const tokenId = tokenIdNum.toString();
            const uriRaw = await contract.tokenURI(tokenId);
            const uri = uriRaw.replace('ipfs://', 'https://ipfs.io/ipfs/');
            const meta = await fetch(uri).then(res => res.json());
            const image = meta?.image?.replace('ipfs://', 'https://ipfs.io/ipfs/') || null;

            if (image) {
              const embed = new EmbedBuilder()
                .setTitle(`🖼️ Flexing from ${name}`)
                .setDescription(`Token #${tokenId} • 🎲 Random flex`)
                .setImage(image)
                .setURL(`https://opensea.io/assets/${chain}/${address}/${tokenId}`)
                .setColor(network === 'base' ? 0x1d9bf0 : 0xf5851f)
                .addFields({ name: '🔍 Rarity', value: 'Fetching...', inline: true })
                .setFooter({ text: `Network: ${network.toUpperCase()} (Fallback)` })
                .setTimestamp();

              return await interaction.editReply({ embeds: [embed] });
            }
          } catch {
            continue;
          }
        }

        return interaction.editReply('⚠️ No NFTs could be flexed. Nothing minted or accessible yet.');
      }

      const random = tokens[Math.floor(Math.random() * tokens.length)].token;
      const image = random.image || 'https://via.placeholder.com/400x400.png?text=NFT';
      const tokenId = random.tokenId;

      const embed = new EmbedBuilder()
        .setTitle(`🖼️ Flexing: ${name} #${tokenId}`)
        .setDescription(`🎲 Randomly flexed from ${name}`)
        .setImage(image)
        .setURL(`https://opensea.io/assets/${chain}/${address}/${tokenId}`)
        .setColor(network === 'base' ? 0x1d9bf0 : 0xf5851f)
        .addFields({ name: '🔍 Rarity', value: 'Fetching...', inline: true })
        .setFooter({ text: `Network: ${network.toUpperCase()}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Error in /flex:', err);
      await interaction.editReply('⚠️ Something went wrong while flexing.');
    }
  }
};


