// Antenna — metal stem behind the head (back slot) + accent ball on top.
// Polisher: the ball starts at row 2 (1-px canvas margin for its outline); it is 4 rows when a 1-px stem still fits
// under it, else a 3-row bulb (dome heads).
export default {
  name: 'antenna',
  slot: 'top',
  layers: (ctx) => {
    const y = ctx.a.top.y;
    const by = Math.max(2, y - 6);
    const bh = Math.min(4, y - 1 - by);
    return [
      { slot: 'back', material: 'flat', color: 'body.deep', takesLine: false, shapes: [['rect', 15, by + bh - 1, 2, y - by - bh + 2]] },
      { material: 'accent', shapes: [['ellipse', 14, by, 4, bh]] },
    ];
  },
};
