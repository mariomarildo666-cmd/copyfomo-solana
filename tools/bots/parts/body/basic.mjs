// Basic body — small pearl torso, stubby feet, accent chest light.
// Polisher: feet end on x 13 / start on x 18 (open gap between the legs) and are painted lit from the top-left.
export default {
  name: 'basic',
  slot: 'body',
  layers: (ctx) => {
    const b = ctx.a.body, f = ctx.a.feet;
    const foot = ['.Ww.', 'Wwws', '.sd.'];
    return [
      { name: 'footL', paint: { x: b.x, y: f.y, rows: foot } },
      { name: 'footR', paint: { x: 31 - b.x - 3, y: f.y, rows: foot } },
      { material: 'body', line: true, shapes: [['roundedRect', b.x, b.y, b.w, b.h, 2]] },
      { material: 'accent', shade: { hi: 0, lo: 0, loR: 0, deep: 0, spec: [[0, 0]] }, shapes: [['rect', 14, b.y + 4, 4, 2]] },
    ];
  },
};
