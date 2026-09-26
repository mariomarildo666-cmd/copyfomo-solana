#!/usr/bin/env node
// lint.mjs — pixel-art QA for the copyfomo bots (polisher).
//   node lint.mjs                      lint every curated robot (all app moods) + N wallet seeds; exit 1 on errors
//   node lint.mjs --seeds 300          more seeds
//   node lint.mjs --dump minty[,byte]  named-colour ASCII of robots (--mood m) ; --dump seed:<i> for wallet seed i
//   node lint.mjs --spec '{"head":"tv",…}'  named-colour ASCII of one compose spec
// Checks (1× pixels, sprite.mjs defects()): clump = 2×2 block of outline (doubled outline / tangent), edge = a pixel on
// the canvas border ring (keep a 1-px margin), orphan = opaque pixel with no opaque 8-neighbour (dust).
import { compose, fromSeed, APP_MOODS } from './robot.mjs';
import { loadRobots, resolveSpec } from './render.mjs';
import { walletSeeds } from './wallets.mjs';
import { W, H, defects } from './sprite.mjs';
import { OUTLINE, LINE_SOFT, PEARL, SCREEN, rgbaToHex, ACCENTS } from './palette.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const NAMES = new Map([
  [OUTLINE, '#'], [LINE_SOFT, '%'], [PEARL.hi, 'W'], [PEARL.base, 'o'], [PEARL.shade, 's'], [PEARL.deep, 'd'],
  [SCREEN.base, '_'], [SCREEN.gloss, 'g'],
]);
const hexAt = (rgba, x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  const p = (y * W + x) * 4;
  return rgba[p + 3] ? rgbaToHex([rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]]) : null;
};

export function dump(rgba) {
  const legend = new Map(), pool = 'ABCDEFGHIJKLMNOPQRSTUVXYZabcefhijklmnpqrtuvwxyz0123456789'.split('');
  const out = ['   ' + Array.from({ length: W }, (_, i) => i % 10).join('')];
  for (let y = 0; y < H; y++) {
    let r = '';
    for (let x = 0; x < W; x++) {
      const h = hexAt(rgba, x, y);
      if (!h) { r += '.'; continue; }
      if (h.length > 7) { r += ','; continue; }
      let c = NAMES.get(h);
      if (!c) { if (!legend.has(h)) legend.set(h, pool.shift()); c = legend.get(h); }
      r += c;
    }
    out.push(String(y).padStart(2) + ' ' + r);
  }
  out.push('# outline % soft W/o/s/d pearl _ screen g gloss , shadow  ' + [...legend].map(([h, c]) => `${c}=${h}${accentName(h)}`).join(' '));
  return out.join('\n');
}
function accentName(h) {
  for (const [n, r] of Object.entries(ACCENTS)) for (const t of ['hi', 'base', 'lo', 'deep', 'glow']) if (r[t] === h) return `(${n}.${t})`;
  return '';
}

/** same checks as the engine's fromSeed QA gate (sprite.mjs defects) */
export const lint = (rgba) => defects(rgba);

async function main() {
  const all = await loadRobots();
  const cast = all.filter((r) => !r.lab);
  if (opt('--dump') || opt('--spec')) {
    for (const n of opt('--spec') ? [opt('--spec')] : opt('--dump').split(',')) {
      let spec;
      if (n.startsWith('seed:')) spec = fromSeed(walletSeeds(+n.slice(5) + 1, 'copyfomo')[+n.slice(5)]);
      else if (n.startsWith('{')) spec = JSON.parse(n);
      else { const d = all.find((r) => r.name === n); if (!d) throw new Error('no robot ' + n); spec = resolveSpec(d); }
      const mood = opt('--mood') ?? spec.mood ?? 'idle';
      const r = compose({ ...spec, mood });
      console.log(`== ${n} (${mood})`);
      console.log(dump(r.rgba));
      const l = lint(r.rgba);
      if (l.length) console.log('lint:', l.join('  '));
      if (r.warnings.length) console.log('warnings:', r.warnings);
    }
    return;
  }
  let errors = 0;
  const report = (label, rgba) => {
    const l = lint(rgba);
    if (l.length) { errors += l.length; console.log(`${label.padEnd(22)} ${l.join('  ')}`); }
  };
  for (const def of cast) {
    const spec = resolveSpec(def);
    const moods = [...new Set([spec.mood ?? 'idle', ...APP_MOODS, 'wave'])];
    for (const m of moods) report(`${def.name}:${m}`, compose({ ...spec, mood: m }).rgba);
  }
  const n = +opt('--seeds', 48);
  walletSeeds(n, 'copyfomo').forEach((w, i) => {
    const s = fromSeed(w);
    for (const m of APP_MOODS) report(`seed-${String(i).padStart(2, '0')}:${m}`, compose({ ...s, mood: m }).rgba);
  });
  console.log(errors ? `\n${errors} lint issues` : '\nlint clean');
  process.exitCode = errors ? 1 : 0;
}
if (process.argv[1]?.endsWith("lint.mjs")) main();
