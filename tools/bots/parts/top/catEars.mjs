// Cat ears — pearl ears tucked behind the head (back slot) with accent inners (the "#Vitality" cat bot).
export default {
  name: 'catEars',
  slot: 'top',
  layers: (ctx) => {
    const { x, y } = ctx.a.ear;
    return [
      { slot: 'back', material: 'body', mirror: true, shapes: [['bits', x, y - 5, [
        '##....',
        '###...',
        '####..',
        '#####.',
        '######',
        '######',
      ]]] },
      { slot: 'back', material: 'accent', mirror: true, shade: { hi: 0, lo: 0, loR: 0, deep: 0 }, shapes: [['bits', x + 1, y - 3, [
        '#..',
        '##.',
      ]]] },
    ];
  },
};
