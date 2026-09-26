// robots/samples.mjs — the engine starter samples (moved out of robots.mjs by the curator; rendered as a lab list).
// Extra lists can live in robots/*.mjs (same format: default-export an array) so designers never edit the same file.
// Entry: { name, group?, ...compose spec }  or  { name, group?, seed: 'string', ...overrides }
export default [
  { name: 'sample-scout', group: 'samples', head: 'boxy', face: 'square', eyes: 'pill', top: 'antenna', body: 'basic', arms: 'nub', accent: 'mint' },
  { name: 'sample-kitty', group: 'samples', head: 'round', face: 'square', eyes: 'oval', top: 'catEars', body: 'basic', arms: 'nub', accent: 'pink' },
  { name: 'sample-orbit', group: 'samples', head: 'round', face: 'visor', eyes: 'oval', top: 'antenna', body: 'capsule', arms: 'mitt', prop: 'coin', accent: 'blue' },
  { name: 'sample-goldie', group: 'samples', head: 'boxy', face: 'visor', eyes: 'pill', top: 'catEars', body: 'basic', arms: 'mitt', fx: 'sparkle', shadow: 'pixel', accent: 'gold', eyeColor: 'gold' },

  { name: 'seed-alpha', group: 'seeded', seed: 'alpha' },
  { name: 'seed-whale', group: 'seeded', seed: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
  { name: 'seed-degen', group: 'seeded', seed: 'degen.sol' },
  { name: 'seed-copy', group: 'seeded', seed: 'copyfomo' },
];
