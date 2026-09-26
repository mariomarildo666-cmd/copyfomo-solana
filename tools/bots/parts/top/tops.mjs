// tops.mjs — headwear for copyfomo bots (TOPS + FX designer; polished by the polisher).
// Every top reads ctx.a (top.y = first head row on the axis, ear = left ear base, head / face / eye boxes), so it sits
// on any head. Symmetric tops are centred on the axis x = 15.5.
//
// House rules (polisher):
//   · 1-px canvas margin: fills start at row TOP_MIN = 2, so the outline never lands on row 0.
//   · hats end on hatBase(ctx): the lowest head row a hat may cover, chosen so the hat's line lands on pearl ABOVE the
//     face screen — a hat never cuts off the glass or the eyes (it used to on mini / tv heads).
//   · no 2×2 outline blocks: crown dips are diagonal V's, the headphone band shares one outline column with the head.

const FLAT = { hi: 0, lo: 0, loR: 0, deep: 0, spec: false };
/** first row a top may fill (row 0 stays empty, row 1 takes the outline) */
export const TOP_MIN = 2;
/** lowest head row a hat may cover: its line then lands at most on face.y - 1 (pearl), never on the screen */
export const hatBase = (ctx) => Math.min(ctx.a.top.y + 1, ctx.a.face.y - 2);
/** mirror a run [x0, x1] about the axis */
const mirrorRun = (x0, x1) => [31 - x1, 31 - x0];

// ---------------------------------------------------------------- kitty ears
// Slanted pearl ears tucked behind the head corners (the head draws the joint line), accent inner with a rim shadow.
const EAR = [
  '##.....',
  '###....',
  '####...',
  '#####..',
  '######.',
  '#######',
  '#######',
  '#######',
];
const EAR_INNER = [[2, 1, 2], [3, 1, 3], [4, 1, 4], [5, 1, 5]]; // [row, x0, x1] relative to the left ear
const kittyEars = {
  name: 'kittyEars',
  slot: 'top',
  description: 'slanted pearl cat ears with a two-tone accent inner (the "#Vitality" cat bot)',
  tags: ['ears', 'cat'],
  layers: (ctx) => {
    const { x, y } = ctx.a.ear;
    const y0 = Math.max(TOP_MIN, Math.min(y, ctx.a.top.y) - 6); // tip ~6 rows above the head top
    // ear width: the two ears always leave a 4-px notch on the axis (outline · 2 clear px · outline); a 0- or 2-px notch
    // filled with outline into a 2×2 block (mini, round, capsule heads)
    const ew = Math.min(7, 14 - x);
    const rows = EAR.concat(Array(Math.max(0, y + 2 - y0 - EAR.length)).fill('#######')).map((r) => r.slice(0, ew));
    const lo = [], base = [];
    for (const [r, a, b0] of EAR_INNER) {
      const b = Math.min(b0, ew - 2);
      for (const [s, e] of [[x + a, x + b], mirrorRun(x + a, x + b)]) {
        for (let px = s; px <= e; px++) (px === s || r === 2 ? lo : base).push([px, y0 + r]);
      }
    }
    return [
      { slot: 'back', material: 'body', mirror: true, shade: { lo: 0, deep: 0 }, shapes: [['bits', x, y0, rows]] },
      { slot: 'back', material: 'flat', color: 'accent.base', shapes: [['px', base]] },
      { slot: 'back', material: 'flat', color: 'accent.lo', shapes: [['px', lo]] },
    ];
  },
};

// ---------------------------------------------------------------- beacon
// Single slim antenna with a glowing LED bulb in the EYE colour ("agent is live"). The bulb is 4 rows when there is
// room for a 1-px stem under it, else 3. (Polisher: the two loose 1-px light ticks beside it read as dust — removed.)
const beacon = {
  name: 'beacon',
  slot: 'top',
  description: 'single antenna with a glowing LED bulb in the eye colour',
  tags: ['antenna', 'glow'],
  layers: (ctx) => {
    const y = ctx.a.top.y, by = Math.max(TOP_MIN, y - 6);
    const bulb = y - 1 - by >= 4 ? ['.EE.', 'EEee', 'Eeer', '.rr.'] : ['.EE.', 'Eeer', '.rr.'];
    const sy = by + bulb.length - 1;
    return [
      { slot: 'back', material: 'body', takesLine: false, shapes: [['rect', 15, sy, 2, y + 3 - sy]] },
      { paint: { x: 14, y: by, rows: bulb } },
    ];
  },
};

// ---------------------------------------------------------------- twin antennae
const twinAntennae = {
  name: 'twinAntennae',
  slot: 'top',
  description: 'two slim antennae with accent ball tips (the "#Future" card bot)',
  tags: ['antenna'],
  layers: (ctx) => {
    const y = ctx.a.top.y, by = Math.max(TOP_MIN, y - 6);
    return [
      { slot: 'back', material: 'body', takesLine: false, mirror: true, shapes: [['vline', 11, by + 3, y + 3]] },
      { material: 'accent', mirror: true, shapes: [['rect', 10, by, 3, 3]] },
    ];
  },
};

// ---------------------------------------------------------------- bolt ears
// Accent lightning bolts on the head sides at eye height (polisher: the old round discs read exactly like the
// headphone cups at 1×; a zig-zag silhouette reads as "bolt"). In front of the head and any visor band, so the
// bolt plugs into the head and owns the joint line. Hand-lit from the top-left on both sides (a mirrored copy would
// light the right bolt from the right).
const BOLT_L = ['..Aa', '.Aa.', 'Aaaq', '.aq.', 'aq..', 'q...'];
const BOLT_R = ['Aa..', '.Aa.', 'Aaaq', '.aq.', '..aq', '...q'];
const boltEars = {
  name: 'boltEars',
  slot: 'top',
  description: 'accent lightning-bolt ears on the head sides',
  tags: ['ears', 'side'],
  excludes: { arms: ['wave', 'cheer'] }, // raised hands sit exactly where the bolts are
  layers: (ctx) => {
    const h = ctx.a.head, cy = Math.floor(ctx.a.eye.cy);
    const x = Math.max(2, h.x - 4);
    return [
      { paint: { x, y: cy - 3, rows: BOLT_L } },
      { paint: { x: 31 - x - 3, y: cy - 3, rows: BOLT_R } },
    ];
  },
};

// ---------------------------------------------------------------- headphones
// Over-ear headphones: a 1-px accent band that follows the head's own contour one outline away (ring d = 2, so band
// and head share a single outline column — polisher: the old 2-px pearl band read as a second shell and doubled the
// outline), accent cups with pearl cushions.
const headphones = {
  name: 'headphones',
  slot: 'top',
  description: 'over-ear headphones: thin accent band hugging the head, accent cups with pearl cushions',
  tags: ['ears', 'side', 'music'],
  excludes: { arms: ['wave', 'cheer'] },
  layers: (ctx) => {
    const h = ctx.a.head, cy = Math.floor(ctx.a.eye.cy);
    const cx0 = Math.max(2, h.x - 4);           // cup left x (3 accent px + 1 pearl cushion px)
    return [
      { name: 'band', material: 'accent', shade: FLAT, ring: { slot: ['head', 'face'], d: 2, y1: cy - 4 } },
      { name: 'cups', material: 'accent', mirror: true, shapes: [['roundedRect', cx0, cy - 4, 3, 9, 1]] },
      { name: 'cushion', material: 'body', mirror: true, shade: { hi: 0, lo: 1, loR: 0, deep: 0, spec: false }, shapes: [['rect', cx0 + 3, cy - 3, 1, 7]] },
    ];
  },
};

// ---------------------------------------------------------------- propeller cap
// Accent dome (4 rows, ends on hatBase) with a pearl centre panel and a gold spinner. Mood 'blink' turns the blades.
const propellerLayers = (turned) => (ctx) => {
  const hb = hatBase(ctx), top = hb - 3;
  const g = ctx.accent === 'gold' ? 'mint' : 'gold'; // spinner colour, never the same as the cap
  const key = { Y: g + '.hi', y: g + '.base', u: g + '.lo', U: g + '.deep' };
  return [
    { material: 'accent', shapes: [['ellipse', 9, top, 14, 8]], cut: [['rect', 0, hb + 1, 32, 12]] },
    { material: 'body', clip: ['top'], shade: { hi: 1, lo: 0, loR: 0, deep: 0, spec: false }, shapes: [['rect', 15, top, 2, 4]] },
    { paint: { x: 10, y: top - 2, key, rows: turned ? [
      '.....Yy.....',
      '....YYyu....',
      '.....yu.....',
    ] : [
      '.....Yy.....',
      'YYyyyYyyyyyu',
      '.....yu.....',
    ] } },
  ];
};
const propeller = {
  name: 'propeller',
  slot: 'top',
  description: 'propeller cap: accent dome, pearl centre panel, gold spinner (blades turn on blink)',
  tags: ['hat', 'fun'],
  moods: { idle: propellerLayers(false), blink: propellerLayers(true) },
};

// ---------------------------------------------------------------- crown
// Gold three-point crown with jewels in the robot accent (mint when the robot is gold). For the ORIGINAL trader.
// 5 rows; the dips between the points are diagonal V's (polisher: the old 2×2 notches outlined into dark blocks and
// read as a castle wall). Shared by copyCrown.mjs, which recolours it.
export const CROWN_ROWS = [
  'Y....Yy....u',
  'Yy..YYyy..yu',
  'YYyyyJjyyyyu',
  'Yjyyyjqyyyju',
  'uuuuuuuuuuuU',
];
export const crownY = (ctx) => Math.max(TOP_MIN, ctx.a.top.y - CROWN_ROWS.length);
const crown = {
  name: 'crown',
  slot: 'top',
  description: 'gold crown with accent jewels — for the ORIGINAL trader',
  tags: ['hat', 'crown', 'gold', 'royal'],
  weight: 0, // never seeded: the app puts it on the ORIGINAL trader explicitly
  layers: (ctx) => {
    const j = ctx.accent === 'gold' ? 'mint' : ctx.accent;
    return [{ paint: { x: 10, y: crownY(ctx), key: { Y: 'gold.hi', y: 'gold.base', u: 'gold.lo', U: 'gold.deep', J: `${j}.hi`, j: `${j}.base`, q: `${j}.lo` }, rows: CROWN_ROWS } }];
  },
};

// ---------------------------------------------------------------- top hat
// Small silk top hat in dark steel with a lit top-left rim and an accent band (polisher: the old screen-black fill was
// one tone off the outline, so the hat read as a single dark blob and vanished on dark tiles).
const topHat = {
  name: 'topHat',
  slot: 'top',
  description: 'tiny dark-steel top hat with a lit rim and an accent band',
  tags: ['hat', 'fancy'],
  layers: (ctx) => {
    const y = Math.max(TOP_MIN, ctx.a.top.y - 5);
    return [{ paint: { x: 10, y, key: { H: 'steel.hi', b: 'steel.base', k: 'steel.shade', K: 'steel.deep' }, rows: [
      '..HHHHHHHb..',
      '..Hbbbbbkk..',
      '..HbbbbbkK..',
      '..AAaaaaaq..',
      'HHbbbbbbbkKK',
    ] } }];
  },
};

// ---------------------------------------------------------------- beanie
// Knit accent beanie (5 rows ending on hatBase): round dome, vertically ribbed cuff, pearl pompom.
const beanie = {
  name: 'beanie',
  slot: 'top',
  description: 'knit accent beanie with a ribbed cuff and a pearl pompom',
  tags: ['hat', 'cozy'],
  layers: (ctx) => {
    const top = hatBase(ctx) - 4;
    return [
      { paint: { x: 7, y: top, rows: [
        '....AAAaaaaaqq....',
        '..AAaaaaaaaaaaqq..',
        '.Aaaaaaaaaaaaaaqq.',
        'AaAaAaAaAaAaAaAaqQ',
        'aqaqaqaqaqaqaqaqqQ',
      ] } },
      { line: true, paint: { x: 14, y: top - 1, rows: ['.WW.', 'WWws', '.ss.'] } },
    ];
  },
};

// ---------------------------------------------------------------- cap
// Accent snapback (6-row dome ending on hatBase) with the bill to the side; the bill stays inside x <= 29.
const cap = {
  name: 'cap',
  slot: 'top',
  description: 'accent snapback cap with the bill to the side',
  tags: ['hat', 'street'],
  layers: (ctx) => {
    const hb = hatBase(ctx), top = hb - 5;
    return [
      { material: 'accent', shapes: [['ellipse', 8, top, 16, 12]], cut: [['rect', 0, hb + 1, 32, 12]] },
      { material: 'accent', line: true, shade: { hi: 1, lo: 1, loR: 1, deep: 1, spec: false }, shapes: [['roundedRect', 21, hb - 1, 9, 2, 1]] },
      { material: 'accent', shade: FLAT, shapes: [['rect', 15, top, 2, 1]] },
    ];
  },
};

// ---------------------------------------------------------------- halo
// Thin floating gold ring seen from slightly above: 1-px ring, 2-row see-through hole, lit back arc, shaded front arc.
// It is light, so it has no outline (like sparkles), and it floats with one clear row above the head's outline
// (polisher: the old filled 3-row pill read as a hot dog and sat on dome heads with a doubled outline).
const halo = {
  name: 'halo',
  slot: 'top',
  description: 'thin floating gold halo',
  tags: ['halo', 'gold'],
  outline: false,
  line: false,
  layers: (ctx) => {
    const y = Math.max(1, ctx.a.top.y - 6);
    return [{ paint: { x: 9, y, key: { Y: 'gold.hi', y: 'gold.base', u: 'gold.lo', U: 'gold.deep' }, rows: [
      '..yYYyyyyyyu..',
      '.y..........u.',
      '.u..........U.',
      '..uuuuuuuuUU..',
    ] } }];
  },
};

export default [kittyEars, beacon, twinAntennae, boltEars, headphones, propeller, crown, topHat, beanie, cap, halo];
