# OSM Micromapping Visualizer

A TypeScript app that renders **any OpenStreetMap `.osm.pbf` extract** in the browser with a
focus on street-level micromapping: `area:highway` surfaces, footways and crossings with
real-world markings, kerbs, building outlines, grass areas and inferred lane markings.

**No data is bundled or built** — drag & drop a PBF at runtime and it renders. Works with any
Geofabrik extract (Berlin, Bavaria, Netherlands, …) or your own `.osm.pbf`.

Live demo: https://svenpilz.github.io/vibe/

## Usage

```bash
npm install
npm run dev      # open the printed URL
```

Then drag a `*-latest.osm.pbf` from [download.geofabrik.de](https://download.geofabrik.de/index.html)
onto the page. The file is parsed entirely in your browser — it is not uploaded anywhere.
Scroll to zoom, drag to pan, click any feature to inspect its tags (including a link to the
object on openstreetmap.org). The status bar shows the current zoom level and the deployed
git commit.

## Specification

### 1. Coordinate and scale handling

- Positions are stored as integers quantized to 1e-7 degrees (~1 cm); all geometry
  (containment, intersections, ray casts) operates on these integers.
- Rendering uses a Web Mercator projection on a `<canvas>` (no map library, no tiles).
- Meter-based sizes (crossing widths, lane widths, line widths, kerb radii) are converted to
  pixels with the local ground scale: `px/m = mercatorScale / (6 371 000 · cos(latitude))`.
  The latitude factor is essential — without it everything renders ~40 % too small at
  mid latitudes (e.g. Berlin).
- Conversions between quantized degrees and meters use
  `1e-7 deg latitude ≈ 1.1132 cm` and `1e-7 deg longitude ≈ 1.1132 cm · cos(latitude)`.

### 2. Extracted features

| Feature       | OSM source                                                                 | Notes |
|---------------|----------------------------------------------------------------------------|-------|
| Highway areas  | `area:highway=*` closed ways and `type=multipolygon` relations (holes supported) | `traffic_island` defaults to `surface=sett`; `junction=*` or `area:highway=junction` marks junction areas |
| Centerlines    | Non-closed ways of common highway types with `surface=*`, `width=*` or `lanes=*` | Includes major roads (motorway…tertiary + links) |
| Footways       | `highway=footway` or `footway=sidewalk` ways                              | |
| Crossings      | `footway=crossing` or `crossing=*` ways                                    | `crossing:markings=*`, falling back to `crossing=zebra → zebra` |
| Kerbs          | `barrier=kerb` or `kerb=*` nodes **and** ways                              | `kerb` type + `tactile_paving` |
| Buildings      | `building=*` closed ways and multipolygon relations                        | Outline only |
| Grass          | `landuse=grass` closed ways and multipolygon relations (holes supported)    | |
| Lane markings  | Derived from `lanes=*` centerlines (see §5)                                 | Not directly tagged |

All features carry their `layer=*` value (default 0, clamped to ±16) and, when tagged,
their `level=*` value.

### 3. Derived data

**Layer inheritance for points.** A kerb node without `layer=*` inherits the layer of its
parent way when it belongs to exactly one way, or when all its parent ways share the same
layer value. Conflicting parents leave the node at the default layer 0.

**Surface inheritance.** A highway area without `surface=*` takes the surface of a
centerline that (a) has a compatible highway type — equal, or the footway/sidewalk pair —
(b) lies **entirely** inside the area (every vertex, holes respected), and (c) is on the
same layer. A way that merely clips a polygon corner does not donate its surface.

**Centerline suppression.** A centerline is not drawn when a same-type, same-layer highway
area covers its midpoint: the area fill replaces the line.

### 4. Vertical ordering: layers and levels

- **Bird's eye** (default): all feature classes are drawn in **ascending layer order**,
  class by class within each layer (grass → areas → buildings → centerlines → lane
  markings → footways → crossings → kerb ways → kerb nodes). The highest layer always
  paints over lower ones, like looking down on stacked bridges/tunnels.
- **Explicit layer selection**: only features on the chosen layer are drawn.
- **Levels** filter like layers with a separate selector; features without a `level` tag
  stay visible regardless of the selected level.
- The layer and level selectors list only values present **in the current viewport** and
  rebuild on every pan/zoom; a selector hides itself when fewer than two values are in
  view, and a selection that leaves the viewport resets.

### 5. Lane markings

For a centerline with `lanes ≥ 2` that runs inside a non-junction highway area:

1. At the midpoint of its middle segment, two rays are cast **orthogonally** to the
   centerline (left and right along the segment normal) until they leave the area
   (coarse scan, then binary refinement). Each ray length is converted to meters
   (§1); the road width is `leftM + rightM`. This works even when the centerline is not
   the geometric center of the road.
2. **Parking lanes** (`parking:lane:left/right/both`, widths from the `:width` sub-tags;
   defaults 2.5 m parallel / 5 m perpendicular) consume space on the road but do not
   count as regular lanes: their width is subtracted virtually from the highway area on
   the respective side before the remaining width is divided among the traffic lanes.
   If nothing is left, no markings are drawn.
3. All traffic lanes split the remaining width equally:
   `laneW = (leftM + rightM − parking) / lanes`.
4. Lane boundaries are drawn as continuous offset curves of the centerline, using
   averaged vertex normals and **Chaikin corner-cutting** (two iterations), so the
   markings flow smoothly around corners instead of breaking at each vertex. They are
   laid out from the measured left traffic edge (lane 1) to the right edge (lane n),
   so markings stay inside the street polygon even for off-center centerlines.
5. Line style:
   - **Solid** only between opposite directions — the boundary between forward and
     backward lanes. Forward lanes = `lanes:forward` if tagged, else `lanes − lanes:backward`,
     else `ceil(lanes/2)` for bidirectional roads.
   - **Dashed** between lanes of the same direction.
   - **No solid line** on one-way roads (`oneway=yes`/`-1`, `junction=roundabout`/`circular`):
     all lanes run forward, so all boundaries are dashed.
6. Markings are clipped to the containing highway area and are skipped for junction
   areas. Markings adopt the area's layer (bird's-eye stacking, selector filtering).

### 6. Crossing markings

- The crossing renders as a dark band of the tagged `width`; default 3 m for zebra,
  1.5 m otherwise.
- `crossing:markings=zebra`: white bars perpendicular to the walking direction spanning
  the full band width.
- `crossing:markings=dash(es)`: two continuous dashed white lines along the left and
  right boundary of the footway, each 10 cm wide, offset to stay inside the band;
  50 cm dashes with 35 cm gaps.
- Other markings (line/dot/pictogram): a dashed line along the centerline.
- The band and markings are **clipped to the highway area containing the crossing's
  midpoint**, so they end flush at the street outline and never overlap sidewalks,
  kerbs or adjacent areas, regardless of street curvature.
- `surface:colour`/`colour` tags override the palette; crossings without markings render
  as a translucent gray band.

### 7. Rendering, colors and level of detail

- Surface palette: asphalt, concrete, sett, paving_stones, cobblestone, gravel, grass,
  compacted and more (legend on screen). `surface:colour`/`colour` overrides the palette
  when present and valid.
- Buildings: gray outlines. Grass: green fill. Kerbs: red raised, teal lowered, purple
  flush, yellow tactile paving. Areas fill with a same-color edge stroke so adjacent
  polygons read as one continuous surface.
- **Level of detail** (zoom thresholds, slippy-map zoom levels): highway areas always
  render; below zoom 14 only major-road areas (motorway, trunk, primary, secondary and
  their links) render. Grass, buildings, centerlines, footways, crossings and kerbs
  appear from zoom 20; lane markings from zoom 17.
- Every class has an on/off toggle with a live feature count. LOD culling applies to both
  drawing and click-picking.
- Spatial indexes (uniform grids over quantized coordinates) limit drawing and picking
  to the visible viewport.

### 8. Inspection

Click picks the nearest feature: point-in-polygon for areas, buildings, grass and lane
markings; segment-distance for lines; nearest node for kerbs. Bird's eye prefers the
locally highest layer. The info panel shows the feature's tags plus a link to the object
on openstreetmap.org (`way/`, `node/`, `relation/` derived from the feature id).

## Architecture

```
your .osm.pbf (drag & drop)
  └── src/osm-pbf.ts    streaming PBF parser (blob → primitive_block → dense nodes/ways/relations)
       └── src/extract.ts   feature extraction & derivation (runs in a web worker, src/worker.ts)
            └── main.ts          canvas renderer, selectors, picking
```

- Parsing and extraction run in a **web worker**; the main thread stays responsive. The
  zlib-compressed PBF blobs are inflated with the web-standard `DecompressionStream`.
- Feature geometry is quantized to 1e-7 degree integers end-to-end; typed-array stores
  hold node coordinates for large extracts.

## Deployment

`npm run build` produces a fully self-contained static site in `dist/` (no data):

```
dist/
├── index.html
└── assets/index-*.js + worker-*.js
```

The build injects the current git commit id, shown in the UI status bar. Deploy to any
static host — GitHub Pages workflow included (`.github/workflows/pages.yml`, just
`npm install && npm run build`, no PBF download in CI).

## Scripts

| command | description |
|---|---|
| `npm run dev`       | vite dev server |
| `npm run build`     | typecheck + production build to `dist/` |
| `npm test`          | PBF parser round-trip tests against a synthetic fixture |
| `npm run make-fixture` | regenerate `tests/fixtures/synthetic.osm.pbf` |

## Notes

- Large extracts (100 MB+) parse in a few seconds in the worker; a whole-country file may
  take longer and use significant memory (all nodes are retained in typed-array stores).
- Data © OpenStreetMap contributors, ODbL 1.0.
