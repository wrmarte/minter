const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trackmint')
    .setDescription('Start tracking a contract')
    .addStringOption(option =>
      option.setName('contract')
        .setDescription('Contract address to track')
        .setRequired(true)),

  async execute(interaction, { pg }) {
    await interaction.deferReply({ ephemeral: true });

    const contract = interaction.options.getString('contract');
    const channelId = interaction.channel.id;

    try {
      await pg.query(`
        INSERT INTO contract_watchlist (contract_address, channel_ids)
        VALUES ($1, ARRAY[$2]::text[])
        ON CONFLICT (contract_address)
        DO UPDATE SET channel_ids = array_cat(contract_watchlist.channel_ids, ARRAY[$2]::text[])
        WHERE NOT contract_watchlist.channel_ids @> ARRAY[$2]::text[]
      `, [contract.toLowerCase(), channelId]);

      await interaction.editReply(`✅ Now tracking contract \`${contract}\` in this channel.`);
    } catch (err) {
      console.error(err);
      await interaction.editReply('❌ Failed to track contract.');
    }
  }
};

