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
  const options = flavorMap[name] || [];
  if (options.length === 0) return null;
  const pick = options[Math.floor(Math.random() * options.length)];
  return pick.replace('{user}', userMention);
}

module.exports = {
  flavorMap,
  getRandomFlavor
};

