// Arm poses by the body/arms/props designer (polished by the polisher). All poses read ctx.a.hand (LEFT hand centre,
// owned by the body) and ctx.a.body / ctx.a.head / ctx.a.top, so they follow slim / round / mech bodies and every head.
// The prop hand is drawn on the image RIGHT at grip = (31 - hand.x, hand.y); props (front slot) sit over it and cover
// the whole hand but its fingers (see parts/front/props.mjs), so no 1-px hand sliver doubles the outline.
//
// Polisher rules:
//   · light from the top-left on BOTH sides: right-side arms are painted, not mirrored (a mirror lights them from the right)
//   · raised hands (wave, cheer) are 3×3 mitts lifted ABOVE the head top, on a 2-px forearm that runs down the head side
//     one outline away from it (head and arm share a single outline column), then tucks under the head corner.
//   · every hand is closed by the main outline (no soft-line edges on the silhouette).

const PROPS = ['coin', 'phone', 'solCoin', 'chartCard', 'rocket', 'magnifier', 'copyCard', 'trophy'];

// relaxed arm hanging slightly out from the torso, lit on its left side. The two top rows go up BEHIND the head, so
// the head's own line always lands on the arm (one shared outline) — on narrow-bottomed heads (round, dome) the arm
// used to start two rows below the head's outline and the two outlines stacked into a 2×2 block at the shoulder.
const HANG_L = ['..ww', '..ww', '..Ww', '.Wws', '.Wws', 'Wws.', 'Wwd.', '.d..'];
const HANG_R = ['ww..', 'ww..', 'wW..', 'Wws.', 'Wws.', '.Wws', '.Wwd', '..d.'];
const hangL = (h) => ({ paint: { x: h.x - 2, y: h.y - 5, rows: HANG_L } });
const hangR = (h) => ({ paint: { x: 31 - h.x - 2, y: h.y - 5, rows: HANG_R } });

// 3×3 mitt, lit from the top-left. (Paint keys: W/w/s/d = pearl hi/base/shade/deep; 'o' would be the OUTLINE.)
const MITT = ['WWw', 'Wws', 'wsd'];
// open hand for the wave frame: two fingers spread (the notch fills with outline)
const MITT_OPEN = ['W.w', 'Wws', 'wsd'];

/**
 * Raised arm (image-left; `right` = the mirrored placement, painted with its own top-left lighting).
 *   forearm: 3 px wide (x = head.x - 3 .. head.x - 1), drawn BEHIND the head: wherever the head's side is, the head's
 *            line turns the column next to it into the one shared outline — also where the head's corners step in
 *            (a 2-px arm left a transparent gap there that filled with a second outline).
 *   hand:    3×3 mitt whose bottom row is 2 rows above the head top (lift = extra rows up, for the wave frame)
 *   elbow:   the forearm runs down to the head's lower corner, then the upper arm tucks in to the shoulder.
 */
function raised(ctx, { right = false, lift = 0, out = 0, open = false } = {}) {
  const a = ctx.a;
  const fx = Math.max(2, a.head.x - 3);               // forearm outer column (image-left side)
  const hx = Math.max(2, fx - out);                   // mitt left column (out < 0 = flicked in toward the head)
  const hy = Math.max(2, a.top.y - 4 - lift);         // mitt top row: bottom row = top.y - 2
  const ey = a.head.y + a.head.h - 3;                 // elbow row (head's lower corner)
  const my = a.head.y + Math.floor(a.head.h / 2);     // head middle row: every head is at full width there
  const hb = a.head.y + a.head.h;                     // first row under the head
  const sx = a.body.x - 1, sy = a.body.y + 3;         // shoulder px (touches the torso side)
  // One polygon (pixel-edge coords): a 3-px forearm down to the head's middle row, then the arm reaches in BEHIND the
  // head (hidden) and its outer edge runs diagonally from the elbow to the shoulder. Arms sit under the head, so the
  // head's line lands on the arm wherever they touch: one shared outline, whatever the head's corner profile.
  const X = (x) => (right ? 32 - x : x);
  const poly = [[fx, hy + 2], [fx + 3, hy + 2], [fx + 3, my], [a.head.x + 4, my], [a.head.x + 4, hb - 1], [sx + 1, hb - 1], [sx + 1, sy + 1], [fx, ey + 1]];
  return [
    { name: 'arm', material: 'body', shade: { hi: 1, lo: 0, loR: 1, deep: 0, spec: false }, shapes: [['poly', poly.map(([x, y]) => [X(x), y])]] },
    { name: 'mitt', paint: { x: right ? 31 - hx - 2 : hx, y: hy, rows: open ? MITT_OPEN : MITT } },
  ];
}

export default [
  {
    name: 'down',
    slot: 'arms',
    description: 'relaxed arms hanging slightly away from the torso',
    tags: ['idle'],
    layers: (ctx) => [hangL(ctx.a.hand), hangR(ctx.a.hand)],
  },
  {
    name: 'wave',
    slot: 'arms',
    description: 'image-left arm raised above the head in a wave, the other arm relaxed; mood "wave" = 2nd frame',
    tags: ['wave', 'raised'],
    weight: 0.75,
    // idle = hand up (mitt); wave = the same hand opened, fingers spread (alternate idle/wave for a hello loop). It stays
    // in place: any lift or swing met ears, antenna balls or hat brims on some head.
    moods: {
      idle: (ctx) => [...raised(ctx), hangR(ctx.a.hand)],
      wave: (ctx) => [...raised(ctx, { lift: 1, open: true }), hangR(ctx.a.hand)],
    },
  },
  {
    name: 'hold',
    slot: 'arms',
    description: 'image-right hand forward at the prop grip, image-left arm relaxed (pair with a front prop)',
    tags: ['hold'],
    requires: { front: PROPS }, // seeds always give the hold pose something to hold
    layers: (ctx) => {
      const h = ctx.a.hand, gx = 31 - h.x, gy = h.y;
      const m = ctx.a.mitt ?? { x: gx - 1, y: gy }; // a prop may move the hand (anchor 'mitt'), or hide it (mitt: false)
      return [
        hangL(h),
        // the hand grips the prop's lower-left corner IN FRONT of it (slot fx = drawn after the prop, with its own
        // line), touching the torso side: torso · one shared outline · hand. The arm itself hides behind the prop.
        m && { name: 'grip', slot: 'fx', line: true, paint: { x: m.x, y: m.y, rows: MITT } },
      ];
    },
  },
  {
    name: 'thumbsUp',
    slot: 'arms',
    description: 'image-right thumbs up at chest height beside the head corner (finger creases in soft line)',
    tags: ['happy'],
    weight: 0.5,
    excludes: { front: PROPS },
    layers: (ctx) => {
      const h = ctx.a.hand, hd = ctx.a.head, gx = 31 - h.x;
      // Polisher: fist box x 25..29 from the head's lower corner row down (was raised beside the face: its left edge ran
      // along the head's stepped-in bottom corner and doubled the outline on every head). The thumb now stands next to
      // the head corner with one shared outline column; the forearm joins the torso side (gx - 1) and the fist.
      const fx = 25, fy = hd.y + hd.h - 2;
      return [
        hangL(h),
        { name: 'arm', paint: { x: gx - 1, y: fy + 5, rows: ['W' + 'w'.repeat(Math.max(0, fx - gx)), 's'.repeat(fx - gx + 1)] } },
        // fist in the front slot, thumb 3 rows tall and set off from the knuckles by its shade; closed by the main outline
        { name: 'fist', slot: 'front', line: true, paint: { x: fx, y: fy, rows: [
          '.Ww..',
          '.Ww..',
          '.ws..',
          'WWWw.',
          'WOOws',
          'Wwwws',
          'WOOsd',
          '.sdd.',
        ] } },
      ];
    },
  },
  {
    name: 'cheer',
    slot: 'arms',
    description: 'both arms raised, hands up above the head',
    tags: ['happy', 'raised'],
    weight: 0.5,
    excludes: { front: PROPS },
    layers: (ctx) => [...raised(ctx), ...raised(ctx, { right: true })],
  },
];
