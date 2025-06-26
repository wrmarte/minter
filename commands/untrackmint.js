const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackmintplus')
    .setDescription('🛑 Stop tracking a mint/sale contract')
    .addStringOption(opt =>
      opt.setName('contract')
        .setDescription('Tracked contract to stop')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const pg = interaction.client.pg;
    const focused = interaction.options.getFocused();

    try {
      const res = await pg.query(`SELECT name, address, chain, channel_ids FROM contract_watchlist`);
      console.log('📦 Total tracked contracts:', res.rows.length);

      const options = [];

      for (const row of res.rows) {
        console.log('🔍 Row:', row);

        if (!row.name || typeof row.name !== 'string') continue;
        if (!row.name.toLowerCase().includes(focused.toLowerCase())) continue;

        const address = row.address || '0x000000';
        const chain = row.chain || 'unknown';

        // Normalize channel_ids
        const channels = Array.isArray(row.channel_ids)
          ? row.channel_ids
          : (row.channel_ids || '').toString().split(',').filter(Boolean);

        const emoji = chain === 'base' ? '🟦' : chain === 'eth' ? '🟧' : chain === 'ape' ? '🐵' : '❓';
        const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;
        const channelInfo = channels.length === 1 ? '1 channel' : `${channels.length} channels`;

        const label = `${emoji} ${row.name} • ${shortAddr} • ${channelInfo} • ${chain}`;
        const value = `${row.name}|${chain}`;

        if (label && value) {
          options.push({
            name: label.slice(0, 100), // Discord limit
            value
          });
        }

        if (options.length >= 25) break;
      }

      console.log('✅ Responding with options:', options);
      await interaction.respond(options);
    } catch (err) {
      console.error('❌ Autocomplete error in /untrackmintplus:', err);
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    const pg = interaction.client.pg;
    const { member, options } = interaction;

    const raw = options.getString('contract');
   const [name, chain] = options.getString('contract').split('|');


    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await pg.query(
        `DELETE FROM contract_watchlist WHERE name = $1 AND chain = $2 RETURNING *`,
        [name, chain]
      );

      if (!result.rowCount) {
        return interaction.editReply(`❌ No tracked contract named **${name}** on \`${chain}\`.`);
      }

      return interaction.editReply(`🛑 Successfully untracked **${name}** on \`${chain}\`.`);
    } catch (err) {
      console.error('❌ Error in /untrackmintplus:', err);
      return interaction.editReply('⚠️ Failed to execute `/untrackmintplus`.');
    }
  }
};

