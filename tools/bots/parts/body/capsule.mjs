// Capsule body — rounder pearl belly with an accent belt, no separate feet.
// Polisher: the belt is lit on its left end and shaded on its right end (a flat 1-tone band flattened the body).
export default {
  name: 'capsule',
  slot: 'body',
  layers: (ctx) => {
    const b = ctx.a.body;
    const w = b.w + 2;
    return [
      { material: 'body', shapes: [['ellipse', b.x - 1, b.y, w, 11]] },
      { clip: 'body', paint: { x: b.x - 1, y: b.y + 6, rows: ['AAA' + 'a'.repeat(w - 6) + 'qqq'] } },
    ];
  },
};
