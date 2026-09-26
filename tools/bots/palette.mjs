// palette.mjs — the ONLY source of colour for copyfomo bots.
// Light comes from the top-left. Every ramp: hi (lit) / base / shade|lo (shadow side) / deep (rim).
// Part files never hard-code hex; they use colour refs (see resolveColor) so accents/eyes can be swapped.

export const OUTLINE = '#1b1f2a';     // never pure black
export const LINE_SOFT = '#4a5468';   // optional selout / soft internal line tone

export const PEARL = { hi: '#ffffff', base: '#eef2f7', shade: '#d5dde8', deep: '#aab5c6' };
export const SCREEN = { base: '#0b0f16', gloss: '#26303f' };
/** dark steel for hats (top hat): lighter than the outline so a dark hat never merges with it or with dark UIs */
export const STEEL = { hi: '#7a8597', base: '#4a5468', shade: '#343d4f', deep: '#26303f' };
export const SHADOW = { outer: '#1b1f2a1c', inner: '#1b1f2a33', solid: '#dfe5ee', solidDeep: '#c9d2df' };

// Accent ramps: hi / base / lo are hand hue-shifted (lights lean warm, darks lean cool).
// deep = lo pushed toward the outline.
// glow = the eye halo on the black screen: lo sunk ~35 % into the screen, hand hue-shifted where a plain mix goes muddy
//        (gold turned brown, orange/pink maroon), so every halo stays a saturated, clearly coloured light (polisher).
const RAW_ACCENTS = {
  mint:   { hi: '#b2f5e8', base: '#3ed6c5', lo: '#1f9aa0', glow: '#186e74' },
  blue:   { hi: '#a9d1ff', base: '#4c8dff', lo: '#2e56cf', glow: '#2442a0' },
  violet: { hi: '#d9ccff', base: '#9b7bff', lo: '#6a4bd6', glow: '#4b36a0' },
  gold:   { hi: '#fff1a6', base: '#ffc83a', lo: '#dc8a1c', glow: '#a65a12' },
  pink:   { hi: '#ffc6de', base: '#ff6fb1', lo: '#d6438c', glow: '#a02f78' },
  lime:   { hi: '#ecffab', base: '#b6f03c', lo: '#6fae26', glow: '#4f7d1c' },
  orange: { hi: '#ffc896', base: '#ff8a3d', lo: '#d6552a', glow: '#a8401a' },
  cyan:   { hi: '#dcfdff', base: '#5ff2ff', lo: '#1fb0d4', glow: '#187c96' },   // default eye colour
};
// Eye LEDs: blue and violet read dim on the black screen next to the cyan cast, so their EYE ramp is lifted
// (the accent ramp used on shells, hats and props is unchanged).
const EYE_LIFT = {
  blue:   { hi: '#eef5ff', base: '#9cc4ff', lo: '#4c8dff', glow: '#2a4fb0' },
  violet: { hi: '#f4f0ff', base: '#c9b8ff', lo: '#9b7bff', glow: '#5a41b8' },
};

// ---------------------------------------------------------------- colour math
const cache = new Map();
/** '#rgb' | '#rrggbb' | '#rrggbbaa' → [r,g,b,a] (0-255) */
export function hexToRgba(hex) {
  if (cache.has(hex)) return cache.get(hex);
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 6) h += 'ff';
  if (!/^[0-9a-f]{8}$/i.test(h)) throw new Error(`bad hex colour "${hex}"`);
  const v = [0, 2, 4, 6].map((k) => parseInt(h.slice(k, k + 2), 16));
  cache.set(hex, v);
  return v;
}
export function rgbaToHex([r, g, b, a = 255]) {
  const s = [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return '#' + s + (a === 255 ? '' : a.toString(16).padStart(2, '0'));
}
/** linear mix of two hex colours, t=0 → a, t=1 → b */
export function mix(a, b, t) {
  const A = hexToRgba(a), B = hexToRgba(b);
  return rgbaToHex(A.map((v, i) => Math.round(v + (B[i] - v) * t)));
}

export const ACCENTS = Object.fromEntries(
  Object.entries(RAW_ACCENTS).map(([k, r]) => [k, {
    ...r,
    shade: r.lo,
    deep: mix(r.lo, OUTLINE, 0.28),
    glow: r.glow ?? mix(r.lo, SCREEN.base, 0.35),
  }]),
);
/** ramps used by the 'eye' material and 'eye.*' refs: the accent ramp, lifted for the dim hues (EYE_LIFT) */
export const EYES = Object.fromEntries(Object.entries(ACCENTS).map(([k, r]) => [k, { ...r, ...(EYE_LIFT[k] ?? {}) }]));
export const ACCENT_NAMES = Object.keys(ACCENTS).filter((k) => k !== 'cyan');
export const EYE_COLORS = Object.keys(ACCENTS);

/** Ramp used by a shading material. Always has hi/base/shade/deep (+lo/glow for accents). */
export function rampFor(material, ctx = {}) {
  if (material === 'body') return PEARL;
  if (material === 'accent') return ACCENTS[ctx.accent ?? 'mint'];
  if (material.startsWith('accent:')) {
    const name = material.slice(7);
    if (!ACCENTS[name]) throw new Error(`unknown accent "${name}"`);
    return ACCENTS[name];
  }
  if (material === 'eye') return EYES[ctx.eyeColor ?? 'cyan'];
  throw new Error(`material "${material}" has no ramp`);
}

/**
 * Colour reference → hex (or null for 'clear').
 *   '#rrggbb' | '#rrggbbaa'                    raw (avoid in parts)
 *   'outline' | 'line'  'line.soft'
 *   'body' 'body.hi|base|shade|deep'           pearl ramp
 *   'screen' 'screen.gloss'   'steel.hi|base|shade|deep'
 *   'shadow' 'shadow.outer|inner|solid|solidDeep'
 *   'accent' 'accent.hi|base|lo|shade|deep|glow'           → robot accent
 *   'accent:gold' 'accent:gold.lo' / 'gold.lo'               → named accent
 *   'eye' 'eye.hi|base|lo|glow'                              → robot eye colour
 *   'clear'                                                   → erase pixel (paint layers only)
 */
export function resolveColor(ref, ctx = {}) {
  if (ref == null) throw new Error('colour ref is null');
  if (ref.startsWith('#')) return ref;
  if (ref === 'clear') return null;
  const [head, tone0] = ref.split('.');
  const tone = tone0 ?? 'base';
  switch (head) {
    case 'outline': case 'line': return tone === 'soft' ? LINE_SOFT : OUTLINE;
    case 'body': return pick(PEARL, tone, ref);
    case 'screen': return tone === 'gloss' ? SCREEN.gloss : SCREEN.base;
    case 'steel': return pick(STEEL, tone, ref);
    case 'shadow': return pick(SHADOW, tone === 'base' ? 'outer' : tone, ref);
    case 'accent': return pick(ACCENTS[ctx.accent ?? 'mint'], tone, ref);
    case 'eye': return pick(EYES[ctx.eyeColor ?? 'cyan'], tone, ref);
    default: {
      const name = head.startsWith('accent:') ? head.slice(7) : head;
      if (ACCENTS[name]) return pick(ACCENTS[name], tone, ref);
      throw new Error(`unknown colour ref "${ref}"`);
    }
  }
}
function pick(ramp, tone, ref) {
  const v = ramp?.[tone];
  if (!v) throw new Error(`unknown tone in colour ref "${ref}"`);
  return v;
}
