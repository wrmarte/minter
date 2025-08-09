const { SlashCommandBuilder } = require('discord.js');

function shortAddr(addr = '') {
  return addr ? `${addr.slice(0, 8)}...${addr.slice(-4)}` : '';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untracktoken')
    .setDescription('Stop tracking a token in this server')
    .addStringOption(option =>
      option.setName('token')
        .setDescription('Token name or address')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  // ✅ Autocomplete: list tokens tracked by THIS server
  async autocomplete(interaction) {
    try {
      const pg = interaction.client.pg;
      const guildId = interaction.guildId;
      const focused = (interaction.options.getFocused() || '').toLowerCase();

      const res = await pg.query(
        `SELECT name, address FROM tracked_tokens WHERE guild_id = $1 ORDER BY name NULLS LAST`,
        [guildId]
      );

      const choices = res.rows
        .filter(row => {
          const n = (row.name || '').toLowerCase();
          const a = (row.address || '').toLowerCase();
          if (!focused) return true;
          return n.includes(focused) || a.includes(focused);
        })
        .slice(0, 25)
        .map(row => ({
          name: `${(row.name || 'Unknown').toUpperCase()} — ${shortAddr(row.address)}`,
          value: row.address || row.name
        }));

      await interaction.respond(choices);
    } catch (err) {
      console.error('❌ Autocomplete error (/untracktoken):', err);
      try { await interaction.respond([]); } catch (_) {}
    }
  },

  async execute(interaction, { pg }) {
    const guildId = interaction.guild.id;
    const inputRaw = interaction.options.getString('token');
    const input = (inputRaw || '').toLowerCase();

    try {
      // Fetch the token first so we always know its name/address before deleting
      const toDelete = await pg.query(
        `SELECT name, address FROM tracked_tokens
         WHERE guild_id = $1 AND (LOWER(address) = $2 OR LOWER(name) = $2)
         LIMIT 1`,
        [guildId, input]
      );

      if (toDelete.rowCount === 0) {
        // No match, just show current list
        const remaining = await pg.query(
          `SELECT name, address FROM tracked_tokens WHERE guild_id = $1 ORDER BY name NULLS LAST`,
          [guildId]
        );

        const list = remaining.rowCount === 0
          ? '🧼 No tokens are currently being tracked.'
          : '📡 Currently tracking:\n' + remaining.rows
              .map(r => `• **${(r.name || 'Unknown').toUpperCase()}** — \`${shortAddr(r.address)}\``)
              .join('\n');

        await interaction.reply({
          content: `❌ No tracked token found for \`${inputRaw}\` in this server.\n\n${list}`,
          ephemeral: true
        });
        return;
      }

      const tokenInfo = toDelete.rows[0];
      const removedName = (tokenInfo.name || tokenInfo.address || inputRaw).toUpperCase();

      // Now delete it
      await pg.query(
        `DELETE FROM tracked_tokens
         WHERE guild_id = $1 AND (LOWER(address) = $2 OR LOWER(name) = $2)`,
        [guildId, input]
      );

      // Fetch remaining list
      const remaining = await pg.query(
        `SELECT name, address FROM tracked_tokens WHERE guild_id = $1 ORDER BY name NULLS LAST`,
        [guildId]
      );

      const list = remaining.rowCount === 0
        ? '🧼 No tokens are currently being tracked.'
        : '📡 Currently tracking:\n' + remaining.rows
            .map(r => `• **${(r.name || 'Unknown').toUpperCase()}** — \`${shortAddr(r.address)}\``)
            .join('\n');

      await interaction.reply({
        content: `🗑️ Untracked **${removedName}** from this server.\n\n${list}`,
        ephemeral: false
      });

    } catch (err) {
      console.error('❌ Error in /untracktoken:', err);
      await interaction.reply({
        content: `❌ Something went wrong trying to untrack \`${inputRaw}\`. Please try again later.`,
        ephemeral: true
      });
    }
  }
};



