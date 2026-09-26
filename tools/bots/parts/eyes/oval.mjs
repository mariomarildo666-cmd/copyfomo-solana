// Oval eyes — 3×4 rounded LEDs; blink squashes them to a 3×1 dash.
export default {
  name: 'oval',
  slot: 'eyes',
  moods: {
    idle: (ctx) => {
      const { x, y } = ctx.eyeBox(3, 4);
      return [{ material: 'eye', mirror: true, shapes: [['ellipse', x, y, 3, 4]] }];
    },
    blink: (ctx) => {
      const { x, y } = ctx.eyeBox(3, 4);
      return [{ material: 'eye', mirror: true, shapes: [['rect', x, y + 2, 3, 1]] }];
    },
  },
};
