// services/webhookRelay.js
const fetch = require('node-fetch');

const WEBHOOK_URL = process.env.MB_RELAY_WEBHOOK_URL;

if (!WEBHOOK_URL) {
  console.warn('[MB Relay] WEBHOOK URL NOT SET');
}

async function sendRelay({ content, embeds, username, avatar_url }) {
  if (!WEBHOOK_URL) return;

  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        embeds,
        username: username || 'MB Relay',
        avatar_url
      })
    });
  } catch (err) {
    console.error('[MB Relay] Webhook send failed:', err.message);
  }
}

module.exports = { sendRelay };
