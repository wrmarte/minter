const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tracktoken')
    .setDescription('Track a new ERC20 token sale')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Token name').setRequired(true))
    .addStringOption(opt =>
      opt.setName('address').setDescription('Token contract address').setRequired(true)),

  async execute(interaction) {
const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
const isOwner = interaction.user.id === process.env.BOT_OWNER_ID;

if (!isAdmin && !isOwner) {
  return interaction.reply({ content: '🚫 Admins only. (Bot owner bypass not detected)', ephemeral: true });
}


    const pg = interaction.client.pg;
    const guildId = interaction.guildId;
    const channelId = interaction.channel.id;
    const name = interaction.options.getString('name').toLowerCase();
    const address = interaction.options.getString('address').toLowerCase();

    try {
      // Ensure table has channel_id column
      await pg.query(`
        CREATE TABLE IF NOT EXISTS tracked_tokens (
          name TEXT,
          address TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          channel_id TEXT,
          PRIMARY KEY (address, guild_id)
        )
      `);

      // Upsert token + channel
      await pg.query(`
        INSERT INTO tracked_tokens (name, address, guild_id, channel_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (address, guild_id) DO UPDATE SET name = $1, channel_id = $4
      `, [name, address, guildId, channelId]);

      const embed = new EmbedBuilder()
        .setTitle('📈 Token Tracking Enabled')
        .addFields(
          { name: '🪙 Token', value: name.toUpperCase(), inline: true },
          { name: '🔗 Contract', value: address, inline: false },
          { name: '🏠 Server', value: interaction.guild.name, inline: false },
          { name: '📡 Channel', value: `<#${channelId}>`, inline: false }
        )
        .setColor(0x00cc99)
        .setFooter({ text: 'Now watching for token buys!' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Error tracking token:', err);
      return interaction.reply({ content: '⚠️ Something went wrong.', ephemeral: true });
    }
  }
};

