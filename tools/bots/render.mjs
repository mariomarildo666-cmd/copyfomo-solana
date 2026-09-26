#!/usr/bin/env node
// render.mjs — node render.mjs [--only a,b] [--no-parts] [--no-lab] [--keep] [--out <dir>] [--seeds 48]
//              node render.mjs --ascii <robotName> [--mood blink]     (text dump of one robot)
//              node render.mjs --seed <string>                         (print fromSeed spec + text dump)
//
// CURATED robots (robots.mjs — the shipped cast):
//   out/png/<name>.png (32) · out/png@8x/<name>.png (256) · out/svg/<name>.svg
//   out/moods/<name>.png (strip of all moods) · out/anim/<name>.blink.png · out/anim/<name>.react.png (CSS steps() strips)
//   out/sheet.png + out/sheet.json (one row per curated robot, col 0 = idle; frames['<name>'] = its own mood)
//   out/moodset.png + out/moodset.json (robots with moodSet: idle blink happy buy sell sleep)
//   out/icons/<name>@{1,2,4,8,16}x.png + <name>-tile@…/-tile-dark@… (group 'icons': head-only app icons)
//   out/seeds.png + out/seeds.json + out/seeds/seed-NN.png (fromSeed over N fake Solana wallets, default 48)
//   out/preview.png (contact sheet: white | dark | moods) · out/parts/… · out/parts-preview.png · out/manifest.json
// LAB robots (robots/*.mjs — designer showcases) go to out/lab/{png,png@8x,svg,moods,anim} + out/lab/preview.png.
// gallery.html (root; or <dir>/gallery.html with --out) shows everything.
import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compose, fromSeed, moodsFor, normalizeSpec, PARTS, LOAD_ERRORS, LOAD_WARNINGS, ANIMS, APP_MOODS, DEFAULT_SPEC } from './robot.mjs';
import { SLOTS, W, H } from './sprite.mjs';
import { writePNG, blit, blitOver, fillRect } from './png.mjs';
import { toSVG } from './svg.mjs';
import { rgbaToHex, hexToRgba } from './palette.mjs';
import { walletSeeds } from './wallets.mjs';
import { gallery } from './gallery.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
// --out <dir>: write everything (incl. gallery.html) into another folder — use it when several people render at once
const OUT = opt('--out') ? resolve(opt('--out')) : join(HERE, 'out');
const GALLERY = opt('--out') ? join(OUT, 'gallery.html') : join(HERE, 'gallery.html');
const PFX = opt('--out') ? '' : 'out/'; // gallery-relative prefix of OUT

export const ICON_SCALES = [1, 2, 4, 8, 16];
export const ICON_TILES = { tile: '#dff7f2', 'tile-dark': '#0e1117' };
const SEED_SALT = 'copyfomo';

/** robots.mjs = curated (shipped); robots/*.mjs = lab (designer showcases, rendered into out/lab/) */
export async function loadRobots() {
  const list = [...(await import(pathToFileURL(join(HERE, 'robots.mjs')).href)).default].map((r) => ({ group: 'robots', ...r }));
  const d = join(HERE, 'robots');
  if (existsSync(d)) {
    for (const f of readdirSync(d).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort()) {
      const mod = await import(pathToFileURL(join(d, f)).href);
      list.push(...[].concat(mod.default ?? []).map((r) => ({ group: f.replace(/\.mjs$/, ''), ...r, lab: true })));
    }
  }
  return list;
}
/** robot list entry → compose spec (drops the list-only keys) */
export function resolveSpec(def) {
  const { name, group, seed, about, moodSet, lab, ...rest } = def;
  return seed != null ? fromSeed(seed, rest) : rest;
}
/** mood used for an animation frame: robots resting in another mood (e.g. asleep) keep it for idle/blink frames */
export function animMood(m, base = 'idle') {
  if (base === 'idle') return m;
  if (m === 'idle') return base;
  if (m === 'blink' && base === 'sleep') return 'sleep';
  return m;
}

function strip(frames) {
  const out = new Uint8ClampedArray(W * frames.length * H * 4);
  frames.forEach((f, k) => blit(out, W * frames.length, f, W, H, k * W, 0));
  return out;
}

export function ascii(rgba) {
  const keys = new Map(), chars = '.#abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const rows = [];
  for (let y = 0; y < H; y++) {
    let row = '';
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      if (!rgba[p + 3]) { row += ' .'; continue; }
      const hex = rgbaToHex([rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]]);
      if (!keys.has(hex)) keys.set(hex, chars[1 + keys.size] ?? '?');
      row += ' ' + keys.get(hex);
    }
    rows.push(String(y).padStart(2) + row);
  }
  const head = '   ' + Array.from({ length: W }, (_, x) => String(x % 10).padStart(2)).join('');
  return [head, ...rows, '', ...[...keys].map(([h, c]) => `${c} = ${h}`)].join('\n');
}

/** compose a robot in every mood it needs, with a per-mood cache */
function framer(spec) {
  const cache = new Map();
  return (m) => {
    if (!cache.has(m)) cache.set(m, compose({ ...spec, mood: m }));
    return cache.get(m);
  };
}

function renderRobot(def) {
  const spec = resolveSpec(def);
  const base = normalizeSpec(spec).mood ?? 'idle';
  const frame = framer(spec);
  const r = frame(base);
  const n = def.name, rel = def.lab ? 'lab/' : '', dir = join(OUT, rel);
  writePNG(join(dir, 'png', `${n}.png`), r.rgba, W, H, 1);
  writePNG(join(dir, 'png@8x', `${n}.png`), r.rgba, W, H, 8);
  mkdirSync(join(dir, 'svg'), { recursive: true });
  writeFileSync(join(dir, 'svg', `${n}.svg`), toSVG(r.rgba, W, H, { scale: 8, title: n }));
  const moods = moodsFor(spec);
  const moodFrames = moods.map((m) => frame(m).rgba);
  writePNG(join(dir, 'moods', `${n}.png`), strip(moodFrames), W * moods.length, H, 1);
  const anims = {};
  for (const [an, a] of Object.entries(ANIMS)) {
    // the react loop needs trading moods: skip it for robots whose eyes cannot show buy / sell
    if (a.frames.some((m) => !moods.includes(m) && m !== 'idle')) continue;
    const frames = a.frames.map((m) => frame(animMood(m, base)).rgba);
    writePNG(join(dir, 'anim', `${n}.${an}.png`), strip(frames), W * frames.length, H, 1);
    anims[an] = { file: `${PFX}${rel}anim/${n}.${an}.png`, frames: a.frames.length, ms: a.ms };
  }
  const warnings = [...new Set(moods.flatMap((m) => frame(m).warnings))];
  return {
    name: n, group: def.group ?? 'robots', lab: !!def.lab, about: def.about, moodSet: !!def.moodSet, seed: def.seed,
    spec: r.spec, mood: base, moods, anims, warnings, asym: r.asym, moodFrames, main: r.rgba, frame,
    files: { png: `${PFX}${rel}png/${n}.png`, png8: `${PFX}${rel}png@8x/${n}.png`, svg: `${PFX}${rel}svg/${n}.svg`, moods: `${PFX}${rel}moods/${n}.png` },
  };
}

async function main() {
  if (LOAD_ERRORS.length) { console.error('PART LOAD ERRORS:\n  ' + LOAD_ERRORS.join('\n  ')); }
  if (LOAD_WARNINGS.length) { console.error('part warnings:\n  ' + LOAD_WARNINGS.join('\n  ')); }
  const all = await loadRobots();
  if (opt('--seed') != null) {
    const spec = fromSeed(opt('--seed'));
    console.log(JSON.stringify(spec));
    console.log(ascii(compose(spec).rgba));
    return;
  }
  if (opt('--ascii')) {
    const def = all.find((r) => r.name === opt('--ascii'));
    if (!def) throw new Error(`no robot "${opt('--ascii')}"`);
    const spec = resolveSpec(def);
    const r = compose({ ...spec, mood: opt('--mood') ?? spec.mood ?? 'idle' });
    console.log(ascii(r.rgba));
    if (r.warnings.length) console.log('warnings:', r.warnings);
    return;
  }
  const only = opt('--only')?.split(',');
  let robots = only ? all.filter((r) => only.includes(r.name)) : all;
  if (flag('--no-lab')) robots = robots.filter((r) => !r.lab);
  const seen = new Set();
  for (const r of robots) { if (seen.has(r.name)) throw new Error(`duplicate robot name "${r.name}"`); seen.add(r.name); }
  if (!only && !flag('--keep')) {
    for (const d of ['png', 'png@8x', 'svg', 'moods', 'anim', 'parts', 'icons', 'seeds', 'lab']) rmSync(join(OUT, d), { recursive: true, force: true });
  }
  mkdirSync(OUT, { recursive: true });

  const results = [];
  for (const def of robots) {
    try { results.push(renderRobot(def)); } catch (e) {
      console.error(`✗ ${def.name}: ${e.message}`);
      results.push({ name: def.name, group: def.group, lab: !!def.lab, error: e.message });
    }
  }
  const ok = results.filter((r) => !r.error);
  const cast = ok.filter((r) => !r.lab), lab = ok.filter((r) => r.lab);

  // ---- sprite sheet (curated only): one row per robot, one column per mood (col 0 = idle)
  const cols = Math.max(1, ...cast.map((r) => r.moods.length));
  const frames = {};
  if (cast.length) {
    const sheet = new Uint8ClampedArray(cols * W * cast.length * H * 4);
    cast.forEach((r, row) => r.moodFrames.forEach((f, col) => {
      blit(sheet, cols * W, f, W, H, col * W, row * H);
      frames[`${r.name}:${r.moods[col]}`] = { x: col * W, y: row * H, w: W, h: H };
    }));
    cast.forEach((r) => { frames[r.name] = frames[`${r.name}:${r.mood}`] ?? frames[`${r.name}:idle`]; });
    writePNG(join(OUT, 'sheet.png'), sheet, cols * W, cast.length * H, 1);
  }
  writeFileSync(join(OUT, 'sheet.json'), JSON.stringify({ image: 'sheet.png', frameSize: W, columns: cols, rows: cast.length, frames }, null, 2));

  // ---- mood set (idle blink happy buy sell sleep) for the robots flagged moodSet
  const moodBots = cast.filter((r) => r.moodSet);
  const moodset = { image: 'moodset.png', frameSize: W, moods: APP_MOODS, robots: moodBots.map((r) => r.name), frames: {} };
  if (moodBots.length) {
    const img = new Uint8ClampedArray(APP_MOODS.length * W * moodBots.length * H * 4);
    moodBots.forEach((r, row) => APP_MOODS.forEach((m, col) => {
      blit(img, APP_MOODS.length * W, r.frame(m).rgba, W, H, col * W, row * H);
      moodset.frames[`${r.name}:${m}`] = { x: col * W, y: row * H, w: W, h: H };
    }));
    writePNG(join(OUT, 'moodset.png'), img, APP_MOODS.length * W, moodBots.length * H, 1);
  }
  writeFileSync(join(OUT, 'moodset.json'), JSON.stringify(moodset, null, 2));

  // ---- app icons (group 'icons'): transparent + opaque tiles, integer scales only
  const icons = cast.filter((r) => r.group === 'icons').map((r) => {
    const files = {};
    for (const k of ICON_SCALES) {
      writePNG(join(OUT, 'icons', `${r.name}@${k}x.png`), r.main, W, H, k);
      files[`${k}x`] = `${PFX}icons/${r.name}@${k}x.png`;
      for (const [tile, hex] of Object.entries(ICON_TILES)) {
        const img = new Uint8ClampedArray(W * H * 4);
        fillRect(img, W, 0, 0, W, H, hexToRgba(hex));
        blitOver(img, W, r.main, W, H, 0, 0, 1);
        writePNG(join(OUT, 'icons', `${r.name}-${tile}@${k}x.png`), img, W, H, k);
        files[`${tile}-${k}x`] = `${PFX}icons/${r.name}-${tile}@${k}x.png`;
      }
    }
    return { name: r.name, files };
  });

  // ---- seeds: fromSeed over N fake (random, base58) Solana wallets
  const nSeeds = flag('--no-seeds') ? 0 : +(opt('--seeds') ?? 48);
  const seeds = walletSeeds(nSeeds, SEED_SALT).map((address, i) => {
    const spec = fromSeed(address);
    const r = compose(spec);
    const file = `seeds/seed-${String(i).padStart(2, '0')}.png`;
    writePNG(join(OUT, file), r.rgba, W, H, 1);
    return { address, spec, file: PFX + file, warnings: r.warnings, rgba: r.rgba };
  });
  if (seeds.length) {
    writeSeedGrid(join(OUT, 'seeds.png'), seeds);
    writeFileSync(join(OUT, 'seeds.json'), JSON.stringify({ salt: SEED_SALT, note: 'random base58 strings, not real wallets; persist the spec, not the seed', seeds: seeds.map(({ rgba, file, ...s }) => ({ ...s, file: file.slice(PFX.length) })) }, null, 2));
  }

  // ---- parts catalogue: every part on the default robot (all its moods) + on every other head (idle)
  const parts = [];
  if (!flag('--no-parts')) {
    const heads = Object.keys(PARTS.head);
    for (const slot of SLOTS) for (const [name, p] of Object.entries(PARTS[slot])) {
      const base = { ...DEFAULT_SPEC, ...(p.preview ?? {}), [slot]: name };
      const moods = p.moods ? Object.keys(p.moods) : ['idle'];
      const variants = moods.map((m) => ({ label: m, spec: { ...base, mood: m } }));
      if (slot !== 'head' && !p.preview?.head) {
        for (const h of heads) if (h !== base.head) variants.push({ label: `on ${h}`, spec: { ...base, head: h } });
      }
      const files = [], warnings = [];
      for (const v of variants) {
        try {
          const r = compose(v.spec);
          const rel = `parts/${slot}--${name}--${v.label.replace(/\W+/g, '-')}.png`;
          writePNG(join(OUT, rel), r.rgba, W, H, 1);
          files.push({ mood: v.label, file: PFX + rel, rgba: r.rgba });
          warnings.push(...r.warnings);
        } catch (e) { warnings.push(`${v.label}: ${e.message}`); }
      }
      parts.push({ slot, name, src: p.src, moods, files, warnings: [...new Set(warnings)] });
    }
  }

  if (cast.length) writeContactSheet(join(OUT, 'preview.png'), cast);
  if (lab.length) writeContactSheet(join(OUT, 'lab', 'preview.png'), lab);
  if (parts.length) writePartsSheet(join(OUT, 'parts-preview.png'), parts);

  const strip0 = ({ moodFrames, main, frame, ...r }) => r;
  const manifest = {
    generated: new Date().toISOString(), frameSize: W,
    robots: results.filter((r) => !r.lab).map(strip0), lab: results.filter((r) => r.lab).map(strip0),
    moodset, icons, seeds: seeds.map(({ rgba, ...s }) => s),
    parts: parts.map(({ files, ...p }) => ({ ...p, files: files.map((f) => f.file) })), loadErrors: LOAD_ERRORS, loadWarnings: LOAD_WARNINGS,
  };
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(GALLERY, gallery({ PFX, results, cast, lab, parts, cols, moodset, moodBots, icons, seeds, loadErrors: LOAD_ERRORS }));

  for (const r of results) {
    if (r.error) continue;
    const w = r.warnings.length ? `  ⚠ ${r.warnings.join(' | ')}` : '';
    console.log(`${r.lab ? '·' : '✓'} ${r.name.padEnd(14)} ${summary(r.spec)}  asym=${r.asym}${w}`);
  }
  for (const s of seeds) if (s.warnings.length) console.log(`  seed ${s.address}: ⚠ ${s.warnings.join(' | ')}`);
  for (const p of parts) if (p.warnings.length) console.log(`  part ${p.slot}/${p.name}: ⚠ ${p.warnings.join(' | ')}`);
  console.log(`\n${cast.length} curated + ${lab.length} lab robots, ${moodBots.length} mood sets, ${icons.length} icons, ${seeds.length} seeds, ${parts.length} parts → ${OUT}\ngallery: ${GALLERY}`);
}

/** preview.png — per robot: [white card 1×/2×/4×] [dark 1×/2×/4×] [moods 2× on page grey]. Read it with any image viewer. */
function writeContactSheet(file, rows) {
  const P = 8, panel = P + 32 + P + 64 + P + 128 + P, maxMoods = Math.max(...rows.map((r) => r.moods.length));
  const wMoods = P + maxMoods * (64 + P), Wd = panel * 2 + wMoods, rowH = 128 + 2 * P, Hd = rows.length * rowH;
  const img = new Uint8ClampedArray(Wd * Hd * 4);
  rows.forEach((r, k) => {
    const y0 = k * rowH;
    fillRect(img, Wd, 0, y0, panel, rowH, [255, 255, 255]);
    fillRect(img, Wd, panel, y0, panel, rowH, [14, 17, 23]);
    fillRect(img, Wd, panel * 2, y0, wMoods, rowH, [243, 245, 248]);
    for (const px of [0, panel]) {
      let x = px + P;
      for (const n of [1, 2, 4]) { blitOver(img, Wd, r.main, W, H, x, y0 + P + 128 - 32 * n, n); x += 32 * n + P; }
    }
    r.moodFrames.forEach((f, j) => blitOver(img, Wd, f, W, H, panel * 2 + P + j * (64 + P), y0 + P + 64, 2));
    fillRect(img, Wd, 0, y0 + rowH - 1, Wd, 1, [220, 225, 232]);
  });
  writePNG(file, img, Wd, Hd, 1);
}
/** seeds.png — the wallet seeds 2× on white cards, 8 per row */
function writeSeedGrid(file, seeds) {
  const P = 8, S = 64, C = 8, R = Math.ceil(seeds.length / C);
  const Wd = P + C * (S + P), Hd = P + R * (S + P);
  const img = new Uint8ClampedArray(Wd * Hd * 4);
  fillRect(img, Wd, 0, 0, Wd, Hd, [243, 245, 248]);
  seeds.forEach((s, i) => {
    const x = P + (i % C) * (S + P), y = P + Math.floor(i / C) * (S + P);
    fillRect(img, Wd, x, y, S, S, [255, 255, 255]);
    blitOver(img, Wd, s.rgba, W, H, x, y, 2);
  });
  writePNG(file, img, Wd, Hd, 1);
}
/** out/parts-preview.png — every part (each mood) on the default robot, 2× on white, one row per slot. */
function writePartsSheet(file, parts) {
  const P = 8, cell = 64 + P, bySlot = SLOTS.map((s) => parts.filter((p) => p.slot === s)).filter((a) => a.length);
  const cols = Math.max(...bySlot.map((ps) => ps.reduce((t, p) => t + p.files.length, 0)));
  const Wd = P + cols * cell, Hd = P + bySlot.length * cell;
  const img = new Uint8ClampedArray(Wd * Hd * 4);
  fillRect(img, Wd, 0, 0, Wd, Hd, [255, 255, 255]);
  bySlot.forEach((ps, row) => {
    let c = 0;
    ps.forEach((p, pi) => {
      for (const f of p.files) {
        fillRect(img, Wd, P + c * cell, P + row * cell, 64, 64, pi % 2 ? [243, 245, 248] : [233, 250, 246]);
        blitOver(img, Wd, f.rgba, W, H, P + c * cell, P + row * cell, 2);
        c++;
      }
    });
  });
  writePNG(file, img, Wd, Hd, 1);
}

export function summary(s) {
  return SLOTS.filter((k) => k !== 'shadow' && s[k].length).map((k) => s[k].join('+')).join(' · ') + ` · ${s.accent}/${s.eyeColor}`;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
