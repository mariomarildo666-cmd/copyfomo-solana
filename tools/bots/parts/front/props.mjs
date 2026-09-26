// Props by the body/arms/props designer. Every prop is held in the robot's LEFT hand, drawn on the image
// RIGHT around grip G = (31 - hand.x, hand.y) — (23, 23) on the default frame — and kept below the face
// screen (rows >= 16, x >= 22) so it never covers the eyes. Icons are hand-painted (`paint` = exact pixels,
// light from the top-left); the engine still adds the 1-px outline and draws the prop edge as a line over the
// hand / torso below. Pairs best with arms:'hold' (hand under the prop); also fine with nub / mitt / down / wave.
// Paint keys used: W/w/s/d pearl hi/base/shade/deep · k/g screen/gloss · A/a/q/Q robot accent hi/base/lo/deep
// plus per-prop named-accent keys (lime/pink candles, gold trophy, mint→violet SOL gradient).

const grip = (ctx) => ({ x: 31 - ctx.a.hand.x, y: ctx.a.hand.y });
// Polisher: fills stay inside x <= 29 (1-px canvas margin for the outline), and every prop starts on the grip hand's
// first column (grip.x - 1) so it covers the hand — a 1-px hand sliver between torso and prop doubled the outline.
const clampX = (x, w) => Math.min(x, 30 - w);
const px0 = (ctx, w) => clampX(grip(ctx).x - 1, w);
/** anchor 'mitt' for arms:hold — the hand grips the prop's lower-left corner, on the prop's (clamped) left column */
const held = (w) => (a) => ({ mitt: { x: clampX(31 - a.hand.x - 1, w), y: a.hand.y } });

export default [
  // ------------------------------------------------------------------ phone
  {
    name: 'phone',
    slot: 'front',
    anchors: held(6),
    description: 'pearl smartphone, dark screen with a lime area chart going up + accent BUY bar (trading on FOMO)',
    tags: ['trade'],
    preview: { arms: 'hold' },
    layers: (ctx) => {
      const g = grip(ctx);
      return [{ paint: { x: px0(ctx, 6), y: g.y - 6, key: { L: 'lime.hi', l: 'lime.lo' }, rows: [
        '.WWWW.',
        'Wkkkks',
        'WkkkLs',
        'WkLkls',
        'WLlLls',
        'Wlllls',
        'Wwaaws',
        '.ssss.',
      ] } }];
    },
  },

  // ------------------------------------------------------------------ solCoin
  {
    name: 'solCoin',
    slot: 'front',
    anchors: held(8),
    description: 'SOL coin: teal → purple diagonal gradient face with the three-bar zigzag mark',
    tags: ['coin', 'sol'],
    preview: { arms: 'hold' },
    layers: (ctx) => {
      const g = grip(ctx);
      return [{ paint: { x: px0(ctx, 8), y: g.y - 4, key: {
        T: 'mint.hi', t: 'mint.base', m: 'blue.base', v: 'violet.base', V: 'violet.lo', X: 'body.hi',
      }, rows: [
        '..TTtt..',
        '.Tttttm.',
        'TttXXXmv',
        'tttmmmvV',
        'ttXXXvvV',
        'tmmvvvVV',
        '.mvXXXV.',
        '..vVVV..',
      ] } }];
    },
  },

  // ------------------------------------------------------------------ chartCard
  {
    name: 'chartCard',
    slot: 'front',
    anchors: held(8),
    description: 'mini white chart card: accent header, one red and two green candlesticks with wicks',
    tags: ['trade', 'chart'],
    preview: { arms: 'hold' },
    layers: (ctx) => {
      const g = grip(ctx);
      return [{ paint: { x: px0(ctx, 8), y: g.y - 5, key: { R: 'pink.base', r: 'pink.lo', G: 'lime.base', g: 'lime.lo' }, rows: [
        '.AAAAaa.',
        'WwwwwwGs',
        'WwwwgwGs',
        'WwRwGwGs',
        'WwRwGwgs',
        'Wwrwwwws',
        '.ssssss.',
      ] } }];
    },
  },

  // ------------------------------------------------------------------ rocket
  {
    name: 'rocket',
    slot: 'front',
    // no front grip mitt: a 3×3 hand over a 5-px rocket hid half of it. The rocket rests against the torso side
    // (one shared outline) with the arm implied behind it.
    anchors: { mitt: false },
    description: 'little pearl rocket with accent nose + fins, cyan porthole and a gold flame ("to the moon")',
    tags: ['moon'],
    preview: { arms: 'hold' },
    layers: (ctx) => {
      const g = grip(ctx);
      return [{ paint: { x: px0(ctx, 5), y: g.y - 6, key: { C: 'cyan.base', c: 'cyan.hi', Y: 'gold.hi', y: 'gold.base', F: 'orange.base' }, rows: [
        '..A..',
        '.Aaq.',
        '.WWs.',
        '.WCs.',
        '.Wws.',
        'aWwsq',
        'qWwsQ',
        '.FYF.',
        '..F..',
      ] } }];
    },
  },

  // ------------------------------------------------------------------ magnifier
  {
    name: 'magnifier',
    slot: 'front',
    anchors: held(8),
    description: 'magnifying glass (scan top traders): steel-pearl ring, pale glass with a glint, accent handle',
    tags: ['search'],
    preview: { arms: 'hold' },
    layers: (ctx) => {
      const g = grip(ctx);
      return [{ paint: { x: px0(ctx, 8), y: g.y - 7, key: { L: 'cyan.hi', l: 'blue.hi', X: 'body.hi' }, rows: [
        '...WWWs.',
        '..WXLLld',
        '..WLLlld',
        '..sLllld',
        '..sllldd',
        '...dddd.',
        '..Aq....',
        '.aq.....',
        'aq......',
      ] } }];
    },
  },

  // ------------------------------------------------------------------ copyCard
  {
    name: 'copyCard',
    slot: 'front',
    anchors: held(9),
    description: 'copy / duplicate icon: accent card behind a pearl card with two text lines',
    tags: ['copy'],
    preview: { arms: 'hold' },
    layers: (ctx) => {
      const g = grip(ctx), x = px0(ctx, 9), y = g.y - 6;
      return [
        { name: 'back', material: 'accent', shade: { hi: 1, lo: 1, loR: 1, deep: 0, spec: false }, shapes: [['roundedRect', x + 3, y, 6, 7, 1]] },
        { name: 'front', material: 'body', line: true, shade: { spec: false, deep: 0 }, shapes: [['roundedRect', x, y + 2, 6, 7, 1]] },
        { name: 'text', material: 'flat', color: 'body.deep', shapes: [['hline', x + 1, x + 4, y + 4], ['hline', x + 1, x + 3, y + 6]] },
      ];
    },
  },

  // ------------------------------------------------------------------ trophy
  {
    name: 'trophy',
    slot: 'front',
    anchors: held(8),
    description: 'gold trophy cup (top trader / leaderboard) with ring handles',
    tags: ['win', 'leaderboard'],
    preview: { arms: 'hold' },
    layers: (ctx) => {
      const g = grip(ctx);
      return [{ paint: { x: px0(ctx, 8), y: g.y - 6, key: { Y: 'gold.hi', y: 'gold.base', q: 'gold.lo', Q: 'gold.deep' }, rows: [
        '.YYYYyy.',
        'YYYyyyqq',
        'Y.Yyyq.q',
        '.YYyyqq.',
        '..Yyyq..',
        '...yq...',
        '..Yyyq..',
        '.YyyyqQ.',
      ] } }];
    },
  },
];
