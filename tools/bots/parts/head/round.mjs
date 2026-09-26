// Round head — pearl dome/sphere (the "#Intelligent" card robot).
export default {
  name: 'round',
  slot: 'head',
  tags: ['round'],
  anchors: {
    head: { x: 6, y: 7, w: 20, h: 13 },
    face: { x: 9, y: 10, w: 14, h: 7 },
    eye: { cx: 12, cy: 13.5 },
    top: { y: 7 },
    ear: { x: 8, y: 8 },
  },
  layers: (ctx) => {
    const { x, y, w, h } = ctx.a.head;
    return [{ material: 'body', shapes: [['ellipse', x, y, w, h]] }];
  },
};
