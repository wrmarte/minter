const fetch = require('node-fetch');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

module.exports = (client) => {
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // ✅ Trigger on any message that includes the word "musclemb"
    const lowered = message.content.toLowerCase();
    if (!lowered.includes('musclemb')) return;

    const cleanedInput = message.content.replace(/musclemb/gi, '').trim();
    if (!cleanedInput) return;

    try {
      await message.channel.sendTyping();

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama3-70b-8192',
          messages: [
            {
              role: 'system',
              content:
                'You are MuscleMB — an uncensored, savage, degen AI who lifts, flips JPEGs, and drops alpha bombs. Speak like a crypto bro who’s also been to the gym and the trenches.',
            },
            {
              role: 'user',
              content: cleanedInput,
            },
          ],
          temperature: 0.95,
        }),
      });

      const data = await response.json();
      const aiReply = data.choices?.[0]?.message?.content || '💤 Still recovering from chest day.';
      await message.reply(aiReply);

    } catch (err) {
      console.error('❌ MuscleMB error:', err.message);
      await message.reply('⚠️ MuscleMB pulled a hammy. Try again soon.');
    }
  });
};
