const { SlashCommandBuilder } = require('discord.js');
const { Contract } = require('ethers');
const { getProvider, safeRpcCall } = require('../services/providerM');

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
        .setRequired(true)
    ),

  async execute(interaction) {
    const wallet = interaction.options.getString('wallet').toLowerCase();
    const guildId = interaction.guild.id;
    const pg = interaction.client.pg;

    await interaction.deferReply({ ephemeral: true });

    // ✅ Fetch staking project info
    const res = await pg.query(`SELECT * FROM staking_projects WHERE guild_id = $1`, [guildId]);
    if (res.rowCount === 0) {
      return interaction.editReply('❌ No staking contract is set for this server. Ask an admin to use `/addstaking`.');
    }

    const project = res.rows[0];
    const contract = project.contract_address;
    const network = project.network || 'base';
    const provider = getProvider(network);
    const nftContract = new Contract(contract, erc721Abi, provider);

    let tokenIds = [];
    const scanned = new Set();

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
          console.warn(`⚠️ tokenOfOwnerByIndex failed at index ${i}: ${e.message}`);
          throw new Error('non-enumerable');
        }
      }
    } catch (err) {
      if (err.message === 'non-enumerable') {
        console.log('🔁 Falling back to ownerOf() sweeping...');

        let tokenIdRange = [];
        try {
          const total = await nftContract.totalSupply();
          const buffer = 250; // extra buffer for ongoing mints
          const limit = project.scan_limit || Math.min(Number(total) + buffer, 4000);
          tokenIdRange = Array.from({ length: limit }, (_, i) => i);
        } catch {
          console.warn('⚠️ totalSupply() unsupported. Defaulting to 2000 token sweep.');
          const limit = project.scan_limit || 2000;
          tokenIdRange = Array.from({ length: limit }, (_, i) => i);
        }

        const BATCH_SIZE = 10;
        for (let i = 0; i < tokenIdRange.length; i += BATCH_SIZE) {
          const batch = tokenIdRange.slice(i, i + BATCH_SIZE);

          const results = await Promise.all(
            batch.map(async (id) => {
              try {
                const owner = await safeRpcCall(network, async (prov) => {
                  const tempContract = new Contract(contract, erc721Abi, prov);
                  return await tempContract.ownerOf(id);
                });
                return { id, owner };
              } catch (err) {
                const msg = err?.message || '';
                const isCallException = msg.includes('CALL_EXCEPTION') || msg.includes('execution reverted');
                if (!isCallException) {
                  console.warn(`❌ Unexpected error for token ${id}:`, msg);
                }
                return null;
              }
            })
          );

          for (const res of results) {
            if (!res || !res.owner) continue;
            if (res.owner.toLowerCase() === wallet) {
              const idStr = res.id.toString();
              if (!scanned.has(idStr)) {
                tokenIds.push(idStr);
                scanned.add(idStr);
              }
            }
          }

          await new Promise((res) => setTimeout(res, 100)); // optional delay between batches
        }
      } else {
        console.error('❌ Unexpected error fetching NFTs:', err);
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
      `, [wallet, contract, network, tokenIds]);

      return interaction.editReply(`✅ ${tokenIds.length} NFT(s) now actively staked for wallet \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\`.`);
    } catch (err) {
      console.error('❌ Error inserting into staked_wallets:', err);
      return interaction.editReply(`❌ Failed to stake NFTs due to database error.`);
    }
  }
};




