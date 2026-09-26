// gallery.mjs — builds gallery.html for render.mjs (curator). Pure string templating, no dependencies.
// Sections: app mock · heroes · the pair · moods (live CSS demos) · app icons · seeds · sprite sheets · files · lab.
import { SLOTS, W } from './sprite.mjs';
import { ACCENTS } from './palette.mjs';
import { APP_MOODS, ANIMS, DEFAULT_SPEC } from './robot.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cap = (s) => s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const img = (src, px, alt = '') => `<img src="${src}" width="${px}" height="${px}" alt="${esc(alt)}" loading="lazy">`;
const specLine = (s) => SLOTS.filter((k) => k !== 'shadow' && s[k]?.length).map((k) => s[k].join('+')).join(' · ');

export function gallery({ PFX, cast, lab, parts, cols, moodBots, icons, seeds, loadErrors = [] }) {
  const heroes = cast.filter((r) => r.group === 'heroes');
  const others = cast.filter((r) => !['heroes', 'pair', 'icons'].includes(r.group));
  const by = Object.fromEntries(cast.map((r) => [r.name, r]));
  const png = (r, px) => img(px > 64 ? r.files.png8 : r.files.png, px, `${r.name} ${px}px`);
  const nMood = APP_MOODS.length, nRows = Math.max(1, moodBots.length);
  const rowOf = Object.fromEntries(moodBots.map((r, i) => [r.name, i]));
  const blinkN = ANIMS.blink.frames.length;
  const wallets = seeds.map((s) => s.address);
  const trader = (i) => (wallets.length ? short(wallets[i % wallets.length]) : 'trader');

  /** one frame of out/moodset.png at k× (a live sprite: --c column can be changed from JS) */
  const spr = (name, mood, k, extra = '') => rowOf[name] == null ? '' :
    `<span class="spr ${extra}" style="--k:${k};--r:${rowOf[name]};--c:${APP_MOODS.indexOf(mood)}" role="img" aria-label="${esc(name)} ${esc(mood)}"></span>`;
  const player = (r, anim, s) => {
    const a = r.anims[anim];
    return a ? `<span class="player" style="--n:${a.frames};--s:${s}px;--d:${a.ms}ms;background-image:url('${a.file}')" role="img" aria-label="${esc(r.name)} ${anim} loop"></span>` : '';
  };

  // ------------------------------------------------------------------ app mock
  const bannerBots = ['minty', 'kit', 'orbit'].map((n) => by[n]).filter(Boolean);
  const cardBots = ['the-copy', 'byte', 'kit', 'orbit', 'luna', 'rex'].map((n) => by[n]).filter(Boolean);
  const feed = [
    ['the-copy', 'buy', 'copied a <b class="up">BUY</b> · 2.4 SOL', '2m'],
    ['byte', 'happy', 'closed a trade <b class="up">+18.2%</b>', '9m'],
    ['kit', 'sell', 'copied a <b class="down">SELL</b> · 0.8 SOL', '14m'],
    ['orbit', 'sleep', 'paused · waiting for the next signal', '1h'],
    ['the-original', 'idle', 'opened a new position', '1h'],
  ].filter(([n]) => rowOf[n] != null);
  const appMock = `
<section class="app" aria-label="Robots in a copyfomo-style UI">
  <div class="banner">
    <div class="bots">${bannerBots.map((r) => png(r, 128)).join('')}</div>
    <div class="btxt"><p class="kicker">copyfomo agents</p><h2>Copy the best Solana traders</h2><p>Pick a top trader. Your robot copies every move.</p>
      <span class="cta">Create agent →</span></div>
  </div>
  <div class="app-grid">
    <div class="cards">${cardBots.map((r, i) => `
      <article class="acard">
        <div class="avatar">${png(r, 64)}</div>
        <div class="ameta"><b>${esc(cap(r.name))}</b><small>copying ${esc(trader(i + 3))}</small>
          <span class="stats"><span class="pnl ${i === 4 ? 'neg' : ''}">${i === 4 ? '−3.1%' : '+' + (6.4 + i * 4.3).toFixed(1) + '%'}</span><span class="muted">${12 + i * 7} trades</span></span></div>
      </article>`).join('')}
    </div>
    <aside class="feed"><h3>Live activity</h3>${feed.map(([n, m, t, ago]) => `
      <div class="frow">${spr(n, m, 1)}<span><b>${esc(cap(n))}</b> ${t}</span><small>${ago}</small></div>`).join('')}
      <p class="muted small">Avatars here are 32 px (1×) frames from <code>moodset.png</code>: the mood follows the trade.</p>
    </aside>
  </div>
</section>`;

  // ------------------------------------------------------------------ heroes
  const heroCard = (r) => `
  <article class="hero" id="bot-${esc(r.name)}">
    <div class="stage big">${png(r, 128)}</div>
    <div class="hmeta"><h3>${esc(cap(r.name))}</h3><p>${esc(r.about ?? '')}</p><code>${esc(specLine(r.spec))} · ${esc(r.spec.accent)}${r.mood !== 'idle' ? ` · mood ${esc(r.mood)}` : ''}</code></div>
    <div class="sizes"><span class="chip light">${png(r, 64)}${png(r, 32)}</span><span class="chip dark">${png(r, 64)}${png(r, 32)}</span></div>
    ${r.warnings.length ? `<p class="warn">⚠ ${esc(r.warnings.join(' | '))}</p>` : ''}
  </article>`;

  // ------------------------------------------------------------------ pair
  const [orig, copy] = [by['the-original'], by['the-copy']];
  const pairHtml = orig && copy ? `
<div class="pair">
  ${[orig, copy].map((r, i) => `
  <figure class="pside ${i ? 'copy' : 'orig'}">
    <div class="stage huge">${png(r, 256)}</div>
    <figcaption><b>${i ? 'The Copy' : 'The Original'}</b><span>${esc(r.about)}</span></figcaption>
    <div class="pmoods">${APP_MOODS.map((m) => `<span class="pm">${spr(r.name, m, 2)}<small>${m}</small></span>`).join('')}</div>
  </figure>${i ? '' : '<div class="parrow" aria-hidden="true"><span>copies</span><b class="h">→</b><b class="v">↓</b></div>'}`).join('')}
</div>` : '';

  // ------------------------------------------------------------------ moods
  const moodDemo = (r) => `
  <article class="md" data-bot="${esc(r.name)}">
    <header><h3>${esc(cap(r.name))}</h3><small class="muted">${esc(r.about ?? '')}</small></header>
    <div class="mdbody">
      <figure><div class="stage mstage">
        ${spr(r.name, 'idle', 4, 'md-main')}
        <span class="player md-blink" style="--n:${blinkN};--s:128px;--d:${ANIMS.blink.ms}ms;background-image:url('${r.anims.blink.file}')" role="img" aria-label="${esc(r.name)} idle blink"></span>
      </div><figcaption>pick a mood ↓</figcaption></figure>
      <figure><div class="stage mstage">${player(r, 'react', 128)}</div><figcaption>auto: react loop (${(ANIMS.react.ms / 1000).toFixed(1)} s, ${ANIMS.react.frames.length} steps)</figcaption></figure>
    </div>
    <div class="mbtns" role="group" aria-label="${esc(r.name)} mood">${APP_MOODS.map((m, c) => `<button type="button" data-c="${c}" data-m="${m}" aria-pressed="${m === 'idle'}">${spr(r.name, m, 1)}<span>${m}</span></button>`).join('')}</div>
  </article>`;

  // ------------------------------------------------------------------ icons
  const iconBlock = (ic) => {
    const r = by[ic.name];
    return `
  <article class="icon">
    <header><h3>${esc(cap(ic.name.replace(/^icon-/, '')))}</h3><small class="muted">${esc(r?.about ?? '')}</small></header>
    <div class="irow">
      <div class="stage iplain">${[32, 64, 128].map((px) => `<figure>${img(ic.files[`${px / 32}x`], px, `${ic.name} ${px}px`)}<figcaption>${px}</figcaption></figure>`).join('')}</div>
      <div class="itiles">
        <figure>${img(ic.files['tile-4x'], 128, `${ic.name} tile`)}<figcaption>tile · light</figcaption></figure>
        <figure>${img(ic.files['tile-dark-4x'], 128, `${ic.name} dark tile`)}<figcaption>tile · dark</figcaption></figure>
        <figure class="tab"><span class="tabbar">${img(ic.files['1x'], 32, 'favicon')}<span>copyfomo</span><span class="x">×</span></span><figcaption>favicon · 32 px</figcaption></figure>
      </div>
    </div>
  </article>`;
  };

  // ------------------------------------------------------------------ seeds
  const seedTile = (s) => `<figure class="seed"><div class="stage">${img(s.file, 64, 'robot for ' + s.address)}</div><figcaption><i style="background:${ACCENTS[s.spec.accent].base}"></i><code title="${esc(s.address)}">${esc(short(s.address))}</code></figcaption></figure>`;

  // ------------------------------------------------------------------ lab
  const labGroups = [...new Set(lab.map((r) => r.group))];
  const partCards = SLOTS.map((slot) => {
    const ps = parts.filter((p) => p.slot === slot);
    if (!ps.length) return '';
    return `<div class="slot"><h4>${slot} <small class="muted">${ps.length}</small></h4><div class="plist">${ps.map((p) => `<figure class="part"><div class="pimgs">${p.files.slice(0, 8).map((f) => `<img src="${f.file}" width="64" height="64" title="${esc(f.mood)}" alt="" loading="lazy">`).join('')}</div><figcaption><b>${esc(p.name)}</b> <span class="muted">${esc(p.src)}</span>${p.warnings.length ? `<br><span class="warn">⚠ ${esc(p.warnings.join(' | '))}</span>` : ''}</figcaption></figure>`).join('')}</div></div>`;
  }).join('');

  const sheetW = cols * W, sheetRows = cast.length;
  const firstHero = heroes[0]?.name ?? cast[0]?.name ?? 'minty';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>copyfomo bots</title>
${icons[0] ? `<link rel="icon" type="image/png" href="${icons[0].files['1x']}">` : ''}
<style>
:root{--page:#f3f5f8;--card:#fff;--ink:#1b1f2a;--muted:#6b7385;--line:#e4e8ef;--mint:#3ed6c5;--mint-ink:#0f7f74;--mint-tint:#e9faf7;
  --dk:#0e1117;--dk-2:#171b24;--stage:#f3f5f8;--up:#2f8f2a;--down:#c2336f;--r:16px}
body[data-stage=dark]{--stage:#0e1117}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
img,.player,.spr{image-rendering:pixelated;image-rendering:crisp-edges}
code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}
.muted{color:var(--muted)}.small{font-size:12px}
.top{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;padding:10px 16px;background:rgba(243,245,248,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;font-size:16px}.brand b{font-weight:700}
.top nav{display:flex;flex-wrap:wrap;gap:4px;flex:1}
.top nav a{color:var(--muted);text-decoration:none;padding:4px 10px;border-radius:999px}.top nav a:hover{background:#fff;color:var(--ink)}
.seg{display:inline-flex;background:#fff;border:1px solid var(--line);border-radius:999px;padding:2px}
.seg button{border:0;background:none;font:inherit;font-size:12px;padding:4px 12px;border-radius:999px;color:var(--muted);cursor:pointer}
.seg button[aria-pressed=true]{background:var(--ink);color:#fff}
main{max-width:1240px;margin:0 auto;padding:24px 16px 96px}
section{scroll-margin-top:64px}
.sh{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;margin:44px 0 14px}.sh h2{font-size:20px;margin:0}.sh p{margin:0;color:var(--muted)}
.card,.hero,.md,.icon,.pside,.acard,.feed,.slot,.sheetbox{background:var(--card);border:1px solid var(--line);border-radius:var(--r)}
.stage{background:var(--stage);border-radius:12px;display:flex;align-items:center;justify-content:center;transition:background .2s}
figure{margin:0}figcaption{font-size:11px;color:var(--muted);text-align:center;margin-top:6px}
.warn{color:#b4540a;font-size:12px;margin:6px 0 0}

/* app mock */
.banner{position:relative;display:flex;align-items:flex-end;gap:24px;flex-wrap:wrap;padding:20px 28px 0;border-radius:22px;overflow:hidden;
  background:linear-gradient(115deg,#3ed6c5 0%,#62e0d2 48%,#9aeee4 100%);color:#fff}
.banner .bots{display:flex;align-items:flex-end;margin-bottom:-6px}.banner .bots img{margin-right:-18px}
.btxt{flex:1;min-width:240px;padding:8px 0 28px}.btxt h2{font-size:28px;line-height:1.15;margin:2px 0 6px;font-weight:800;font-style:italic;letter-spacing:-.01em;text-shadow:0 1px 0 rgba(15,127,116,.25)}
.btxt p{margin:0;opacity:.95}.kicker{text-transform:uppercase;font-size:11px;letter-spacing:.12em;font-weight:700;opacity:.85}
.cta{display:inline-block;margin-top:14px;background:var(--ink);color:#fff;border-radius:999px;padding:8px 16px;font-weight:600;font-size:13px}
.app-grid{display:grid;grid-template-columns:1fr 340px;gap:16px;margin-top:16px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.acard{display:flex;gap:12px;align-items:center;padding:12px}
.avatar{width:72px;height:72px;border-radius:14px;background:var(--mint-tint);display:grid;place-items:center;flex:none}
.ameta{display:flex;flex-direction:column;min-width:0}.ameta small{color:var(--muted)}
.stats{display:flex;gap:8px;align-items:center;margin-top:4px;font-size:12px}
.pnl{font-weight:700;color:var(--mint-ink);background:var(--mint-tint);border-radius:999px;padding:1px 9px}.pnl.neg{color:var(--down);background:#fdebf3}
.feed{padding:14px 16px}.feed h3{margin:0 0 8px;font-size:14px}
.frow{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--line)}.frow span:not(.spr){flex:1;font-size:13px}.frow small{color:var(--muted)}
.up{color:var(--up)}.down{color:var(--down)}

/* sprites from moodset.png */
.spr{display:inline-block;flex:none;width:calc(32px * var(--k));height:calc(32px * var(--k));
  background:url('${PFX}moodset.png') no-repeat;background-size:calc(${nMood * 32}px * var(--k)) calc(${nRows * 32}px * var(--k));
  background-position:calc(var(--c) * -32px * var(--k)) calc(var(--r) * -32px * var(--k))}
.player{display:inline-block;width:var(--s);height:var(--s);background-repeat:no-repeat;background-size:calc(var(--s) * var(--n)) var(--s);animation:play var(--d) steps(var(--n)) infinite}
@keyframes play{from{background-position:0 0}to{background-position:calc(var(--s) * var(--n) * -1) 0}}

/* heroes */
.heroes{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.hero{padding:12px;display:flex;flex-direction:column;gap:10px}
.stage.big{height:156px}
.hmeta h3{margin:0;font-size:16px}.hmeta p{margin:2px 0 6px;color:var(--ink);font-size:13px}.hmeta code{display:block;font-size:11px;line-height:1.4}
.sizes{display:flex;gap:8px;margin-top:auto}
.chip{display:flex;align-items:flex-end;gap:8px;padding:6px 10px;border-radius:10px;flex:1;justify-content:center}.chip.light{background:#f3f5f8}.chip.dark{background:var(--dk)}

/* pair */
.pair{display:grid;grid-template-columns:1fr auto 1fr;gap:14px;align-items:center}
.pside{padding:14px;display:flex;flex-direction:column;gap:10px}
.pside.orig{border-color:#ffe08a;box-shadow:0 0 0 3px #fff7d6 inset}.pside.copy{border-color:#b2f5e8;box-shadow:0 0 0 3px var(--mint-tint) inset}
.stage.huge{height:280px}
.pside figcaption{text-align:left;font-size:13px;color:var(--ink)}.pside figcaption b{display:block;font-size:16px}.pside figcaption span{color:var(--muted)}
.pmoods{display:grid;grid-template-columns:repeat(6,1fr);gap:6px}.pm{display:flex;flex-direction:column;align-items:center;gap:2px}.pm small{font-size:11px;color:var(--muted)}
.parrow{font-size:28px;color:var(--mint-ink);display:flex;flex-direction:column;align-items:center;font-weight:700}.parrow span{font-size:11px;text-transform:uppercase;letter-spacing:.1em}.parrow .v{display:none}

/* moods */
.mds{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}
.md{padding:14px}.md header{display:flex;flex-wrap:wrap;gap:2px 10px;align-items:baseline;margin-bottom:10px}.md h3{margin:0;font-size:16px}
.mdbody{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.stage.mstage{height:150px;position:relative}
.md-blink{position:absolute;inset:0;margin:auto}.md.moody .md-blink{display:none}.md:not(.moody) .md-main{visibility:hidden}
.mbtns{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-top:10px}
.mbtns button{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 2px;border:1px solid var(--line);border-radius:10px;background:#fff;font:inherit;font-size:11px;color:var(--muted);cursor:pointer}
.mbtns button[aria-pressed=true]{border-color:var(--mint);background:var(--mint-tint);color:var(--mint-ink);font-weight:600}
.mbtns button:focus-visible,.seg button:focus-visible{outline:2px solid var(--mint-ink);outline-offset:2px}

/* icons */
.icons{display:grid;gap:14px}
.icon{padding:14px}.icon header{display:flex;gap:10px;align-items:baseline;margin-bottom:10px}.icon h3{margin:0;font-size:16px}
.irow{display:flex;flex-wrap:wrap;gap:14px;align-items:stretch}
.stage.iplain{gap:18px;padding:14px 20px;align-items:flex-end}
.itiles{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end}
.itiles img{border-radius:28px;box-shadow:0 1px 2px rgba(27,31,42,.08),0 6px 16px rgba(27,31,42,.08)}
.tabbar{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--line);border-radius:10px 10px 0 0;padding:6px 12px;min-width:200px}
.tabbar img{border-radius:0;box-shadow:none}.tabbar .x{margin-left:auto;color:var(--muted)}

/* seeds */
.seeds{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:10px}
.seed{background:#fff;border:1px solid var(--line);border-radius:12px;padding:8px}.seed .stage{height:76px}
.seed figcaption{display:flex;align-items:center;justify-content:center;gap:6px}.seed i{width:8px;height:8px;border-radius:50%;flex:none}

/* sheets + files */
.sheetbox{padding:14px;overflow:auto}
pre{background:#0e1117;color:#d5dde8;border-radius:12px;padding:14px;overflow:auto;font:12px/1.5 ui-monospace,Consolas,monospace}
.files{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px}
.files div{background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px 12px}.files code{color:var(--ink)}

/* lab */
details.lab{margin-top:44px;background:#fff;border:1px dashed #cdd4df;border-radius:var(--r);padding:12px 16px}
details.lab summary{cursor:pointer;font-weight:600}
.labgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin:8px 0 16px}
.labgrid figure{background:var(--page);border-radius:10px;padding:6px}.labgrid .stage{height:70px}
.slot{padding:10px 12px;margin-bottom:8px}.slot h4{margin:0 0 6px}
.plist{display:flex;flex-wrap:wrap;gap:12px}.part figcaption{text-align:left}.pimgs{display:flex;flex-wrap:wrap;gap:4px;max-width:560px}.pimgs img{background:var(--page);border-radius:8px}

@media (max-width:900px){.app-grid{grid-template-columns:1fr}.pair{grid-template-columns:1fr}.parrow .h{display:none}.parrow .v{display:inline}.mds{grid-template-columns:1fr}}
@media (max-width:640px){.top{position:static}.top nav{flex:1 1 100%;order:3;flex-wrap:nowrap;overflow-x:auto;margin:0 -4px}.top nav a{white-space:nowrap}.seg{margin-left:auto}}
@media (max-width:520px){.pmoods{grid-template-columns:repeat(3,1fr)}.mdbody{grid-template-columns:1fr}.mbtns{grid-template-columns:repeat(3,1fr)}.stage.huge{height:200px}.stage.huge img{width:192px;height:192px}.banner{padding:16px 16px 0}.banner .bots img{width:96px;height:96px}}
@media (prefers-reduced-motion:reduce){.player{animation:none}}
</style></head>
<body data-stage="light">
<header class="top">
  <div class="brand">${icons[0] ? img(icons[0].files['1x'], 32, 'copyfomo icon') : ''}<b>copyfomo</b><span class="muted">bots</span></div>
  <nav aria-label="Sections"><a href="#heroes">Heroes</a><a href="#pair">The pair</a><a href="#moods">Moods</a><a href="#icons">App icons</a><a href="#seeds">Seeds</a><a href="#sheets">Sprite sheets</a><a href="#files">Files</a><a href="#lab">Lab</a></nav>
  <div class="seg" role="group" aria-label="Preview background"><button type="button" data-stage-set="light" aria-pressed="true">Light</button><button type="button" data-stage-set="dark" aria-pressed="false">Dark</button></div>
</header>
<main>
${loadErrors.length ? `<p class="warn">Part load errors: ${esc(loadErrors.join(' | '))}</p>` : ''}
${appMock}

<section id="heroes"><div class="sh"><h2>Heroes</h2><p>${heroes.length} named robots · 32×32 native · shown at 128 / 64 / 32 px on light and dark</p></div>
<div class="heroes">${heroes.map(heroCard).join('')}</div></section>

<section id="pair"><div class="sh"><h2>The Original &amp; The Copy</h2><p>Same silhouette: gold crown + phone for the trader, minted crown + copy card for your agent</p></div>
${pairHtml}</section>

<section id="moods"><div class="sh"><h2>Moods</h2><p>${APP_MOODS.join(' · ')}. Frames come from <code>out/moodset.png</code>; the loop is a CSS <code>steps()</code> strip</p></div>
<div class="mds">${moodBots.map(moodDemo).join('')}</div></section>

<section id="icons"><div class="sh"><h2>App icons</h2><p>Head only, centred in 32×32. Integer scales up to 512 px in <code>out/icons/</code>, plus opaque tiles</p></div>
<div class="icons">${icons.map(iconBlock).join('')}</div></section>

<section id="seeds"><div class="sh"><h2>Seeded robots</h2><p><code>fromSeed(wallet)</code> over ${seeds.length} random base58 wallet strings (not real wallets). Curated allow-lists keep every combo clean</p></div>
<div class="seeds">${seeds.map(seedTile).join('')}</div></section>

<section id="sheets"><div class="sh"><h2>Sprite sheets</h2><p><code>sheet.png</code>: ${sheetRows} robots × ${cols} moods · <code>moodset.png</code>: ${moodBots.length} robots × ${nMood} app moods</p></div>
<div class="sheetbox"><img src="${PFX}moodset.png" width="${nMood * 32 * 3}" height="${nRows * 32 * 3}" alt="moodset sprite sheet at 3x"></div>
<pre>/* 64 px avatar from sheet.png (frames in sheet.json are 32 px; multiply by the scale) */
.bot { width: 64px; height: 64px; image-rendering: pixelated;
       background: url(sheet.png) no-repeat; background-size: ${sheetW * 2}px ${sheetRows * 64}px; }
.bot.${esc(firstHero)} { background-position: 0 0; }      /* sheet.json frames["${esc(firstHero)}"] = {x:0, y:0} */
/* mood: frames["${esc(firstHero)}:buy"] → background-position: -x*2px -y*2px */
/* blink: out/anim/&lt;name&gt;.blink.png, ${blinkN} frames → animation: play 1.6s steps(${blinkN}) infinite */</pre>
<div class="sheetbox"><img src="${PFX}sheet.png" width="${sheetW * 2}" height="${sheetRows * 64}" alt="full sprite sheet at 2x"></div>
</section>

<section id="files"><div class="sh"><h2>Files</h2><p>everything is generated by <code>node render.mjs</code></p></div>
<div class="files">
  <div><code>out/png/&lt;name&gt;.png</code><br><span class="muted">32×32 transparent, the native sprite</span></div>
  <div><code>out/png@8x/&lt;name&gt;.png</code><br><span class="muted">256×256 nearest-neighbour</span></div>
  <div><code>out/svg/&lt;name&gt;.svg</code><br><span class="muted">crisp vector, any size</span></div>
  <div><code>out/moods/&lt;name&gt;.png</code><br><span class="muted">every mood the robot has, one strip</span></div>
  <div><code>out/anim/&lt;name&gt;.blink.png · .react.png</code><br><span class="muted">CSS steps() strips (${blinkN} / ${ANIMS.react.frames.length} frames)</span></div>
  <div><code>out/sheet.png + sheet.json</code><br><span class="muted">all curated robots × moods</span></div>
  <div><code>out/moodset.png + moodset.json</code><br><span class="muted">${moodBots.length} robots × ${APP_MOODS.join('/')}</span></div>
  <div><code>out/icons/icon-*@{1,2,4,8,16}x.png</code><br><span class="muted">32 to 512 px, transparent + tile + dark tile</span></div>
  <div><code>out/seeds.json</code><br><span class="muted">wallet → spec for the seed grid</span></div>
</div></section>

<details class="lab" id="lab"><summary>Lab: ${lab.length} designer showcase robots and the parts catalogue (${parts.length} parts, default robot ${esc(Object.values(DEFAULT_SPEC).slice(0, 7).join(' · '))})</summary>
${labGroups.map((g) => `<h4>${esc(g)}</h4><div class="labgrid">${lab.filter((r) => r.group === g).map((r) => `<figure><div class="stage">${png(r, 64)}</div><figcaption>${esc(r.name)}</figcaption></figure>`).join('')}</div>`).join('')}
${others.length ? `<h4>other curated</h4><div class="labgrid">${others.map((r) => `<figure><div class="stage">${png(r, 64)}</div><figcaption>${esc(r.name)}</figcaption></figure>`).join('')}</div>` : ''}
${partCards}
</details>
</main>
<script>
document.querySelectorAll('[data-stage-set]').forEach((b) => b.addEventListener('click', () => {
  document.body.dataset.stage = b.dataset.stageSet;
  document.querySelectorAll('[data-stage-set]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}));
document.querySelectorAll('.md').forEach((md) => {
  const main = md.querySelector('.md-main');
  md.querySelectorAll('.mbtns button').forEach((b) => b.addEventListener('click', () => {
    main.style.setProperty('--c', b.dataset.c);
    md.classList.toggle('moody', b.dataset.m !== 'idle');
    md.querySelectorAll('.mbtns button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
});
</script>
</body></html>
`;
}
