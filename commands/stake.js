const { SlashCommandBuilder } = require('discord.js');
const { Contract } = require('ethers');
const { getProvider, safeRpcCall } = require('../services/providerM');

const erc721Abi = [
  'function ownerOf(uint256 tokenId) view returns (address)'
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

    const res = await pg.query(`SELECT * FROM staking_projects WHERE guild_id = $1`, [guildId]);
    if (res.rowCount === 0) {
      return interaction.editReply('❌ No staking contract is set for this server. Ask an admin to use `/addstaking`.');
    }

    const project = res.rows[0];
    const contract = project.contract_address.toLowerCase();
    const network = project.network || 'base';

    const provider = getProvider(network);
    const nftContract = new Contract(contract, erc721Abi, provider);

    const BATCH_SIZE = 10;
    const scanned = new Set();
    let tokenIds = [];
    let tokenId = 0;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 20;
    const scanLimit = project.scan_limit || 20000;

    await interaction.editReply(`Scanning NFTs... Starting from tokenId 0.`);

    while (tokenId < scanLimit && consecutiveErrors < maxConsecutiveErrors) {
      let batch = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        batch.push(tokenId);
        tokenId++;
      }

      const results = await Promise.all(
        batch.map(async (id) => {
          try {
            const owner = await safeRpcCall(network, async (prov) => {
              const tempContract = new Contract(contract, erc721Abi, prov);
              return await tempContract.ownerOf(id);
            });
            return { id, owner };
          } catch (error) {
            if (error.code === 'CALL_EXCEPTION') {
              consecutiveErrors++;
            }
            return null;
          }
        })
      );

      for (const res of results) {
        if (!res || !res.owner) continue;
        consecutiveErrors = 0;
        if (res.owner.toLowerCase() === wallet) {
          const idStr = res.id.toString();
          if (!scanned.has(idStr)) {
            tokenIds.push(idStr);
            scanned.add(idStr);
          }
        }
      }

      await interaction.editReply(`Scanning NFTs... Last checked tokenId: ${tokenId}. Found: ${tokenIds.length}. Consecutive errors: ${consecutiveErrors}/${maxConsecutiveErrors}`);
      await new Promise((res) => setTimeout(res, 100));
    }

    if (tokenIds.length === 0) {
      return interaction.editReply(`❌ No NFTs detected in wallet \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\` for this project.`);
    }

    await pg.query(`
      INSERT INTO staked_wallets (wallet_address, contract_address, network, token_ids, staked_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (wallet_address, contract_address)
      DO UPDATE SET token_ids = $4, staked_at = NOW()
    `, [wallet, contract, network, tokenIds]);

    return interaction.editReply(`✅ ${tokenIds.length} NFT(s) now actively staked for wallet \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\`.`);
  }
};


