// Pixel shadow — opaque two-tone grey ellipse (for light UIs only). Same footprint as 'soft' (polisher).
export default {
  name: 'pixel',
  slot: 'shadow',
  layers: (ctx) => ctx.hasTag('float')
    ? [{ material: 'flat', color: 'shadow.solid', shapes: [['hline', 11, 20, 30]] }]
    : [
      { material: 'flat', color: 'shadow.solid', shapes: [['bits', 7, 28, ['...############...', '##################', '...############...']]] },
      { material: 'flat', color: 'shadow.solidDeep', shapes: [['bits', 10, 29, ['############', '..########..']]] },
    ],
};
