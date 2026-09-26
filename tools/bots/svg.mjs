// svg.mjs — pixel grid → crisp SVG. Same-colour runs per row become one <rect>;
// identical runs on consecutive rows are merged vertically into taller rects.
import { rgbaToHex } from './palette.mjs';

export function toSVG(rgba, w, h, { scale = 8, title = '' } = {}) {
  const open = new Map(); // key "x,len,color" → rect (still growing downward)
  const rects = [];
  for (let y = 0; y < h; y++) {
    const seen = new Set();
    let x = 0;
    while (x < w) {
      const p = (y * w + x) * 4;
      if (rgba[p + 3] === 0) { x++; continue; }
      const col = rgbaToHex([rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]]);
      let x2 = x + 1;
      while (x2 < w) {
        const q = (y * w + x2) * 4;
        if (rgba[q] !== rgba[p] || rgba[q + 1] !== rgba[p + 1] || rgba[q + 2] !== rgba[p + 2] || rgba[q + 3] !== rgba[p + 3]) break;
        x2++;
      }
      const key = `${x},${x2 - x},${col}`;
      const prev = open.get(key);
      if (prev && prev.y + prev.h === y) prev.h++;
      else { const r = { x, y, w: x2 - x, h: 1, col }; rects.push(r); open.set(key, r); }
      seen.add(key);
      x = x2;
    }
    for (const k of [...open.keys()]) if (!seen.has(k)) open.delete(k);
  }
  const body = rects.map((r) => {
    const hex = r.col.slice(0, 7);
    const a = r.col.length > 7 ? parseInt(r.col.slice(7), 16) / 255 : 1;
    return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${hex}"${a < 1 ? ` fill-opacity="${a.toFixed(3)}"` : ''}/>`;
  }).join('');
  const t = title ? `<title>${title.replace(/[<&>]/g, '')}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * scale}" height="${h * scale}" shape-rendering="crispEdges">${t}${body}</svg>\n`;
}
