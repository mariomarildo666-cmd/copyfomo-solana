// Coin prop — a gold coin held at the right hand (asymmetric on purpose).
export default {
  name: 'coin',
  slot: 'front',
  layers: (ctx) => {
    const b = ctx.a.body;
    const x = b.x + b.w - 2, y = b.y + 3;
    return [
      { material: 'accent:gold', shapes: [['ellipse', x, y, 6, 6]] },
      { material: 'flat', color: 'gold.lo', shapes: [['rect', x + 2, y + 2, 2, 2]] },
    ];
  },
};
