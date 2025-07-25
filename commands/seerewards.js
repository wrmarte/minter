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
      // Get staking project for this server
      const projectRes = await pg.query(`
        SELECT * FROM staking_projects WHERE guild_id = $1
      `, [guildId]);

      if (projectRes.rowCount === 0) {
        return interaction.editReply('❌ This server has no staking project configured.');
      }

      const project = projectRes.rows[0];
      const contract = project.contract_address;

      // Get staked token IDs from compact table
      const stakeRes = await pg.query(`
        SELECT token_ids FROM staked_wallets
        WHERE wallet_address = $1 AND contract_address = $2
      `, [wallet, contract]);

      const tokenIds = stakeRes.rows[0]?.token_ids || [];
      const nftCount = tokenIds.length;

      // Get rewards
      const rewardRes = await pg.query(`
        SELECT * FROM reward_log WHERE wallet_address = $1
      `, [wallet]);

      const totalRewards = rewardRes.rows[0]?.total_rewards || 0;
      const lastClaimed = rewardRes.rows[0]?.last_claimed
        ? new Date(rewardRes.rows[0].last_claimed).toLocaleString()
        : 'N/A';

      // Reward config
      const configRes = await pg.query(`
        SELECT * FROM staking_config WHERE contract_address = $1
      `, [contract]);

      const config = configRes.rows[0];
      const rewardToken = config?.token_contract || 'N/A';
      const rewardSymbol = rewardToken !== 'N/A' ? `${rewardToken.slice(0, 6)}...` : 'N/A';

      const embed = new EmbedBuilder()
        .setTitle(`📊 Staking Summary`)
        .setDescription(`Project: **${project.name}**`)
        .addFields(
          { name: 'Wallet', value: `\`${wallet.slice(0, 6)}...${wallet.slice(-4)}\``, inline: true },
          { name: 'NFTs Staked', value: `${nftCount}`, inline: true },
          { name: 'Daily Reward', value: `${config?.daily_reward || 0}`, inline: true },
          { name: 'Total Earned', value: `${totalRewards} tokens`, inline: true },
          { name: 'Last Claimed', value: lastClaimed, inline: true },
          { name: 'Reward Token', value: `\`${rewardToken}\``, inline: true }
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

