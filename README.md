# OSM Micromapping Visualizer

A TypeScript app that renders **any OpenStreetMap `.osm.pbf` extract** in the browser with a
focus on **`area:highway` micromapping**: highway area polygons as continuous surfaces, surface
details (asphalt, sett, paving_stones …) inherited from highway **centerlines**, plus
**footway/sidewalk** and **crossing** overlays (zebra / dash markings, width) and **kerb**
nodes and ways (raised / lowered / flush, tactile paving).

**No data is bundled or built** — drag & drop a PBF at runtime and it renders. Works with any
Geofabrik extract (Berlin, Bavaria, Netherlands, …) or your own `.osm.pbf`.

Live demo: https://svenpilz.github.io/vibe/

## Usage

```bash
npm install
npm run dev      # open the printed URL
```

Then drag a `*-latest.osm.pbf` from [download.geofabrik.de](https://download.geofabrik.de/index.html)
onto the page (or click the drop zone to pick a file). The file is parsed entirely in your
browser — it is not uploaded anywhere. Progress is shown while parsing; when done, the view
auto-fits to the loaded region.

Scroll to zoom, drag to pan, click any feature to inspect its tags.

## Pipeline (all in-browser)

```
your .osm.pbf (drag & drop)
  └── src/osm-pbf.ts    streaming PBF parser (blob → primitiveblock → dense nodes/ways/relations)
       └── src/extract.ts  filters & assembles features
            ├── areas        area:highway closed ways + multipolygon relations (with holes)
            ├── centerlines  highway ways with surface=* / width=*
            ├── footways     highway=footway / footway=sidewalk lines (surface, width)
            ├── crossings    footway=crossing (crossing=*, crossing:markings=*, width)
            └── kerbs        barrier=kerb nodes AND ways (kerb=raised/lowered/flush, tactile_paving)
```

Everything runs in a **web worker** (`src/worker.ts`): the main thread stays responsive, and
the parsed features are transferred back as plain arrays. The zlib-compressed PBF blobs are
inflated with the web-standard `DecompressionStream`.

**Surface inheritance**: when an `area:highway` polygon has no `surface` tag but a highway
centerline with `surface=*` runs through it (midpoint point-in-polygon test against outer
rings minus holes), the centerline's surface is copied onto the area (~2,300 areas enriched
in the current Berlin extract).

### Berlin extract stats (berlin-latest, 2026-10)

| feature     | count  |
|-------------|--------|
| areas       | 15,934 (incl. 146 multipolygons) |
| centerlines | 135,320 |
| footways    | 171,256 |
| crossings   | 41,504 |
| kerbs       | 50,016 nodes + 24,028 ways |

## Rendering

- Web Mercator projection on a `<canvas>` (no map library, no tiles)
- grid spatial index per layer; only visible features are drawn
- **areas** filled by surface color (see legend); same-color edge stroke closes antialiasing
  seams so adjacent polygons read as one continuous surface
- **centerlines** stroked in their surface color at `width` meters
- **footways** light lines scaled to tagged width
- **crossings**: `crossing:markings=zebra` renders perpendicular white bars, `dashes`/`dots`
  render dashed/dotted white lines over the crossing band
- **kerbs**: colored dots (nodes) and lines (ways) — red raised, teal lowered, purple flush,
  yellow = tactile_paving=yes
- click → nearest-feature pick (point-in-polygon for areas, segment distance for lines) and a
  tag inspector panel

## Deployment

`npm run build` produces a fully self-contained static site in `dist/` (no data):

```
dist/
├── index.html
└── assets/index-*.js + worker-*.js
```

Deploy to any static host — GitHub Pages workflow included (`.github/workflows/pages.yml`,
just `npm install && npm run build`, no PBF download in CI).

## Scripts

| command | description |
|---|---|
| `npm run dev`       | vite dev server |
| `npm run build`     | typecheck + production build to `dist/` |
| `npm test`          | PBF parser round-trip tests against a synthetic fixture |
| `npm run make-fixture` | regenerate `tests/fixtures/synthetic.osm.pbf` |

## Tests

`tests/make-fixture.ts` writes a small synthetic PBF (with dense nodes, tagged kerb nodes,
closed-way areas, a multipolygon relation with a hole, crossings) and `tests/run.ts` asserts
the parser decodes ids, delta-encoded refs, string-table tags, roles, and coordinates correctly.

## Notes

- Large extracts (100 MB+) parse in a few seconds in the worker; a whole-country file may
  take longer and use significant memory (all nodes are retained in typed-array stores).
- Crossing markings become visually distinct at high zoom (a 3 m crossing needs ~1.1e6 px/deg
  to span 30 px — normal wheel zoom reaches this).
- Data © OpenStreetMap contributors, ODbL 1.0.
