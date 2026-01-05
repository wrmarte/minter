// services/digestDebug.js
// Runs quick sanity queries against digest_events (Railway-safe via client.pg.query)

const DEBUG = String(process.env.DIGEST_DEBUG || '').trim() === '1';

function dlog(...args) {
  if (DEBUG) console.log('[DIGEST_DEBUG]', ...args);
}

function cleanGuildId(guildId) {
  const s = String(guildId || '').trim();
  if (!s) return null;
  return s.length > 64 ? s.slice(0, 64) : s;
}

async function getDigestDebugSnapshot(client, guildId, hours = 24, limit = 25) {
  const pg = client?.pg;
  if (!pg?.query) throw new Error('Postgres not available on client.pg');

  const gid = cleanGuildId(guildId);
  if (!gid) throw new Error('Missing guildId');

  const h = Number(hours);
  const l = Number(limit);

  const hoursSafe = Number.isFinite(h) && h > 0 && h <= 168 ? h : 24; // cap at 7 days
  const limitSafe = Number.isFinite(l) && l > 0 && l <= 200 ? l : 25;

  dlog('snapshot', { guildId: gid, hours: hoursSafe, limit: limitSafe });

  const bySubTypeQ = `
    SELECT COALESCE(sub_type, '(null)') AS sub_type, COUNT(*)::int AS n
    FROM digest_events
    WHERE guild_id = $1
      AND ts > NOW() - ($2::text || ' hours')::interval
    GROUP BY COALESCE(sub_type, '(null)')
    ORDER BY n DESC;
  `;

  const recentTokenishQ = `
    SELECT ts, event_type, sub_type, chain, contract, token_id,
           amount_eth, amount_usd, buyer, seller, tx_hash
    FROM digest_events
    WHERE guild_id = $1
      AND ts > NOW() - ($2::text || ' hours')::interval
      AND token_id IS NULL
    ORDER BY ts DESC
    LIMIT $3;
  `;

  const [bySubTypeRes, recentTokenishRes] = await Promise.all([
    pg.query(bySubTypeQ, [gid, String(hoursSafe)]),
    pg.query(recentTokenishQ, [gid, String(hoursSafe), limitSafe]),
  ]);

  return {
    bySubType: bySubTypeRes.rows || [],
    recentTokenish: recentTokenishRes.rows || [],
  };
}

module.exports = { getDigestDebugSnapshot };

