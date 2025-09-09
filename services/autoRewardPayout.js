// services/autoRewardPayout.js
const { Contract, Wallet, ethers } = require('ethers');
const { getProvider } = require('./providerM');
const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';
const IV_LENGTH = 16;
const MAX_DAILY_REWARD = Number.parseFloat(process.env.MAX_DAILY_REWARD || '500');
const DRY_RUN = String(process.env.REWARD_DRY_RUN || '').toLowerCase() === 'true';

function keyTo32Bytes(keyStr) {
  // Accept raw, hex (64 chars), or base64; otherwise derive via sha256
  const raw = String(keyStr || '');
  try {
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex'); // hex-encoded 32 bytes
    if (/^[A-Za-z0-9+/=]+$/.test(raw)) { // maybe base64
      const b = Buffer.from(raw, 'base64');
      if (b.length === 32) return b;
    }
  } catch {}
  // fallback: hash to 32 bytes
  return crypto.createHash('sha256').update(raw).digest();
}

function decrypt(text) {
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY missing');
  if (!text || !text.includes(':')) throw new Error('Invalid encrypted payload');
  const [ivHex, encryptedHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  if (iv.length !== IV_LENGTH) throw new Error('Invalid IV length');
  const encryptedText = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyTo32Bytes(ENCRYPTION_KEY), iv);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
  return decrypted.toString('utf8');
}

async function getTokenDecimals(contract) {
  try {
    const dec = await contract.decimals();
    const n = Number(dec);
    return Number.isFinite(n) ? n : 18;
  } catch {
    return 18;
  }
}

async function upsertRewardLogScoped(pg, { wallet, contract, network, amount }) {
  // Try fully scoped (preferred; no schema assumptions about unique indexes)
  try {
    const sel = await pg.query(
      `SELECT 1 FROM reward_log WHERE wallet_address = $1 AND contract_address = $2 AND network = $3 LIMIT 1`,
      [wallet, contract, network]
    );
    if (sel.rowCount > 0) {
      await pg.query(
        `UPDATE reward_log
         SET total_rewards = total_rewards + $1, last_claimed = NOW()
         WHERE wallet_address = $2 AND contract_address = $3 AND network = $4`,
        [amount, wallet, contract, network]
      );
    } else {
      await pg.query(
        `INSERT INTO reward_log (wallet_address, contract_address, network, total_rewards, last_claimed)
         VALUES ($1, $2, $3, $4, NOW())`,
        [wallet, contract, network, amount]
      );
    }
    return true;
  } catch (e) {
    // Fallback to legacy (wallet-only) if scoped columns don’t exist
    try {
      const selLegacy = await pg.query(
        `SELECT 1 FROM reward_log WHERE wallet_address = $1 LIMIT 1`,
        [wallet]
      );
      if (selLegacy.rowCount > 0) {
        await pg.query(
          `UPDATE reward_log
           SET total_rewards = total_rewards + $1, last_claimed = NOW()
           WHERE wallet_address = $2`,
          [amount, wallet]
        );
      } else {
        await pg.query(
          `INSERT INTO reward_log (wallet_address, total_rewards, last_claimed)
           VALUES ($1, $2, NOW())`,
          [wallet, amount]
        );
      }
      return true;
    } catch (e2) {
      console.error('❌ reward_log upsert failed:', e2.message);
      return false;
    }
  }
}

async function getLastClaimed(pg, { wallet, contract, network }) {
  // Prefer scoped last_claimed
  try {
    const r = await pg.query(
      `SELECT last_claimed FROM reward_log
       WHERE wallet_address = $1 AND contract_address = $2 AND network = $3
       ORDER BY last_claimed DESC LIMIT 1`,
      [wallet, contract, network]
    );
    if (r.rowCount > 0) return r.rows[0].last_claimed ? new Date(r.rows[0].last_claimed).getTime() : null;
  } catch {}
  // Legacy wallet-only
  try {
    const r2 = await pg.query(
      `SELECT last_claimed FROM reward_log
       WHERE wallet_address = $1 ORDER BY last_claimed DESC LIMIT 1`,
      [wallet]
    );
    if (r2.rowCount > 0) return r2.rows[0].last_claimed ? new Date(r2.rows[0].last_claimed).getTime() : null;
  } catch {}
  return null;
}

async function autoRewardPayout(client) {
  const pg = client.pg;

  // 🔁 For every unique staked user & contract *and network*
  const res = await pg.query(
    `SELECT DISTINCT wallet_address, contract_address, network FROM staked_nfts`
  );

  for (const row of res.rows) {
    const wallet_address = String(row.wallet_address).toLowerCase();
    const contract_address = String(row.contract_address).toLowerCase();
    const network = (row.network || 'base').toLowerCase();

    const provider = getProvider(network);
    if (!provider) {
      console.warn(`⚠️ No provider for network ${network}, skipping ${contract_address}`);
      continue;
    }

    // Minimal ERC-721 ABI for ownerOf
    const nft = new Contract(contract_address, ['function ownerOf(uint256) view returns (address)'], provider);

    // 🔍 Lookup staking config for this contract
    const configRes = await pg.query(
      `SELECT * FROM staking_config WHERE contract_address = $1`,
      [contract_address]
    );
    const config = configRes.rows[0];
    if (!config || !config.vault_private_key || !config.token_contract) {
      // nothing to pay out for this contract
      continue;
    }

    // 🔓 Decrypt vault key
    let vaultWallet;
    try {
      const decryptedKey = decrypt(config.vault_private_key);
      vaultWallet = new Wallet(decryptedKey, provider);
    } catch (err) {
      console.error(`❌ Failed to decrypt vault key for ${contract_address}:`, err.message);
      continue;
    }

    // Reward token contract (ERC20)
    const rewardToken = new Contract(
      String(config.token_contract).toLowerCase(),
      [
        'function balanceOf(address owner) view returns (uint256)',
        'function transfer(address to, uint256 amount) returns (bool)',
        'function decimals() view returns (uint8)'
      ],
      vaultWallet
    );

    // 🔁 Pull staked tokens for this wallet+contract+network
    const tokensRes = await pg.query(
      `SELECT token_id FROM staked_nfts
       WHERE wallet_address = $1 AND contract_address = $2 AND network = $3`,
      [wallet_address, contract_address, network]
    );

    const ownedTokens = [];
    for (const t of tokensRes.rows) {
      const tid = String(t.token_id);
      try {
        const owner = await nft.ownerOf(tid);
        if (String(owner).toLowerCase() === wallet_address) {
          ownedTokens.push(tid);
        } else {
          // cleanup stale stake record
          await pg.query(
            `DELETE FROM staked_nfts
             WHERE wallet_address = $1 AND contract_address = $2 AND network = $3 AND token_id = $4`,
            [wallet_address, contract_address, network, tid]
          );
        }
      } catch (err) {
        // If token burned or non-721, clean up the row
        console.warn(`⚠️ ownerOf failed for ${contract_address} #${tid}: ${err.message}`);
        await pg.query(
          `DELETE FROM staked_nfts
           WHERE wallet_address = $1 AND contract_address = $2 AND network = $3 AND token_id = $4`,
          [wallet_address, contract_address, network, tid]
        ).catch(() => {});
      }
    }

    if (ownedTokens.length === 0) continue;

    // 🧮 Calculate reward since last claim (scoped)
    const perNftDaily = Number.parseFloat(config.daily_reward || '0');
    if (!Number.isFinite(perNftDaily) || perNftDaily <= 0) continue;

    const lastClaimedMs = await getLastClaimed(pg, {
      wallet: wallet_address,
      contract: contract_address,
      network
    });

    const nowMs = Date.now();
    const startMs = lastClaimedMs ?? nowMs; // if no record, don't pay retroactively
    const daysElapsed = (nowMs - startMs) / (1000 * 60 * 60 * 24);
    if (daysElapsed <= 0) continue;

    const rawReward = perNftDaily * ownedTokens.length * daysElapsed;
    const cappedReward = Math.min(rawReward, MAX_DAILY_REWARD); // cap payout per cycle/day
    const rewardToSendNum = Math.max(0, Number(cappedReward));
    if (!(rewardToSendNum > 0)) continue;

    if (DRY_RUN) {
      console.log(`💡 [DRY RUN] Would send ${rewardToSendNum.toFixed(6)} to ${wallet_address} for ${ownedTokens.length} NFTs`);
      continue;
    }

    try {
      const decimals = await getTokenDecimals(rewardToken);
      const rewardAmount = ethers.parseUnits(rewardToSendNum.toFixed(decimals > 6 ? 6 : decimals), decimals); // clamp to <= 6 dp to avoid dust
      const vaultBalance = await rewardToken.balanceOf(vaultWallet.address);

      // ethers v6: BigInt comparisons
      if (vaultBalance < rewardAmount) {
        console.warn(`❌ Not enough vault balance for ${wallet_address} on ${network} (need ${rewardAmount} / have ${vaultBalance})`);
        continue;
      }

      const tx = await rewardToken.transfer(wallet_address, rewardAmount);
      const rcpt = await tx.wait();

      // Minimal TX log (keep your schema); feel free to extend with contract/network if columns exist
      await pg.query(
        `INSERT INTO reward_tx_log (wallet_address, amount, tx_hash)
         VALUES ($1, $2, $3)`,
        [wallet_address, rewardToSendNum, tx.hash]
      ).catch((e) => console.warn('⚠️ reward_tx_log insert failed:', e.message));

      // Scoped reward log (fallback to legacy if table lacks columns)
      await upsertRewardLogScoped(pg, {
        wallet: wallet_address,
        contract: contract_address,
        network,
        amount: rewardToSendNum
      });

      console.log(`✅ Sent ${rewardToSendNum} tokens (decimals ${decimals}) to ${wallet_address} | TX: ${tx.hash} | Status: ${rcpt?.status}`);
    } catch (err) {
      console.error(`❌ Failed to send reward to ${wallet_address}:`, err.message);
    }
  }
}

module.exports = autoRewardPayout;



