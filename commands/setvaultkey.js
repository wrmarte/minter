const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const IV_LENGTH = 16;

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setvaultkey')
    .setDescription('Set encrypted private key for this server’s staking vault (admin or bot owner only)')
    .addStringOption(option =>
      option.setName('private_key')
        .setDescription('Private key for vault (starts with 0x...)')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const isOwner = userId === process.env.BOT_OWNER_ID;
    const hasPerms = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
    const pg = interaction.client.pg;

    // Permission check
    if (!isOwner && !hasPerms) {
      return interaction.reply({
        content: '❌ You must be a server admin or the bot owner to use this.',
        ephemeral: true
      });
    }

    // Get contract assigned to this server
    const res = await pg.query(
      `SELECT address FROM flex_projects WHERE guild_id = $1`,
      [guildId]
    );

    if (res.rowCount === 0) {
      return interaction.reply({
        content: '❌ This server has no staking contract set. Use `/addstaking` first.',
        ephemeral: true
      });
    }

    const contract = res.rows[0].address;
    const privateKey = interaction.options.getString('private_key');

    if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
      return interaction.reply({
        content: '❌ Invalid private key format. It must start with `0x` and be 66 characters long.',
        ephemeral: true
      });
    }

    if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
      return interaction.reply({
        content: '❌ Missing or invalid `ENCRYPTION_KEY` in your environment. It must be exactly 32 characters.',
        ephemeral: true
      });
    }

    const encrypted = encrypt(privateKey);

    try {
      await pg.query(`
        UPDATE staking_config
        SET vault_private_key = $1
        WHERE contract_address = $2
      `, [encrypted, contract]);

      return interaction.reply({
        content: `✅ Vault key securely stored for contract: \`${contract}\`. It will be used during auto payouts.`,
        ephemeral: true
      });
    } catch (err) {
      console.error('❌ /setvaultkey error:', err);
      return interaction.reply({
        content: '❌ Failed to update vault key. Check logs for details.',
        ephemeral: true
      });
    }
  }
};
