const { AttachmentBuilder } = require('discord.js');
const { flavorMap, getRandomFlavor } = require('../utils/flavorMap');
const fetch = require('node-fetch');

module.exports = {
  name: 'exp',
  async execute(message, args, { pg }) {
    const guildId = message.guild?.id ?? null;
    const userMention = `<@${message.author.id}>`;

    const name = args[0]?.toLowerCase();
    if (!name) {
      return message.reply('❌ Please provide an expression name. Example: `!exp rich`');
    }

    // 1️⃣ Check built-in flavorMap first
    if (flavorMap[name]) {
      const msg = getRandomFlavor(name, userMention);
      return message.reply(msg);
    }

    // 2️⃣ Check PostgreSQL database for saved expressions
    const res = await pg.query(`
      SELECT * FROM expressions 
      WHERE name = $1 AND (guild_id = $2 OR guild_id IS NULL) 
      ORDER BY RANDOM() LIMIT 1
    `, [name, guildId]);

    if (res.rows.length) {
      const exp = res.rows[0];
      const customMessage = exp?.content?.includes('{user}')
        ? exp.content.replace('{user}', userMention)
        : `${userMention} is vibing "${name}" right now!`;

      if (exp?.type === 'image') {
        try {
          const imageRes = await fetch(exp.content);
          if (!imageRes.ok) throw new Error(`Image failed to load: ${imageRes.status}`);
          const file = new AttachmentBuilder(exp.content);
          return await message.reply({ content: customMessage, files: [file] });
        } catch (err) {
          console.error('❌ Image fetch error:', err.message);
          return await message.reply({ content: `⚠️ Image broken, but:\n${customMessage}` });
        }
      }

      return message.reply(customMessage);
    }

    // 3️⃣ AI fallback if not found anywhere
    try {
      let aiResponse = await getGroqAI(name, userMention);
      aiResponse = cleanQuotes(aiResponse); // Clean up any extra quotes
      return message.reply(aiResponse);
    } catch (err) {
      console.error('❌ AI error:', err);
      return message.reply('❌ No expression found & AI failed.');
    }
  }
};

// 🔥 Groq AI function (exactly matching your slash /exp)
async function getGroqAI(keyword, userMention) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const apiKey = process.env.GROQ_API_KEY;

  const body = {
    model: 'llama3-70b-8192',
    messages: [
      {
        role: 'system',
        content: 'You are a savage Discord bot AI expression generator.'
      },
      {
        role: 'user',
        content: `Someone typed "${keyword}". Generate a super short savage one-liner. Include ${userMention}. Use Discord/Web3 slang. Max 1 sentence.`
      }
    ],
    max_tokens: 50,
    temperature: 0.9
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errData = await res.json();
    console.error(errData);
    throw new Error('Groq AI call failed');
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// 🧼 Utility to strip any surrounding quotes from AI
function cleanQuotes(text) {
  return text.replace(/^"(.*)"$/, '$1').trim();
}





