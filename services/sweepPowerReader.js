// sweepPowerReader.js
const { decayPower } = require("./sweepPower"); // or copy small helper
const SWEEP_POWER_CHAIN = "base";

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

async function getSweepPowerSnapshot(pg, scope = "global") {
  const r = await pg.query(
    `SELECT power, last_ts FROM sweep_power_state
     WHERE chain=$1 AND scope=$2`,
    [SWEEP_POWER_CHAIN, scope]
  );

  if (!r.rows.length) {
    return {
      scope,
      power: 0,
      decayedPower: 0,
      lastUpdateSec: null,
    };
  }

  const { power, last_ts } = r.rows[0];
  const ts = nowSec();
  const dt = last_ts ? Math.max(0, ts - Number(last_ts)) : 0;

  const decayed = decayPower(Number(power), dt);

  return {
    scope,
    power: Number(power),
    decayedPower: decayed,
    lastUpdateSec: Number(last_ts),
    secondsSinceUpdate: dt,
  };
}

module.exports = { getSweepPowerSnapshot };
