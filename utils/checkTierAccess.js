const COMMAND_TIERS = {
  flexcard: 'premium',
  flexplus: 'premiumplus',
  flexduo: 'premiumplus',
  flex: 'free',
  helpmint: 'free',
  // Add other commands as needed
};

const tierRank = {
  free: 0,
  premium: 1,
  premiumplus: 2
};

module.exports = async function checkTierAccess(pg, command, userId, serverId) {
  const requiredTier = COMMAND_TIERS[command] || 'free';

  // Get user tier if exists
  const userRes = await pg.query(
    `SELECT tier FROM premium_users WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  const userTier = userRes.rows[0]?.tier;

  // Get server tier
  const serverRes = await pg.query(
    `SELECT tier FROM premium_servers WHERE server_id = $1 LIMIT 1`,
    [serverId]
  );
  const serverTier = serverRes.rows[0]?.tier || 'free';

  const effectiveTier = userTier || serverTier || 'free';

  return tierRank[effectiveTier] >= tierRank[requiredTier];
};
