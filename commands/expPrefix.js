const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { flavorMap, getRandomFlavor } = require('../utils/flavorMap');
const fetch = require('node-fetch');

// Random color generator (same as slash)
function getRandomColor() {
  const colors = [
    0xFFD700, 0x66CCFF, 0xFF66CC, 0xFF4500,
    0x00FF99, 0xFF69B4, 0x00CED1, 0xFFA500, 0x8A2BE2
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

module.exports = {
  name: 'exp',
  async execute(message, args, { pg, groqApiKey }) {
    const guildId = message.guild?.id ?? null;
    const userMention = `<@${message.author.id}>`;
    const name = args[0]?.toLowerCase();
    if (!name) {
      return message.reply('❌ Please provide an expression name. Example: `!exp rich`');
    }

    // ✅ Check built-in flavorMap first
    if (flavorMap[name]) {
      const msg = getRandomFlavor(name, userMention);
      const embed = new EmbedBuilder().setDescription(msg).setColor(getRandomColor());
      return message.reply({ embeds: [embed] });
    }

    // ✅ Check PostgreSQL database
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

      const embed = new EmbedBuilder().setDescription(customMessage).setColor(getRandomColor());
      return message.reply({ embeds: [embed] });
    }

    // ✅ AI fallback (Groq with patched mention-safe logic)
    try {
      let aiResponse = await getGroqAI(name, userMention, groqApiKey);
      aiResponse = cleanQuotes(aiResponse);
      const embed = new EmbedBuilder().setDescription(aiResponse).setColor(getRandomColor());
      return message.reply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ AI error:', err);
      return message.reply('❌ No expression found & AI failed.');
    }
  }
};

// ✅ Unified Groq AI function (patched mention-safe)
async function getGroqAI(keyword, userMention, groqApiKey) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';

  const body = {
    model: 'llama3-70b-8192',
    messages: [
      {
        role: 'system',
        content: 'You are a savage Discord bot AI expression generator.'
      },
      {
        role: 'user',
        content: `Someone typed "${keyword}". Generate a savage one-liner. Insert {user} where you want to mention the user. Use Discord/Web3 slang. Max 1 sentence. Add 1 fitting emoji at the end.`
      }
    ],
    max_tokens: 50,
    temperature: 0.9
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${groqApiKey}`,
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

  const replaced = rawReply.replace(/{user}/gi, userMention);
  return replaced;
}









