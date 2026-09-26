// fx.mjs — floating accessories for copyfomo bots (TOPS + FX designer; polished by the polisher).
// FX float in two zones beside the head so they never cover a top or the face:
//   TR (top-right) glyph right edge on x 29      TL (top-left) glyph left edge on x 2      from row fy = max(1, top.y - 6)
// Every fx has a 'blink' mood that nudges it, so the standard blink loop (idle ×6, blink, idle) doubles as a tiny idle
// animation (twinkle, bob, coin flip, flicker). In mood 'sleep' they drop their top-right element, where the eyes draw
// their zZ (tag 'sleepCorner' tells the eyes the corner is free; an fx without that tag keeps it and the eyes skip zZ).
//
// Polisher rules:
//   · fx are light particles: NO outline (hearts/coins used to share an outline with ears and read as stuck to them),
//     readable on white through their own darker rim (lo / deep tones at the bottom-right, never a pale edge pixel);
//   · every element is placed with layer.place: the big glyph at the zone corner or a nudge of it, else the small glyph,
//     else nothing — always 1 clear px from ears, hats, hands and the other fx, and inside the 1-px canvas margin.
import { FX_TRY, Z_BIG, Z_SMALL } from '../eyes/eyes.mjs';

const fyOf = (ctx) => Math.max(1, ctx.a.top.y - 6);
const TR_TRY = FX_TRY;
const TL_TRY = FX_TRY.map(([dx, dy]) => [-dx, dy]);
/**
 * one floating element: `side` 'R' (right edge on x 29) | 'L' (left edge on x 2), first row y; big glyph first, then
 * the small one (placed at the same zone corner), each tried at the zone's nudges.
 */
function el(side, y, big, small, key, dy2 = 0) {
  const at = side === 'R' ? TR_TRY : TL_TRY;
  const x = (rows) => (side === 'R' ? 30 - rows[0].length : 2);
  const L = (rows, yy) => ({ paint: { x: x(rows), y: yy, rows, key } });
  return { ...L(big, y), place: { at, alt: small ? [L(small, y + dy2)] : [] } };
}
/** mood 'sleep': the eyes draw their own zZ top-right, so keep only the top-left element (layer 1) */
const tlOnly = (idle) => (ctx) => idle(ctx).slice(1);

// ---------------------------------------------------------------- twinkle
// Accent four-point sparkles. Base-colour body with darker tips (polisher: the pale hi centre vanished on white).
// Blink swaps the big and small star. Light accents (gold / lime / mint) shift one tone darker so they read on white.
const STAR_BIG = ['..q..', '..a..', '.aaa.', 'qaAaq', '.aaa.', '..a..', '..Q..'];
const STAR_SMALL = ['.q.', 'qaq', '.Q.'];
const LIGHT = ['gold', 'lime', 'mint'];
const starKey = (ctx) => (LIGHT.includes(ctx.accent)
  ? { A: 'accent.base', a: 'accent.lo', q: 'accent.deep', Q: 'accent.deep' }
  : { A: 'accent.hi', a: 'accent.base', q: 'accent.lo', Q: 'accent.deep' });
const twinkleLayers = (swap) => (ctx) => {
  const fy = fyOf(ctx), k = starKey(ctx);
  return swap
    ? [el('R', fy + 1, STAR_SMALL, null, k), el('L', fy + 1, STAR_BIG, STAR_SMALL, k, 2)]
    : [el('R', fy, STAR_BIG, STAR_SMALL, k, 2), el('L', fy + 2, STAR_SMALL, null, k)];
};
const twinkle = {
  name: 'twinkle',
  slot: 'fx',
  description: 'accent four-point sparkles that swap size on blink',
  tags: ['sparkle', 'sleepCorner'],
  outline: false,
  excludes: { top: ['cap'] },
  moods: { idle: twinkleLayers(false), blink: twinkleLayers(true), sleep: tlOnly(twinkleLayers(false)) },
};

// ---------------------------------------------------------------- zzz
// Sleepy "Z z" at the top-right in the eye glow tone (same glyphs as the eyes' own sleep zZ). Tagged zz/sleep so the
// eyes' zZ stands down.
const zzLayers = (dy) => (ctx) => {
  const fy = fyOf(ctx);
  const key = { '#': 'eye.glow' };
  return [el('R', fy, Z_BIG, null, key), el('R', fy + 5 + dy, Z_SMALL, null, key)];
};
const zzz = {
  name: 'zzz',
  slot: 'fx',
  description: 'sleepy z Z floating up-right (pair with the sleep mood)',
  tags: ['zz', 'sleep'],
  weight: 0, // hand-picked only (open eyes + zZ reads wrong); pair with mood 'sleep'
  outline: false,
  excludes: { top: ['boltEars', 'headphones', 'cap'] },
  moods: { idle: zzLayers(0), blink: zzLayers(-1), sleep: zzLayers(0) },
};

// ---------------------------------------------------------------- coins
// Floating gold coins with a stamped groove (light column) and a dark rim; blink turns them edge-on (spin).
const GOLD = { Y: 'gold.hi', y: 'gold.base', u: 'gold.lo', U: 'gold.deep' };
const COIN = ['.uu.', 'uYyU', 'uYyU', 'uyyU', '.UU.'];
const COIN_EDGE = ['uU', 'yU', 'yU', 'yU', 'uU'];
const COIN_SMALL = ['.u.', 'uYU', 'uyU', '.U.'];
const COIN_SMALL_EDGE = ['u', 'y', 'y', 'U'];
const coinLayers = (edge) => (ctx) => {
  const fy = fyOf(ctx);
  return edge
    ? [el('R', fy, COIN_EDGE, null, GOLD), el('L', fy + 2, COIN_SMALL_EDGE, null, GOLD)]
    : [el('R', fy, COIN, COIN_SMALL, GOLD), el('L', fy + 2, COIN_SMALL, null, GOLD)];
};
const coins = {
  name: 'coins',
  slot: 'fx',
  description: 'floating gold coins that spin on blink',
  tags: ['money', 'gold', 'sleepCorner'],
  outline: false,
  excludes: { top: ['cap'] },
  moods: { idle: coinLayers(false), blink: coinLayers(true), sleep: tlOnly(coinLayers(false)) },
};

// ---------------------------------------------------------------- pump
// Green ↗ chart arrow (the PnL is pumping) + a small green plus; the arrow bobs up on blink.
// Lime is very light, so the arrow body is lime.lo with a lime.base highlight and deep tips (lime.base alone ~1.3:1 on white).
const LIME = { A: 'lime.base', a: 'lime.lo', q: 'lime.deep' };
const ARROW = ['.aaaa', '..Aaq', '.Aaaq', 'Aaq.q', 'aq...'];
const ARROW_SMALL = ['.aaa', '..Aq', '.Aaq', 'aq..'];
const PLUS = ['.a.', 'aAq', '.q.'];
const pumpLayers = (dy) => (ctx) => {
  const fy = fyOf(ctx);
  return [el('R', fy + 1 + dy, ARROW, ARROW_SMALL, LIME), el('L', fy + 3, PLUS, null, LIME)];
};
const pump = {
  name: 'pump',
  slot: 'fx',
  description: 'green up-right chart arrow and plus — PnL pumping; the arrow bobs on blink',
  tags: ['chart', 'up', 'green', 'sleepCorner'],
  outline: false,
  excludes: { top: ['cap'] },
  moods: { idle: pumpLayers(0), blink: pumpLayers(-1), sleep: tlOnly(pumpLayers(0)) },
};

// ---------------------------------------------------------------- hearts
// Pink hearts (a copier's love for its trader) with a darker bottom-right rim; they float up a pixel on blink.
const PINK = { A: 'pink.hi', a: 'pink.base', q: 'pink.lo', Q: 'pink.deep' };
const HEART = ['aa.aq', 'aAaaq', '.aaq.', '..Q..'];
const HEART_SMALL = ['a.q', 'aaq', '.Q.'];
const heartLayers = (dy) => (ctx) => {
  const fy = fyOf(ctx);
  return [el('R', fy + 1 + dy, HEART, HEART_SMALL, PINK), el('L', fy + 3 + dy, HEART_SMALL, null, PINK)];
};
const hearts = {
  name: 'hearts',
  slot: 'fx',
  description: 'floating pink hearts that drift up on blink',
  tags: ['love', 'sleepCorner'],
  outline: false,
  excludes: { top: ['cap'] },
  moods: { idle: heartLayers(0), blink: heartLayers(-1), sleep: tlOnly(heartLayers(0)) },
};

// ---------------------------------------------------------------- fire
// A little FOMO flame (hot trader / streak) with an ember; the flame tip flickers on blink.
const FIRE = { R: 'orange.lo', r: 'orange.base', Y: 'gold.hi', y: 'gold.base' };
const FLAME = ['...r.', '..rr.', '.rrr.', 'rrYrR', 'ryYyR', 'ryYyR', '.RRR.'];
const FLAME_FLICK = ['.r...', '.rr..', '.rrr.', 'rrYrR', 'ryYyR', 'ryYyR', '.RRR.'];
const FLAME_SMALL = ['.r.', 'rr.', 'rYR', 'ryR', '.R.'];
const EMBER = ['.r', 'rR'];
const fireLayers = (flick) => (ctx) => {
  const fy = fyOf(ctx);
  return [el('R', fy, flick ? FLAME_FLICK : FLAME, FLAME_SMALL, FIRE, 2), el('L', fy + (flick ? 3 : 4), EMBER, null, FIRE)];
};
const fire = {
  name: 'fire',
  slot: 'fx',
  description: 'FOMO flame beside the head (hot streak); flickers on blink',
  tags: ['hot', 'fomo', 'sleepCorner'],
  outline: false,
  excludes: { top: ['cap'] },
  moods: { idle: fireLayers(false), blink: fireLayers(true), sleep: tlOnly(fireLayers(false)) },
};

export default [twinkle, zzz, coins, pump, hearts, fire];
