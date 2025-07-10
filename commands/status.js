const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { Contract } = require('ethers');
const { getProvider } = require('../services/provider');

const erc721Abi = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function totalSupply() view returns (uint256)'
];

// ✅ Fallback counter if contract is not enumerable
async function countOwnedTokensFallback(contract, wallet) {
  let total = 0;
  try {
    const supply = await contract.totalSupply();
    for (let i = 0; i < supply; i++) {
      try {
        const owner = await contract.ownerOf(i);
        if (owner.toLowerCase() === wallet.toLowerCase()) {
          total++;
        }
      } catch (err) {
        continue; // skip burned/missing token
      }
    }
  } catch (err) {
    console.warn(`❌ Fallback count failed: ${err.message}`);
  }
  return total;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stake')
    .setDescription('Stake all NFTs from this server’s project using your wallet')
    .addStringOption(option =>
      option.setName('wallet')
        .setDescription('Your wallet address')
        .setRequired(true)),

  async execute(interaction) {
    const wallet = interaction.options.getString('wallet');
    const pg = interaction.client.pg;

    await interaction.deferReply();

    // ✅ Fetch the NFT contract for this server
    let contractRow;
    try {
      const res = await pg.query(
        `SELECT contract, name FROM flex_projects WHERE server_id = $1 LIMIT 1`,
        [interaction.guildId]
      );
      contractRow = res.rows[0];
    } catch (err) {
      return await interaction.editReply('❌ Failed to fetch contract for this server.');
    }

    if (!contractRow) {
      return await interaction.editReply('❌ No NFT contract is configured for this server.');
    }

    const provider = getProvider('base');
    const contract = new Contract(contractRow.contract, erc721Abi, provider);

    let nftCount = 0;
    try {
      // Primary method using balanceOf
      nftCount = await contract.balanceOf(wallet);

      // Try to verify each token if tokenOfOwnerByIndex exists
      const tokens = [];
      for (let i = 0; i < nftCount; i++) {
        try {
          const tokenId = await contract.tokenOfOwnerByIndex(wallet, i);
          tokens.push(tokenId.toString());
        } catch (err) {
          console.warn('⚠️ tokenOfOwnerByIndex failed. Falling back to full scan.');
          nftCount = await countOwnedTokensFallback(contract, wallet);
          break;
        }
      }
    } catch (err) {
      console.warn('⚠️ balanceOf failed. Using fallback.');
      nftCount = await countOwnedTokensFallback(contract, wallet);
    }

    // ✅ Display result
    const embed = new EmbedBuilder()
      .setTitle('🧱 Soft Stake Summary')
      .setColor(0x00bcd4)
      .setDescription([
        `🔹 **Project:** ${contractRow.name}`,
        `🔹 **Wallet:** \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\``,
        `🔹 **NFTs Detected:** ${nftCount}`
      ].join('\n'))
      .setFooter({ text: 'Soft Stake • MuscleMB' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
};







