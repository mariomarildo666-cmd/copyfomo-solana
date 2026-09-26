// test.mjs — engine self-checks: node test.mjs
import { inflateSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RASTER, newMask, W, H, cornerProfile, SLOTS } from './sprite.mjs';
import { encodePNG, scaleRGBA } from './png.mjs';
import { toSVG } from './svg.mjs';
import { compose, fromSeed, PARTS, LOAD_ERRORS } from './robot.mjs';
import { OUTLINE, hexToRgba } from './palette.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg); } else console.log('ok  ', msg); };
const rows = (m) => Array.from({ length: H }, (_, y) => m.slice(y * W, y * W + W).reduce((a, b) => a + b, 0)).filter(Boolean);
const shape = (op, ...a) => { const m = newMask(); RASTER[op]((x, y) => { m[y * W + x] = 1; }, ...a); return m; };

ok(LOAD_ERRORS.length === 0, `parts load cleanly (${SLOTS.map((s) => `${s}:${Object.keys(PARTS[s]).length}`).join(' ')})`);
ok(JSON.stringify(rows(shape('ellipse', 0, 0, 8, 8))) === '[4,6,8,8,8,8,6,4]', 'ellipse 8×8 = classic circle');
ok(JSON.stringify(rows(shape('ellipse', 0, 0, 4, 4))) === '[2,4,4,2]', 'ellipse 4×4');
ok(JSON.stringify(rows(shape('ellipse', 0, 0, 5, 5))) === '[3,5,5,5,3]', 'ellipse 5×5');
ok(JSON.stringify(rows(shape('roundedRect', 0, 0, 10, 6, 2))) === '[6,8,10,10,8,6]', 'roundedRect r2 = [2,1] corners');
ok(JSON.stringify(cornerProfile(4)) === '[4,2,1,1]' && JSON.stringify(cornerProfile([3, 1])) === '[3,1]', 'corner profiles');
ok(rows(shape('poly', [[0, 0], [4, 0], [4, 4], [0, 4]])).join() === '4,4,4,4', 'poly square covers exact pixels');
ok(rows(shape('line', 0, 0, 5, 3)).reduce((a, b) => a + b) === 6, 'bresenham line');

// mirror symmetry of a mirrored ellipse centred on the axis
{
  const m = shape('ellipse', 6, 7, 20, 13);
  let asym = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < 16; x++) if (m[y * W + x] !== m[y * W + 31 - x]) asym++;
  ok(asym === 0, 'even-width ellipse at x=6 is symmetric about 15.5');
}

// PNG round-trip (decode our own IDAT)
{
  const r = compose({});
  const png = encodePNG(r.rgba, W, H);
  ok(png.slice(1, 4).toString() === 'PNG', 'png signature');
  const idatLen = png.readUInt32BE(33);
  ok(png.slice(37, 41).toString() === 'IDAT', 'IDAT chunk follows IHDR');
  const raw = inflateSync(png.slice(41, 41 + idatLen));
  let same = true;
  for (let y = 0; y < H; y++) for (let k = 0; k < W * 4; k++) if (raw[y * (W * 4 + 1) + 1 + k] !== r.rgba[y * W * 4 + k]) same = false;
  ok(same, 'png pixels round-trip exactly');
  const s = scaleRGBA(r.rgba, W, H, 8);
  let nn = true;
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) for (let c = 0; c < 4; c++) if (s.data[(y * s.w + x) * 4 + c] !== r.rgba[(((y / 8) | 0) * W + ((x / 8) | 0)) * 4 + c]) nn = false;
  ok(nn, '8× upscale is exact nearest-neighbour');

  // SVG covers exactly the opaque pixels
  const svg = toSVG(r.rgba, W, H);
  const cov = new Uint8Array(W * H);
  for (const m of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)) {
    const [x, y, w, h] = m.slice(1).map(Number);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) cov[(y + j) * W + x + i]++;
  }
  let good = true;
  for (let i = 0; i < W * H; i++) if (cov[i] !== (r.rgba[i * 4 + 3] ? 1 : 0)) good = false;
  ok(good, `svg rects tile the sprite exactly (${(svg.match(/<rect/g) || []).length} rects)`);

  // outline: every transparent px touching a fill px (4-neigh) is outline-coloured; no pure black anywhere
  const o = hexToRgba(OUTLINE);
  let black = 0;
  for (let i = 0; i < W * H; i++) if (r.rgba[i * 4 + 3] === 255 && !r.rgba[i * 4] && !r.rgba[i * 4 + 1] && !r.rgba[i * 4 + 2]) black++;
  ok(black === 0, 'no pure black pixels');
  let hole = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (r.rgba[i * 4 + 3] !== 0) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = (y + dy) * W + x + dx;
      if (x + dx < 0 || x + dx >= W || y + dy < 0 || y + dy >= H) continue;
      const p = n * 4;
      if (r.rgba[p + 3] === 255 && !(r.rgba[p] === o[0] && r.rgba[p + 1] === o[1] && r.rgba[p + 2] === o[2])) hole++;
    }
  }
  ok(hole === 0, 'silhouette fully closed by the 1-px outline');
}

// fromSeed determinism + validity
{
  const a = JSON.stringify(fromSeed('abc')), b = JSON.stringify(fromSeed('abc'));
  ok(a === b, 'fromSeed deterministic');
  let bad = 0;
  for (let i = 0; i < 300; i++) { try { const r = compose(fromSeed('bot' + i)); if (r.warnings.length) bad++; } catch { bad++; } }
  ok(bad === 0, '300 random seeds compose without errors/warnings');
  const accents = new Set(Array.from({ length: 200 }, (_, i) => fromSeed('x' + i).accent));
  ok(accents.size >= 6, `seeds spread over accents (${[...accents].join(',')})`);
}

// curated seeding (curator): allow-listed parts only, full app moods, no banned pairs, clean composes
{
  const { SEED_RULES, APP_MOODS } = await import('./robot.mjs');
  const { walletSeeds } = await import('./wallets.mjs');
  const missing = Object.entries(SEED_RULES.allow).flatMap(([slot, a]) => Object.keys(a).filter((n) => !PARTS[slot][n]).map((n) => `${slot}:${n}`));
  ok(missing.length === 0, `seed allow-lists name existing parts ${missing.join(' ')}`);
  const moodless = Object.keys(SEED_RULES.allow.eyes).filter((n) => APP_MOODS.some((m) => !PARTS.eyes[n]?.moods?.[m]));
  ok(moodless.length === 0, `every seedable eye part has ${APP_MOODS.join('/')} ${moodless.join(' ')}`);
  const wallets = walletSeeds(300, 'test');
  ok(wallets.every((w) => /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(w)), 'fake wallets look like base58 Solana addresses');
  let outside = 0, banned = 0, bad = 0;
  for (const w of wallets) {
    const s = fromSeed(w);
    for (const [slot, a] of Object.entries(SEED_RULES.allow)) for (const n of s[slot]) if (!(n in a)) outside++;
    const have = new Set(Object.keys(SEED_RULES.allow).flatMap((sl) => s[sl].flatMap((n) => [`${sl}:${n}`, `${sl}:*`])));
    for (const n of [`accent:${s.accent}`, `eye:${s.eyeColor}`, ...(s.eyeColor === s.accent ? ['eye:accent'] : [])]) have.add(n);
    for (const tags of SEED_RULES.banned) if (tags.every((t) => have.has(t))) banned++;
    for (const m of APP_MOODS) { try { if (compose({ ...s, mood: m }).warnings.length) bad++; } catch { bad++; } }
  }
  ok(outside === 0 && banned === 0, `300 wallet seeds stay inside the allow-lists (outside ${outside}) and banned pairs (${banned})`);
  ok(bad === 0, `300 wallet seeds × ${APP_MOODS.length} app moods compose without warnings (${bad})`);
}

// curated cast (robots.mjs): covers every head, body, accent and seedable top; mood set robots have all app moods
{
  const { default: cast } = await import('./robots.mjs');
  const { SEED_RULES, APP_MOODS, moodsFor } = await import('./robot.mjs');
  const { ACCENT_NAMES } = await import('./palette.mjs');
  const used = (slot) => new Set(cast.flatMap((r) => [].concat(r[slot] ?? [])));
  const gap = [
    ...Object.keys(PARTS.head).filter((n) => !used('head').has(n)).map((n) => 'head:' + n),
    ...Object.keys(PARTS.body).filter((n) => !used('body').has(n)).map((n) => 'body:' + n),
    ...Object.keys(SEED_RULES.allow.top).filter((n) => !used('top').has(n)).map((n) => 'top:' + n),
    ...ACCENT_NAMES.filter((a) => !cast.some((r) => r.accent === a)).map((a) => 'accent:' + a),
  ];
  ok(gap.length === 0, `curated cast covers every head, body, seedable top and accent ${gap.join(' ')}`);
  const heroes = cast.filter((r) => r.group === 'heroes');
  ok(heroes.length >= 24, `${heroes.length} named heroes`);
  let warn = 0;
  for (const r of cast) { const { name, group, about, moodSet, ...spec } = r; if (compose(spec).warnings.length) warn++; }
  ok(warn === 0, 'curated robots compose without warnings');
  const short = cast.filter((r) => r.moodSet).filter((r) => { const { name, group, about, moodSet, ...spec } = r; return APP_MOODS.some((m) => !moodsFor(spec).includes(m)); });
  ok(cast.filter((r) => r.moodSet).length >= 6 && short.length === 0, `mood-set robots offer ${APP_MOODS.join('/')}`);
}

// pixel QA (polisher): no 2×2 outline blocks, nothing on the canvas border ring, no orphan pixels — for every curated
// robot in every mood it offers (+ the wave frame), and for 300 wallet seeds in every app mood (fromSeed's QA gate)
{
  const { default: cast } = await import('./robots.mjs');
  const { APP_MOODS, moodsFor, passesQA } = await import('./robot.mjs');
  const { defects } = await import('./sprite.mjs');
  const { walletSeeds } = await import('./wallets.mjs');
  const { SCREEN, hexToRgba } = await import('./palette.mjs');
  const bad = [];
  let noGloss = 0;
  const G = hexToRgba(SCREEN.gloss);
  for (const r of cast) {
    const { name, group, about, moodSet, ...spec } = r;
    for (const m of new Set([...moodsFor(spec), ...APP_MOODS])) {
      const d = defects(compose({ ...spec, mood: m }).rgba);
      if (d.length) bad.push(`${name}:${m} ${d.join(' ')}`);
    }
    const px = compose(spec).rgba;
    let g = 0;
    for (let i = 0; i < W * H; i++) if (px[i * 4] === G[0] && px[i * 4 + 1] === G[1] && px[i * 4 + 2] === G[2]) g++;
    if (g < 2) noGloss++;
  }
  ok(bad.length === 0, `curated robots: no doubled outlines, edge or orphan pixels in any mood ${bad.slice(0, 3).join(' | ')}`);
  ok(noGloss === 0, `every curated screen keeps its top-left gloss streak (${noGloss} without)`);
  const seeds = walletSeeds(300, 'polish');
  const failing = seeds.filter((w) => !passesQA(fromSeed(w)));
  ok(failing.length === 0, `300 wallet seeds pass the pixel QA gate in every app mood (${failing.length} fail)`);
}

// gallery references exist
if (existsSync(join(HERE, 'gallery.html'))) {
  const html = readFileSync(join(HERE, 'gallery.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src="|url\(')([^"']+)/g)].map((m) => m[1]);
  const missing = refs.filter((r) => !existsSync(join(HERE, r)));
  ok(refs.length > 0 && missing.length === 0, `gallery.html: ${refs.length} refs, missing ${missing.length} ${missing.slice(0, 3).join(' ')}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
