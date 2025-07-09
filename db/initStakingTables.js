module.exports = async function initStakingTables(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS staked_nfts (
      wallet_address TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      token_id TEXT NOT NULL,
      network TEXT NOT NULL DEFAULT 'base',
      staked_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (wallet_address, contract_address, token_id)
    );
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS reward_log (
      wallet_address TEXT PRIMARY KEY,
      total_rewards NUMERIC DEFAULT 0,
      last_claimed TIMESTAMP DEFAULT NOW()
    );
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS staking_config (
      contract_address TEXT PRIMARY KEY,
      network TEXT NOT NULL DEFAULT 'base',
      daily_reward NUMERIC NOT NULL,
      vault_wallet TEXT NOT NULL,
      token_contract TEXT,
      vault_private_key TEXT
    );
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS staking_projects (
      name TEXT NOT NULL,
      contract_address TEXT PRIMARY KEY,
      network TEXT NOT NULL DEFAULT 'base',
      guild_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // ✅ Ensure vault_private_key column exists in staking_projects
  await pg.query(`
    ALTER TABLE staking_projects
    ADD COLUMN IF NOT EXISTS vault_private_key TEXT;
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS reward_tx_log (
      wallet_address TEXT,
      amount NUMERIC,
      timestamp TIMESTAMP DEFAULT NOW(),
      tx_hash TEXT,
      PRIMARY KEY (wallet_address, timestamp)
    );
  `);

  console.log('✅ Staking tables ensured.');
};



