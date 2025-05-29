const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fetch = require('node-fetch');

const flavorMap = {
  rich: [
    '💸 {user} just flexed their bags. Money talks.',
    '🤑 {user} is feeling extra loaded today.',
    '🧈 {user} buttery wallet energy detected!',
    '💰 Who needs banks when you got this kind of flex, {user}?',
    'Ohhh we got some moola, {user}!',
    '💎 {user} out here with diamond wrists.',
    '🪙 {user} just minted another flex.',
    '🏦 Big baller {user} reporting in!',
    '💼 {user} just signed a Web3 deal in gold.',
    '💲 Rich? Nah. {user} is generational wealth now.'
  ],
  sad: [
    '😢 {user} is not vibing today.',
    '🥀 {user} having a not-so-good day.',
    '☔ Someone hug {user} pls.',
    '💔 {user} feeling some Web3 blues.',
    '🫠 All down bad today, hang in there {user}.',
    '📉 {user} portfolio crying too.',
    '🧸 {user} needs some comfort NFTs.',
    '😞 Even the gas fees feel personal today, huh {user}?',
    '🧃 Juice is gone, and so is {user}’s mood.',
    '🪦 Rip {user}’s vibes today.'
  ],
  angry: [
    '🔥 {user} about to burn the whole thing down.',
    '😤 Who poked {user}? They mad mad.',
    '⚠️ Rage level: Over 9000 for {user}.',
    '💢 {user} is seeing red today.',
    '🚨 PSA: Do not cross {user} today.',
    '🪓 {user} chopping rugs left and right.',
    '🚫 Not the day to shill near {user}.',
    '🥊 {user} fighting FUD with fists.',
    '🧨 {user} armed with alpha and attitude.',
    '☠️ {user} going full rekt-mode on devs.'
  ],
  happy: [
    '🌞 {user} shining brighter than the ETH candles.',
    '🕺 {user} vibing to that mint rhythm!',
    '🎉 {user} is mint-high and mood-maxed!',
    '🥂 Cheers! {user} feeling top of the meta.',
    '🧃 Juice full, vibes on peak — {user} is UP!',
    '🎈 {user} floating on Web3 dopamine.',
    '🐸 {user} got a win and won’t shut up about it.',
    '🎁 {user} just unwrapped some alpha joy.',
    '😄 Smiles minted. {user} got the airdrop of happiness.',
    '🌈 Rainbow road unlocked for {user} today.'
  ],
  degen: [
    '🧠 {user} just aped without checking the contract.',
    '🎲 {user} bet it all on vibes and vibes alone.',
    '🧻 {user} on chain toilet paper with style.',
    '💊 Red pill, blue pill? {user} ate both.',
    '🔮 {user} saw the future… and aped anyway.',
    '📉 Floor crashed? {user} bought more.',
    '🕳️ {user} in deep, and they’re smiling.',
    '🔥 {user} burned ETH just to feel alive.',
    '🥵 Gas pain? {user} says “one more tx!”',
    '🤡 {user} laughing with tears and transaction fees.'
  ],
  bullish: [
    '🚀 {user} sees nothing but green candles.',
    '📈 To the moon? Nah. {user} aiming for galaxies.',
    '🦍 {user} in full bull mode — no breaks.',
    '💪 {user} said “let me leverage that hopium.”',
    '🔥 Charts on fire, just like {user}’s DMs.',
    '🐂 Bull horns sharp, {user} charging!',
    '📢 {user} yelling “WAGMI” from the rooftops.',
    '💸 Dip? {user} don’t know her.',
    '🪄 {user} sprinkled magic alpha on the charts.',
    '💼 SEC calling but {user} too busy moonwalking.'
  ],
  rekt: [
    '💀 {user} just got rekt beyond recognition.',
    '🪦 RIP {user}’s wallet, vibes, and portfolio.',
    '🚑 Someone call 911 — {user} just bought top.',
    '📉 {user} living proof of “buy high, sell low.”',
    '😵 {user} can’t even afford hopium anymore.',
    '🥴 {user} can’t tell rug from rare anymore.',
    '😬 {user} down so bad, they checking MySpace for alpha.',
    '🕳️ {user} crawling out of a black hole of bags.',
    '🧼 {user} got cleaned like a whale’s teeth.',
    '📵 Don’t ask {user} about their last play.'
  ],
  legend: [
    '🏆 {user} is built different.',
    '👑 Crown this legend: {user}.',
    '🌌 {user} isn’t early — they’re eternal.',
    '📜 {user} name forever on-chain.',
    '💯 {user} is the alpha others copy.',
    '🎖️ {user} earned respect in every cycle.',
    '🔥 Legendary gas fees? {user} paid them gladly.',
    '🔐 {user} has the seed phrase to greatness.',
    '🕊️ {user} walked so we could mint.',
    '⚡ {user} is the glitch in the meta.'
  ]
};

function getRandomFlavor(name, userMention) {
  const flavors = flavorMap[name] ?? [];
  if (flavors.length === 0) return null;
  const pick = flavors[Math.floor(Math.random() * flavors.length)];
  return pick.replace('{user}', userMention);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('exp')
    .setDescription('Show a visual experience vibe')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Name of the expression (e.g. "rich")')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async execute(interaction, { pg }) {
    const ownerId = process.env.BOT_OWNER_ID;
    const isOwner = interaction.user.id === ownerId;

    const name = interaction.options.getString('name').toLowerCase();
    const guildId = interaction.guild?.id ?? null;
    const userMention = `<@${interaction.user.id}>`;

    let res;
    if (isOwner) {
      res = await pg.query(
        `SELECT * FROM expressions WHERE name = $1 ORDER BY RANDOM() LIMIT 1`,
        [name]
      );
    } else {
      res = await pg.query(
        `SELECT * FROM expressions WHERE name = $1 AND (guild_id = $2 OR guild_id IS NULL) ORDER BY RANDOM() LIMIT 1`,
        [name, guildId]
      );
    }

    if (!res.rows.length && !flavorMap[name]) {
      return interaction.reply({ content: `❌ No expression named \`${name}\` found.`, flags: 64 });
    }

    const exp = res.rows[0];
    const customMessage = exp?.content?.includes('{user}')
      ? exp.content.replace('{user}', userMention)
      : getRandomFlavor(name, userMention) || `💥 ${userMention} is experiencing **"${name}"** energy today!`;

    if (exp?.type === 'image') {
      try {
        const imageRes = await fetch(exp.content);
        if (!imageRes.ok) throw new Error(`Image failed to load: ${imageRes.status}`);
        const file = new AttachmentBuilder(exp.content);
        return await interaction.reply({ content: customMessage, files: [file] });
      } catch (err) {
        console.error('❌ Image fetch error:', err.message);
        return await interaction.reply({ content: `⚠️ Image broken, but:\n${customMessage}`, flags: 64 });
      }
    }

    return interaction.reply({ content: customMessage });
  },

  async autocomplete(interaction, { pg }) {
    const focused = interaction.options.getFocused();
    const guildId = interaction.guild?.id ?? null;

    const res = await pg.query(
      `SELECT DISTINCT name FROM expressions WHERE guild_id = $1 OR guild_id IS NULL`,
      [guildId]
    );

    const dbOptions = res.rows.map(row => row.name);
    const flavorOptions = Object.keys(flavorMap);

    const allOptions = [...new Set([...dbOptions, ...flavorOptions])]
      .filter(name => name.toLowerCase().includes(focused.toLowerCase()))
      .slice(0, 25)
      .map(name => ({ name, value: name }));

    await interaction.respond(allOptions);
  }
};
