const { SlashCommandBuilder } = require('discord.js');
const { Contract } = require('ethers');
const { getProvider, safeRpcCall } = require('../services/providerM');

const erc721Abi = [
  'function ownerOf(uint256 tokenId) view returns (address)'
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stake')
    .setDescription('Scan 1000 token IDs and count NFTs from contract owned by wallet')
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

    const MAX_SCAN = 1000;
    const BATCH_SIZE = 5;
    const scanned = new Set();
    let tokenIds = [];

    await interaction.editReply(`Scanning first ${MAX_SCAN} token IDs for wallet ownership.`);

    for (let tokenId = 0; tokenId < MAX_SCAN; tokenId += BATCH_SIZE) {
      const batch = Array.from({ length: BATCH_SIZE }, (_, i) => tokenId + i).filter(id => id < MAX_SCAN);

      const results = await Promise.all(
        batch.map(async (id) => {
          try {
            const owner = await safeRpcCall(network, async (prov) => {
              const tempContract = new Contract(contract, erc721Abi, prov);
              return await tempContract.ownerOf(id);
            });
            return { id, owner };
          } catch {
            return null;
          }
        })
      );

      for (const res of results) {
        if (res && res.owner && res.owner.toLowerCase() === wallet) {
          const idStr = res.id.toString();
          if (!scanned.has(idStr)) {
            tokenIds.push(idStr);
            scanned.add(idStr);
          }
        }
      }
      await new Promise((res) => setTimeout(res, 150));
    }

    if (tokenIds.length === 0) {
      return interaction.editReply(`❌ No NFTs detected in wallet \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\` within first ${MAX_SCAN} token IDs.`);
    }

    await pg.query(`
      INSERT INTO staked_wallets (wallet_address, contract_address, network, token_ids, staked_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (wallet_address, contract_address)
      DO UPDATE SET token_ids = $4, staked_at = NOW()
    `, [wallet, contract, network, tokenIds]);

    return interaction.editReply(`✅ ${tokenIds.length} NFT(s) found within first ${MAX_SCAN} token IDs for wallet \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\`.`);
  }
};


