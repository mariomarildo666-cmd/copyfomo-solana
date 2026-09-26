// Square screen — big glossy black rounded-rect screen filling the head's face box.
export default {
  name: 'square',
  slot: 'face',
  layers: (ctx) => {
    const f = ctx.a.face;
    return [{ material: 'screen', shapes: [['roundedRect', f.x, f.y, f.w, f.h, 2]] }];
  },
};
