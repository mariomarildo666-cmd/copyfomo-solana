// parts/eyes/eyes.mjs — glowing LED eyes with a full mood set (HEAD/FACE/EYES designer).
//
// Six eye parts share one mood engine:
//   led (3×3 ■■) · tall (2×4 ▮▮) · orb (4×4 ●●) · slit (4×2 ▬▬) · smile (tall + ‿ mouth) · kitty (led + ω mouth)
// Moods (every part has all of them):
//   idle blink happy wink excited love buy sell money thinking sleep shock rekt lookL lookR
// Eyes sit on ctx.a.eye (the head's LEFT eye centre) and are mirrored to x' = 31 - x.
// Glyphs adapt to the room: close-set heads (15.5 - eye.cx < 3.5, e.g. 'mini') or short screens get the 3-px set;
// LEDs taller than the screen's inner height shrink by 1 px.
// Semantic colours (not the robot eyeColor): love = pink hearts, buy = lime ▲, sell = orange ▼, money = gold $.
// (Polisher: sell was pink ▼, too close to the pink love hearts at 1×.)
// Tight screens (close-set eyes, e.g. 'mini'): the open LED is 2 px wide and 3-px mood glyphs drop their glow, so
// there is always 1 px of screen around and between the eyes (they used to spill onto the pearl and merge in the middle).
// Sleep: closed eyes are 1-px arcs in the dark eye tone with no glow (a glowing LED line still read as awake).
// sleep adds a small "zZ" in the fx slot unless the spec already has an fx part (e.g. fx 'zzz').
// Mouth parts (smile, kitty) centre eyes + mouth in the screen and drop the mouth when it would crowd the eyes.
// A face part may replace a.face (face 'band' does) — glyph sizes and the mouth layout follow the real screen.

export const MOOD_COLORS = { love: 'pink', buy: 'lime', sell: 'orange', money: 'gold' };
export const MOODS = ['idle', 'blink', 'happy', 'wink', 'excited', 'love', 'buy', 'sell', 'money', 'thinking', 'sleep', 'shock', 'rekt', 'lookL', 'lookR'];

const G = {
  heart: ['##.##', '#####', '.###.', '..#..'],
  heartS: ['#.#', '###', '.#.'],
  star: ['..#..', '.###.', '#####', '.###.', '.#.#.'],
  starS: ['.#.', '###', '.#.'],
  up: ['..#..', '.###.', '#####'],
  upS: ['.#.', '###'],
  down: ['#####', '.###.', '..#..'],
  downS: ['###', '.#.'],
  dollar: ['.####', '#.#..', '.###.', '..#.#', '####.'],
  dollarS: ['.##.', '####', '.##.'],   // small room: gold coins
  x: ['#..#', '.##.', '.##.', '#..#'],
  xS: ['#.#', '.#.', '#.#'],
  ring: ['.##.', '#..#', '#..#', '.##.'],
  ringS: ['###', '#.#', '###'],
  arc: ['.##.', '#..#'],
  arcS: ['.#.', '#.#'],
  shut: ['#..#', '.##.'],   // sleeping ‿
  shutS: ['#.#', '.#.'],
};

const MOUTHS = {
  smile: { base: ['#..#', '.##.'], happy: ['#....#', '.####.'], open: ['####', '.##.'], sad: ['.##.', '#..#'], o: ['##', '##'], flat: ['##'] },
  cat: { base: ['#.##.#', '.#..#.'], happy: ['#.##.#', '.#..#.'], open: ['####', '.##.'], sad: ['.#..#.', '#.##.#'], o: ['##', '##'], flat: ['##'] },
};
const MOUTH_FOR = {
  idle: 'base', blink: 'base', wink: 'base', lookL: 'base', lookR: 'base', love: 'base', buy: 'base',
  happy: 'happy', money: 'happy', excited: 'open', sell: 'sad', rekt: 'sad', shock: 'o', thinking: 'flat', sleep: 'flat',
};

const isSym = (rows) => rows.every((r) => r === [...r].reverse().join(''));
const bigRoom = (ctx) => 15.5 - ctx.a.eye.cx >= 3.5;
const rect = (w, h) => Array.from({ length: h }, () => '#'.repeat(w));
const ellipseRows = (w, h) => Array.from({ length: h }, (_, j) => Array.from({ length: w }, (_, i) => {
  const dx = (i + 0.5 - w / 2) / (w / 2), dy = (j + 0.5 - h / 2) / (h / 2);
  return dx * dx + dy * dy <= 1 + 1e-9 ? '#' : '.';
}).join(''));
const lineAt = (w, h, row) => Array.from({ length: h }, (_, j) => (j === row ? '#'.repeat(w) : '.'.repeat(w)));

/** material props: robot eye colour (default) or a named accent lit like an eye (flat + 1-px core + glow) */
function mat(rows, { color, core, glow } = {}) {
  if (!color) {
    const m = { material: 'eye' };
    if (core !== undefined) m.core = core;
    if (glow !== undefined) m.glow = glow;
    return m;
  }
  const c = core === undefined ? [rows[0].indexOf('#'), 0] : core;
  return { material: `accent:${color}`, shade: { hi: 0, lo: 0, loR: 0, deep: 0, spec: c === false ? false : [c] }, glow: glow ?? true };
}

/** the same bits on both eyes, centred on a.eye (+dx,dy); mirrored when symmetric, copied otherwise ($) */
function pair(ctx, rows, o = {}) {
  const w = rows[0].length, h = rows.length;
  const { x, y } = ctx.eyeBox(w, h, 0, o.dy ?? 0);
  const m = mat(rows, o);
  if (isSym(rows)) return [{ ...m, mirror: true, shapes: [['bits', x, y, rows]] }];
  return [{ ...m, shapes: [['bits', x, y, rows], ['bits', ctx.mx(x, w), y, rows]] }];
}
/** different bits per eye (wink) and/or a shared horizontal gaze shift (look) */
function twoEyes(ctx, left, right, o = {}) {
  return [[left, true], [right, false]].map(([rows, isLeft]) => {
    const w = rows[0].length, h = rows.length;
    const { x, y } = ctx.eyeBox(w, h, 0, o.dy ?? 0);
    return { ...mat(rows, o), shapes: [['bits', (isLeft ? x : ctx.mx(x, w)) + (o.shift ?? 0), y, rows]] };
  });
}

/** thinking: three 2×2 "loading" dots across the screen, centred on the axis */
function dots(ctx, dy) {
  const off = bigRoom(ctx) ? 5 : 4;
  const y = ctx.eyeBox(2, 2, 0, dy).y;
  return [{ material: 'eye', ...(bigRoom(ctx) ? {} : { glow: false }), shapes: [['rect', 15 - off, y, 2, 2], ['rect', 15, y, 2, 2], ['rect', 15 + off, y, 2, 2]] }];
}

/**
 * sleep "Z z" in the top-right fx zone, the same place and glyphs as fx 'zzz' (curator: it used to cut into ear tops).
 * Polisher: smaller glyphs (4×4 Z + 3×4 z) in the eye GLOW tone, which reads on white and on dark pages (the pale
 * eye.lo cyan vanished on white), and placed with layer.place: each glyph takes the first spot that keeps 1 clear px
 * from everything and the 1-px canvas margin, else it is dropped — so it never touches ears, hats or hands.
 * Stands down for fx 'zzz' (tag zz) and for any fx that does not free that corner in mood sleep (tag sleepCorner).
 */
export const Z_BIG = ['####', '..#.', '.#..', '####'];
export const Z_SMALL = ['###', '..#', '.#.', '###'];
export const FX_TRY = [[0, 0], [1, 0], [0, 1], [1, 1], [0, -1], [1, -1], [0, 2], [1, 2], [-1, 0], [-1, 1], [0, 3], [1, 3], [-1, 2], [-2, 1]];
function zz(ctx) {
  if (ctx.hasTag('zz') || (ctx.has('fx') && !ctx.hasTag('sleepCorner'))) return [];
  const fy = Math.max(1, ctx.a.top.y - 6);
  const z = (x, y, rows) => ({ name: 'zz', slot: 'fx', outline: false, paint: { x, y, rows, key: { '#': 'eye.glow' } }, place: { at: FX_TRY } });
  return [z(26, fy, Z_BIG), z(27, fy + 5, Z_SMALL)];
}

/**
 * Where eyes + mouth go inside the screen: centred as a group with a 1-row gap (0 if tight), 1-row margins.
 * Returns null (→ no mouth) when it can't fit without the mouth touching an eye.
 */
function mouthLayout(ctx, w, h, rows) {
  const f = ctx.a.face, inner = f.h - 2, mh = rows.length, mw = rows[0].length;
  let gap = 1;
  if (h + gap + mh > inner) gap = 0;
  if (h + gap + mh > inner) return null;
  const top = f.y + 1 + Math.floor((inner - (h + gap + mh)) / 2);
  const box = ctx.eyeBox(w, h);
  const mx = 16 - mw / 2;
  if (gap === 0 && box.x + w - 1 >= mx - 1) return null;
  return { dy: top - box.y, x: mx, y: top + h + gap, rows };
}

/**
 * Eye part factory.
 *   style: { w, h, shape: 'rect' | 'ellipse', core }   the open LED
 *   mouth: key of MOUTHS (optional)
 * Each mood is { w, h, draw(dy) }: w×h is the box used for the eyes+mouth layout.
 */
function makeEyes({ name, description, style, mouth, weight = 1, tags = [] }) {
  // tight screens (close-set eyes): 2-px wide LEDs, at most 3 tall unless the LED already was 2 wide (tall bars)
  const narrow = { ...style, w: Math.min(2, style.w), h: style.w > 2 ? Math.min(3, style.h) : style.h, shape: 'rect', core: undefined };
  const tables = [style, narrow].map((st) => ({
    M: makeMoods(st),
    // compact eyes (1 px shorter): used on screens too short for the LED, and by mouth parts before dropping the mouth
    Mc: st.h >= 4 ? makeMoods({ ...st, h: st.h - 1 }) : null,
    st,
  }));
  const moods = {};
  for (const mood of Object.keys(tables[0].M)) {
    moods[mood] = (ctx) => {
      const { M, Mc, st } = tables[bigRoom(ctx) ? 0 : 1];
      const style = st;
      let m = M[mood](ctx), lay = null;
      if (Mc && style.h > ctx.a.face.h - 2) m = Mc[mood](ctx);
      if (mouth) {
        const rows = MOUTHS[mouth][MOUTH_FOR[mood] ?? 'base'];
        lay = mouthLayout(ctx, m.w, m.h, rows);
        if (!lay && Mc) {
          const mc = Mc[mood](ctx), lc = mouthLayout(ctx, mc.w, mc.h, rows);
          if (lc) { m = mc; lay = lc; }
        }
      }
      const layers = lay
        ? [...m.draw(lay.dy), { name: 'mouth', material: 'eye', core: false, glow: false, shapes: [['bits', lay.x, lay.y, lay.rows]] }]
        : m.draw(0);
      return mood === 'sleep' ? [...layers, ...zz(ctx)] : layers;
    };
  }
  return { name, slot: 'eyes', description, tags: ['eyes', ...tags], weight, moods };
}

/** mood table for one LED style: mood → (ctx) => { w, h, draw(dy) } */
function makeMoods(style) {
  const open = style.shape === 'ellipse' ? ellipseRows(style.w, style.h) : rect(style.w, style.h);
  const { w: sw, h: sh, core } = style;
  const blinkRows = lineAt(sw, sh, sh >= 3 ? Math.floor(sh / 2) : sh - 1);
  const shut = (ctx) => (bigRoom(ctx) || sw >= 4 ? G.shut : G.shutS);
  const sleepShapes = (ctx, rows, dy) => {
    const { x, y } = ctx.eyeBox(rows[0].length, rows.length, 0, dy + Math.ceil((sh - rows.length) / 2));
    return [['bits', x, y, rows]];
  };
  const arc = (ctx) => (bigRoom(ctx) || sw >= 4 ? G.arc : G.arcS);
  // big glyph when there is room both ways (close-set eyes or a short screen → the 3-px set)
  // big glyph when there is room both ways; the 3-px set on short screens, glow-less on tight (close-set) screens
  const glyph = (key, oBig = {}, oSmall = oBig) => (ctx) => {
    const big = bigRoom(ctx) && G[key].length <= ctx.a.face.h - 2;
    const rows = big ? G[key] : G[key + 'S'], o = big ? oBig : { ...oSmall, ...(bigRoom(ctx) ? {} : { glow: false }) };
    return { w: rows[0].length, h: rows.length, draw: (dy) => pair(ctx, rows, { ...o, dy }) };
  };
  const tightGlow = (ctx) => (bigRoom(ctx) ? {} : { glow: false });
  const eyeBoxMood = (draw) => (ctx) => ({ w: sw, h: sh, draw: (dy) => draw(ctx, dy) });

  return {
    idle: eyeBoxMood((ctx, dy) => pair(ctx, open, { core, dy })),
    blink: eyeBoxMood((ctx, dy) => pair(ctx, blinkRows, { dy })),
    happy: eyeBoxMood((ctx, dy) => pair(ctx, arc(ctx), { dy, core: false, ...(sw >= 3 || bigRoom(ctx) ? {} : { glow: false }) })),
    wink: eyeBoxMood((ctx, dy) => twoEyes(ctx, open, arc(ctx), { dy, core, ...tightGlow(ctx) })),
    excited: glyph('star', { core: [2, 2] }, { core: [1, 1] }),
    love: glyph('heart', { color: MOOD_COLORS.love, core: [0, 0] }),
    buy: glyph('up', { color: MOOD_COLORS.buy }),
    sell: glyph('down', { color: MOOD_COLORS.sell }),
    money: glyph('dollar', { color: MOOD_COLORS.money, core: false, glow: false }, { color: MOOD_COLORS.money, core: [1, 0] }),
    thinking: (ctx) => ({ w: 2, h: 2, draw: (dy) => dots(ctx, dy) }),
    // closed ‿ lids in the dark eye tone, no glow, no core
    sleep: eyeBoxMood((ctx, dy) => [{ material: 'flat', color: 'eye.lo', mirror: isSym(shut(ctx)), shapes: sleepShapes(ctx, shut(ctx), dy) }]),
    shock: glyph('ring', { glow: false }),
    rekt: glyph('x', { glow: false }),
    lookL: eyeBoxMood((ctx, dy) => twoEyes(ctx, open, open, { dy, core, shift: -1 })),
    lookR: eyeBoxMood((ctx, dy) => twoEyes(ctx, open, open, { dy, core, shift: 1 })),
  };
}

export default [
  makeEyes({ name: 'led', description: 'Square 3×3 LEDs (■ ■) with a bright core', style: { w: 3, h: 3, shape: 'rect' }, weight: 2 }),
  makeEyes({ name: 'tall', description: 'Tall 2×4 LED bars (▮ ▮)', style: { w: 2, h: 4, shape: 'rect' } }),
  makeEyes({ name: 'orb', description: 'Big round 4×4 eyes with an inner glint', style: { w: 4, h: 4, shape: 'ellipse', core: [1, 1] }, weight: 2 }),
  makeEyes({ name: 'slit', description: 'Wide 4×2 visor slits (▬ ▬)', style: { w: 4, h: 2, shape: 'rect' } }),
  makeEyes({ name: 'smile', description: 'Tall LED bars + glowing smile (the ‿ robot)', style: { w: 2, h: 4, shape: 'rect' }, mouth: 'smile', tags: ['mouth'], weight: 2 }),
  makeEyes({ name: 'kitty', description: 'Square LEDs + ω cat mouth', style: { w: 3, h: 3, shape: 'rect' }, mouth: 'cat', tags: ['mouth'] }),
];
