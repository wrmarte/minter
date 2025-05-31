const { flavorMap, getRandomFlavor } = require('../utils/flavorMap');
const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

// Random embed color generator
function getRandomColor() {
  const colors = [
    0xFFD700, 0x66CCFF, 0xFF66CC, 0xFF4500,
    0x00FF99, 0xFF69B4, 0x00CED1, 0xFFA500, 0x8A2BE2
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

module.exports = (client, pg) => {
  client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const prefix = '!exp';
    if (!message.content.toLowerCase().startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const name = args[0]?.toLowerCase();
    const guildId = message.guild?.id ?? null;
    const userMention = `<@${message.author.id}>`;

    if (!name) {
      return message.reply({ content: '❌ Please provide an expression name. Example: `!exp rich`' });
    }

    try {
      // 1️⃣ Built-in FlavorMap check
      if (flavorMap[name]) {
        const msg = getRandomFlavor(name, userMention);
        const embed = new EmbedBuilder().setDescription(msg).setColor(getRandomColor());
        return message.reply({ embeds: [embed] });
      }

      // 2️⃣ PostgreSQL check
      const res = await pg.query(
        `SELECT * FROM expressions WHERE name = $1 AND (guild_id = $2 OR ($2 IS NULL AND guild_id IS NULL)) ORDER BY RANDOM() LIMIT 1`,
        [name, guildId]
      );

      if (res.rows.length > 0) {
        const exp = res.rows[0];
        const customMessage = exp?.content?.includes('{user}')
          ? exp.content.replace('{user}', userMention)
          : `${userMention} is experiencing **"${name}"** energy today!`;

        if (exp?.type === 'image') {
          const file = new AttachmentBuilder(exp.content);
          return await message.reply({ content: customMessage, files: [file] });
        }

        const embed = new EmbedBuilder().setDescription(customMessage).setColor(getRandomColor());
        return message.reply({ embeds: [embed] });
      }

      // 3️⃣ AI Fallback (Groq-powered with mention patch)
      try {
        let aiResponse = await getGroqAI(name, userMention);
        aiResponse = cleanQuotes(aiResponse);
        const embed = new EmbedBuilder().setDescription(aiResponse).setColor(getRandomColor());
        return message.reply({ embeds: [embed] });
      } catch (aiErr) {
        console.error('❌ AI error:', aiErr);
        return message.reply({ content: '❌ No expression found & AI failed.' });
      }

    } catch (err) {
      console.error('❌ Error handling !exp:', err);
      return message.reply({ content: '⚠️ Internal error occurred while processing this command.' });
    }
  });
};

// ✅ Groq AI logic fully patched with mention-safe placeholder
async function getGroqAI(keyword, userMention) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const apiKey = process.env.GROQ_API_KEY; // fully Railway safe

  const body = {
    model: 'llama3-70b-8192',
    messages: [
      {
        role: 'system',
        content: 'You are a savage Discord bot AI expression generator.'
      },
      {
        role: 'user',
        content: `Someone typed "${keyword}". Generate a super short savage one-liner. Insert {user} where you want to mention the user. Use Discord/Web3 slang. Max 1 sentence.`
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
    throw new Error(`Groq AI call failed: ${JSON.stringify(errData)}`);
  }

  const data = await res.json();
  const rawReply = data?.choices?.[0]?.message?.content?.trim();
  if (!rawReply) throw new Error('Empty AI response');

  // Replace {user} placeholder with real Discord mention
  const replaced = rawReply.replace(/{user}/gi, userMention);
  return replaced;
}

// 🧼 Utility to clean quotes
function cleanQuotes(text) {
  return text.replace(/^"(.*)"$/, '$1').trim();
}





