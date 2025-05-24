const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untracktoken')
    .setDescription('Stop tracking a token in this server')
    .addStringOption(option =>
      option.setName('token')
        .setDescription('Token name or address')
        .setRequired(true)
    ),

  async execute(interaction, { pg }) {
    const guildId = interaction.guild.id;
    const input = interaction.options.getString('token').toLowerCase();

    try {
      const result = await pg.query(`
        DELETE FROM tracked_tokens
        WHERE guild_id = $1 AND (LOWER(address) = $2 OR LOWER(name) = $2)
        RETURNING *
      `, [guildId, input]);

      if (result.rowCount === 0) {
        await interaction.reply({
          content: `❌ No tracked token found for \`${input}\` in this server.`,
          ephemeral: true
        });
        return;
      }

      const deleted = result.rows[0];
      let msg = `🗑️ Untracked **${deleted.name.toUpperCase()}** from this server.\n\n`;

      const remaining = await pg.query(`
        SELECT name, address FROM tracked_tokens
        WHERE guild_id = $1
      `, [guildId]);

      if (remaining.rowCount === 0) {
        msg += `🧼 No tokens are currently being tracked.`;
      } else {
        msg += `📡 Still tracking:\n` +
          remaining.rows.map(r => `• \`${r.name}\` — \`${r.address.slice(0, 8)}...${r.address.slice(-4)}\``).join('\n');
      }

      await interaction.reply({ content: msg, ephemeral: false });

    } catch (err) {
      console.error('❌ Error in /untracktoken:', err);
      await interaction.reply({
        content: `❌ Something went wrong trying to untrack \`${input}\`. Please try again later.`,
        ephemeral: true
      });
    }
  }
};

