// Visor — wide pill-shaped band that nearly wraps the head.
export default {
  name: 'visor',
  slot: 'face',
  layers: (ctx) => {
    const f = ctx.a.face;
    return [{ material: 'screen', shapes: [['roundedRect', f.x - 1, f.y + 1, f.w + 2, f.h - 2, 2]] }];
  },
};
