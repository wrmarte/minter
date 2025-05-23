// /minter/commands/tracktoken.js
const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tracktoken')
    .setDescription('Track a new ERC20 token sale')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Token name').setRequired(true))
    .addStringOption(opt =>
      opt.setName('address').setDescription('Token contract address').setRequired(true)),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '🚫 Admin only.', ephemeral: true });
    }

    const pg = interaction.client.pg;
    const guildId = interaction.guildId;
    const name = interaction.options.getString('name').toLowerCase();
    const address = interaction.options.getString('address').toLowerCase();

    try {
      // Create SQL table if not exists
      await pg.query(`
        CREATE TABLE IF NOT EXISTS tracked_tokens (
          name TEXT,
          address TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          PRIMARY KEY (address, guild_id)
        )
      `);

      // Upsert tracked token
      await pg.query(`
        INSERT INTO tracked_tokens (name, address, guild_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (address, guild_id) DO UPDATE SET name = $1
      `, [name, address, guildId]);

      return interaction.reply(`✅ Now tracking **${name.toUpperCase()}** sales for this server.`);
    } catch (err) {
      console.error('❌ Error tracking token:', err);
      return interaction.reply({ content: '⚠️ Something went wrong.', ephemeral: true });
    }
  }
};
