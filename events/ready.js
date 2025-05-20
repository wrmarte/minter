module.exports = async (client, pg, trackContract) => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    const result = await pg.query(`SELECT * FROM contract_watchlist`);
    for (const row of result.rows) {
      await trackContract(row, client); // 👈 Pass client here
    }
  } catch (err) {
    console.error('❌ Error loading contracts from DB:', err);
  }
};


