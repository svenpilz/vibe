# vibe heightfield — 3D OpenStreetMap POC (S Friedenau, Berlin)

A **3D OpenStreetMap visualization** as a static web app (GitHub Pages), branch `heightfield`.
It renders a **2 km radius around S-Bahnhof Friedenau in Berlin** in 3D: buildings with real
heights, multi-level roads (bridges, tunnels, ramps), real terrain elevation — and a small car
you can drive on the road network, including **under bridges**.

Live demo (deployed from this branch): https://svenpilz.github.io/vibe/vibe-heightfield/

The 2D micromapping visualizer lives on `main` (https://svenpilz.github.io/vibe/).

## Controls

| Input | Action |
|---|---|
| left-drag | pan in the ground plane (never changes height; leaves chase cam) |
| wheel / middle-drag | zoom towards the mouse cursor |
| right-drag | orbit around the screen center (the current target) |
| `W A S D` or arrow keys | drive the car (accelerate / steer / brake-reverse) |
| `C` | toggle chase cam (camera follows the car) |
| `V` | first-person driver view (camera aligned with the car's driving direction) |
| `H` | cycle terrain source (DGM1-cleaned DOM1 / raw DGM1 / raw DOM1) |
| `T` | terrain-only mode: show just the terrain surface (e.g. only the cleaned DOM values), OSM overlays hidden |
| `R` | reset the car to its spawn point |

A north-up minimap (bottom-right) shows a 500 m radius around the car with roads, buildings,
the car marker and the camera view direction.

The car drives on the road network (elevation-aware snapping, so it can pass **under bridges**,
and on a `layer=1` deck it drives 5 m above the road below) and can also go **off-road** — it then
follows the bare-earth DGM1 terrain with extra drag. Buildings block the car.

## Real heights — three combined sources

| What | Source | How |
|---|---|---|
| Terrain (absolute elevation) | **Berlin ATKIS DGM1 + DOM1** — official 1 m LiDAR models (DHHN2016, UTM33N xyz tiles via `gdi.berlin.de/data/dgm1/atom` and `/data/dom/atom`, DL-DE-Zero) | baked into 440×440 grids (10 m cells). Default view uses the **DOM1 surface cleaned by the DGM1** (objects > 1.5 m outside building footprints — trees, signs, cars — are filtered out); `H` switches to raw DGM1 or raw DOM1. SRTM only as last-resort pipeline fallback |
| Building heights | OSM `height=*` (216 buildings), else `building:levels`/`roof:levels` × 3 m + roof allowance (8 272 buildings), else 10 m default | `buildingHeightM` in `src3d/schema.ts` |
| Road vertical stacking | OSM `layer=*` (+ `bridge=yes`/`tunnel=yes` implying ±1) | deck = terrain + layer × 5 m with 60 m ramps where a road meets a higher layer (connecting roads visibly climb to bridge decks); decks get parapets + piers and render 0.12 m above landuse ground so terrain never covers roads |

Data is extracted from the **Geofabrik Berlin `.osm.pbf`** (100 MB, parsed with the repo's own
PBF parser `src/osm-pbf.ts`) and baked into `public/data/friedenau-2km.json` (~9 MB, plus a
precompressed `.json.gz` that GitHub Pages serves with `Content-Encoding: gzip`).

## Rebuilding the data

```bash
npm install
npm run build:data   # downloads + parses the Berlin PBF, fetches SRTM tiles, writes public/data/
```

Raw downloads are cached in `.vibe/cache/` (gitignored).

## Develop / build / test

```bash
npm run dev      # vite dev server, open the printed URL
npm run build    # tsc + vite build -> dist/ (static, Pages-ready)
npm test         # all regression tests incl. the heightfield suites
```

## Architecture

- `scripts/build-friedenau-data.ts` — data pipeline (PBF extract + DEM sampling + compact JSON).
- `scripts/png.ts` — dependency-free PNG decoder for the terrarium tiles.
- `src3d/geo.ts` — local equirectangular projection around S Friedenau (pure, shared).
- `src3d/schema.ts` — baked-data schema + all derived values (heights, layers, widths, colors).
- `src3d/mesh.ts` — pure geometry builders (terrain heightfield, road ribbons + parapets,
  extruded buildings, ground polygons, road spatial index). No three.js import → unit-testable.
- `src3d/main.ts` — three.js scene, OrbitControls, car physics + road constraint, HUD.
- `tests/heightfield-*.ts` — unit tests for the above plus dataset integrity checks.

## Screenshots (headless-rendered verification)

| Overview — roads as gray strips on the terrain, extruded buildings | Under a bridge — elevated deck with piers over the lower road | Top-down city center |
|---|---|---|
| ![overview](examples/heightfield-overview.png) | ![under bridge](examples/heightfield-underbridge.png) | ![top-down](examples/heightfield-topdown.png) |

Known POC limitations: building multipolygon relations (courtyards) are not assembled, roofs are
flat, tunnels are occluded by the terrain surface when viewed from above.
