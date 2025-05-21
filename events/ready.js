module.exports = async (client, pg, trackContract) => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  try {
    const { rows } = await pg.query('SELECT * FROM contract_watchlist');
    for (const row of rows) {
      const contract = row.contract_address;
      const channels = row.channel_ids || [];
      console.log(`📡 Tracking contract: ${contract} in channels: ${channels.join(', ')}`);
      trackContract(client, pg, contract, channels);
    }
  } catch (err) {
    console.error('❌ Error in ready.js while loading contracts:', err);
  }
};


