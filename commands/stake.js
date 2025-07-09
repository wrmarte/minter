const { SlashCommandBuilder } = require('discord.js');
const { Contract } = require('ethers');
const { getProvider } = require('../services/providerM');

const erc721Abi = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function totalSupply() view returns (uint256)'
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

    const res = await pg.query(`SELECT * FROM staking_projects WHERE guild_id = $1`, [guildId]);

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
      const count = Number(balance);

      for (let i = 0; i < count; i++) {
        try {
          const tokenId = await nftContract.tokenOfOwnerByIndex(wallet, i);
          tokenIds.push(tokenId.toString());
        } catch (e) {
          console.warn(`⚠️ tokenOfOwnerByIndex failed at index ${i}:`, e.message);
          throw new Error('non-enumerable');
        }
      }
    } catch (err) {
      if (err.message === 'non-enumerable') {
        console.log('🔁 Falling back to sweep method using ownerOf()');

        const fallbackRes = await pg.query(
          `SELECT token_ids FROM staked_wallets WHERE contract_address = $1`,
          [contract]
        );

        const seenTokenIds = new Set();
        fallbackRes.rows.forEach(row => {
          if (Array.isArray(row.token_ids)) {
            row.token_ids.forEach(id => seenTokenIds.add(id));
          }
        });

        const tokenIdRange = seenTokenIds.size > 0
          ? Array.from(seenTokenIds)
          : Array.from({ length: 1000 }, (_, i) => i);

        for (const id of tokenIdRange) {
          try {
            const owner = await nftContract.ownerOf(id);
            if (owner.toLowerCase() === wallet) {
              tokenIds.push(id.toString());
            }
          } catch (err) {
            // Likely not minted yet
          }
        }
      } else {
        console.error('❌ Error fetching owned NFTs:', err);
        return interaction.editReply(`⚠️ Could not fetch NFT ownership. Either the contract is not ERC721Enumerable or RPC is rate-limiting.`);
      }
    }

    if (tokenIds.length === 0) {
      return interaction.editReply(`❌ No NFTs detected in wallet \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\` for this project.`);
    }

    try {
      await pg.query(
        `INSERT INTO staked_wallets (wallet_address, contract_address, network, token_ids, staked_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (wallet_address, contract_address)
         DO UPDATE SET token_ids = $4, staked_at = NOW()`,
        [wallet, contract, project.network || 'base', tokenIds]
      );

      return interaction.editReply(`✅ ${tokenIds.length} NFT(s) now actively staked for wallet \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\`. Rewards will be distributed automatically.`);
    } catch (err) {
      console.error('❌ Error inserting into staked_wallets:', err);
      return interaction.editReply(`❌ Failed to stake NFTs due to database error.`);
    }
  }
};

