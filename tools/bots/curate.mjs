#!/usr/bin/env node
// curate.mjs — curator review sheets (writes only to out-curator/).
//   node curate.mjs robots [names,..] [--scale 4] [--cols 8] [--bg white|dark|grey] [--mood m] [--file x.png]
//   node curate.mjs seeds [N] [--scale 3] [--cols 8]           N wallet seeds as a grid (+ prints specs)
//   node curate.mjs specs '<json array of specs>' [--scale 6]
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose, fromSeed } from './robot.mjs';
import { loadRobots, resolveSpec } from './render.mjs';
import { writePNG, blitOver, fillRect } from './png.mjs';
import { W, H } from './sprite.mjs';
import { walletSeeds } from './wallets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const BG = { white: [255, 255, 255], dark: [14, 17, 23], grey: [243, 245, 248], mint: [233, 250, 246] };

function grid(frames, { scale = 4, cols = 8, bg = 'white', file }) {
  const P = 6, cell = W * scale + P;
  const rows = Math.ceil(frames.length / cols);
  const Wd = P + cols * cell, Hd = P + rows * cell;
  const img = new Uint8ClampedArray(Wd * Hd * 4);
  fillRect(img, Wd, 0, 0, Wd, Hd, [205, 211, 220]);
  frames.forEach((f, k) => {
    const x = P + (k % cols) * cell, y = P + Math.floor(k / cols) * cell;
    fillRect(img, Wd, x, y, W * scale, H * scale, BG[f.bg ?? bg]);
    blitOver(img, Wd, f.rgba, W, H, x, y, scale);
  });
  writePNG(join(HERE, 'out-curator', file), img, Wd, Hd, 1);
  console.log('→ out-curator/' + file);
}

const cmd = argv[0];
const scale = +opt('--scale', 4), cols = +opt('--cols', 8), bg = opt('--bg', 'white');
if (cmd === 'robots') {
  const all = await loadRobots();
  const names = argv[1] && !argv[1].startsWith('--') ? argv[1].split(',') : null;
  const list = names ? names.map((n) => all.find((r) => r.name === n) ?? (() => { throw new Error('no robot ' + n); })()) : all;
  const moods = opt('--mood', 'idle').split(',');
  const frames = [];
  for (const def of list) for (const m of moods) {
    const r = compose({ ...resolveSpec(def), mood: m });
    if (r.warnings.length) console.log(def.name, m, r.warnings);
    frames.push({ rgba: r.rgba });
  }
  list.forEach((d, i) => console.log(String(i).padStart(2), d.name));
  grid(frames, { scale, cols: names ? Math.min(cols, frames.length) : cols, bg, file: opt('--file', 'robots.png') });
} else if (cmd === 'seeds') {
  const n = +(argv[1] && !argv[1].startsWith('--') ? argv[1] : 48);
  const seeds = walletSeeds(n, opt('--salt', 'copyfomo'));
  const frames = [];
  const tally = {};
  seeds.forEach((s, i) => {
    const spec = fromSeed(s);
    const r = compose(spec);
    if (r.warnings.length) console.log(i, s, r.warnings);
    frames.push({ rgba: r.rgba });
    for (const k of ['head', 'face', 'eyes', 'top', 'body', 'arms', 'front', 'fx']) for (const v of spec[k]) tally[k + ':' + v] = (tally[k + ':' + v] ?? 0) + 1;
    if (argv.includes('--v')) console.log(String(i).padStart(2), s.slice(0, 6), ['head', 'face', 'eyes', 'top', 'body', 'arms', 'front', 'fx'].map((k) => spec[k].join('+') || '-').join(' '), spec.accent + '/' + spec.eyeColor);
  });
  if (argv.includes('--tally')) console.log(Object.entries(tally).sort().map(([k, v]) => `${k}=${v}`).join('  '));
  grid(frames, { scale, cols, bg, file: opt('--file', 'seeds.png') });
} else if (cmd === 'specs') {
  const specs = JSON.parse(argv[1]);
  const frames = specs.map((s) => { const r = compose(s); if (r.warnings.length) console.log(r.warnings); return { rgba: r.rgba }; });
  grid(frames, { scale, cols: Math.min(cols, frames.length), bg, file: opt('--file', 'specs.png') });
} else {
  console.log('usage: node curate.mjs robots|seeds|specs ...');
}
