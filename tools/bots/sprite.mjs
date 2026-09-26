// sprite.mjs — layered pixel DSL on a 32×32 grid.
//   rasterisers (px, rect, hline, vline, line, roundedRect, ellipse, poly, bits) → masks
//   materials (body / accent[:name] / screen / eye / flat) → colours, lit from the top-left
//   Canvas (colour + per-pixel owner) → finalize(): auto 1-px outline + internal part lines
import { hexToRgba, resolveColor, rampFor, SCREEN, OUTLINE, LINE_SOFT } from './palette.mjs';

export const W = 32, H = 32, AXIS = 15.5;
/** z-order, bottom → top */
export const SLOTS = ['shadow', 'back', 'body', 'arms', 'head', 'face', 'eyes', 'top', 'front', 'fx'];
/** per-slot defaults: line = draw my edge onto lower parts; outline = join the silhouette */
export const SLOT_DEFAULTS = {
  shadow: { line: false, outline: false },
  back:   { line: false, outline: true },
  body:   { line: true,  outline: true },
  arms:   { line: true,  outline: true },
  head:   { line: true,  outline: true },
  face:   { line: false, outline: true },
  eyes:   { line: false, outline: true },
  top:    { line: true,  outline: true },
  front:  { line: true,  outline: true },
  fx:     { line: false, outline: true },
};

const N4 = [[0, -1], [-1, 0], [1, 0], [0, 1]];
const N8 = [...N4, [-1, -1], [1, -1], [-1, 1], [1, 1]];
export const mirrorX = (x, w = 1) => W - x - w;   // x of the mirrored copy of a w-wide run
export const newMask = () => new Uint8Array(W * H);
const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

// ------------------------------------------------------------------ corners
/** Numeric corner radius → rows cut from each corner (top row first). Arrays pass through. */
export const CORNERS = {
  0: [], 1: [1], 2: [2, 1], 3: [3, 1, 1], 4: [4, 2, 1, 1], 5: [5, 3, 2, 1, 1],
  6: [6, 4, 3, 2, 1, 1], 7: [7, 5, 3, 2, 2, 1, 1], 8: [8, 5, 4, 3, 2, 1, 1, 1],
};
export function cornerProfile(r) {
  if (Array.isArray(r)) return r.slice();
  const k = Math.max(0, Math.round(r || 0));
  if (CORNERS[k]) return CORNERS[k].slice();
  // > 8: quarter of a pixel-centre circle of radius k
  const out = [];
  for (let i = 0; i < k; i++) {
    const dy = k - i - 0.5;
    let cut = 0;
    while (cut < k && (k - cut - 0.5) ** 2 + dy * dy > k * k) cut++;
    out.push(cut);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

// ------------------------------------------------------------------ rasterisers
// Every rasteriser calls put(x, y) for each covered pixel (integers; out-of-canvas is ignored by put).
export const RASTER = {
  px(put, a, b) {
    if (Array.isArray(a)) for (const [x, y] of a) put(x, y);
    else put(a, b);
  },
  rect(put, x, y, w, h) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j);
  },
  hline(put, x0, x1, y) {
    const [a, b] = x0 <= x1 ? [x0, x1] : [x1, x0];
    for (let x = a; x <= b; x++) put(x, y);
  },
  vline(put, x, y0, y1) {
    const [a, b] = y0 <= y1 ? [y0, y1] : [y1, y0];
    for (let y = a; y <= b; y++) put(x, y);
  },
  line(put, x0, y0, x1, y1) { // Bresenham, both ends inclusive
    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1, e = dx + dy;
    for (;;) {
      put(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) { e += dy; x0 += sx; }
      if (e2 <= dx) { e += dx; y0 += sy; }
    }
  },
  roundedRect(put, x, y, w, h, r = 0) {
    const prof = cornerProfile(r).slice(0, Math.floor(h / 2)).map((c) => Math.min(c, Math.floor(w / 2)));
    for (let j = 0; j < h; j++) {
      const k = Math.min(j, h - 1 - j);
      const cut = k < prof.length ? prof[k] : 0;
      for (let i = cut; i < w - cut; i++) put(x + i, y + j);
    }
  },
  ellipse(put, x, y, w, h) { // bounding-box ellipse, pixel-centre test (matches the classic pixel-art ellipse tool)
    const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const dx = (x + i + 0.5 - cx) / rx, dy = (y + j + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1 + 1e-9) put(x + i, y + j);
    }
  },
  poly(put, pts) { // even-odd scanline fill sampled at pixel centres; vertices in pixel-edge coordinates
    const ys = pts.map((p) => p[1]);
    const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
    for (let y = y0; y < y1; y++) {
      const py = y + 0.5, xs = [];
      for (let k = 0; k < pts.length; k++) {
        const [ax, ay] = pts[k], [bx, by] = pts[(k + 1) % pts.length];
        if ((ay <= py && by > py) || (by <= py && ay > py)) xs.push(ax + ((py - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.ceil(xs[k] - 0.5 - 1e-9); x + 0.5 <= xs[k + 1] + 1e-9; x++) put(x, y);
      }
    }
  },
  bits(put, x, y, rows) { // ASCII mask: '.' or ' ' = off, anything else = on
    rows.forEach((row, j) => [...row].forEach((ch, i) => { if (ch !== '.' && ch !== ' ') put(x + i, y + j); }));
  },
};
RASTER.rrect = RASTER.roundedRect;
RASTER.oval = RASTER.ellipse;
/** ['shift', dx, dy, [shapes…]] — the given shapes moved by (dx, dy) (used by layer placement) */
RASTER.shift = (put, dx, dy, shapes) => { for (const s of shapes) drawShape((x, y) => put(x + dx, y + dy), s); };

export function drawShape(put, shape) {
  if (!Array.isArray(shape) || typeof shape[0] !== 'string') throw new Error(`shape must be ['op', ...args], got ${JSON.stringify(shape)}`);
  const [op, ...args] = shape;
  const fn = RASTER[op];
  if (!fn) throw new Error(`unknown shape op "${op}" (known: ${Object.keys(RASTER).join(', ')})`);
  fn(put, ...args);
}

/** shapes ∪ (mirrored) minus cut → mask */
export function rasterLayer(layer) {
  const m = newMask();
  const add = (x, y) => { if (inb(x, y)) m[y * W + x] = 1; };
  for (const s of layer.shapes ?? []) drawShape(add, s);
  if (layer.cut?.length) {
    const c = newMask();
    const addC = (x, y) => { if (inb(x, y)) c[y * W + x] = 1; };
    for (const s of layer.cut) drawShape(addC, s);
    if (layer.mirror) mirrorMask(c);
    if (layer.mirror) mirrorMask(m);
    for (let i = 0; i < m.length; i++) if (c[i]) m[i] = 0;
  } else if (layer.mirror) mirrorMask(m);
  return m;
}
function mirrorMask(m) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) m[y * W + (W - 1 - x)] = 1;
}

// ------------------------------------------------------------------ analysis
/** run lengths to the mask edge in 4 directions (1 = edge pixel) + 4-connected components */
export function analyse(m) {
  const t = new Uint8Array(W * H), l = new Uint8Array(W * H), b = new Uint8Array(W * H), r = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!m[i]) continue;
    t[i] = y > 0 && m[i - W] ? t[i - W] + 1 : 1;
    l[i] = x > 0 && m[i - 1] ? l[i - 1] + 1 : 1;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x;
    if (!m[i]) continue;
    b[i] = y < H - 1 && m[i + W] ? b[i + W] + 1 : 1;
    r[i] = x < W - 1 && m[i + 1] ? r[i + 1] + 1 : 1;
  }
  const lab = new Int16Array(W * H).fill(-1), comps = [];
  for (let i0 = 0; i0 < W * H; i0++) {
    if (!m[i0] || lab[i0] >= 0) continue;
    const c = { id: comps.length, x0: W, y0: H, x1: -1, y1: -1, px: [], first: i0 };
    const stack = [i0];
    lab[i0] = c.id;
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i / W) | 0;
      c.px.push(i);
      if (i < c.first) c.first = i;
      c.x0 = Math.min(c.x0, x); c.x1 = Math.max(c.x1, x); c.y0 = Math.min(c.y0, y); c.y1 = Math.max(c.y1, y);
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy, n = ny * W + nx;
        if (inb(nx, ny) && m[n] && lab[n] < 0) { lab[n] = c.id; stack.push(n); }
      }
    }
    c.w = c.x1 - c.x0 + 1; c.h = c.y1 - c.y0 + 1; c.cx = (c.x0 + c.x1) / 2; c.cy = (c.y0 + c.y1) / 2;
    comps.push(c);
  }
  return { t, l, b, r, lab, comps };
}

// ------------------------------------------------------------------ materials
/**
 * Ramp shading, light from the top-left, per 4-connected component:
 *   deep  : bottom rim (right half) + right rim (lower half)           [shade.deep px thick, 0 = off]
 *   shade : bottom band (shade.lo px; auto 2 when comp is ≥10 tall) + right band (shade.loR px)
 *   hi    : top + left bands (shade.hi px)
 *   spec  : small inner L-glint 1 px inside the top-left corner (auto on comps ≥ 8×6; false = off; or [[dx,dy],…] from bbox)
 *   base  : the rest.  1-px-thin components are flat base.
 */
export function shadeRamp(m, ramp, o = {}) {
  const A = analyse(m), out = new Array(W * H).fill(null);
  for (const c of A.comps) {
    const hi = o.hi ?? 1, lo = o.lo ?? (c.h >= 10 ? 2 : 1), loR = o.loR ?? 1, deep = o.deep ?? 1;
    const thin = c.w < 2 || c.h < 2;
    for (const i of c.px) {
      const x = i % W, y = (i / W) | 0, T = A.t[i], L = A.l[i], B = A.b[i], R = A.r[i];
      let tone = 'base';
      if (thin) tone = 'base';
      else if (deep && ((B <= deep && x >= c.cx) || (R <= deep && y >= c.cy))) tone = 'deep';
      else if (B <= lo || R <= loR) tone = 'shade';
      else if (T <= hi || L <= hi) tone = 'hi';
      out[i] = ramp[tone];
    }
    const spec = o.spec ?? 'auto';
    if (spec === 'auto' && c.w >= 8 && c.h >= 6) {
      for (const i of c.px) {
        const T = A.t[i], L = A.l[i];
        if (out[i] === ramp.base && ((T === hi + 1 && L >= hi + 1 && L <= hi + 2) || (L === hi + 1 && T >= hi + 1 && T <= hi + 2))) out[i] = ramp.hi;
      }
    } else if (Array.isArray(spec)) {
      for (const [dx, dy] of spec) { const i = (c.y0 + dy) * W + c.x0 + dx; if (A.lab[i] === c.id) out[i] = ramp.hi; }
    }
  }
  return out;
}

/**
 * Screen: flat SCREEN.base + diagonal "/" gloss streak(s) near the top-left of each screen blob.
 * gloss: { d, len = 3, dy = 1 } → pixels (x0 + d - k', y0 + k') for k' = dy … dy+len-1, relative to the blob bbox,
 * kept only when inset (their up & left neighbours are screen too). Default: DEFAULT_GLOSS. false = none.
 */
export const DEFAULT_GLOSS = [{ d: 4, len: 3 }];
export function shadeScreen(m, o = {}) {
  const A = analyse(m), out = new Array(W * H).fill(null);
  const G = o.gloss === false ? [] : [].concat(o.gloss ?? DEFAULT_GLOSS);
  for (const c of A.comps) {
    for (const i of c.px) out[i] = SCREEN.base;
    if (c.w < 5 || c.h < 4) continue;
    for (const g of G) {
      const len = g.len ?? 3, dy0 = g.dy ?? 1;
      for (let k = 0; k < len; k++) {
        const dy = dy0 + k, dx = g.d - dy, x = c.x0 + dx, y = c.y0 + dy;
        if (dx < 1 || !inb(x, y)) continue;
        const i = y * W + x;
        if (A.lab[i] === c.id && A.t[i] >= 2 && A.l[i] >= 2) out[i] = SCREEN.gloss;
      }
    }
  }
  return out;
}

/** Eyes: ramp.base with a 1-px ramp.hi core at the first (top-left) pixel of each blob ≥ 2×2. core:false disables. */
export function shadeEye(m, ramp, o = {}) {
  const A = analyse(m), out = new Array(W * H).fill(null);
  for (const c of A.comps) {
    for (const i of c.px) out[i] = ramp.base;
    if (o.core !== false && c.w >= 2 && c.h >= 2) {
      if (Array.isArray(o.core)) { const i = (c.y0 + o.core[1]) * W + c.x0 + o.core[0]; if (A.lab[i] === c.id) out[i] = ramp.hi; }
      else out[c.first] = ramp.hi;
    }
  }
  return out;
}

// ------------------------------------------------------------------ canvas
export class Canvas {
  constructor() {
    this.rgba = new Uint8ClampedArray(W * H * 4);
    this.own = new Int16Array(W * H).fill(-1);
    this.owners = [];
  }
  addOwner(o) { this.owners.push(o); return this.owners.length - 1; }
  owner(i) { return this.own[i] >= 0 ? this.owners[this.own[i]] : null; }
  alpha(i) { return this.rgba[i * 4 + 3]; }
  clear(i) { this.rgba.fill(0, i * 4, i * 4 + 4); this.own[i] = -1; }
  put(i, hex, ownerId) {
    if (hex == null) return this.clear(i);
    const c = hexToRgba(hex), d = this.rgba, p = i * 4;
    if (c[3] >= 255 || d[p + 3] === 0) {
      d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = c[3];
      this.own[i] = ownerId;
      return;
    }
    const a = c[3] / 255, ba = d[p + 3] / 255, oa = a + ba * (1 - a);
    for (let k = 0; k < 3; k++) d[p + k] = Math.round((c[k] * a + d[p + k] * ba * (1 - a)) / oa);
    d[p + 3] = Math.round(oa * 255);
  }
}

/**
 * Draw one layer entry { layer, part, slot, z } onto the canvas.
 * ctx needs: accent, eyeColor (for colour refs / ramps).
 */
export function drawLayer(cv, entry, ctx) {
  const { layer, part, slot, z } = entry;
  const def = SLOT_DEFAULTS[slot];
  if (!def) throw new Error(`${part.slot}/${part.name}: unknown slot "${slot}"`);
  if (layer.place) return drawPlaced(cv, entry, ctx);
  const material = layer.paint ? 'paint' : layer.material ?? (layer.color ? 'flat' : 'body');
  const isLine = material === 'flat' && /^(outline|line)(\.|$)/.test(layer.color ?? '');
  const base = {
    part: `${part.slot}/${part.name}`, slot, z, material,
    line: layer.line ?? part.line ?? def.line,
    lineExplicit: layer.line !== undefined,
    takesLine: layer.takesLine ?? part.takesLine ?? true,
    outline: layer.outline ?? part.outline ?? def.outline,
  };
  const ownerId = cv.addOwner({ ...base, isLine });
  const clip = layer.clip ? new Set([].concat(layer.clip)) : null;
  const onto = layer.onto ? new Set([].concat(layer.onto)) : null; // only over pixels of these materials (e.g. screen, glow)
  const allowed = (i) => (!clip || (cv.own[i] >= 0 && clip.has(cv.owners[cv.own[i]].slot) && cv.alpha(i) === 255))
    && (!onto || (cv.own[i] >= 0 && onto.has(cv.owners[cv.own[i]].material) && cv.alpha(i) === 255));

  if (layer.paint) {
    const { x = 0, y = 0, rows = [], key = {} } = layer.paint;
    const K = { ...PAINT_KEY, ...key };
    const lineId = cv.addOwner({ ...base, isLine: true });
    const cells = [];
    rows.forEach((row, j) => [...row].forEach((ch, i) => {
      if (ch === '.' || ch === ' ') return;
      const ref = K[ch];
      if (!ref) throw new Error(`${base.part}: paint char "${ch}" has no key`);
      cells.push([x + i, y + j, ref]);
      if (layer.mirror) cells.push([W - 1 - (x + i), y + j, ref]);
    }));
    for (const [px, py, ref] of cells) {
      if (!inb(px, py)) continue;
      const i = py * W + px;
      if (!allowed(i)) continue;
      const hex = resolveColor(ref, ctx);
      cv.put(i, hex, /^(outline|line)(\.|$)/.test(ref) ? lineId : ownerId);
    }
    return;
  }

  const m = rasterLayer(layer);
  if (layer.ring) ringInto(m, cv, layer.ring);
  if (clip) for (let i = 0; i < m.length; i++) if (m[i] && !allowed(i)) m[i] = 0;
  let cols;
  if (material === 'body' || material.startsWith('accent')) cols = shadeRamp(m, rampFor(material, ctx), layer.shade);
  else if (material === 'screen') cols = shadeScreen(m, layer);
  else if (material === 'eye') cols = shadeEye(m, rampFor('eye', ctx), layer);
  else if (material === 'flat') {
    const hex = resolveColor(layer.color ?? 'body', ctx);
    cols = Array.from(m, (v) => (v ? hex : null));
  } else throw new Error(`${base.part}: unknown material "${material}"`);

  for (let i = 0; i < m.length; i++) if (m[i]) cv.put(i, cols[i], ownerId);

  // glow: 1-px halo (eye glow tone) on screen pixels around the eye blobs. The glass gloss is a reflection on top of
  // the glass, so the halo never paints over it (polisher: the gloss used to be eaten down to a stray pixel).
  const glow = layer.glow ?? (material === 'eye');
  if (glow) {
    const ramp = rampFor(material === 'eye' || material.startsWith('accent') ? material : 'accent', ctx);
    const hid = cv.addOwner({ ...base, material: 'glow', line: false });
    const N = glow === 8 ? N8 : N4;
    const G = hexToRgba(SCREEN.gloss);
    const isGloss = (n) => cv.rgba[n * 4] === G[0] && cv.rgba[n * 4 + 1] === G[1] && cv.rgba[n * 4 + 2] === G[2];
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of N) {
        const nx = x + dx, ny = y + dy, n = ny * W + nx;
        if (!inb(nx, ny) || m[n]) continue;
        const o = cv.owner(n);
        if (o && o.material === 'screen' && !isGloss(n)) cv.put(n, ramp.glow, hid);
      }
    }
  }
}

/**
 * layer.ring = { slot: 'head' | [slots], d = 2, y0 = 0, y1 = 31 } adds every pixel at exactly 4-distance d from the
 * opaque pixels already drawn by those slots (rows y0..y1). d = 2 gives a 1-px band that hugs the shape and shares
 * ONE outline column with it (fill · shared outline · fill) — e.g. a headphone band that follows any head's contour.
 * Needs the slot to be drawn first, so the layer must sit in a later slot (e.g. 'top' for slot 'head').
 */
function ringInto(m, cv, { slot, d = 2, y0 = 0, y1 = H - 1 }) {
  const slots = new Set([].concat(slot));
  const dist = new Int16Array(W * H).fill(-1);
  let q = [];
  for (let i = 0; i < W * H; i++) {
    const o = cv.owner(i);
    if (o && slots.has(o.slot) && cv.alpha(i) === 255) { dist[i] = 0; q.push(i); }
  }
  for (let k = 1; k <= d; k++) {
    const nq = [];
    for (const i of q) {
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy, n = ny * W + nx;
        if (inb(nx, ny) && dist[n] < 0) { dist[n] = k; nq.push(n); }
      }
    }
    q = nq;
  }
  for (const i of q) { const y = (i / W) | 0; if (y >= y0 && y <= y1) m[i] = 1; }
}

// ------------------------------------------------------------------ placement (floating fx)
/**
 * layer.place = { at: [[dx, dy], …], gap = 1, alt: [layer, …] }
 * Tries the layer at each offset (then each `alt` layer — e.g. a smaller glyph — at its own place.at or the same
 * offsets) and draws the first one that fits:
 *   · its pixels (plus its own 1-px outline when outlined) stay inside x/y 1..30 (1-px canvas margin), and
 *   · keep `gap` transparent px (8-neighbour) from everything already drawn, counting the outline every drawn
 *     silhouette part will get in finalize().
 * Nothing fits → the layer is dropped. Used by fx so floating hearts/coins/sparkles never touch ears, hands or hats.
 * place.fit = 'onto' instead: a spot fits when EVERY pixel lands on a material listed in layer.onto (used by the
 * screen gloss, which must keep its full 3-px streak on the glass and never cross an eye).
 */
function drawPlaced(cv, entry, ctx) {
  const { layer, part, slot } = entry;
  const P = layer.place;
  const taken = occupancy(cv);
  const gap = P.gap ?? 1;
  for (const L of [layer, ...(P.alt ?? [])]) {
    const outlined = (L.outline ?? part.outline ?? SLOT_DEFAULTS[slot].outline) !== false;
    for (const [dx, dy] of L.place?.at ?? P.at ?? [[0, 0]]) {
      const cand = shiftLayer(L, dx, dy);
      const ok = P.fit === 'onto' ? fitsOnto(cv, layerCoords(cand), L.onto) : fitsAt(layerCoords(cand), outlined, taken, gap);
      if (ok) {
        const plain = { ...cand };
        delete plain.place;
        drawLayer(cv, { ...entry, layer: plain }, ctx);
        return;
      }
    }
  }
}
function shiftLayer(L, dx, dy) {
  if (!dx && !dy) return L;
  if (L.paint) return { ...L, paint: { ...L.paint, x: (L.paint.x ?? 0) + dx, y: (L.paint.y ?? 0) + dy } };
  return { ...L, shapes: [['shift', dx, dy, L.shapes ?? []]], ...(L.cut ? { cut: [['shift', dx, dy, L.cut]] } : {}) };
}
/** unclipped pixel coords of a layer (paint cells or shapes − cut, mirrored) */
function layerCoords(L) {
  const set = new Map();
  const add = (x, y) => set.set(`${x},${y}`, [x, y]);
  if (L.paint) {
    const { x = 0, y = 0, rows = [] } = L.paint;
    rows.forEach((row, j) => [...row].forEach((ch, i) => { if (ch !== '.' && ch !== ' ') add(x + i, y + j); }));
  } else {
    for (const s of L.shapes ?? []) drawShape(add, s);
    for (const s of L.cut ?? []) drawShape((x, y) => set.delete(`${x},${y}`), s);
  }
  if (L.mirror) for (const [x, y] of [...set.values()]) add(W - 1 - x, y);
  return [...set.values()];
}
/** pixels already used: every opaque non-shadow pixel + the 4-neighbour outline ring of the silhouette */
function occupancy(cv) {
  const t = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = cv.owner(i);
    if (!o || !cv.alpha(i) || o.slot === 'shadow') continue;
    t[i] = 1;
    if (o.outline === false || o.isLine || cv.alpha(i) !== 255) continue;
    const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of N4) if (inb(x + dx, y + dy)) t[(y + dy) * W + x + dx] = 1;
  }
  return t;
}
function fitsOnto(cv, coords, onto) {
  const set = new Set([].concat(onto ?? []));
  return coords.every(([x, y]) => {
    if (!inb(x, y)) return false;
    const i = y * W + x, o = cv.owner(i);
    return o && set.has(o.material) && cv.alpha(i) === 255;
  });
}
function fitsAt(coords, outlined, taken, gap) {
  const foot = new Map(coords.map(([x, y]) => [`${x},${y}`, [x, y]]));
  if (outlined) for (const [x, y] of coords) for (const [dx, dy] of N4) foot.set(`${x + dx},${y + dy}`, [x + dx, y + dy]);
  for (const [x, y] of foot.values()) {
    if (x < 1 || y < 1 || x > W - 2 || y > H - 2) return false;
    for (let dy = -gap; dy <= gap; dy++) for (let dx = -gap; dx <= gap; dx++) {
      const nx = x + dx, ny = y + dy;
      if (inb(nx, ny) && taken[ny * W + nx]) return false;
    }
  }
  return true;
}

/** Default paint keys (a layer's paint.key may add/override). */
export const PAINT_KEY = {
  o: 'outline', O: 'line.soft',
  W: 'body.hi', w: 'body.base', s: 'body.shade', d: 'body.deep',
  k: 'screen', g: 'screen.gloss',
  A: 'accent.hi', a: 'accent.base', q: 'accent.lo', Q: 'accent.deep',
  E: 'eye.hi', e: 'eye.base', r: 'eye.lo', h: 'eye.glow',
  '%': 'shadow.inner', x: 'clear',
};

// ------------------------------------------------------------------ outline pass
/**
 * opts.internal : true (default) | false | 'soft'   lines where an upper part meets a lower part
 * opts.selout   : false (default) | true            lit-side (top/left) external outline uses LINE_SOFT
 * opts.corners  : false (default) | true            8-neighbour outline (fills diagonal corners)
 */
export function finalize(cv, opts = {}) {
  const { rgba, own, owners } = cv;
  const S = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = cv.owner(i);
    if (o && rgba[i * 4 + 3] === 255 && o.outline !== false && !o.isLine && o.slot !== 'shadow') S[i] = 1;
  }
  const lineId = cv.addOwner({ part: 'outline', slot: 'outline', z: 1e9, material: 'flat', isLine: true, line: false, outline: false });
  const paint = [];
  if (opts.internal !== false) {
    for (let i = 0; i < W * H; i++) {
      if (!S[i]) continue;
      const A = owners[own[i]];
      if (A.takesLine === false) continue;
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (!inb(nx, ny)) continue;
        const n = ny * W + nx;
        if (!S[n]) continue;
        const B = owners[own[n]];
        if (B.z <= A.z || !B.line) continue;
        if (A.part === B.part && !B.lineExplicit) continue;
        paint.push([i, B.line === 'soft' || opts.internal === 'soft' ? LINE_SOFT : OUTLINE]);
        break;
      }
    }
  }
  // A pixel that just received a dark internal line IS outline now: it must not grow a second outline outside itself.
  // (Polisher: where one part's edge ran along another's — arm root under a head corner, hand beside a torso — the lined
  // pixel plus its own outer outline stacked into 2×2 dark blocks.)
  const lined = new Uint8Array(W * H);
  for (const [i, hex] of paint) if (hex === OUTLINE) lined[i] = 1;
  const N = opts.corners ? N8 : N4;
  for (let i = 0; i < W * H; i++) {
    if (S[i]) continue;
    const o = cv.owner(i);
    if (o && rgba[i * 4 + 3] === 255 && o.slot !== 'shadow') continue; // keep painted lines / un-outlined fx
    const x = i % W, y = (i / W) | 0;
    let hit = false, litOnly = true;
    for (const [dx, dy] of N) {
      const nx = x + dx, ny = y + dy;
      if (!inb(nx, ny) || !S[ny * W + nx] || lined[ny * W + nx]) continue;
      hit = true;
      if (dx < 0 || dy < 0) litOnly = false;
    }
    if (hit) paint.push([i, opts.selout && litOnly ? LINE_SOFT : OUTLINE]);
  }
  for (const [i, hex] of paint) { cv.rgba.fill(0, i * 4, i * 4 + 4); cv.put(i, hex, lineId); }
  // diagnostics
  const warnings = [];
  let edge = 0;
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    if (S[i] && (x === 0 || y === 0 || x === W - 1 || y === H - 1)) edge++;
  }
  if (edge) warnings.push(`${edge} filled px touch the canvas edge (outline clipped) — keep fills inside x/y 1..30`);
  return { warnings, silhouette: S };
}

/**
 * Pixel-art QA on a finished 32×32 RGBA sprite (polisher). Returns ['kind x,y', …]:
 *   clump   2×2 block of outline pixels (doubled outline / tangent)
 *   edge    any pixel on the canvas border ring (x or y = 0 / 31): keep a 1-px margin
 *   orphan  opaque pixel with no opaque 8-neighbour (dust)
 * Translucent pixels (the soft shadow) only count for 'edge'.
 */
export function defects(rgba) {
  const out = [], O = hexToRgba(OUTLINE);
  const a = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : rgba[(y * W + x) * 4 + 3]);
  const isO = (x, y) => { const p = (y * W + x) * 4; return a(x, y) === 255 && rgba[p] === O[0] && rgba[p + 1] === O[1] && rgba[p + 2] === O[2]; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!a(x, y)) continue;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) out.push(`edge ${x},${y}`);
    if (a(x, y) !== 255) continue;
    if (x < W - 1 && y < H - 1 && isO(x, y) && isO(x + 1, y) && isO(x, y + 1) && isO(x + 1, y + 1)) out.push(`clump ${x},${y}`);
    let n = 0;
    for (const [dx, dy] of N8) if (a(x + dx, y + dy) === 255) n++;
    if (!n) out.push(`orphan ${x},${y}`);
  }
  return out;
}

/**
 * Shape asymmetry: mirrored pixel pairs whose coverage class differs (empty / translucent / outline / fill).
 * Shading is lit from the top-left so colours are never symmetric; this only checks the drawing.
 */
export function asymmetry(rgba) {
  const out = hexToRgba(OUTLINE);
  const cls = (p) => (rgba[p + 3] === 0 ? 0 : rgba[p + 3] < 255 ? 1 : rgba[p] === out[0] && rgba[p + 1] === out[1] && rgba[p + 2] === out[2] ? 2 : 3);
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) {
    if (cls((y * W + x) * 4) !== cls((y * W + W - 1 - x) * 4)) n++;
  }
  return n;
}
