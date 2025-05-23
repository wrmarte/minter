const { trackAllContracts } = require('../services/trackContracts');
const trackTokenSales = require('../services/trackTokenSales');

module.exports = client => {
  client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    const res = await client.pg.query(`SELECT * FROM contract_watchlist`);
    for (const row of res.rows) {
      await trackAllContracts(client, row);
    }

    await trackTokenSales(client); // 👈 added token sale tracking
  });
};



