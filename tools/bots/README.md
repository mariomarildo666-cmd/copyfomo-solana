# tools/bots: the copyfomo robot generator

Plain Node ESM (`.mjs`, Node 22+). It has no npm dependencies: a small PNG encoder (`node:zlib` + CRC32) writes the images. The shipped output lives in `public/bots/`; see `public/bots/README.md` for file naming and how `fromSeed` works.

```sh
node tools/bots/test.mjs                                        # engine + pixel-QA + seed tests
node tools/bots/lint.mjs                                        # pixel QA: cast in every mood + 48 wallet seeds
node tools/bots/lint.mjs --dump minty --mood sleep              # named-colour ASCII of one robot
node tools/bots/render.mjs --out .bots-out --no-lab --no-parts  # render the cast (+ .bots-out/gallery.html)
node tools/bots/export.mjs public/bots --from .bots-out         # refresh public/bots
```

| file | role |
| --- | --- |
| `palette.mjs` | the only colour source: outline, pearl ramp, screen, accent ramps, eye ramps, steel |
| `sprite.mjs` | 32×32 layer engine: shapes, lighting from the top-left, auto outline, fx placement, pixel QA (`defects`) |
| `robot.mjs` | part registry, `compose(spec)`, `fromSeed(seed)` with `SEED_RULES` and the QA gate |
| `parts/<slot>/*.mjs` | the parts (copy `parts/_TEMPLATE.mjs` to add one) |
| `robots.mjs` | the shipped cast (24 heroes, the pair, 3 app icons); `robots/*.mjs` are designer lab lists |
| `render.mjs`, `gallery.mjs`, `export.mjs` | render every output + an HTML gallery, then package `public/bots` |
| `lint.mjs`, `test.mjs`, `curate.mjs` | QA, tests, review sheets (`out-curator/`) |
