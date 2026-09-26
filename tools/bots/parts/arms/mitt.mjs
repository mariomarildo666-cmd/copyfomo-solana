// Mitt arms — thin pearl arm with a round accent hand.
// Polisher: tucked under the head (top row = head bottom + 1) so arm and head share one outline row at the shoulder.
export default {
  name: 'mitt',
  slot: 'arms',
  layers: (ctx) => {
    const b = ctx.a.body, y = ctx.a.head.y + ctx.a.head.h;
    return [
      { material: 'body', mirror: true, shade: { hi: 1, lo: 0, loR: 1, deep: 0, spec: false }, shapes: [['rect', b.x - 2, y - 2, 2, 4]] }, // root hidden behind the head
      { material: 'accent', mirror: true, shade: { hi: 1, lo: 1, loR: 1, deep: 1, spec: false }, shapes: [['rect', b.x - 3, y + 2, 3, 3]] },
    ];
  },
};
