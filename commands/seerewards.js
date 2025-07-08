const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('seereward')
    .setDescription('View your staking rewards and current staked NFTs.')
    .addStringOption(option =>
      option.setName('wallet')
        .setDescription('Your wallet address')
        .setRequired(true)),

  async execute(interaction) {
    const wallet = interaction.options.getString('wallet').toLowerCase();
    const guildId = interaction.guild.id;
    const pg = interaction.client.pg;

    await interaction.deferReply({ ephemeral: true });

    try {
      // Get current project
      const projectRes = await pg.query(`
        SELECT * FROM flex_projects WHERE guild_id = $1
      `, [guildId]);

      if (projectRes.rowCount === 0) {
        return interaction.editReply('❌ This server has no staking project configured.');
      }

      const project = projectRes.rows[0];

      // Count currently staked NFTs
      const stakedRes = await pg.query(`
        SELECT COUNT(*) FROM staked_nfts
        WHERE wallet_address = $1 AND contract_address = $2
      `, [wallet, project.address]);

      const nftCount = parseInt(stakedRes.rows[0].count || '0');

      // Get total rewards paid
      const rewardRes = await pg.query(`
        SELECT * FROM reward_log WHERE wallet_address = $1
      `, [wallet]);

      const totalRewards = rewardRes.rows[0]?.total_rewards || 0;
      const lastClaimed = rewardRes.rows[0]?.last_claimed
        ? new Date(rewardRes.rows[0].last_claimed).toLocaleString()
        : 'N/A';

      // Get reward token info
      const configRes = await pg.query(`
        SELECT * FROM staking_config WHERE contract_address = $1
      `, [project.address]);

      const config = configRes.rows[0];
      const rewardSymbol = config?.token_contract?.slice(0, 6) + '...';

      // Response Embed
      const embed = new EmbedBuilder()
        .setTitle(`📊 Staking Summary`)
        .setDescription(`Project: **${project.name}**`)
        .addFields(
          { name: 'Wallet', value: `\`${wallet.slice(0, 6)}...${wallet.slice(-4)}\``, inline: true },
          { name: 'NFTs Staked', value: `${nftCount}`, inline: true },
          { name: 'Daily Reward per NFT', value: `${config?.daily_reward || 0}`, inline: true },
          { name: 'Total Rewards Earned', value: `${totalRewards} tokens`, inline: true },
          { name: 'Last Reward Timestamp', value: lastClaimed, inline: true },
          { name: 'Reward Token', value: `\`${config?.token_contract || 'N/A'}\``, inline: true }
        )
        .setFooter({ text: 'Rewards are auto-distributed daily.' })
        .setColor('#00cc99');

      return interaction.editReply({ embeds: [embed] });

    } catch (err) {
      console.error('❌ /seereward error:', err);
      return interaction.editReply('⚠️ Failed to fetch staking data. Please try again.');
    }
  }
};
