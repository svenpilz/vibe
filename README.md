# Berlin Micromapping Visualizer

A TypeScript app that renders [Geofabrik's Berlin `osm.pbf`](https://download.geofabrik.de/europe/germany/berlin.html)
with a focus on **`area:highway` micromapping**: highway area polygons as outlines, surface details
(asphalt, sett, paving_stones …) inherited from the corresponding highway **centerlines**, plus
**footway/sidewalk** and **crossing** overlays (zebra / dash markings, width) and **kerb** nodes
(raised / lowered / flush, tactile paving).

## Quick start

```bash
npm install
npm run data     # downloads berlin-latest.osm.pbf (~100 MB) + extracts data/map.jsonl
npm run dev      # serves the app at http://localhost:5173
```

Then open the printed URL. Scroll to zoom, drag to pan, click any feature to inspect its tags.

To re-download a fresh extract: `FORCE=1 npm run download`.

## Pipeline

```
berlin-latest.osm.pbf
  └── src/osm-pbf.ts        streaming PBF parser (blob → primitiveblock → dense nodes/ways/relations)
       ├── scripts/download.ts    fetches the Geofabrik extract with Node fetch
       └── scripts/extract.ts     filters & assembles features → data/map.jsonl (+ .gz)
            ├── areas        area:highway closed ways + multipolygon relations (with holes)
            ├── centerlines  highway ways with surface=* / width=* (used for surface inheritance)
            ├── footways     highway=footway / footway=sidewalk lines (surface, width)
            ├── crossings    footway=crossing (crossing=*, crossing:markings=*, width)
            └── kerbs        barrier=kerb nodes (kerb=raised/lowered/flush, tactile_paving)
```

**Surface inheritance**: when an `area:highway` polygon has no `surface` tag but a highway
centerline with `surface=*` runs through it (midpoint point-in-polygon test against outer
rings minus holes), the centerline's surface is copied onto the area (~2,300 areas enriched in
the current Berlin extract).

### Extract stats (berlin-latest, 2026-10)

| feature     | count  |
|-------------|--------|
| areas       | 15,934 (incl. 146 multipolygons) |
| centerlines | 135,320 |
| footways    | 171,256 |
| crossings   | 41,504 |
| kerbs       | 50,016 |

Coordinates are quantized to 1e-7 degree units (~1 cm) and stored as integer pairs; the whole
dataset is ~107 MB JSONL, served gzipped (~21 MB).

## Rendering

- Web Mercator projection on a `<canvas>` (no map library, no tiles)
- grid spatial index per layer; only visible features are drawn
- **areas** filled by surface color (see legend), outlines at high zoom, holes via even-odd fill
- **centerlines** stroked in their surface color at `width` meters
- **footways** light lines scaled to tagged width
- **crossings**: `crossing:markings=zebra` renders perpendicular white bars, `dashes`/`dots` render
  dashed/dotted white lines over the crossing band
- **kerbs**: colored dots — red raised, teal lowered, purple flush, yellow = tactile_paving=yes
- click → nearest-feature pick (point-in-polygon for areas, segment distance for lines) and a
  tag inspector panel

## Static deployment

`npm run build` produces a fully self-contained static site in `dist/`:

```
dist/
├── index.html
├── assets/index-*.js
└── data/map.jsonl.gz     (the whole map dataset, ~21 MB)
```

Deploy it to any static host — no server-side code required:

```bash
npm run data && npm run build
npx serve dist                # or: python3 -m http.server -d dist
# or drop the dist/ folder onto GitHub Pages / Netlify / nginx
```

The loader resolves its data relative to `document.baseURI`, so the site works under any
base path, and it handles both serving modes: hosts that transparently decode `.gz`
(`Content-Encoding: gzip`) and hosts that serve it as a plain file (client-side
`DecompressionStream` fallback, then `map.jsonl` as last resort).

## Scripts

| command | description |
|---|---|
| `npm run download` | fetch berlin-latest.osm.pbf into `data/` |
| `npm run extract`  | parse PBF → `data/map.jsonl` (use `PBF=path` to override input) |
| `npm run data`      | download + extract |
| `npm run dev`       | vite dev server (serves `data/` too) |
| `npm run build`     | typecheck + production build to `dist/` |
| `npm test`          | PBF parser round-trip tests against a synthetic fixture |
| `npm run make-fixture` | regenerate `tests/fixtures/synthetic.osm.pbf` |

## Tests

`tests/make-fixture.ts` writes a small synthetic PBF (with dense nodes, tagged kerb nodes,
closed-way areas, a multipolygon relation with a hole, crossings) and `tests/run.ts` asserts
the parser decodes ids, delta-encoded refs, string-table tags, roles, and coordinates correctly.

## Notes

- `npm run extract` needs ~4.6 GB heap for the Berlin extract (`NODE_OPTIONS=--max-old-space-size=4600`).
- Crossing markings become visually distinct at high zoom (a 3 m crossing needs ~1.1e6 px/deg
  to span 30 px — normal wheel zoom reaches this).
- Data © OpenStreetMap contributors, ODbL 1.0 (via Geofabrik).
