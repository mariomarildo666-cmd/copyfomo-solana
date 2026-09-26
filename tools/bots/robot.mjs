// robot.mjs — part registry (auto-loads parts/<slot>/*.mjs), compose(), fromSeed().
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { W, H, SLOTS, Canvas, drawLayer, finalize, asymmetry, mirrorX, defects } from './sprite.mjs';
import { ACCENTS, resolveColor } from './palette.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PARTS_DIR = join(HERE, 'parts');

/**
 * Canonical 32×32 skeleton. Heads/bodies override the anchors they own; every other part reads ctx.a.
 * All boxes are FILL boxes (the auto outline lands 1 px outside). Symmetry axis: x = 15.5 (x ↔ 31 - x).
 */
export const FRAME = {
  ground: 29,                              // outline row under the feet; shadow lives on rows 28–30
  head: { x: 6, y: 7, w: 20, h: 13 },      // head fill bbox                    (owner: head)
  face: { x: 8, y: 9, w: 16, h: 9 },       // screen fill bbox, x + w/2 === 16  (owner: head)
  eye:  { cx: 12, cy: 13.5 },              // centre of the LEFT eye            (owner: head; derived from face if unset)
  top:  { y: 7 },                          // first head row on the axis        (owner: head)
  ear:  { x: 8, y: 7 },                    // left ear base: left x on head top row (owner: head)
  body: { x: 10, y: 18, w: 12, h: 8 },     // torso fill bbox (top rows hide under the head) (owner: body)
  hand: { x: 8, y: 23 },                   // left hand centre px               (owner: body)
  feet: { y: 26, h: 3 },                   // feet rows; top row receives the torso line (owner: body)
};

/** compose() option keys → slot. `prop` is an alias of `front`. */
export const SPEC_KEYS = { shadow: 'shadow', back: 'back', body: 'body', arms: 'arms', head: 'head', face: 'face', eyes: 'eyes', top: 'top', prop: 'front', front: 'front', fx: 'fx' };
export const DEFAULT_SPEC = { shadow: 'soft', head: 'tv', face: 'fit', eyes: 'led', top: 'antenna', body: 'basic', arms: 'nub', accent: 'mint', eyeColor: 'cyan', mood: 'idle' };

/** Named animations: sequences of moods, played with CSS steps(). */
export const ANIMS = {
  blink: { frames: ['idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'blink', 'idle'], ms: 1600 },
  // the copy-trading loop an agent card can play: wait → copy a BUY → happy → copy a SELL → nap (curator)
  react: {
    frames: ['idle', 'idle', 'blink', 'idle', 'buy', 'buy', 'buy', 'happy', 'happy', 'happy', 'idle', 'blink',
      'idle', 'sell', 'sell', 'sell', 'idle', 'idle', 'sleep', 'sleep', 'sleep', 'sleep', 'blink', 'idle'],
    ms: 4800,
  },
};
/** The six app moods every seeded / curated agent supports (out/moodset.png columns, in this order). */
export const APP_MOODS = ['idle', 'blink', 'happy', 'buy', 'sell', 'sleep'];

// ------------------------------------------------------------------ registry
export const PARTS = Object.fromEntries(SLOTS.map((s) => [s, {}]));
export const LOAD_ERRORS = [];
export const LOAD_WARNINGS = [];

export const PART_KEYS = ['name', 'slot', 'description', 'tags', 'anchors', 'layers', 'moods', 'weight', 'requires', 'excludes', 'preview', 'line', 'takesLine', 'outline'];
export const LAYER_KEYS = ['name', 'slot', 'material', 'color', 'shapes', 'cut', 'mirror', 'shade', 'gloss', 'glow', 'core', 'paint', 'outline', 'line', 'takesLine', 'clip', 'place', 'ring', 'onto'];

export function registerPart(p, src = '(inline)', dirSlot) {
  if (!p || typeof p !== 'object') throw new Error(`${src}: export a part object (or an array of them)`);
  if (!p.name || !/^[a-z][a-zA-Z0-9-]*$/.test(p.name)) throw new Error(`${src}: part.name must be camelCase/kebab ascii`);
  if (!SLOTS.includes(p.slot)) throw new Error(`${src}: part.slot "${p.slot}" not in ${SLOTS.join(', ')}`);
  if (dirSlot && p.slot !== dirSlot) throw new Error(`${src}: part.slot "${p.slot}" must match its folder "${dirSlot}"`);
  if (!p.layers && !p.moods) throw new Error(`${src}: part needs layers or moods`);
  if (PARTS[p.slot][p.name]) throw new Error(`${src}: duplicate ${p.slot} part "${p.name}" (also in ${PARTS[p.slot][p.name].src})`);
  const unknown = Object.keys(p).filter((k) => !PART_KEYS.includes(k));
  if (unknown.length) LOAD_WARNINGS.push(`${src}: unknown part keys ${unknown.join(', ')}`);
  if (p.moods && !p.moods.idle) LOAD_WARNINGS.push(`${src}: moods has no "idle"`);
  PARTS[p.slot][p.name] = { weight: 1, ...p, src };
}

export async function loadParts(dir = PARTS_DIR) {
  for (const slot of SLOTS) {
    const d = join(dir, slot);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort()) {
      try {
        const mod = await import(pathToFileURL(join(d, f)).href);
        for (const p of [].concat(mod.default ?? [])) registerPart(p, `parts/${slot}/${f}`, slot);
      } catch (e) {
        LOAD_ERRORS.push(`parts/${slot}/${f}: ${e.message}`);
      }
    }
  }
}
await loadParts();

// ------------------------------------------------------------------ compose
export function normalizeSpec(spec = {}) {
  const s = { ...DEFAULT_SPEC };
  for (const [k, v] of Object.entries(spec)) s[SPEC_KEYS[k] ?? k] = v;
  for (const slot of SLOTS) {
    const v = s[slot];
    s[slot] = v == null || v === false || v === 'none' ? [] : [].concat(v).filter((n) => n && n !== 'none');
  }
  if (!ACCENTS[s.accent]) throw new Error(`unknown accent "${s.accent}"`);
  if (!ACCENTS[s.eyeColor]) throw new Error(`unknown eyeColor "${s.eyeColor}"`);
  return s;
}

function mergeAnchors(a, add) {
  for (const [k, v] of Object.entries(add ?? {})) {
    a[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? { ...a[k], ...v } : v;
  }
}

export function makeCtx(s, a, parts) {
  return {
    a, spec: s, W, H, accent: s.accent, eyeColor: s.eyeColor, mood: s.mood,
    mx: mirrorX,
    has: (slot, name) => (name ? s[slot]?.includes(name) : s[slot]?.length > 0),
    hasTag: (tag) => parts.some((p) => p.tags?.includes(tag)),
    eyeBox: (w, h, dx = 0, dy = 0) => ({ x: Math.round(a.eye.cx - w / 2 + dx), y: Math.round(a.eye.cy - h / 2 + dy), w, h }),
    color: (ref) => resolveColor(ref, { accent: s.accent, eyeColor: s.eyeColor }),
  };
}

/**
 * compose(spec) → { spec, w, h, rgba (Uint8ClampedArray 32*32*4), warnings[], asym, anchors }
 * spec: { head, face, eyes, top, body, arms, prop|front, fx, back, shadow  (part name | [names] | null),
 *         accent, eyeColor, mood, outline: { internal, selout, corners }, align: 'ground' | 'center' }
 */
export function compose(spec = {}) {
  const s = normalizeSpec(spec);
  const parts = [];
  for (const slot of SLOTS) for (const name of s[slot]) {
    const p = PARTS[slot][name];
    if (!p) throw new Error(`unknown ${slot} part "${name}" (have: ${Object.keys(PARTS[slot]).join(', ') || 'none'})`);
    parts.push(p);
  }
  const a = structuredClone(FRAME);
  let eyeSet = false, faceSet = false;
  for (const p of parts) {
    if (!p.anchors) continue;
    const add = typeof p.anchors === 'function' ? p.anchors(structuredClone(a)) : p.anchors;
    if (add?.eye) eyeSet = true;
    if (add?.face) faceSet = true;
    mergeAnchors(a, add);
  }
  // a part moved the screen but not the eyes → derive the eye centre from the screen box
  if (faceSet && !eyeSet) a.eye = { cx: a.face.x + Math.round(a.face.w / 4), cy: a.face.y + a.face.h / 2 };
  const ctx = makeCtx(s, a, parts);
  const entries = [];
  const warnings = [];
  for (const p of parts) {
    // a part without the requested mood silently falls back to its idle (or plain layers)
    const L0 = p.moods ? p.moods[s.mood] ?? p.moods.idle ?? p.layers : p.layers;
    let L = L0;
    if (typeof L === 'function') L = L(ctx);
    for (const layer of [].concat(L ?? [])) {
      if (!layer) continue;
      const bad = Object.keys(layer).filter((k) => !LAYER_KEYS.includes(k));
      if (bad.length) warnings.push(`${p.slot}/${p.name}: unknown layer keys ${bad.join(', ')}`);
      entries.push({ layer, part: p, slot: layer.slot ?? p.slot, order: entries.length });
    }
  }
  entries.sort((x, y) => SLOTS.indexOf(x.slot) - SLOTS.indexOf(y.slot) || x.order - y.order);
  const cv = new Canvas();
  entries.forEach((e, z) => { e.z = z; drawLayer(cv, e, ctx); });
  const fin = finalize(cv, s.outline ?? {});
  warnings.push(...fin.warnings);
  if (s.align === 'center') recenter(cv);
  return { spec: s, w: W, h: H, rgba: cv.rgba, warnings, asym: asymmetry(cv.rgba), anchors: a };
}

function recenter(cv) {
  let y0 = H, y1 = -1;
  for (let i = 0; i < W * H; i++) if (cv.rgba[i * 4 + 3]) { const y = (i / W) | 0; y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (y1 < 0) return;
  const dy = Math.floor((H - (y1 - y0 + 1)) / 2) - y0;
  if (!dy) return;
  const src = cv.rgba.slice();
  cv.rgba.fill(0);
  for (let y = 0; y < H; y++) {
    const ny = y + dy;
    if (ny < 0 || ny >= H) continue;
    cv.rgba.set(src.subarray(y * W * 4, (y + 1) * W * 4), ny * W * 4);
  }
}

/** all mood names offered by the parts in a spec (always includes 'idle') */
export function moodsFor(spec = {}) {
  const s = normalizeSpec(spec), set = new Set(['idle']);
  for (const slot of SLOTS) for (const n of s[slot]) for (const m of Object.keys(PARTS[slot][n]?.moods ?? {})) set.add(m);
  return [...set];
}

// ------------------------------------------------------------------ seeds
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(String(str))) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
/** mulberry32 stream seeded by FNV-1a(seed) */
export function rng(seed) {
  let s = typeof seed === 'number' ? seed >>> 0 : fnv1a(seed);
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Curated seeding rules (curator). Only parts named in `allow` can come out of a seed, with the weight given there
 * (part.weight is ignored for allow-listed slots), so a NEW part never changes existing seeds until it is added here.
 * Part requires/excludes are still honoured on top of these rules.
 *   allow    slot → { partName: weight }. Left out on purpose:
 *            face square/visor (starter look-alikes of fit/band), eyes pill/oval (only idle+blink: seeded agents must
 *            show buy/sell/happy/sleep), top catEars (kittyEars is the finished version), crown/copyCrown (app-assigned),
 *            front coin (solCoin), fx sparkle (twinkle) and zzz (pair with mood sleep by hand).
 *   empty    P(slot stays empty); a prop only ever appears in the hold pose (arms:hold requires a front part).
 *   emptyIf  [have, slot, p]: when `have` ('slot:name') was chosen, P(slot empty) becomes p.
 *   boost    [have, cand, factor]: multiply cand's weight when `have` was chosen (factor 0 = never together).
 *   banned   ['slot:name', 'slot:name' | 'slot:*']: never together (checked both ways).
 *   Colour tags usable in emptyIf / boost / banned: 'accent:<name>', 'eye:<name>' and 'eye:accent' (eyes = accent colour).
 */
export const SEED_RULES = {
  order: ['head', 'face', 'eyes', 'top', 'body', 'arms', 'front', 'fx', 'back', 'shadow'],
  empty: { back: 1, front: 1, fx: 0.7, top: 0.08 },
  emptyIf: [
    ['head:cat', 'top', 0.65],      // show the cat head's own ears most of the time
    ['arms:thumbsUp', 'fx', 0.85],  // the raised fist already fills the right side
  ],
  fixed: { shadow: 'soft' },
  accents: ['mint', 'blue', 'violet', 'gold', 'pink', 'lime', 'orange'],
  eyeColors: {
    mint: ['cyan', 'cyan', 'cyan', 'mint'], blue: ['cyan', 'cyan', 'cyan', 'blue'], violet: ['cyan', 'cyan', 'pink', 'violet'],
    gold: ['cyan', 'cyan', 'gold'], pink: ['cyan', 'cyan', 'pink'], lime: ['cyan', 'cyan', 'lime'], orange: ['cyan', 'cyan', 'orange'],
  },
  allow: {
    head: { tv: 3, dome: 2.5, cat: 2.5, mini: 2, capsule: 2, round: 1.5, wide: 1.5, boxy: 1.5 },
    face: { fit: 8, bezel: 1.5, rounded: 1, band: 1, oval: 1 },
    eyes: { smile: 3, orb: 3, led: 2.5, kitty: 1.5, tall: 1.5, slit: 1.25 },
    top: { antenna: 2, beacon: 2, twinAntennae: 2, kittyEars: 2, headphones: 1.5, propeller: 1, beanie: 1.25, boltEars: 1, topHat: 1, cap: 1, halo: 1 },
    body: { basic: 3, belly: 2, terminal: 2, capsule: 1.5, scarf: 1.5, hover: 1.5, mech: 1.5 },
    arms: { down: 2, nub: 2, hold: 2.5, wave: 1.5, mitt: 1, cheer: 1.5, thumbsUp: 1 },
    front: { phone: 2, copyCard: 2, solCoin: 2, chartCard: 1.5, rocket: 1.5, trophy: 1, magnifier: 1 },
    fx: { twinkle: 2, hearts: 1.5, pump: 1.5, coins: 1.5, fire: 1 },
  },
  boost: [
    ['head:cat', 'eyes:kitty', 3],                                   // the ω mouth belongs on the cat muzzle
    ['head:wide', 'eyes:slit', 3], ['head:wide', 'eyes:smile', 0.3], // visor band: slits read best, mouths get dropped
    ['head:dome', 'eyes:orb', 2], ['head:mini', 'eyes:smile', 2],
    ['head:wide', 'face:bezel', 0], ['head:mini', 'face:band', 0],    // bezel on a visor band / band on the mini: muddy
    ['head:cat', 'top:twinAntennae', 0], ['head:cat', 'top:antenna', 0], ['head:cat', 'top:beacon', 0], // no stalk between the cat's ears (reads as a horn)
    ['top:halo', 'fx:twinkle', 2], ['top:propeller', 'fx:pump', 2], ['body:terminal', 'fx:pump', 2],
    ['top:antenna', 'fx:fire', 0], ['top:beacon', 'fx:fire', 0],    // flame next to a bulb: two light sources fight
  ],
  banned: [
    ['arms:hold', 'fx:*'],        // prop + floating fx = too busy at 32 px
    ['arms:wave', 'fx:*'],        // the raised hand + fx crowd the left side
    ['body:hover', 'arms:nub'],   // stubs on a floating torso read as a bug
    ['top:boltEars', 'head:dome'], ['top:boltEars', 'head:capsule'], // 22-wide heads push the bolts to the canvas edge
    ['top:headphones', 'head:dome'], ['top:headphones', 'head:capsule'],
    ['top:beanie', 'face:bezel'], ['top:topHat', 'head:wide'], // black hat on a black visor = one blob
    ['head:cat', 'top:boltEars'], ['head:cat', 'top:halo'],     // four ears / a halo resting on the ear tips
    ['top:boltEars', 'arms:thumbsUp'], ['top:headphones', 'arms:thumbsUp'], // the fist lands on the right ear
    ['top:boltEars', 'arms:hold'], ['top:headphones', 'arms:hold'],         // tall props run into the right ear
    ['eye:accent', 'face:bezel'], // bezel ring in the eye colour swallows the eyes
    // polisher (art-director review items 1, 2, 3, 12, 19) — an entry may list 3 tags: banned when ALL are present
    ['arms:cheer', 'fx:*'],                                   // both raised hands fill both fx zones
    ['head:wide', 'arms:cheer'],                              // wide helmet + two raised arms: a crowded frame
    ['head:cat', 'top:cap'], ['head:cat', 'top:propeller'],   // a hat hides the cat head's ears: the head type is wasted
    ['head:cat', 'top:beanie'], ['head:cat', 'top:topHat'],
    ['head:dome', 'top:halo'],                                // no clear row between a halo and a dome head (row 6)
    ['head:mini', 'arms:thumbsUp'],                           // the fist runs into the narrow head's corner
    ['arms:thumbsUp', 'body:belly'], ['arms:thumbsUp', 'body:capsule'], // round torso edge + fist = doubled outline
    ['top:cap', 'arms:wave'], ['top:cap', 'arms:cheer'],      // the cap dome overhangs the raised forearm
    ['head:dome', 'top:kittyEars', 'arms:wave'], ['head:dome', 'top:kittyEars', 'arms:cheer'], // ear 2 px inside the arm
    ['head:round', 'top:kittyEars', 'arms:wave'], ['head:round', 'top:kittyEars', 'arms:cheer'],
    ['head:dome', 'top:beanie', 'arms:wave'], ['head:dome', 'top:beanie', 'arms:cheer'],
    ['head:capsule', 'top:beanie', 'arms:wave'], ['head:capsule', 'top:beanie', 'arms:cheer'],
    ['head:mini', 'top:topHat', 'arms:wave'], ['head:mini', 'top:topHat', 'arms:cheer'],       // brim wider than the mini head
    ['head:round', 'body:belly', 'arms:wave'], ['head:round', 'body:belly', 'arms:cheer'],     // armpit between two curves
    ['head:round', 'body:scarf', 'arms:nub'],                                                  // stub root under a narrow chin
    ['head:mini', 'top:twinAntennae', 'arms:wave'],                                            // the waving hand meets a ball tip
  ],
  // QA gate: a rolled robot must compose with no warnings and no pixel defects (sprite.mjs defects(): 2×2 outline
  // blocks, canvas-edge pixels, orphans) in every app mood; otherwise its PARTS are re-rolled from '<seed>#k' (the
  // colours stay). The rules above catch the known clashes; this catches any combination nobody listed.
  qa: { tries: 16 },
  // terminal chest screen (spec.chest), derived from the seed without touching the part rolls
  chests: ['candles', 'line', 'bars', 'check', 'gold'],
};

const tagOf = (slot, name) => `${slot}:${name}`;
function chosenSet(chosen, extra = []) {
  return new Set([...extra, ...Object.entries(chosen).flatMap(([sl, ns]) => ns.flatMap((n) => [tagOf(sl, n), `${sl}:*`]))]);
}

function compatible(p, chosen, extra = []) {
  for (const [slot, names] of Object.entries(p.requires ?? {})) if (chosen[slot] && !chosen[slot].some((n) => names.includes(n))) return false;
  for (const [slot, names] of Object.entries(p.excludes ?? {})) if (chosen[slot]?.some((n) => names.includes(n))) return false;
  for (const [slot, names] of Object.entries(chosen)) for (const n of names) {
    const q = PARTS[slot][n];
    if (!q) continue;
    const req = q.requires?.[p.slot];
    if (req && !req.includes(p.name)) return false;
    if (q.excludes?.[p.slot]?.includes(p.name)) return false;
  }
  const me = [tagOf(p.slot, p.name), `${p.slot}:*`];
  const have = chosenSet(chosen, extra);
  for (const tags of SEED_RULES.banned) if (tags.some((t) => me.includes(t)) && tags.every((t) => me.includes(t) || have.has(t))) return false;
  return true;
}

/** candidate pool for a slot: allow-listed parts with their curated weights (or every part by part.weight) */
function seedPool(slot) {
  const allow = SEED_RULES.allow?.[slot];
  if (!allow) return Object.values(PARTS[slot]).map((p) => [p, p.weight ?? 1]);
  return Object.entries(allow).filter(([n]) => PARTS[slot][n]).map(([n, w]) => [PARTS[slot][n], w]);
}
function seedWeight(p, w, have) {
  for (const [x, y, f] of SEED_RULES.boost ?? []) if (y === tagOf(p.slot, p.name) && have.has(x)) w *= f;
  return w;
}
function emptyChance(slot, have) {
  let e = SEED_RULES.empty[slot] ?? 0;
  for (const [x, sl, pr] of SEED_RULES.emptyIf ?? []) if (sl === slot && have.has(x)) e = pr;
  return e;
}

/**
 * fromSeed('wallet-or-name', overrides?) → compose spec (deterministic for a given seed + part registry).
 * Colours are rolled first, so adding parts never changes a seed's accent/eye colour.
 * Persist the returned spec (not the seed) if a robot must never change.
 */
export function fromSeed(seed, overrides = {}) {
  const R0 = rng(seed);
  const pickArr = (arr) => arr[Math.floor(R0() * arr.length)];
  const accent = overrides.accent ?? pickArr(SEED_RULES.accents);
  const eyeColor = overrides.eyeColor ?? pickArr(SEED_RULES.eyeColors[accent] ?? ['cyan']);
  const ov = {};
  for (const [k, v] of Object.entries(overrides)) ov[SPEC_KEYS[k] ?? k] = v;
  const tries = SEED_RULES.qa?.tries ?? 1;
  let spec;
  // try 0 continues the seed's own stream (so a clean robot is exactly what the plain roll gives); later tries re-roll
  // the parts only, from '<seed>#k'. The first spec that passes the QA gate wins; if none does, the last one is kept.
  for (let k = 0; k < tries; k++) {
    spec = rollParts(k ? rng(`${seed}#${k}`) : R0, seed, accent, eyeColor, ov);
    if (tries === 1 || passesQA(spec)) break;
  }
  return spec;
}

/** QA gate for seeds: no compose warnings and no pixel defects in any app mood (+ the wave frame for waving arms) */
export function passesQA(spec) {
  const moods = [...APP_MOODS, ...(spec.arms?.includes('wave') ? ['wave'] : [])];
  for (const mood of moods) {
    const r = compose({ ...spec, mood });
    if (r.warnings.length || defects(r.rgba).length) return false;
  }
  return true;
}

function rollParts(R, seed, accent, eyeColor, ov) {
  const chosen = {};
  const colourTags = [`accent:${accent}`, `eye:${eyeColor}`, ...(eyeColor === accent ? ['eye:accent'] : [])];
  for (const slot of SEED_RULES.order) {
    if (slot in ov) { chosen[slot] = v2arr(ov[slot]); continue; }
    if (SEED_RULES.fixed[slot]) { chosen[slot] = PARTS[slot][SEED_RULES.fixed[slot]] ? [SEED_RULES.fixed[slot]] : []; continue; }
    const needed = Object.entries(chosen).some(([sl, ns]) => ns.some((n) => PARTS[sl][n]?.requires?.[slot]));
    const have = chosenSet(chosen, colourTags);
    const roll = R();
    if (!needed && roll < emptyChance(slot, have)) { chosen[slot] = []; continue; }
    const cands = seedPool(slot)
      .map(([p, w]) => [p, seedWeight(p, w, have)])
      .filter(([p, w]) => w > 0 && compatible(p, chosen, colourTags));
    if (!cands.length) { chosen[slot] = []; continue; }
    const total = cands.reduce((t, [, w]) => t + w, 0);
    let r = R() * total, pick = cands[cands.length - 1][0];
    for (const [p, w] of cands) { r -= w; if (r < 0) { pick = p; break; } }
    chosen[slot] = [pick.name];
  }
  const out = { seed: String(seed), accent, eyeColor, mood: 'idle' };
  for (const slot of SLOTS) out[slot] = chosen[slot] ?? [];
  if (out.body.includes('terminal') && SEED_RULES.chests) out.chest = SEED_RULES.chests[fnv1a(`${seed}:chest`) % SEED_RULES.chests.length];
  for (const [k, v] of Object.entries(ov)) if (!SLOTS.includes(k)) out[k] = v;
  return out;
}
const v2arr = (v) => (v == null || v === false || v === 'none' ? [] : [].concat(v));

/** convenience: robot('seed') or robot({...spec}) */
export const robot = (x, overrides) => compose(typeof x === 'string' ? fromSeed(x, overrides) : x);
