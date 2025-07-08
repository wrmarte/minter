const { Contract, Wallet, ethers } = require('ethers');
const { getProvider } = require('./providerM');
const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const IV_LENGTH = 16;
const MAX_DAILY_REWARD = parseFloat(process.env.MAX_DAILY_REWARD || '500');
const DRY_RUN = process.env.REWARD_DRY_RUN === 'true';

function decrypt(text) {
  const [ivHex, encryptedHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedText = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

async function autoRewardPayout(client) {
  const pg = client.pg;
  const res = await pg.query('SELECT DISTINCT wallet_address, contract_address, network FROM staked_nfts');

  for (const row of res.rows) {
    const { wallet_address, contract_address, network } = row;
    const provider = getProvider(network);
    const nft = new Contract(contract_address, ['function ownerOf(uint256) view returns (address)'], provider);

    // Get staking config
    const configRes = await pg.query('SELECT * FROM staking_config WHERE contract_address = $1', [contract_address]);
    const config = configRes.rows[0];
    if (!config || !config.vault_private_key) continue;

    // Decrypt vault key
    let vaultWallet;
    try {
      const decryptedKey = decrypt(config.vault_private_key);
      vaultWallet = new Wallet(decryptedKey, provider);
    } catch (err) {
      console.error(`❌ Failed to decrypt vault key for ${contract_address}:`, err.message);
      continue;
    }

    const rewardToken = new Contract(config.token_contract, [
      'function balanceOf(address owner) view returns (uint256)',
      'function transfer(address to, uint256 amount) returns (bool)'
    ], vaultWallet);

    // Get all staked token_ids
    const tokensRes = await pg.query(`
      SELECT token_id FROM staked_nfts
      WHERE wallet_address = $1 AND contract_address = $2
    `, [wallet_address, contract_address]);

    const ownedTokens = [];

    for (const t of tokensRes.rows) {
      try {
        const owner = await nft.ownerOf(t.token_id);
        if (owner.toLowerCase() === wallet_address.toLowerCase()) {
          ownedTokens.push(t.token_id);
        } else {
          await pg.query(`
            DELETE FROM staked_nfts
            WHERE wallet_address = $1 AND contract_address = $2 AND token_id = $3
          `, [wallet_address, contract_address, t.token_id]);
        }
      } catch (err) {
        console.warn(`⚠️ Failed ownerOf for token ${t.token_id}: ${err.message}`);
      }
    }

    if (ownedTokens.length === 0) continue;

    // Calculate reward
    const dailyReward = parseFloat(config.daily_reward);
    const logRes = await pg.query('SELECT * FROM reward_log WHERE wallet_address = $1', [wallet_address]);
    const now = Date.now();
    const lastClaimed = logRes.rows[0]?.last_claimed ? new Date(logRes.rows[0].last_claimed).getTime() : now;
    const daysElapsed = (now - lastClaimed) / (1000 * 60 * 60 * 24);
    const rawReward = dailyReward * ownedTokens.length * daysElapsed;
    const rewardToSend = Math.min(rawReward, MAX_DAILY_REWARD).toFixed(6);

    if (rewardToSend <= 0) continue;

    if (DRY_RUN) {
      console.log(`💡 [DRY RUN] Would send ${rewardToSend} tokens to ${wallet_address}`);
      continue;
    }

    try {
      const vaultBalance = await rewardToken.balanceOf(vaultWallet.address);
      const rewardAmount = ethers.parseUnits(rewardToSend.toString(), 18);

      if (vaultBalance.lt(rewardAmount)) {
        console.warn(`❌ Not enough balance in vault for ${wallet_address}`);
        continue;
      }

      const tx = await rewardToken.transfer(wallet_address, rewardAmount);
      await tx.wait();

      await pg.query(`
        INSERT INTO reward_tx_log (wallet_address, amount, tx_hash)
        VALUES ($1, $2, $3)
      `, [wallet_address, rewardToSend, tx.hash]);

      await pg.query(`
        INSERT INTO reward_log (wallet_address, total_rewards, last_claimed)
        VALUES ($1, $2, NOW())
        ON CONFLICT (wallet_address)
        DO UPDATE SET
          total_rewards = reward_log.total_rewards + $2,
          last_claimed = NOW()
      `, [wallet_address, rewardToSend]);

      console.log(`✅ Sent ${rewardToSend} tokens to ${wallet_address} | TX: ${tx.hash}`);
    } catch (err) {
      console.error(`❌ Failed to send reward to ${wallet_address}:`, err.message);
    }
  }
}

module.exports = autoRewardPayout;
