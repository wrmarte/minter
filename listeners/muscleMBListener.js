const fetch = require('node-fetch');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const cooldown = new Set();
const TRIGGERS = ['musclemb', 'muscle mb', '@musclemb', 'yo mb', 'mbbot', 'mb bro'];

module.exports = (client) => {
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const lowered = message.content.toLowerCase();

    // 🔥 Trigger if any keyword matches
    const triggered = TRIGGERS.some(trigger => lowered.includes(trigger));
    if (!triggered) return;

    // ⏱️ Cooldown logic
    if (cooldown.has(message.author.id)) return;
    cooldown.add(message.author.id);
    setTimeout(() => cooldown.delete(message.author.id), 10000);

    // 🧹 Clean input by stripping all triggers
    let cleanedInput = lowered;
    TRIGGERS.forEach(trigger => {
      cleanedInput = cleanedInput.replaceAll(trigger, '');
    });
    cleanedInput = cleanedInput.trim();
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
          temperature: 0.6,
          max_tokens: 180,
          messages: [
            {
              role: 'system',
              content:
                'You are 💪 MuscleMB — a short-fused, savage, degen AI who lifts, flips JPEGs, and spits straight alpha. Keep answers 🔥 short, direct, and ruthless. If the message is weak or vague, stay silent. Always add savage emojis when it hits. 💥🧠🔥',
            },
            {
              role: 'user',
              content: cleanedInput,
            },
          ],
        }),
      });

      const data = await response.json();
      const aiReply = data.choices?.[0]?.message?.content?.trim();

      if (aiReply && aiReply.length > 0) {
        await message.reply(`💬 ${aiReply} 💪`);
      }

    } catch (err) {
      console.error('❌ MuscleMB error:', err.message);
      await message.reply('⚠️ MuscleMB pulled a hammy 🦵. Try again soon.');
    }
  });
};

