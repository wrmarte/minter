const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Must be 32 characters
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
    .setDescription('Securely store the private key for this server’s staking vault.')
    .addStringOption(option =>
      option.setName('private_key')
        .setDescription('Private key for the vault wallet (starts with 0x)')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild), // Admin only

  async execute(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const isOwner = userId === process.env.BOT_OWNER_ID;
    const hasPerms = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
    const pg = interaction.client.pg;

    if (!isOwner && !hasPerms) {
      return interaction.reply({
        content: '❌ Only server admins or the bot owner can use this command.',
        ephemeral: true
      });
    }

    const res = await pg.query(
      `SELECT contract_address FROM staking_projects WHERE guild_id = $1`,
      [guildId]
    );

    if (res.rowCount === 0) {
      return interaction.reply({
        content: '❌ This server has no staking project configured. Use `/addstaking` first.',
        ephemeral: true
      });
    }

    const contract = res.rows[0].contract_address;
    const privateKey = interaction.options.getString('private_key');

    if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
      return interaction.reply({
        content: '❌ Invalid private key. It must start with `0x` and be 66 characters long.',
        ephemeral: true
      });
    }

    if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
      return interaction.reply({
        content: '❌ Missing or invalid `ENCRYPTION_KEY` in environment. Must be exactly 32 characters.',
        ephemeral: true
      });
    }

    const encrypted = encrypt(privateKey);

    try {
      await pg.query(`
        UPDATE staking_projects
        SET vault_private_key = $1
        WHERE contract_address = $2
      `, [encrypted, contract]);

      return interaction.reply({
        content: `✅ Vault key encrypted and stored for staking contract \`${contract}\`.`,
        ephemeral: true
      });
    } catch (err) {
      console.error('❌ /setvaultkey DB error:', err);
      return interaction.reply({
        content: '❌ Failed to update vault key. See console for error.',
        ephemeral: true
      });
    }
  }
};



