// parts/head/heads.mjs — pearl heads for copyfomo bots (HEAD designer).
//
// Every head owns the anchors head / face / eye / top / ear and (extra, optional keys read by my face parts):
//   a.face.shape  'rrect' | 'ellipse' | 'pill' | 'mask' | 'band'   native screen shape for face 'fit'
//   a.face.r      corner profile for rrect screens
//   a.band        {x,y,w,h} where a wrap-around visor band fits (face 'band')
// Rules kept by all heads: bottom fill row = 19 (bodies hide their top rows under it), top row >= 6 (room for tops),
// symmetric about x = 15.5, fills inside 4..27.
//
// Lighting comes from the material (top-left). Heads only add tiny accent details (status LED, ear inners).

const FLAT = { hi: 0, lo: 0, loR: 0, deep: 0, spec: false };

/** rows cut from each side, top row first → bits rows (w wide) — for shapes rrect can't express (different top/bottom). */
export function profileBits(w, h, top = [], bottom = []) {
  const rows = [];
  for (let j = 0; j < h; j++) {
    const cut = Math.min(Math.floor(w / 2), (top[j] ?? 0) + (bottom[h - 1 - j] ?? 0));
    rows.push('.'.repeat(cut) + '#'.repeat(w - 2 * cut) + '.'.repeat(cut));
  }
  return rows;
}

export default [
  // ------------------------------------------------------------------ tv
  {
    name: 'tv',
    slot: 'head',
    preview: { face: 'fit', eyes: 'led' },
    description: 'Rounded TV box: squarer corners, tall screen, chin status LED in the accent colour',
    tags: ['boxy', 'tv', 'flatTop'],
    anchors: {
      head: { x: 6, y: 7, w: 20, h: 13 },
      face: { x: 8, y: 9, w: 16, h: 8, shape: 'rrect', r: [2, 1] },
      eye: { cx: 12, cy: 12.5 },
      top: { y: 7 },
      ear: { x: 7, y: 7 },
      band: { x: 7, y: 10, w: 18, h: 6 },
    },
    layers: (ctx) => {
      const { x, y, w, h } = ctx.a.head;
      return [
        { name: 'shell', material: 'body', line: true, shapes: [['roundedRect', x, y, w, h, [3, 1, 1]]] },
        // status LED under the screen (reads as "agent online")
        { name: 'led', material: 'accent', shade: { ...FLAT, spec: [[0, 0]] }, shapes: [['rect', 15, y + h - 2, 2, 1]] },
      ];
    },
  },

  // ------------------------------------------------------------------ dome
  {
    name: 'dome',
    slot: 'head',
    preview: { face: 'fit', eyes: 'orb', top: null },
    description: 'Astronaut bubble: big round pearl helmet with an oval glass visor',
    tags: ['round', 'dome'],
    anchors: {
      head: { x: 5, y: 6, w: 22, h: 14 },
      face: { x: 8, y: 9, w: 16, h: 9, shape: 'ellipse' },
      eye: { cx: 12, cy: 13.5 },
      top: { y: 6 },
      ear: { x: 7, y: 9 },
    },
    layers: (ctx) => {
      const { x, y, w, h } = ctx.a.head;
      return [
        { name: 'shell', material: 'body', line: true, shapes: [['bits', x, y, profileBits(w, h, [7, 4, 2, 1, 1], [5, 3, 2, 1])]] },
      ];
    },
  },

  // ------------------------------------------------------------------ capsule
  {
    name: 'capsule',
    slot: 'head',
    preview: { face: 'fit', eyes: 'tall' },
    description: 'Wide pill head with accent end caps and a pill-shaped screen',
    tags: ['round', 'pill'],
    anchors: {
      head: { x: 5, y: 9, w: 22, h: 11 },
      face: { x: 8, y: 11, w: 16, h: 7, shape: 'pill' },
      eye: { cx: 12, cy: 14.5 },
      top: { y: 9 },
      ear: { x: 8, y: 10 },
    },
    layers: (ctx) => {
      const { x, y, w, h } = ctx.a.head;
      return [
        { name: 'shell', material: 'body', line: true, shapes: [['roundedRect', x, y, w, h, [5, 3, 2, 1]]] },
        // accent end caps (two-tone pill), clipped to the rounded ends; the right cap sits in the shadow side
        { name: 'capL', material: 'accent', clip: 'head', shade: { hi: 1, lo: 1, loR: 0, deep: 0, spec: false }, shapes: [['rect', x, y, 2, h]] },
        { name: 'capR', material: 'accent', clip: 'head', shade: { hi: 0, lo: 1, loR: 1, deep: 1, spec: false }, shapes: [['rect', x + w - 2, y, 2, h]] },
      ];
    },
  },

  // ------------------------------------------------------------------ cat
  {
    name: 'cat',
    slot: 'head',
    preview: { face: 'fit', eyes: 'kitty', top: null },
    description: 'Cat head: ear bases are part of the head silhouette, accent inner ears, muzzle-shaped screen',
    tags: ['catHead', 'flatTop'],
    excludes: { top: ['catEars', 'kittyEars', 'headphones'] },
    anchors: {
      head: { x: 6, y: 8, w: 20, h: 12 },
      face: { x: 8, y: 10, w: 16, h: 8, shape: 'mask' },
      eye: { cx: 12, cy: 13.5 },
      top: { y: 8 },
      ear: { x: 7, y: 8 },
      band: { x: 7, y: 11, w: 18, h: 5 },
    },
    layers: (ctx) => {
      const { x, y, w, h } = ctx.a.head;
      // another ear top or a hat in the spec → drop the built-in ears so they never double up / poke through
      const ears = !(ctx.has('top', 'catEars') || ctx.has('top', 'kittyEars') || ctx.hasTag('hat') || (ctx.hasTag('ears') && !ctx.hasTag('side')));
      const earShape = ['bits', x + 1, y - 5, ['#.....', '##....', '###...', '####..', '#####.']];
      return [
        { name: 'shell', material: 'body', line: true, mirror: true, shapes: [['bits', x, y, profileBits(w, h, [1], [3, 1, 1])], ...(ears ? [earShape] : [])] },
        ears && { name: 'innerEar', material: 'accent', mirror: true, shade: FLAT, shapes: [['bits', x + 2, y - 3, ['#..', '##.', '###']]] },
      ];
    },
  },

  // ------------------------------------------------------------------ wide
  {
    name: 'wide',
    slot: 'head',
    preview: { face: 'fit', eyes: 'slit' },
    // Polisher: face 'fit' is an inset screen 2 px in from each side (pearl frame + the head's side outline stay);
    // only face 'band' wraps the visor around the head (a.band) — that look belongs to the band face, not to fit.
    description: 'Round-top helmet with a wide inset screen; face band wraps a visor around it',
    tags: ['boxy', 'wide', 'visor', 'flatTop'],
    anchors: {
      head: { x: 6, y: 7, w: 20, h: 13 },
      face: { x: 8, y: 10, w: 16, h: 7, shape: 'rrect', r: [2, 1] },
      eye: { cx: 12, cy: 13.5 },
      top: { y: 7 },
      ear: { x: 7, y: 8 },
      band: { x: 5, y: 10, w: 22, h: 7 },
    },
    layers: (ctx) => {
      const { x, y, w, h } = ctx.a.head;
      return [{ name: 'shell', material: 'body', line: true, shapes: [['bits', x, y, profileBits(w, h, [6, 3, 2, 1, 1], [3, 1, 1])]] }];
    },
  },

  // ------------------------------------------------------------------ mini
  {
    name: 'mini',
    slot: 'head',
    preview: { face: 'fit', eyes: 'smile' },
    description: 'Little square head (baby bot), close-set eyes',
    tags: ['boxy', 'mini', 'small', 'flatTop'],
    anchors: {
      head: { x: 8, y: 8, w: 16, h: 12 },
      face: { x: 10, y: 10, w: 12, h: 8, shape: 'rrect', r: [2, 1] },
      eye: { cx: 13, cy: 13.5 },
      top: { y: 8 },
      ear: { x: 9, y: 8 },
      band: { x: 9, y: 11, w: 14, h: 6 },
    },
    layers: (ctx) => {
      const { x, y, w, h } = ctx.a.head;
      return [{ name: 'shell', material: 'body', line: true, shapes: [['roundedRect', x, y, w, h, [3, 1, 1]]] }];
    },
  },
];
