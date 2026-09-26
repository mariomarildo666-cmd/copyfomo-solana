// Pill eyes — 2×3 LED bars ("| |"); blink squashes them to a 2×1 dash.
export default {
  name: 'pill',
  slot: 'eyes',
  moods: {
    idle: (ctx) => {
      const { x, y } = ctx.eyeBox(2, 3);
      return [{ material: 'eye', mirror: true, shapes: [['rect', x, y, 2, 3]] }];
    },
    blink: (ctx) => {
      const { x, y } = ctx.eyeBox(2, 3);
      return [{ material: 'eye', mirror: true, shapes: [['rect', x, y + 1, 2, 1]] }];
    },
  },
};
