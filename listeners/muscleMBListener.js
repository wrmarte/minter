const fetch = require('node-fetch');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const cooldown = new Set();
const TRIGGERS = ['musclemb', 'muscle mb', 'yo mb', 'mbbot', 'mb bro'];

module.exports = (client) => {
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const lowered = message.content.toLowerCase();

    // 🔥 Trigger if any keyword or tag matches
    const mentionedBot = message.mentions.has(client.user);
    const mentionedUsers = message.mentions.users.filter(u => u.id !== client.user.id);
    const hasTriggerWord = TRIGGERS.some(trigger => lowered.includes(trigger));
    const triggered = mentionedBot || mentionedUsers.size > 0 || hasTriggerWord;

    if (!triggered) return;

    // ⏱️ Cooldown per user
    if (cooldown.has(message.author.id)) return;
    cooldown.add(message.author.id);
    setTimeout(() => cooldown.delete(message.author.id), 10000);

    // 🧹 Clean input
    let cleanedInput = lowered;
    TRIGGERS.forEach(trigger => {
      cleanedInput = cleanedInput.replaceAll(trigger, '');
    });
    message.mentions.users.forEach(user => {
      cleanedInput = cleanedInput.replaceAll(`<@${user.id}>`, '');
      cleanedInput = cleanedInput.replaceAll(`<@!${user.id}>`, '');
    });
    cleanedInput = cleanedInput.replaceAll(`<@${client.user.id}>`, '').trim();
    if (!cleanedInput) cleanedInput = 'Roast this fool.';

    try {
      await message.channel.sendTyping();

      // 🧨 Construct system prompt
      const roastTarget = mentionedUsers.first();
      const isRoast = roastTarget && !mentionedBot;

      const systemPrompt = isRoast
        ? `You are MuscleMB — a savage roastmaster. Ruthlessly roast the user "${roastTarget.username}" who was just tagged. Keep it short, brutal, and funny. Use emojis if needed. 💀🔥`
        : `You are 💪 MuscleMB — a short-fused, savage degen AI who flips JPEGs and spits straight alpha. Keep answers 🔥 short, direct, and ruthless. Add savage emojis when it hits. 💥🧠🔥`;

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama3-70b-8192',
          temperature: 0.7,
          max_tokens: 180,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: cleanedInput },
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


