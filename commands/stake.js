const { SlashCommandBuilder } = require('discord.js');
const { Contract } = require('ethers');
const { getProvider } = require('../services/providerM');

const erc721Abi = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stake')
    .setDescription('Stake all NFTs from this server’s project using your wallet')
    .addStringOption(option =>
      option.setName('wallet')
        .setDescription('Your wallet address')
        .setRequired(true)),

  async execute(interaction) {
    const wallet = interaction.options.getString('wallet').toLowerCase();
    const guildId = interaction.guild.id;
    const pg = interaction.client.pg;

    await interaction.deferReply({ ephemeral: true });

    // Get NFT contract for this server
    const res = await pg.query(`
      SELECT * FROM staking_projects WHERE guild_id = $1
    `, [guildId]);

    if (res.rowCount === 0) {
      return interaction.editReply('❌ No staking contract is set for this server. Ask an admin to use `/addstaking`.');
    }

    const project = res.rows[0];
    const contract = project.contract_address;
    const provider = getProvider(project.network || 'base');
    const nftContract = new Contract(contract, erc721Abi, provider);

    let tokenIds = [];

    try {
      const balance = await nftContract.balanceOf(wallet);
      const count = Number(balance); // ✅ FIXED

      if (count === 0) {
        return interaction.editReply(`❌ Wallet \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\` owns no NFTs from this project.`);
      }

      for (let i = 0; i < count; i++) {
        const tokenId = await nftContract.tokenOfOwnerByIndex(wallet, i);
        tokenIds.push(tokenId.toString());
      }
    } catch (err) {
      console.error('❌ Error fetching owned NFTs:', err);
      return interaction.editReply(`⚠️ Could not fetch NFT ownership. Make sure this contract supports ERC721Enumerable.`);
    }

    // Cleanup previously staked NFTs the user no longer owns
    const stakedRes = await pg.query(`
      SELECT token_id FROM staked_nfts
      WHERE wallet_address = $1 AND contract_address = $2
    `, [wallet, contract]);

    const previouslyStaked = stakedRes.rows.map(r => r.token_id);
    const stillOwnedSet = new Set(tokenIds);

    for (const tokenId of previouslyStaked) {
      if (!stillOwnedSet.has(tokenId)) {
        await pg.query(`
          DELETE FROM staked_nfts
          WHERE wallet_address = $1 AND contract_address = $2 AND token_id = $3
        `, [wallet, contract, tokenId]);
        console.log(`🧹 Removed unstaked token #${tokenId} from DB.`);
      }
    }

    // Save new NFTs (if not already staked)
    const insertQuery = `
      INSERT INTO staked_nfts (wallet_address, contract_address, token_id, network)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `;

    for (const tokenId of tokenIds) {
      try {
        await pg.query(insertQuery, [wallet, contract, tokenId, project.network || 'base']);
      } catch (err) {
        console.warn(`⚠️ Failed to insert token #${tokenId}:`, err.message);
      }
    }

    await interaction.editReply(`✅ ${tokenIds.length} NFT(s) now actively staked for wallet \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\`. Rewards will be distributed automatically.`);
  }
};

