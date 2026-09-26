// Boxy head — rounded-square pearl head (the "#Future" card robot). Owns the head/face/eye/top/ear anchors.
export default {
  name: 'boxy',
  slot: 'head',
  tags: ['boxy'],
  anchors: {
    head: { x: 6, y: 7, w: 20, h: 13 },
    face: { x: 8, y: 9, w: 16, h: 9 },
    eye: { cx: 12, cy: 13.5 },
    top: { y: 7 },
    ear: { x: 7, y: 7 },
  },
  layers: (ctx) => {
    const { x, y, w, h } = ctx.a.head;
    return [{ material: 'body', shapes: [['roundedRect', x, y, w, h, 4]] }];
  },
};
