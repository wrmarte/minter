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
    const scanned = new Set();

    // ✅ Try ERC721Enumerable first
    try {
      const balance = await nftContract.balanceOf(wallet);
      const count = Number(balance);

      for (let i = 0; i < count; i++) {
        try {
          const tokenId = await nftContract.tokenOfOwnerByIndex(wallet, i);
          const idStr = tokenId.toString();
          if (!scanned.has(idStr)) {
            tokenIds.push(idStr);
            scanned.add(idStr);
          }
        } catch (e) {
          console.warn(`⚠️ tokenOfOwnerByIndex failed at index ${i}:`, e.message);
          throw new Error('non-enumerable');
        }
      }
    } catch (err) {
      if (err.message === 'non-enumerable') {
        console.log('🔁 Falling back to sweep method using ownerOf()');

        let tokenIdRange = [];

        try {
          const total = await nftContract.totalSupply();
          const limit = Math.min(Number(total) + 50, 3000);
          tokenIdRange = Array.from({ length: limit }, (_, i) => i);
        } catch {
          console.warn('⚠️ totalSupply() not supported. Scanning first 1000 tokens.');
          tokenIdRange = Array.from({ length: 1000 }, (_, i) => i);
        }

        for (const id of tokenIdRange) {
          try {
            const owner = await nftContract.ownerOf(id);
            if (owner.toLowerCase() === wallet) {
              const idStr = id.toString();
              if (!scanned.has(idStr)) {
                tokenIds.push(idStr);
                scanned.add(idStr);
              }
            }
          } catch {
            // token likely doesn't exist or burned
          }
        }
      } else {
        console.error('❌ Error fetching owned NFTs:', err);
        return interaction.editReply(`⚠️ Could not fetch NFT ownership. RPC issue or unsupported contract.`);
      }
    }

    if (tokenIds.length === 0) {
      return interaction.editReply(`❌ No NFTs detected in wallet \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\` for this project.`);
    }

    try {
      await pg.query(`
        INSERT INTO staked_wallets (wallet_address, contract_address, network, token_ids, staked_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (wallet_address, contract_address)
        DO UPDATE SET token_ids = $4, staked_at = NOW()
      `, [wallet, contract, project.network || 'base', tokenIds]);

      return interaction.editReply(`✅ ${tokenIds.length} NFT(s) now actively staked for wallet \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\`.`);
    } catch (err) {
      console.error('❌ Error inserting into staked_wallets:', err);
      return interaction.editReply(`❌ Failed to stake NFTs due to database error.`);
    }
  }
};

