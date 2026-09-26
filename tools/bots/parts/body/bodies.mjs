// Bodies by the body/arms/props designer (polished by the polisher). Each body OWNS the anchors body / hand / feet:
//   body = torso fill box (its top rows hide under the head; heads end on row 19)
//   hand = LEFT hand centre px — arms read it, props hold at grip (31 - hand.x, hand.y)
//   feet = feet rows. ground stays 29 (outline row under the feet) so every robot stands on the same line.
// Torso layers set line:true explicitly so the torso edge draws a line into the feet/legs of the SAME part
// (the engine only draws intra-part lines for layers that ask for them).
//
// Polisher rules shared by every legged body:
//   · feet end on x 13 / start on x 18, so the gap between the legs is open (outline · 2 px of shadow · outline)
//     instead of a 2×2 block of outline;
//   · feet are painted lit from the top-left (left edge light, right edge / sole dark), each foot the same way —
//     no "pillow" shading with dark on both sides;
//   · a 1-row accent band on a round torso is lit on its left end and shaded on its right end, never one flat tone.

/** a pair of painted feet: left foot at x0, right foot mirrored (same top-left lighting on both) */
const feetPair = (x0, y, rows) => [
  { name: 'footL', paint: { x: x0, y, rows } },
  { name: 'footR', paint: { x: 31 - x0 - (rows[0].length - 1), y, rows } },
];
const FOOT4 = ['.Ww.', 'Wwws', '.sd.'];
const FOOT3 = ['Ww.', 'Wws', '.d.'];
/** 1-row accent band `w` wide: 3 lit px at the left end, 3 shaded px at the right end */
export const band = (w, lit = 3) => 'A'.repeat(lit) + 'a'.repeat(Math.max(0, w - 2 * lit)) + 'q'.repeat(lit);

// Terminal chest screens (8×3 glass, content drawn from x + 1). spec.chest picks one; seeds derive it from the seed.
export const CHESTS = {
  candles: { key: { R: 'pink.base', G: 'lime.base', g: 'lime.hi' }, rows: ['....gG', 'RR..GG', 'RR....'] },       // red → green
  line:    { key: { G: 'lime.base', g: 'lime.hi' }, rows: ['....gG', '..gG..', 'gG....'] },                        // chart going up
  bars:    { key: { B: 'blue.base', b: 'blue.hi', G: 'lime.base' }, rows: ['.....G', '...b.G', '.B.b.G'] },         // bar chart
  check:   { key: { G: 'lime.base', g: 'lime.hi' }, rows: ['.....g', 'G...G.', '.GGG..'] },                        // copied ✓
  gold:    { key: { Y: 'gold.hi', y: 'gold.base', u: 'gold.lo' }, rows: ['..Yy..', '.Yyuy.', 'Yyuyyu'] },           // gold pile
};

export default [
  // ------------------------------------------------------------------ terminal
  {
    name: 'terminal',
    slot: 'body',
    description: 'compact boxy torso with a chest screen (spec.chest: candles | line | bars | check | gold)',
    tags: ['screen', 'legs', 'trade'],
    anchors: { body: { x: 10, y: 18, w: 12, h: 8 }, hand: { x: 8, y: 23 }, feet: { y: 26, h: 3 } },
    layers: (ctx) => {
      const b = ctx.a.body, f = ctx.a.feet;
      const sx = b.x + 2, sy = b.y + 4; // chest screen 8×3 (x 12..19, rows 22..24)
      const chest = CHESTS[ctx.spec.chest] ?? CHESTS.candles;
      return [
        ...feetPair(b.x, f.y, FOOT4),
        { name: 'torso', material: 'body', line: true, shapes: [['roundedRect', b.x, b.y, b.w, b.h, 1]] },
        { name: 'screen', material: 'screen', gloss: false, shapes: [['rect', sx, sy, b.w - 4, 3]] },
        { name: 'chest', paint: { x: sx + 1, y: sy, key: chest.key, rows: chest.rows } },
      ];
    },
  },

  // ------------------------------------------------------------------ belly
  {
    name: 'belly',
    slot: 'body',
    description: 'round pearl belly (wider than the head bottom) with a framed accent panel and stubby feet',
    tags: ['round', 'legs'],
    anchors: { body: { x: 8, y: 17, w: 16, h: 10 }, hand: { x: 6, y: 23 }, feet: { y: 26, h: 3 } },
    layers: (ctx) => {
      const b = ctx.a.body, f = ctx.a.feet;
      const px = b.x + 4, py = b.y + 4; // panel frame 8×4 (x 12..19, rows 21..24)
      return [
        ...feetPair(b.x + 2, f.y, FOOT4),
        { name: 'belly', material: 'body', line: true, shapes: [['ellipse', b.x, b.y, b.w, b.h]] },
        { name: 'frame', material: 'flat', color: 'body.shade', shapes: [['roundedRect', px, py, 8, 4, 1]] },
        { name: 'panel', paint: { x: px + 1, y: py + 1, rows: ['AAaaaq', 'aaaqqq'] } },
      ];
    },
  },

  // ------------------------------------------------------------------ scarf
  {
    name: 'scarf',
    slot: 'body',
    description: 'slim torso on thin legs with a 2-row accent scarf and a short tail; the scarf sits over the arms',
    tags: ['slim', 'legs', 'scarf'],
    anchors: { body: { x: 11, y: 18, w: 10, h: 8 }, hand: { x: 9, y: 23 }, feet: { y: 26, h: 3 } },
    layers: (ctx) => {
      const b = ctx.a.body, f = ctx.a.feet;
      // polisher: the scarf is now 2 rows at the neck (lit band + shade row) with a 2×3 tail lit at its top-left,
      // leaving 3–4 rows of torso visible; the old 3-row ribbed wrap covered almost the whole torso.
      const w = b.w + 2, x = b.x - 1, y = b.y + 3; // row under the head's bottom outline
      return [
        ...feetPair(b.x, f.y, FOOT3),
        // 1-px bottom corners: with r 2 the hanging hand left a 2-px gap at row 24 that filled with a doubled outline
        { name: 'torso', material: 'body', line: true, shapes: [['roundedRect', b.x, b.y, b.w, b.h, [1]]] },
        // wrap + tail are ONE layer (no seam line between them); the tail hangs right of centre so the torso keeps
        // 3+ px on both sides of it (a 1-px torso sliver beside it doubled the outline)
        { name: 'scarf', slot: 'head', line: true, paint: { x, y, rows: [
          '.' + band(w - 2, 2) + '.',
          'A' + 'a'.repeat(w - 3) + 'qQ',
          ...['Aa', 'aq', 'qQ'].map((t) => '.'.repeat(w - 6) + t + '....'),
        ] } },
      ];
    },
  },

  // ------------------------------------------------------------------ hover
  {
    name: 'hover',
    slot: 'body',
    description: 'legless floating torso with an accent belt, a thruster and a soft accent hover flame',
    tags: ['float'],
    anchors: { body: { x: 10, y: 18, w: 12, h: 7 }, hand: { x: 8, y: 22 }, feet: { y: 25, h: 1 } },
    layers: (ctx) => {
      const b = ctx.a.body;
      return [
        { name: 'torso', material: 'body', shapes: [['bits', b.x, b.y, [
          '############',
          '############',
          '############',
          '############',
          '############',
          '.##########.',
          '..########..',
        ]]] },
        { name: 'belt', clip: 'body', paint: { x: b.x, y: b.y + 4, rows: [band(b.w)] } },
        { name: 'nozzle', material: 'flat', color: 'body.deep', shapes: [['rect', b.x + 4, b.y + 7, 4, 1]] },
        // flame: outside the silhouette (outline:false) so it glows on light and dark pages alike
        { name: 'flame', slot: 'fx', outline: false, paint: { x: b.x + 4, y: b.y + 8, rows: ['aAAq', '.aq.'] } },
      ];
    },
  },

  // ------------------------------------------------------------------ mech
  {
    name: 'mech',
    slot: 'body',
    description: 'short torso on chunky mech legs: steel pistons, accent knee pads and big boots',
    tags: ['mech', 'legs'],
    anchors: { body: { x: 10, y: 18, w: 12, h: 6 }, hand: { x: 8, y: 22 }, feet: { y: 26, h: 3 } },
    layers: (ctx) => {
      const b = ctx.a.body;
      return [
        // one painted leg per side: accent knee cuff over a big boot (the torso's line lands on the top row)
        ...feetPair(b.x - 2, b.y + b.h, ['...ww.', '.Aaaq.', '.WwwW.', 'Wwwwws', 'Wsssdd']),
        // square bottom corners: a hanging hand beside a rounded corner left a 2×2 block of outline
        { name: 'torso', material: 'body', line: true, shapes: [['rect', b.x, b.y, b.w, b.h]] },
        { name: 'vent', material: 'flat', color: 'body.shade', shapes: [['hline', b.x + 3, b.x + b.w - 4, b.y + 4]] },
      ];
    },
  },
];
