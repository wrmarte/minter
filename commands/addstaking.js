const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('addstaking')
    .setDescription('Assign staking setup for this server\'s NFT project.')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Display name for this staking project')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('contract')
        .setDescription('NFT contract address (ERC721)')
        .setRequired(true))
    .addNumberOption(option =>
      option.setName('reward')
        .setDescription('Daily reward per NFT')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('vault_wallet')
        .setDescription('Vault wallet that holds the reward tokens')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('token_contract')
        .setDescription('ERC20 token contract for rewards')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const name = interaction.options.getString('name');
    const contract = interaction.options.getString('contract').toLowerCase();
    const reward = interaction.options.getNumber('reward');
    const vaultWallet = interaction.options.getString('vault_wallet').toLowerCase();
    const tokenContract = interaction.options.getString('token_contract').toLowerCase();
    const guildId = interaction.guild.id;
    const pg = interaction.client.pg;

    const isOwner = interaction.user.id === process.env.BOT_OWNER_ID;
    const hasPerms = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);

    // ✅ PremiumPlus Tier Check
    const tierRes = await pg.query(
      `SELECT tier FROM premium_servers WHERE server_id = $1`,
      [guildId]
    );
    const tier = tierRes.rows[0]?.tier || 'free';

    if (!isOwner && tier !== 'premiumplus') {
      return interaction.reply({
        content: '❌ This command requires **PremiumPlus** tier. Upgrade your server to unlock `/addstaking`.',
        ephemeral: true
      });
    }

    if (!isOwner && !hasPerms) {
      return interaction.reply({
        content: '❌ You must be a server admin to use this command.',
        ephemeral: true
      });
    }

    try {
      // Insert into staking_projects (replaces flex_projects usage)
      await pg.query(`
        INSERT INTO staking_projects (name, contract_address, network, guild_id)
        VALUES ($1, $2, 'base', $3)
        ON CONFLICT (contract_address) DO UPDATE SET
          name = EXCLUDED.name,
          network = 'base',
          guild_id = EXCLUDED.guild_id
      `, [name, contract, guildId]);

      // Insert or update staking_config
      await pg.query(`
        INSERT INTO staking_config (contract_address, network, daily_reward, vault_wallet, token_contract)
        VALUES ($1, 'base', $2, $3, $4)
        ON CONFLICT (contract_address) DO UPDATE SET
          daily_reward = $2,
          vault_wallet = $3,
          token_contract = $4
      `, [contract, reward, vaultWallet, tokenContract]);

      return interaction.reply({
        content: `✅ Staking setup added:\n• **${name}**\n• Contract: \`${contract}\`\n• Reward: \`${reward}/day\`\n• Vault: \`${vaultWallet.slice(0, 6)}...${vaultWallet.slice(-4)}\`\n• Token: \`${tokenContract.slice(0, 6)}...${tokenContract.slice(-4)}\``,
        ephemeral: true
      });
    } catch (err) {
      console.error('❌ /addstaking DB Error:', err);
      return interaction.reply({
        content: '❌ Failed to save staking setup. Check console for errors.',
        ephemeral: true
      });
    }
  }
};




