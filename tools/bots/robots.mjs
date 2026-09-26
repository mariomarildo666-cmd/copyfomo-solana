// robots.mjs — the CURATED copyfomo cast (curator). This is the set the app ships: out/png, out/png@8x, out/svg,
// out/sheet.png, out/moodset.png and the top of gallery.html. Designer showcase lists live in robots/*.mjs and are
// rendered as "lab" robots into out/lab/ (they never enter the shipped sheet).
//
// Entry: { name, group?, about?, moodSet?, ...compose spec }  or  { name, group?, seed: 'string', ...overrides }
//   about    one-line character note shown in the gallery (not part of the spec)
//   moodSet  true → also gets a row in out/moodset.png (idle blink happy buy sell sleep) + the live mood demo
//
// Coverage: every head (8), every body (7), every accent (7) and every seedable top (12) appears at least once;
// the crown belongs to The Original. Specs are written out in full so they never depend on DEFAULT_SPEC.
//
// Polisher pass (art-director review): no hero uses a combination the seed rules ban; cat ears on 4 heroes (was 6);
// headphones only on Echo (Blip's matched them at 1×); every terminal chest shows something of its own (spec.chest);
// Sunny's eyes are cyan (gold eyes in a gold bezel read as a gold donut); raised arms never share a side with fx.

const hero = (name, about, spec) => ({ name, group: 'heroes', about, shadow: 'soft', face: 'fit', eyeColor: 'cyan', front: null, fx: null, ...spec });

export default [
  // ---------------------------------------------------------------- 24 heroes
  hero('minty', 'The host. Waves you in and explains copy trading.', { head: 'tv', eyes: 'smile', top: 'twinAntennae', body: 'basic', arms: 'wave', accent: 'mint', moodSet: true }),
  hero('byte', 'The analyst. Reads every candle before it copies.', { head: 'boxy', face: 'bezel', eyes: 'led', top: 'antenna', body: 'terminal', arms: 'hold', front: 'chartCard', chest: 'bars', accent: 'blue', moodSet: true }),
  hero('kit', 'The sweetheart. Copies only traders it loves.', { head: 'cat', eyes: 'kitty', top: null, body: 'belly', arms: 'wave', fx: 'hearts', accent: 'pink', moodSet: true }),
  hero('orbit', 'The moonshot. Always one rocket away from the moon.', { head: 'dome', eyes: 'orb', top: 'beacon', body: 'hover', arms: 'hold', front: 'rocket', accent: 'blue', moodSet: true }),
  hero('nova', 'The guardian angel. Stop-loss always on.', { head: 'capsule', eyes: 'tall', top: 'halo', body: 'capsule', arms: 'mitt', fx: 'twinkle', accent: 'violet' }),
  hero('pixel', 'The hype bot. Celebrates every green candle.', { head: 'mini', eyes: 'smile', top: 'propeller', body: 'basic', arms: 'cheer', accent: 'lime' }),
  hero('volt', 'The speedster. First in, first out.', { head: 'wide', face: 'band', eyes: 'slit', top: 'boltEars', body: 'mech', arms: 'down', accent: 'gold' }),
  hero('echo', 'The listener. Tunes into whale wallets.', { head: 'round', eyes: 'orb', top: 'headphones', body: 'belly', arms: 'down', accent: 'violet', eyeColor: 'violet' }),
  hero('zap', 'The FOMO bot. Never misses a pump.', { head: 'wide', eyes: 'tall', top: 'beacon', body: 'hover', arms: 'down', fx: 'fire', accent: 'orange' }),
  hero('chip', 'The little one. Small bags, big dreams.', { head: 'mini', face: 'rounded', eyes: 'led', top: 'antenna', body: 'basic', arms: 'nub', accent: 'mint' }),
  hero('luna', 'The night owl. Trades while you sleep.', { head: 'dome', eyes: 'orb', top: 'kittyEars', body: 'scarf', arms: 'down', fx: 'twinkle', accent: 'violet', eyeColor: 'pink' }),
  hero('rex', 'The whale. Top hat, deep pockets.', { head: 'boxy', eyes: 'led', top: 'topHat', body: 'terminal', arms: 'hold', front: 'solCoin', fx: 'coins', chest: 'gold', accent: 'gold', eyeColor: 'gold' }),
  hero('mochi', 'The cozy one. Holds through every dip.', { head: 'capsule', eyes: 'smile', top: 'beanie', body: 'capsule', arms: 'nub', fx: 'hearts', accent: 'pink' }),
  hero('sunny', 'The optimist. Every day is a green day.', { head: 'round', face: 'bezel', eyes: 'smile', top: 'halo', body: 'basic', arms: 'cheer', accent: 'gold', eyeColor: 'cyan' }),
  hero('juno', 'The scout. Sniffs out top traders.', { head: 'cat', face: 'band', eyes: 'slit', top: null, body: 'hover', arms: 'hold', front: 'magnifier', accent: 'blue' }),
  hero('astro', 'The explorer. Charts new tokens first.', { head: 'dome', eyes: 'tall', top: 'antenna', body: 'mech', arms: 'mitt', accent: 'orange' }),
  hero('dash', 'The day trader. Lives on the 1-minute chart.', { head: 'tv', eyes: 'orb', top: 'cap', body: 'terminal', arms: 'hold', front: 'phone', chest: 'line', accent: 'lime' }),
  hero('pip', 'The rookie. Copied its first trade today.', { head: 'mini', eyes: 'orb', top: 'beacon', body: 'belly', arms: 'wave', accent: 'orange' }),
  hero('ziggy', 'The degen. Snapback on, bags packed.', { head: 'boxy', eyes: 'kitty', top: 'cap', body: 'scarf', arms: 'down', accent: 'pink' }),
  hero('tofu', 'The sleeper. Agent paused, dreaming of gains.', { head: 'capsule', face: 'rounded', eyes: 'led', top: 'beanie', body: 'scarf', arms: 'nub', accent: 'blue', mood: 'sleep' }),
  hero('coco', 'The champion. Tops the weekly leaderboard.', { head: 'round', eyes: 'tall', top: 'topHat', body: 'belly', arms: 'hold', front: 'trophy', accent: 'orange' }),
  hero('blip', 'The pinger. Beeps on every copied trade.', { head: 'tv', face: 'bezel', eyes: 'orb', top: 'beanie', body: 'mech', arms: 'down', accent: 'violet' }),
  hero('jet', 'The flyer. Propeller up, bags up.', { head: 'wide', eyes: 'led', top: 'propeller', body: 'capsule', arms: 'wave', accent: 'lime' }),
  hero('kiki', 'The cheerleader. Thumbs up for every copy.', { head: 'cat', eyes: 'smile', top: null, body: 'scarf', arms: 'thumbsUp', accent: 'lime' }),

  // ---------------------------------------------------------------- the pair: same silhouette, gold vs mint
  { name: 'the-original', group: 'pair', about: 'A crowned top trader. Everyone copies this one.', moodSet: true,
    shadow: 'soft', head: 'tv', face: 'fit', eyes: 'smile', top: 'crown', body: 'terminal', chest: 'candles', arms: 'hold', front: 'phone', fx: null, accent: 'gold', eyeColor: 'cyan' },
  { name: 'the-copy', group: 'pair', about: 'Your agent. Same moves, a minted crown, a copy card in hand.', moodSet: true,
    shadow: 'soft', head: 'tv', face: 'fit', eyes: 'smile', top: 'copyCrown', body: 'terminal', chest: 'check', arms: 'hold', front: 'copyCard', fx: null, accent: 'mint', eyeColor: 'cyan' },

  // ---------------------------------------------------------------- app icons: head only, centred (favicon / app icon)
  { name: 'icon-minty', group: 'icons', about: 'App icon: Minty, head only.', head: 'tv', face: 'fit', eyes: 'smile', top: 'twinAntennae', body: null, arms: null, shadow: null, front: null, fx: null, accent: 'mint', eyeColor: 'cyan', align: 'center' },
  { name: 'icon-kit', group: 'icons', about: 'App icon: cat bot, head only.', head: 'cat', face: 'fit', eyes: 'kitty', top: null, body: null, arms: null, shadow: null, front: null, fx: null, accent: 'mint', eyeColor: 'cyan', align: 'center' },
  { name: 'icon-orb', group: 'icons', about: 'App icon: dome bot with a live beacon.', head: 'dome', face: 'fit', eyes: 'orb', top: 'beacon', body: null, arms: null, shadow: null, front: null, fx: null, accent: 'mint', eyeColor: 'cyan', align: 'center' },
];
