// parts/face/faces.mjs — glossy black face screens (HEAD/FACE/EYES designer).
// A face fills the head's screen box ctx.a.face. Heads from parts/head/heads.mjs add hints:
//   a.face.shape ('rrect' | 'ellipse' | 'pill' | 'mask' | 'band'), a.face.r (rrect corners), a.band (visor band box).
// Starter heads (boxy, round) have no hints: 'fit' then behaves like the starter 'square'.
import { RASTER } from '../../sprite.mjs';

/** rows cut from each side (top rows first / bottom rows first) → bits rows */
function profileBits(w, h, top = [], bottom = []) {
  const rows = [];
  for (let j = 0; j < h; j++) {
    const cut = Math.min(Math.floor(w / 2), (top[j] ?? 0) + (bottom[h - 1 - j] ?? 0));
    rows.push('.'.repeat(cut) + '#'.repeat(w - 2 * cut) + '.'.repeat(cut));
  }
  return rows;
}

/** screen outline for a box + shape name */
export function screenShape(f, shape = f.shape) {
  switch (shape) {
    case 'ellipse': return ['ellipse', f.x, f.y, f.w, f.h];
    case 'pill': return ['roundedRect', f.x, f.y, f.w, f.h, f.h >= 8 ? [4, 2, 1] : [3, 1, 1]];
    case 'mask': return ['bits', f.x, f.y, profileBits(f.w, f.h, [2, 1], [4, 2, 1])];
    case 'band': return ['roundedRect', f.x, f.y, f.w, f.h, [1]];
    default: return ['roundedRect', f.x, f.y, f.w, f.h, f.r ?? 2];
  }
}

// Screen gloss (polisher): ONE standard 3-px "/" streak near the top-left corner of every screen — the diagonal
// (x0+3, y0+1) (x0+2, y0+2) (x0+1, y0+3) of the screen box, like byte's. It is its own layer drawn AFTER the eyes (slot
// top), only onto glass or eye glow (onto), and slides to the nearest spot where all 3 px land on glass: the eyes used
// to overwrite it, leaving 1-px strays on most screens. It stays in the top-left corner: when an eye sits right in
// that corner (smile eyes on small screens), a 2-px corner streak is used instead of moving the gloss elsewhere.
const GLOSS_TRY = [[0, 0], [-1, 0], [1, 0], [0, 1], [-1, 1], [-2, 0]];
export const gloss = (box) => {
  const L = (pts) => ({
    name: 'gloss', slot: 'top', material: 'flat', color: 'screen.gloss', line: false, takesLine: false, outline: false,
    onto: ['screen', 'glow'], shapes: [['px', pts.map(([dx, dy]) => [box.x + dx, box.y + dy])]],
  });
  return { ...L([[3, 1], [2, 2], [1, 3]]), place: { fit: 'onto', at: GLOSS_TRY, alt: [L([[2, 1], [1, 2]])] } };
};
const ROUND_HEADS = ['dome', 'capsule', 'round'];
const FLAT_SIDED = ['tv', 'wide', 'mini', 'cat', 'boxy'];

export default [
  {
    name: 'fit',
    slot: 'face',
    description: "The head's native screen (rounded rect / oval / pill / cat muzzle / visor band)",
    weight: 4,
    layers: (ctx) => [ctx.a.face.shape === 'band'
      ? { material: 'screen', gloss: false, shapes: [screenShape(ctx.a.band ?? ctx.a.face, 'band')] }
      : { material: 'screen', gloss: false, shapes: [screenShape(ctx.a.face)] }, gloss(ctx.a.face.shape === 'band' ? ctx.a.band ?? ctx.a.face : ctx.a.face)],
  },
  {
    name: 'oval',
    slot: 'face',
    description: 'Oval glass visor (round heads)',
    requires: { head: ROUND_HEADS },
    preview: { head: 'dome' },
    layers: (ctx) => [{ material: 'screen', gloss: false, shapes: [screenShape(ctx.a.face, 'ellipse')] }, gloss(ctx.a.face)],
  },
  {
    name: 'rounded',
    slot: 'face',
    description: 'Soft rounded-rect screen, a little rounder than square',
    requires: { head: [...FLAT_SIDED, 'capsule'] },
    preview: { head: 'tv' },
    layers: (ctx) => {
      const f = ctx.a.face;
      return [{ material: 'screen', gloss: false, shapes: [['roundedRect', f.x, f.y, f.w, f.h, f.h >= 8 ? [3, 1, 1] : [2, 1]]] }, gloss(f)];
    },
  },
  {
    name: 'band',
    slot: 'face',
    description: 'Wrap-around visor band across the whole head',
    requires: { head: ['wide', 'tv', 'mini', 'cat'] },
    preview: { head: 'wide' },
    // the band IS the screen now: hand its box to the eyes (glyph sizes, mouth layout) via a.face
    anchors: (a) => {
      const b = a.band ?? { x: a.face.x - 1, y: a.face.y + 1, w: a.face.w + 2, h: a.face.h - 2 };
      return { face: { x: b.x, y: b.y, w: b.w, h: b.h, shape: 'band', r: [1] } };
    },
    layers: (ctx) => [{ material: 'screen', gloss: false, shapes: [screenShape(ctx.a.face, 'band')] }, gloss(ctx.a.face)],
  },
  {
    name: 'bezel',
    slot: 'face',
    description: 'Native screen framed by a 1-px accent bezel ring (premium trim)',
    requires: { head: ['tv', 'dome', 'capsule', 'cat', 'mini', 'boxy', 'round'] },
    preview: { head: 'tv' },
    layers: (ctx) => {
      const glass = screenShape(ctx.a.face);
      return [
        { name: 'ring', material: 'accent', shade: { hi: 0, lo: 1, loR: 1, deep: 0, spec: false }, shapes: [dilate(glass)] },
        { name: 'glass', material: 'screen', gloss: false, shapes: [glass] },
        gloss(ctx.a.face),
      ];
    },
  },
];

/** shape grown by 1 px (4-neighbour) → bits shape */
function dilate(shape) {
  const m = new Set();
  RASTER[shape[0]]((x, y) => m.add(x + ',' + y), ...shape.slice(1));
  const out = new Set(m);
  for (const k of m) {
    const [x, y] = k.split(',').map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) out.add(x + dx + ',' + (y + dy));
  }
  const pts = [...out].map((k) => k.split(',').map(Number));
  return ['px', pts];
}
