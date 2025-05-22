const { trackAllContracts } = require('./../services/tracker');


module.exports = client => {
  client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const res = await client.pg.query(`SELECT * FROM contract_watchlist`);
    for (const row of res.rows) {
      await trackAllContracts(client, row);
    }
  });
};


