// copyCrown.mjs — the crown of "The Copy" (curator). Same pixels as top 'crown' (tops.mjs), but the metal is the
// robot ACCENT and the jewels are gold: a copied crown. Paired with The Original (gold crown) it keeps the exact
// same silhouette. Weight 0: the app sets it explicitly on a copier of the ORIGINAL trader, seeds never roll it.
import { CROWN_ROWS, crownY } from './tops.mjs';

export default {
  name: 'copyCrown',
  slot: 'top',
  description: 'accent-coloured copy of the crown with gold jewels — for "The Copy" of an original trader',
  tags: ['hat', 'crown', 'copy'],
  weight: 0,
  preview: { accent: 'mint' },
  layers: (ctx) => {
    const m = ctx.accent === 'gold' ? 'mint' : ctx.accent; // a gold copy would just be the original
    return [{ paint: { x: 10, y: crownY(ctx), key: { Y: `${m}.hi`, y: `${m}.base`, u: `${m}.lo`, U: `${m}.deep`, J: 'gold.hi', j: 'gold.base', q: 'gold.lo' }, rows: CROWN_ROWS } }];
  },
};
