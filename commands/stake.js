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
        .setRequired(true)),

  async execute(interaction) {
    const wallet = interaction.options.getString('wallet');
    const guildId = interaction.guildId;
    const client = interaction.client;
    const pg = client.pg;

    // Fetch contract from staking_projects
    const res = await pg.query('SELECT contract, chain FROM staking_projects WHERE server = $1', [guildId]);
    if (res.rowCount === 0) return interaction.reply({ content: '⚠️ No staking project set for this server.', ephemeral: true });

    const { contract, chain } = res.rows[0];
    const provider = getProvider(chain);
    const nft = new Contract(contract, erc721Abi, provider);

    let ownedTokenIds = [];
    let usedFallback = false;

    try {
      const balance = await safeRpcCall(chain, p => nft.connect(p).balanceOf(wallet));
      const tokenFetches = [];

      for (let i = 0; i < balance; i++) {
        tokenFetches.push(
          safeRpcCall(chain, async p => {
            try {
              const tokenId = await nft.connect(p).tokenOfOwnerByIndex(wallet, i);
              ownedTokenIds.push(tokenId.toString());
            } catch (e) {
              if (e.code === 'CALL_EXCEPTION') {
                console.warn(`⚠️ tokenOfOwnerByIndex failed at index ${i}`);
              } else {
                throw e;
              }
            }
          })
        );
      }

      await Promise.all(tokenFetches);
    } catch (e) {
      console.warn('🔁 Falling back to ownerOf() sweeping...');
      usedFallback = true;

      let totalSupply;
      try {
        totalSupply = await safeRpcCall(chain, p => nft.connect(p).totalSupply());
      } catch (err) {
        totalSupply = 1000;
        console.warn('⚠️ totalSupply() not supported. Scanning first 1000 tokens.');
      }

      const scan = [];
      for (let i = 0; i < totalSupply; i++) {
        scan.push(
          safeRpcCall(chain, async p => {
            try {
              const owner = await nft.connect(p).ownerOf(i);
              if (owner.toLowerCase() === wallet.toLowerCase()) {
                ownedTokenIds.push(i.toString());
              }
            } catch (err) {
              if (err.code !== 'CALL_EXCEPTION') {
                console.warn(`❌ Unexpected error for token ${i}: ${err.message}`);
              }
              // Skip silently if token does not exist
            }
          })
        );
      }

      await Promise.all(scan);
    }

    if (ownedTokenIds.length === 0) {
      return interaction.reply({ content: '😢 No NFTs owned from this project.', ephemeral: true });
    }

    // Store staking data
    for (const tokenId of ownedTokenIds) {
      await pg.query(
        `INSERT INTO staking_data (server, wallet, contract, token_id, staked_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (server, contract, token_id) DO NOTHING`,
        [guildId, wallet, contract, tokenId]
      );
    }

    await interaction.reply({
      content: `✅ Staked ${ownedTokenIds.length} NFT${ownedTokenIds.length > 1 ? 's' : ''} from contract **${contract.slice(0, 6)}...${contract.slice(-4)}** ${usedFallback ? '(fallback mode)' : ''}`,
      ephemeral: true
    });
  }
};
