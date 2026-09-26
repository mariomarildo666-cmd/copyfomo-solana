// parts/_TEMPLATE.mjs — copy to parts/<slot>/<name>.mjs (files starting with "_" are ignored by the loader).
//
// A part file default-exports ONE part object (or an array of them). The folder must equal part.slot.
// Grid: 32×32, integer pixel coords, (0,0) top-left. Symmetry axis x = 15.5 (mirror: x → 31 - x).
// Draw FILLS only: a 1-px outline is added automatically OUTSIDE the silhouette, so keep fills inside x/y 2..29
// (the outline then stays off the border ring: every sprite keeps a 1-px empty margin; un-outlined fx may use 1..30).
// Light is top-left: materials shade themselves; never hand-shade with raw hex.
// Pixel QA: node lint.mjs (--dump <robot> / --spec <json> for an ASCII view) and node test.mjs must stay clean: no 2×2
// blocks of outline (let parts touch with ONE shared outline column, or keep a clear pixel between them), nothing on
// the canvas border ring, no stray pixels. Floating bits can use layer.place (see sprite.mjs) to find a free spot.
// fromSeed re-rolls any seeded robot that fails this QA, but curated robots must be clean by hand.
//
// Slots (z-order bottom → top): shadow, back, body, arms, head, face, eyes, top, front, fx
// Anchors (read them from ctx.a — never hard-code head/screen positions in non-head parts):
//   a.head {x,y,w,h}  a.face {x,y,w,h} (screen box)  a.eye {cx,cy} (LEFT eye centre)  a.top {y}  a.ear {x,y}
//   a.body {x,y,w,h}  a.hand {x,y} (left)  a.feet {y,h}  a.ground (row under the feet)
export default {
  name: 'example',          // unique within the slot, camelCase
  slot: 'top',              // must match the folder
  description: 'what it is',
  tags: [],                 // free-form, readable by other parts via ctx.hasTag()

  // optional: override anchors you OWN (heads own head/face/eye/top/ear; bodies own body/hand/feet)
  // anchors: { face: { x: 8, y: 9, w: 16, h: 9 } }      or  anchors: (a) => ({ ... })

  // optional behaviour defaults for all layers of this part
  // line: true | false | 'soft'   draw a 1-px line where this part overlaps/abuts LOWER parts (slot default)
  // takesLine: false              never receive lines from upper parts (thin stems, rods)
  // outline: false                not part of the silhouette → no auto outline (glints, sparkles)

  // optional seeding controls for fromSeed()
  // NOTE: seeds only ever pick parts listed in SEED_RULES.allow (robot.mjs). A new part stays out of seeds until the
  // curator adds it there (with a weight), so existing wallet robots never change when parts are added.
  weight: 1,                // 0 = never picked by seeds (hero-only parts); ignored for allow-listed slots
  // requires: { head: ['round'] },   // only combine with these
  // excludes: { top: ['antenna'] },  // never combine with these
  // preview: { head: 'round' },      // spec overrides used by the parts catalogue

  // layers: array, or (ctx) => array. Use `moods: { idle: layers, blink: layers, ... }` instead for expressions.
  layers: (ctx) => {
    const { y } = ctx.a.top;
    return [
      {
        slot: 'back',                 // optional per-layer slot override (e.g. stems/ears behind the head)
        material: 'body',             // 'body' | 'accent' | 'accent:<name>' | 'screen' | 'eye' | 'flat'
        mirror: true,                 // also draw the mirror image (x → 31 - x); lighting stays top-left
        shapes: [                     // union of shapes
          ['rect', 12, y - 3, 2, 3],                 // x, y, w, h
          // ['px', x, y] | ['px', [[x,y], ...]]
          // ['hline', x0, x1, y] | ['vline', x, y0, y1] | ['line', x0, y0, x1, y1]
          // ['roundedRect', x, y, w, h, r]           r: 0..8 → CORNERS table, or explicit cut profile [2,1]
          // ['ellipse', x, y, w, h]                  bbox ellipse, pixel-centre test (8×8 → rows 4,6,8,8,8,8,6,4)
          // ['poly', [[x,y], ...]]                    pixel-edge coords, even-odd, sampled at pixel centres
          // ['bits', x, y, ['.##.', '####']]          ASCII mask ('.' or ' ' = off)
        ],
        // cut: [ ...shapes ],        // subtracted after the union (mirrored too)
        // shade: { hi: 1, lo: 'auto', loR: 1, deep: 1, spec: 'auto' | false | [[dx,dy]] }   (body/accent)
        // color: 'accent.lo',        // for material 'flat' (any colour ref)
        // clip: 'head',              // only draw where these slot(s) already have opaque pixels
        // gloss: [{ d: 4, len: 3 }] | false      (screen)   core: false | [dx,dy]   glow: false | 8   (eye)
        // line / takesLine / outline — per-layer overrides of the part defaults above
      },
      {
        material: 'accent',
        shapes: [['ellipse', 10, y - 6, 4, 4]],
        mirror: true,
      },
      // paint layer: exact hand-placed pixels, no auto-shading. Keys map chars → colour refs.
      // { paint: { x: 26, y: 2, rows: ['.a.', 'aAa', '.a.'], key: { a: 'accent.base' } }, mirror: false }
      // default keys: o outline · O line.soft · W/w/s/d body hi/base/shade/deep · k/g screen/gloss
      //               A/a/q/Q accent hi/base/lo/deep · E/e/r/h eye hi/base/lo/glow · % shadow.inner · x clear
    ];
  },
};
