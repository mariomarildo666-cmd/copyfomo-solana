// Soft shadow — translucent (works on light and dark UIs).
// Polisher: a rounded 3-row ellipse (12 / 18 / 12 px) with a darker core only under the feet, instead of a flat
// 20×2 bar that read as a plinth. Floating bodies (tag 'float') get a smaller, lighter 10-px shadow on the last
// row, leaving 2 clear rows under the thruster flame so they read as hovering.
export default {
  name: 'soft',
  slot: 'shadow',
  layers: (ctx) => ctx.hasTag('float')
    ? [{ material: 'flat', color: 'shadow.outer', shapes: [['hline', 11, 20, 30]] }]
    : [
      { material: 'flat', color: 'shadow.outer', shapes: [['bits', 7, 28, ['...############...', '##################', '...############...']]] },
      { material: 'flat', color: 'shadow.outer', shapes: [['bits', 10, 29, ['############', '..########..']]] },
    ],
};
