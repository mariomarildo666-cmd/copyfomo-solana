// Nub arms — short rounded pearl stubs at the torso sides.
// Polisher: the stub hangs from the row right under the head (head bottom + 1) and its root goes up behind the head,
// so its top outline IS the head's bottom outline; one row lower, the two outlines stacked into a 2×2 dark block.
export default {
  name: 'nub',
  slot: 'arms',
  layers: (ctx) => {
    const b = ctx.a.body, y = ctx.a.head.y + ctx.a.head.h;
    // a 2-px root goes up behind the head so the head's line always lands on the stub (shared outline on every head)
    return [{ material: 'body', mirror: true, shade: { hi: 1, lo: 1, loR: 1, deep: 0, spec: false }, shapes: [['rect', b.x - 2, y - 2, 2, 2], ['roundedRect', b.x - 3, y, 3, 4, 1]] }];
  },
};
