import { buildIndex, queryIndex, type Indexed } from "./src/loader";
import type { ExtractResult } from "./src/extract";
import type {
  StopLineFeature,
  AreaFeature,
  BuildingFeature,
  GrassFeature,
  LineFeature,
  KerbFeature,
  KerbWayFeature,
  BollardFeature,
  FenceFeature,
  LanduseFeature,
  StreetLampFeature,
  ParkingFeature,
  ManholeFeature,
  Dataset,
  Feature,
  Q,
} from "./src/features";
import { surfaceColor, normalizeSurface } from "./src/features";
import { HeightField } from "./src/height";
import {
  GlMap,
  SceneGraph,
  R0,
  mercY,
  invMercY,
  parseColor,
  rgba,
  grassTileData,
  stoneTileData,
  initTriangulation,
  isTriangulationReady,
  type Pt,
  type RGBA,
  type FillSpec,
} from "./src/gl";
import triangleWasmUrl from "triangle-wasm/triangle.out.wasm?url";

// load the Triangle WASM module once; scene building waits for it (see draw())
const triReady = initTriangulation(triangleWasmUrl);

const canvas = document.getElementById("map") as HTMLCanvasElement;
let g: GlMap;
try {
  g = new GlMap(canvas);
} catch (err) {
  document.getElementById("status")!.textContent = String(err);
  throw err;
}
const statusEl = document.getElementById("status")!;
const infoEl = document.getElementById("info")!;

interface View {
  cx: number;
  cy: number;
  scale: number; // pixels per degree longitude
}

/** 3D camera orbit state (Google Earth style): heading + pitch in radians;
 *  pitch 0 looks straight down and reproduces the flat map exactly */
let cam = { heading: 0, pitch: 0 };

let view: View = { cx: 10.0, cy: 51.0, scale: 2000 };
let dataset: Dataset | null = null;
/** height model (DGM ground + DOM surface) for the bundled example */
let hf: HeightField | null = null;
/** bounds of the loaded dataset, quantized — the scene graph is built from
 *  the full dataset so per-frame frustum culling (not a viewport bbox)
 *  decides what is drawn */
let datasetBounds: [number, number, number, number] | null = null;
let areaIndex: Indexed<AreaFeature> | null = null;
let buildingIndex: Indexed<BuildingFeature> | null = null;
let grassIndex: Indexed<GrassFeature> | null = null;
let lineIndexes: {
  centerlines: Indexed<LineFeature>;
  footways: Indexed<LineFeature>;
  crossings: Indexed<LineFeature>;
} | null = null;
let kerbGrid: Map<number, KerbFeature[]> | null = null;
let kerbWayIndex: Indexed<KerbWayFeature> | null = null;
let fenceIndex: Indexed<FenceFeature> | null = null;
let bollardGrid: Map<number, BollardFeature[]> | null = null;
let landuseIndex: Indexed<LanduseFeature> | null = null;
let streetLampGrid: Map<number, StreetLampFeature[]> | null = null;
let parkingIndex: Indexed<ParkingFeature> | null = null;
let manholeGrid: Map<number, ManholeFeature[]> | null = null;
let laneMarkingIndex: Indexed<LineFeature> | null = null;

let stopLineIndex: Indexed<StopLineFeature> | null = null;

/** lane marking rendering mode: "spline" interpolates the offset
 *  samples (Chaikin-smoothed flowing curves), "linear" draws them
 *  piece-wise linear — the crisp extracted polyline connecting the
 *  sample points directly — and "samples" draws ONLY the middle line
 *  with its sample points marked, so the extracted sample grid is
 *  directly visible */
let laneSmoothness: "spline" | "linear" | "samples" = "spline";

const layers = {
  areas: true,
  buildings: true,
  grass: true,
  centerlines: false,
  laneMarkings: true,
  footways: false,
  crossings: true,
  kerbs: true,
  bollards: true,
  fences: true,
  landuse: true,
  streetLamps: true,
  parking: true,
  manholes: true,
};

/**
 * Level of detail: minimum pixels per meter at which a feature class is drawn.
 * Highway areas are the most interesting part and always render; everything
 * else fades out when its geometry would collapse below a few pixels and
 * only add visual noise. Thresholds chosen from typical OSM micromapping
 * dimensions (a kerb is ~10cm high, markings ~50cm wide, sidewalks ~2m).
 */
const LOD: Record<keyof typeof layers, number> = {
  areas: 0, // always
  grass: 20,
  buildings: 20,
  centerlines: 20,
  footways: 22,
  crossings: 20,
  kerbs: 20,
  laneMarkings: 17,
  bollards: 20,
  fences: 20,
  landuse: 14,
  streetLamps: 20,
  parking: 16,
  manholes: 21,
};

const MAJOR_ROADS = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
]);

function lodVisible(key: keyof typeof layers): boolean {
  if (!layers[key]) return false;
  if (LOD[key] === 0) return true;
  return zoomLevel() >= LOD[key];
}

/** below zoom 14 only major-road highway areas render */
function areaLodVisible(area: AreaFeature): boolean {
  if (!lodVisible("areas")) return false;
  const z = zoomLevel();
  if (z >= 14) return true;
  return MAJOR_ROADS.has(area.highway);
}

/** zoom level as shown in the status bar (slippy-map style) */
function zoomLevel(): number {
  return Math.log2(view.scale / 1200) * 2 + 11;
}

/**
 * OSM layer=* handling. Two modes:
 *  - bird's eye (selectedLayer === null, the default): no layer filter; each
 *    feature class is drawn in ascending layer order, so at any location the
 *    locally highest layer paints over lower ones and is the one you see —
 *    like looking down on overlapping bridges/tunnels.
 *  - explicit selection: only features on that exact layer are drawn.
 */
let osmLayers: number[] = [];
let selectedLayer: number | null = null;
let osmLevels: number[] = [];
let selectedLevel: number | null = null;

/** whether a feature is drawn at all under the current selection */
function layerVisible(f: { layer?: number; level?: number }): boolean {
  if (selectedLayer !== null && (f.layer ?? 0) !== selectedLayer) return false;
  if (
    selectedLevel !== null &&
    f.level !== undefined &&
    f.level !== selectedLevel
  )
    return false;
  return true;
}

/** sort key: bird's eye draws ascending layers first */
function layerSortKey(f: { layer?: number; level?: number }): number {
  return (f.layer ?? 0) * 100 + (f.level ?? 0);
}

// ---------------- projection ----------------
// World space: Web Mercator pixels at reference scale (R0 per radian of
// longitude), x east, y north. All geometry is built in these world units
// (z=0 plane); the WebGL camera maps world -> screen. At pitch 0 the mapping
// is exactly the old flat-canvas one: screen = (world - center) * scale/2000.
const Q = 1e7;
function lonToX(lonDeg: number): number {
  return (lonDeg * Math.PI * R0) / 180;
}
function latToY(latDeg: number): number {
  return mercY(latDeg) * R0;
}
function xToLon(x: number): number {
  return (x * 180) / (Math.PI * R0);
}
function yToLat(y: number): number {
  return invMercY(y / R0);
}
/** R: pixels per radian of longitude. Keeps x/y scales equal (no distortion). */
function R(): number {
  return view.scale * (180 / Math.PI);
}
/** world units per css pixel at the current zoom */
function pxToWorld(px: number): number {
  return px / (view.scale / 2000);
}
/**
 * World units per meter on the ground at the current view latitude. Mercator
 * stretches by 1/cos(lat): one radian of longitude spans 6_371_000 * cos(lat)
 * meters on the ground, so the equator-only formula underestimates by ~40%
 * at mid latitudes (e.g. Berlin) and lane/crossing sizes look too small.
 */
function pxPerMeter(): number {
  return R0 / (6_371_000 * Math.cos((view.cy * Math.PI) / 180));
}
function viewBboxQ(): [number, number, number, number] {
  const degPerPx = 180 / (Math.PI * R());
  const halfW = (canvas.clientWidth / 2) * degPerPx;
  const halfH =
    (canvas.clientHeight / 2) * degPerPx * Math.cos((view.cy * Math.PI) / 180) * 1.1;
  return [
    Math.round((view.cx - halfW) * Q),
    Math.round((view.cy - halfH) * Q),
    Math.round((view.cx + halfW) * Q),
    Math.round((view.cy + halfH) * Q),
  ];
}

// ---------------- rendering ----------------
/** quantized ring -> world points */
function ringPts(ring: Q[][]): Pt[] {
  return ring.map(([x, y]) => [lonToX(x / Q), latToY(y / Q)] as Pt);
}
/** closed ring as a stroke path (first point appended) */
function closedRingPts(ring: Q[][]): Pt[] {
  const pts = ringPts(ring);
  if (pts.length > 0) pts.push(pts[0]);
  return pts;
}
function linePts(coords: Q[][]): Pt[] {
  if (coords.length < 2) return coords.map(([x, y]) => [lonToX(x / Q), latToY(y / Q)] as Pt);
  const minStep = pxToWorld(2);
  const out: Pt[] = [[lonToX(coords[0][0] / Q), latToY(coords[0][1] / Q)]];
  let lastX = out[0][0],
    lastY = out[0][1];
  for (let i = 1; i < coords.length; i++) {
    const x = lonToX(coords[i][0] / Q);
    const y = latToY(coords[i][1] / Q);
    const dx = x - lastX,
      dy = y - lastY;
    // skip vertices closer than ~2px on screen to the last drawn vertex
    if (dx * dx + dy * dy < minStep * minStep && i < coords.length - 1) continue;
    out.push([x, y]);
    lastX = x;
    lastY = y;
  }
  return out;
}
function withAlpha(c: RGBA, a: number): RGBA {
  return [c[0], c[1], c[2], c[3] * a];
}

function kerbColor(kerb: string, tactilePaving?: string): string {
  if (tactilePaving === "yes") return "#e8c04a";
  if (kerb === "flush" || kerb.startsWith("flush")) return "#9a6ee8";
  if (kerb === "lowered" || kerb.startsWith("lowered")) return "#4ac8e8";
  return "#e86e6e";
}

function crossingStripeColor(markings?: string): string | null {
  if (!markings) return null;
  const m = markings.toLowerCase();
  if (m.includes("zebra")) return "#e8e8e8";
  if (m.includes("dash")) return "#d8d8d8";
  if (m.includes("line")) return "#cccccc";
  if (m.includes("dot")) return "#bbbbbb";
  if (m.includes("pictogram")) return "#c9d4dd";
  return null;
}

/**
 * A feature's paint colour: an explicit surface:colour (or colour) tag wins
 * over the palette derived from the surface type. Invalid CSS colour values
 * fall back to the surface color.
 */
function featureColor(
  surface: string | undefined,
  colour: string | undefined,
): RGBA {
  if (colour) {
    const c = parseColor(colour);
    if (c) return c;
  }
  const key = surface ? normalizeSurfaceKey(surface) : "";
  if (PATTERN_AVG[key]) return rgba(PATTERN_AVG[key]);
  return rgba(surfaceColor(normalizeSurface(surface) ?? undefined));
}

// ---------------- surface patterns ----------------
// Patterns are generated procedurally into RGBA tiles (src/gl.ts) and drawn
// as repeating WebGL textures with a constant screen-space tile size,
// anchored to the world origin modulo one tile — same look as the old
// canvas patterns, no Canvas2D involved.

/** base green tone per green kind: scrub darker than grass/garden */
function greenBase(kind: string): [number, number, number] {
  if (kind === "scrub") return [73, 94, 55];
  return [93, 122, 68]; // #5d7a44
}

function greenColor(kind: string): RGBA {
  const [r, g2, b] = greenBase(kind);
  return [r / 255, g2 / 255, b / 255, 1];
}

function normalizeSurfaceKey(surface: string): string {
  const base = surface.split(";")[0].split(":")[0];
  return base;
}

/** patterns only render from zoom 25 — below that the average pattern color reads better */
const PATTERN_ZOOM = 25;

/** average fill color of a patterned surface (matches the pattern tone) */
const PATTERN_AVG: Record<string, string> = {
  paving_stones: "#7b7b7b", // tile average: stones 128, joints 106, 8/9 coverage
  sett: "#676767",
  cobblestone: "#676767",
};

/** stone pattern fill for a surface at the current zoom; null below
 *  PATTERN_ZOOM or for surfaces without a stone tile (those render solid) */
function stonePatternFill(surface: string | undefined): FillSpec | null {
  if (!surface) return null;
  if (zoomLevel() < PATTERN_ZOOM) return null;
  const key0 = normalizeSurfaceKey(surface);
  if (key0 !== "paving_stones" && key0 !== "sett" && key0 !== "cobblestone")
    return null;
  const key = "stone:" + key0;
  const isSett = key0 !== "paving_stones";
  const cell = (isSett ? 5 : 8) + 1;
  g.registerPattern(key, () => stoneTileData(surface));
  return { pattern: { key, w: cell * 2, h: cell * 2 } };
}

/** grass-like texture fill at the current zoom, or the plain base green */
function grassFill(kind: string): FillSpec {
  if (zoomLevel() < PATTERN_ZOOM) return { color: greenColor(kind) };
  const key = "green:" + kind;
  g.registerPattern(key, () => grassTileData(kind));
  return { pattern: { key, w: 12, h: 12 } };
}

// ---------------- scene graph ----------------
// Geometry is tessellated into a quadtree scene graph (src/gl.ts) only when
// the zoom band or a layer/LOD-affecting setting changes; the 2D renderer's
// LOD logic (lodVisible/areaLodVisible on integer zoom levels) decides what
// gets baked in. Pan/orbit at the same zoom reuses the graph and just
// frustum-culls per frame — only visible cells are drawn.
let scene: SceneGraph | null = null;
let sceneKey = "";

/** zoom bands at which the LOD actually changes — the scene graph is only
 *  re-tessellated when crossing one of these, not on every zoom step */
const LOD_BANDS = [14, 17, 20, 21, 22, 25];
function lodBand(): number {
  const z = zoomLevel();
  let band = 0;
  for (const t of LOD_BANDS) if (z >= t) band = t;
  return band;
}

/** wireframe mode: draw triangle edges as lines instead of filled surfaces */
let wireframe = false;

function sceneKeyOf(): string {
  return [
    dataset ? "ds" : "none",
    lodBand(),
    JSON.stringify(layers),
    selectedLayer,
    selectedLevel,
    laneSmoothness,
  ].join("|");
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  g.dpr = dpr;
  g.setViewState(canvas.clientWidth, canvas.clientHeight, dpr);
  g.setCamera(lonToX(view.cx), latToY(view.cy), view.scale, cam.heading, cam.pitch);
  g.wireframe = wireframe;
  const key = sceneKeyOf();
  g.beginFrame();
  if (!scene || key !== sceneKey) {
    if (isTriangulationReady()) {
      g.beginRecord();
      if (dataset) buildGeometry();
      scene = g.finishScene();
      sceneKey = key;
    }
  }
  if (scene) g.renderScene(scene);
}

/** tessellate everything LOD-visible in the whole dataset into the scene
 *  graph; per-frame frustum culling renders only what is on screen */
/** world-units ground (DGM) height at a world point (0 without height model) */
function demZAt(p: Pt): number {
  if (!hf) return 0;
  return (hf.groundM(xToLon(p[0]), yToLat(p[1])) ?? 0) * pxPerMeter();
}

/** height function for a filled area feature: layer>0 (bridge deck) takes the
 *  DOM surface height, layer-0 ground takes the DGM height. An area:highway
 *  passing UNDER a bridge is layer 0 and therefore stays on the ground —
 *  geometrically disconnected from the deck above it */
function fillZAt(f: { layer?: number }): ((p: Pt) => number) | undefined {
  if (!hf || !hf.ready) return undefined;
  const fm = hf.fillM(f.layer ?? 0);
  return (p: Pt) => fm(xToLon(p[0]), yToLat(p[1])) * pxPerMeter();
}

/** height for line/point features without their own area (kerbs, lane
 *  markings, lamps, ...): stick to the road/landuse they belong to by reusing
 *  its vertices, else the topmost containing area, else the DOM surface */
function stickZAt(p: Pt): number {
  if (!hf) return 0;
  return hf.stickM(xToLon(p[0]), yToLat(p[1])) * pxPerMeter();
}

/** rasterize occluders (buildings + higher-layer features) into the DGM grid,
 *  inpaint the occluded ground cells, and register every area polygon so
 *  kerbs/lane markings can stick to its vertices */
function setupHeights(): void {
  if (!hf || !hf.ready || !dataset) return;
  const q2ll = (ring: Q[][]): [number, number][] =>
    ring.map(([x, y]) => [x / Q, y / Q]);
  for (const b of dataset.buildings)
    for (const ring of b.outer) hf.dem?.occludeRing(q2ll(ring));
  const polys = [
    ...dataset.areas,
    ...dataset.landuse,
    ...dataset.parking,
    ...dataset.grass,
  ];
  for (const f of polys) {
    if (f.layer > 0) for (const ring of f.outer) hf.dem?.occludeRing(q2ll(ring));
    for (const ring of f.outer) hf.registerArea(q2ll(ring), f.layer);
  }
  const lines = [
    ...dataset.centerlines,
    ...dataset.footways,
    ...dataset.crossings,
  ];
  for (const f of lines)
    if (f.layer > 0) hf.dem?.occludeRing(q2ll(f.coords), f.width ?? 6);
  hf.dem?.inpaint();
}

function buildGeometry() {
  const bbox = datasetBounds ?? viewBboxQ();

  // Bird's eye: draw ALL classes in ascending layer order, so a higher layer
  // occludes everything below it regardless of feature class (previously
  // each class sorted internally, letting e.g. a layer-0 footway paint over
  // a layer-1 bridge's lane markings). Explicit layer selection draws only
  // that layer.
  const px = pxPerMeter();
  const layersToDraw: number[] =
    selectedLayer !== null
      ? [selectedLayer]
      : [...osmLayers].sort((a, b) => a - b);

  const gs =
    lodVisible("grass") && grassIndex ? queryIndex(grassIndex, bbox) : [];
  const areas = lodVisible("areas") && areaIndex
    ? // TRAFFIC ISLANDS LAST: an island inside another area:highway
      // must paint AFTER its surrounding area, or the surrounding
      // fill covers the island's surface
      visibleAreas(bbox).sort((a, b) =>
        a.highway === "traffic_island" && b.highway !== "traffic_island"
          ? 1
          : b.highway === "traffic_island" && a.highway !== "traffic_island"
            ? -1
            : 0,
      )
    : [];
  const bl =
    lodVisible("buildings") && buildingIndex
      ? queryIndex(buildingIndex, bbox)
      : [];
  const cls =
    lodVisible("centerlines") && lineIndexes
      ? queryIndex(lineIndexes.centerlines, bbox)
      : [];
  const lms =
    lodVisible("laneMarkings") && laneMarkingIndex
      ? queryIndex(laneMarkingIndex, bbox)
      : [];
  const fws =
    lodVisible("footways") && lineIndexes
      ? queryIndex(lineIndexes.footways, bbox)
      : [];
  const crs =
    lodVisible("crossings") && lineIndexes
      ? // FOOTWAY crossings paint AFTER cycleway ones: where a
        // footway crossing runs over a cycleway crossing (a combined
        // pedestrian+cycle crossing), the footway's markings win
        queryIndex(lineIndexes.crossings, bbox).sort((a, b) =>
          a.highway === "footway" && b.highway !== "footway"
            ? 1
            : b.highway === "footway" && a.highway !== "footway"
              ? -1
              : 0,
        )
      : [];
  const kws =
    lodVisible("kerbs") && kerbWayIndex ? queryIndex(kerbWayIndex, bbox) : [];
  const kns = lodVisible("kerbs") && kerbGrid ? kerbsInBbox(bbox) : [];

  for (const layer of layersToDraw) {
    const onLayer = (f: { layer?: number; level?: number }) =>
      (f.layer ?? 0) === layer && layerVisible(f);

    // --- landuse fills: opaque average paving-stone grey — reads like
    //     paving stones when zoomed out, consistent with the pattern fill
    if (lodVisible("landuse") && landuseIndex) {
      const lus = queryIndex(landuseIndex, bbox);
      const fill = rgba(PATTERN_AVG.paving_stones);
      // same-color seam stroke keeps adjacent landuse polygons continuous
      const seamW = Math.max(pxToWorld(4), 0.3 * px);
      for (const lu of lus) {
        if (!onLayer(lu)) continue;
        const outer = lu.outer.map(ringPts),
          holes = lu.holes.map(ringPts);
        g.fillPolygon(outer, holes, { color: fill }, 0, fillZAt(lu));
        for (const ring of lu.outer) g.stroke(closedRingPts(ring), seamW, { color: fill, zAt: fillZAt(lu) });
        for (const ring of lu.holes) g.stroke(closedRingPts(ring), seamW, { color: fill, zAt: fillZAt(lu) });
      }
    }

    // --- parking areas: filled with their own surface directly
    if (lodVisible("parking") && parkingIndex) {
      const pks = queryIndex(parkingIndex, bbox);
      const seamW = Math.max(pxToWorld(4), 0.3 * px);
      for (const pk of pks) {
        if (!onLayer(pk)) continue;
        const pat = !pk.surfaceColour ? stonePatternFill(pk.surface) : null;
        const solid =
          pk.surface || pk.surfaceColour
            ? featureColor(pk.surface, pk.surfaceColour)
            : rgba("#4a4a50");
        const fillSpec: FillSpec = pat ?? { color: solid };
        const outer = pk.outer.map(ringPts),
          holes = pk.holes.map(ringPts);
        g.fillPolygon(outer, holes, fillSpec, 0, fillZAt(pk));
        for (const ring of pk.outer) g.stroke(closedRingPts(ring), seamW, { color: solid, zAt: fillZAt(pk) });
        for (const ring of pk.holes) g.stroke(closedRingPts(ring), seamW, { color: solid, zAt: fillZAt(pk) });
      }
    }

    // --- green areas: landuse=grass / leisure=garden (same look),
    //     natural=scrub (darker) — mottled texture from zoom 25
    const seamW = Math.max(pxToWorld(4), 0.3 * px);
    for (const gr of gs) {
      if (!onLayer(gr)) continue;
      const fillSpec = grassFill(gr.kind);
      const solid = greenColor(gr.kind);
      const outer = gr.outer.map(ringPts),
        holes = gr.holes.map(ringPts);
      g.fillPolygon(outer, holes, fillSpec, 0, fillZAt(gr));
      for (const ring of gr.outer) g.stroke(closedRingPts(ring), seamW, { color: solid, zAt: fillZAt(gr) });
      for (const ring of gr.holes) g.stroke(closedRingPts(ring), seamW, { color: solid, zAt: fillZAt(gr) });
    }

    // --- highway areas (surface fill) ---
    for (const area of areas) {
      if (!onLayer(area) || !areaLodVisible(area)) continue;
      const pat = !area.surfaceColour ? stonePatternFill(area.surface) : null;
      const solid =
        area.surface || area.surfaceColour
          ? featureColor(area.surface, area.surfaceColour)
          : rgba("#4a4a50");
      const fillSpec: FillSpec = pat ?? { color: solid };
      const outer = area.outer.map(ringPts),
        holes = area.holes.map(ringPts);
      g.fillPolygon(outer, holes, fillSpec, 0, fillZAt(area));
      // same-color edge stroke: covers antialiased boundaries and cm-scale
      // geometric gaps between neighboring polygons so areas read as one
      // continuous surface — without letting lower layers shine through the
      // seams at high zoom, the stroke scales with the ground resolution
      for (const ring of area.outer) g.stroke(closedRingPts(ring), seamW, { color: solid, zAt: fillZAt(area) });
      for (const ring of area.holes) g.stroke(closedRingPts(ring), seamW, { color: solid, zAt: fillZAt(area) });
    }

    // --- buildings: extruded 3D prisms (height from height=*, else
    //     building:levels*3m, else 6m); top-down they look like the old
    //     translucent fill + outline, tilted they stand up
    for (const b of bl) {
      if (!onLayer(b)) continue;
      const roof = rgba(b.usage === "residential" ? "#f0b98a" : "#f5e9d8", 0.45);
      const hM = b.heightM ?? (b.levels !== undefined ? b.levels * 3 : 6);
      const h = hM * px; // world units
      const wall: RGBA = [roof[0] * 0.55, roof[1] * 0.55, roof[2] * 0.55, 0.9];
      const outer = b.outer.map(ringPts);
      // base sits on the terrain: DGM height at the footprint centroid (the
      // ground under a building is occluded, so this is the inpainted value);
      // the roof top comes from the DOM (measured surface incl. the building)
      let baseZ = 0;
      let roofZ = h;
      if (hf && hf.ready && b.outer[0]?.length) {
        let sx = 0, sy = 0;
        for (const [qx, qy] of b.outer[0]) { sx += qx / Q; sy += qy / Q; }
        const clon = sx / b.outer[0].length, clat = sy / b.outer[0].length;
        baseZ = (hf.groundM(clon, clat) ?? 0) * px;
        roofZ = Math.max((hf.surfaceM(clon, clat) ?? 0) * px, baseZ + 0.5 * px);
        if (hf.surfaceM(clon, clat) === null) roofZ = baseZ + h;
      }
      g.extrude(outer, Math.max(roofZ - baseZ, 0.5 * px), wall, roof, baseZ);
      const outline = rgba("#8a8a94");
      for (const ring of b.outer)
        g.stroke(closedRingPts(ring), pxToWorld(1.5), { color: outline });
    }

    // --- centerlines (surface detail) ---
    for (const cl of cls) {
      if (!onLayer(cl)) continue;
      g.stroke(
        linePts(cl.coords),
        Math.max(pxToWorld(1), (cl.width ?? 1.5) * px * 0.5),
        { color: withAlpha(featureColor(cl.surface, cl.surfaceColour), 0.9) },
      );
    }

    // --- lane markings ---
    for (const lm of lms) {
      if (!onLayer(lm)) continue;
      const clipped = clipToAreas(lm.areaIds);
      drawLaneMarkings(lm);
      if (clipped) g.popClip();
    }
    // --- footways ---
    for (const fw of fws) {
      if (!onLayer(fw)) continue;
      g.stroke(
        linePts(fw.coords),
        Math.max(pxToWorld(0.8), (fw.width ?? 1.8) * px * 0.3),
        {
          color:
            fw.surface || fw.surfaceColour
              ? featureColor(fw.surface, fw.surfaceColour)
              : rgba("#cfcfd6"),
        },
      );
    }

    // --- crossings with markings ---
    for (const cr of crs) {
      if (!onLayer(cr)) continue;
      const stripe = crossingStripeColor(cr.crossingMarkings);
      const m = (cr.crossingMarkings ?? "").toLowerCase();
      const widthM = cr.width ?? (m.includes("zebra") ? 3 : 1.5);
      const clipped = clipToAreas(cr.areaIds);
      if (stripe) {
        if (m.includes("zebra")) {
          // zebra crossings keep their dark band under the stripes
          g.stroke(linePts(cr.coords), Math.max(pxToWorld(2), widthM * px), {
            color: rgba("#5a5a60"),
            cap: "butt",
          });
          drawZebra(cr, widthM, stripe);
        } else if (m.includes("dash")) {
          // DASHED crossings draw ONLY the dashed lines — no filled
          // band underneath (the road surface stays visible between
          // the dashes)
          drawBoundaryDashes(cr, widthM, stripe);
        } else {
          g.stroke(linePts(cr.coords), Math.max(pxToWorld(1.5), widthM * px * 0.35), {
            color: rgba(stripe),
            dash: [pxToWorld(2), pxToWorld(3)],
            cap: "butt",
          });
        }
      } else if (layers.footways) {
        // crossings without markings render as a plain footway band: they
        // belong to the footways toggle, not the crossings (markings) one
        g.stroke(linePts(cr.coords), Math.max(pxToWorld(1.5), widthM * px * 0.4), {
          color: rgba("#8a8a92", 0.7),
          cap: "butt",
        });
      }
      if (clipped) g.popClip();
    }

    // --- standalone stop lines (car ways without drawn lane markings) ---
    const sls2 =
      lodVisible("laneMarkings") && stopLineIndex
        ? queryIndex(stopLineIndex, bbox)
        : [];
    for (const sl of sls2) {
      if (!onLayer(sl)) continue;
      const px2 = pxPerMeter();
      // the shared boundary polyline between the entering road area and
      // the junction area
      if (!sl.line || sl.line.length < 2) continue;
      g.stroke(linePts(sl.line), Math.max(pxToWorld(2), 0.4 * px2), {
        color: rgba("#e8e8e8"),
      });
    }

    // --- fences: black lines ---
    if (lodVisible("fences") && fenceIndex) {
      const fs = queryIndex(fenceIndex, bbox);
      const fw2 = Math.max(pxToWorld(1), 0.08 * px);
      const fc = rgba("#1a1a1a");
      for (const f of fs) {
        if (!onLayer(f)) continue;
        g.stroke(linePts(f.coords), fw2, { color: fc });
      }
    }

    // --- kerb ways: dark edge between sidewalk and road ---
    drawKerbWays(kws, onLayer, px);

    // standalone kerb nodes (not part of a kerb way) are no longer drawn
    void kns;

    // --- street lamps: yellow dot with a radial halo fading out ---
    if (lodVisible("streetLamps") && streetLampGrid) {
      const halo = Math.max(pxToWorld(6), Math.min(pxToWorld(24), 2.5 * px));
      for (const sl of allGridValues(streetLampGrid)) {
        if (!onLayer(sl)) continue;
        const x = lonToX(sl.lon / Q),
          y = latToY(sl.lat / Q);
        g.halo([x, y], halo, [
          [0, rgba("rgb(255,225,120)", 0.95)],
          [0.35, rgba("rgb(255,210,80)", 0.45)],
          [1, rgba("rgb(255,200,60)", 0)],
        ]);
        g.circle([x, y], Math.max(pxToWorld(1.5), halo * 0.12), rgba("#ffe178"));
      }
    }

    // --- manholes: dark anthracite circle with lighter stripes ---
    if (lodVisible("manholes") && manholeGrid) {
      const mr = Math.max(pxToWorld(2), Math.min(pxToWorld(10), 0.4 * px)); // ~80 cm cover
      const stripe = Math.max(pxToWorld(1), mr * 0.16);
      for (const mh of allGridValues(manholeGrid)) {
        if (!onLayer(mh)) continue;
        const x = lonToX(mh.lon / Q),
          y = latToY(mh.lat / Q);
        g.circle([x, y], mr, rgba("#2f3134"));
        // lighter stripes across the cover
        const segs: Pt[][] = [];
        for (let k = -1; k <= 1; k++) {
          const yy = y + k * mr * 0.45;
          const half = Math.sqrt(Math.max(0, mr * mr - (k * mr * 0.45) ** 2));
          segs.push([
            [x - half, yy],
            [x + half, yy],
          ]);
        }
        g.strokeSegments(segs, stripe, rgba("#565a60"));
      }
    }

    // --- bollards: black dots ---
    if (lodVisible("bollards") && bollardGrid) {
      const br = Math.max(pxToWorld(2.5), Math.min(pxToWorld(8), 0.25 * px));
      for (const b of allGridValues(bollardGrid)) {
        if (!onLayer(b)) continue;
        const x = lonToX(b.lon / Q),
          y = latToY(b.lat / Q);
        g.circle([x, y], br, rgba("#2f3134")); // dark anthracite
      }
    }
  }
}

/** all values of a point grid (the scene graph covers the whole dataset) */
function allGridValues<T>(grid: Map<number, T[]>): T[] {
  const out: T[] = [];
  for (const arr of grid.values()) for (const v of arr) out.push(v);
  return out;
}

/** kerb height class of a kerb=* value */
function kerbClass(kerb: string): "high" | "lowered" | "flush" {
  const k = kerb.split(";")[0];
  if (k === "flush" || k === "no") return "flush";
  if (k === "lowered" || k === "rolled") return "lowered";
  return "high";
}

/**
 * Draw kerb ways as a dark edge between sidewalk and road. The way is
 * oriented with the lower end (road) on its right side.
 *  - high: solid dark line + small shadow on the road side
 *  - lowered: gradient across the kerb width (bright sidewalk side fading
 *    to dark road side) so it appears 3D-shaped
 *  - flush: not drawn
 * Kerb nodes on the way locally override the type within ~1 m.
 */
function drawKerbWays(
  kws: KerbWayFeature[],
  onLayer: (f: { layer?: number; level?: number }) => boolean,
  px: number,
): void {
  const kerbW = Math.max(pxToWorld(1.5), 0.18 * px); // ~18 cm kerb width
  const shadowW = kerbW * 0.3;
  // darker than paving-stone grey (#808080): the visual break
  const dark = rgba("#3a3a3e");
  const bright = rgba("#9a9a9e");

  for (const kw of kws) {
    if (!onLayer(kw)) continue;
    const base = kerbClass(kw.kerb);

    // screen coords + per-vertex normals (right side = road)
    const pts: [number, number][] = kw.coords.map((c) => [
      lonToX(c[0] / Q),
      latToY(c[1] / Q),
    ]);
    if (pts.length < 2) continue;
    const normals: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      let nx = 0,
        ny = 0;
      // right-hand normal in screen coords (y down): direction (dx,dy) ->
      // (-dy,dx). Walking east, the right side is screen-down (south).
      if (i > 0) {
        const dx = pts[i][0] - pts[i - 1][0],
          dy = pts[i][1] - pts[i - 1][1];
        const l = Math.hypot(dx, dy);
        if (l > 0) {
          nx += -dy / l;
          ny += dx / l;
        }
      }
      if (i < pts.length - 1) {
        const dx = pts[i + 1][0] - pts[i][0],
          dy = pts[i + 1][1] - pts[i][1];
        const l = Math.hypot(dx, dy);
        if (l > 0) {
          nx += -dy / l;
          ny += dx / l;
        }
      }
      const l = Math.hypot(nx, ny);
      normals.push(l > 0 ? [nx / l, ny / l] : [0, 0]);
    }

    // local type per vertex: way's base type, overridden within ~1 m of a
    // kerb node on the way
    const types: ("high" | "lowered" | "flush")[] = pts.map(() => base);
    if (kw.overrides && kw.overrides.length > 0) {
      const rPx = Math.max(pxToWorld(1), px); // 1 m radius
      for (const o of kw.overrides) {
        const cls = kerbClass(o.kerb);
        if (o.idx >= pts.length) continue;
        const ox = pts[o.idx][0],
          oy = pts[o.idx][1];
        for (let i = 0; i < pts.length; i++) {
          if (Math.hypot(pts[i][0] - ox, pts[i][1] - oy) <= rPx) types[i] = cls;
        }
      }
    }

    // draw segment by segment, grouped by local type
    for (let i = 1; i < pts.length; i++) {
      const t = types[i];
      const tPrev = types[i - 1];
      const a = pts[i - 1],
        b = pts[i];
      const na = normals[i - 1],
        nb = normals[i];
      if (t === "flush" && tPrev === "flush") continue;

      if (t === "high" || tPrev === "high") {
        // solid dark kerb line
        g.stroke([a, b], kerbW, { color: dark, cap: "butt" });
        // shadow on the road side (right)
        g.stroke(
          [
            [a[0] + (na[0] * (kerbW + shadowW)) / 2, a[1] + (na[1] * (kerbW + shadowW)) / 2],
            [b[0] + (nb[0] * (kerbW + shadowW)) / 2, b[1] + (nb[1] * (kerbW + shadowW)) / 2],
          ],
          kerbW,
          { color: rgba("#000000", 0.28), cap: "butt" },
        );
      } else if (t === "lowered" || tPrev === "lowered") {
        // gradient across the kerb width: bright (sidewalk, left) fading
        // to dark (road, right) — appears 3D-shaped; per-vertex colors on
        // the two strip edges reproduce the linear gradient
        g.stroke([a, b], kerbW, { color: bright, colorPos: dark, cap: "butt" });
      }
    }
  }
}

/** highway areas in the bbox, respecting the areas toggle */
function visibleAreas(bbox: [number, number, number, number]): AreaFeature[] {
  return areaIndex ? queryIndex(areaIndex, bbox) : [];
}

/** kerb nodes within the bbox */
function kerbsInBbox(bbox: [number, number, number, number]): KerbFeature[] {
  const out: KerbFeature[] = [];
  if (!kerbGrid) return out;
  for (const cell of cellsForBbox(bbox, 50000)) {
    const arr = kerbGrid.get(cell);
    if (arr) for (const k of arr) out.push(k);
  }
  return out;
}

function drawZebra(cr: LineFeature, widthM: number, color: string) {
  const px = pxPerMeter();
  const halfW = (widthM * px) / 2;
  const lineW = Math.max(pxToWorld(1.2), widthM * px * 0.14);
  const stripeGap = Math.max(widthM * px * 0.22, pxToWorld(3));

  const segs: Pt[][] = [];
  let walked = 0;
  for (let i = 1; i < cr.coords.length; i++) {
    const [x0, y0] = cr.coords[i - 1];
    const [x1, y1] = cr.coords[i];
    const X0 = lonToX(x0 / Q),
      Y0 = latToY(y0 / Q);
    const X1 = lonToX(x1 / Q),
      Y1 = latToY(y1 / Q);
    const segLen = Math.hypot(X1 - X0, Y1 - Y0);
    if (segLen === 0) continue;
    const ux = (X1 - X0) / segLen,
      uy = (Y1 - Y0) / segLen;
    const nx = -uy,
      ny = ux;

    let t = -(walked % stripeGap);
    while (t < segLen) {
      const cxp = X0 + ux * t,
        cyp = Y0 + uy * t;
      segs.push([
        [cxp + nx * halfW, cyp + ny * halfW],
        [cxp - nx * halfW, cyp - ny * halfW],
      ]);
      t += stripeGap;
    }
    walked += segLen;
  }
  g.strokeSegments(segs, lineW, rgba(color));
}

/**
 * Dashed-crossing markings: two dashed lines running along the left and
 * right boundary of the footway, 10 cm wide each, offset to the inside of
 * the crossing band so the stroke stays within the tagged width. Clipped
 * to the containing highway area by the caller.
 */
function drawBoundaryDashes(cr: LineFeature, widthM: number, color: string) {
  const px = pxPerMeter();
  const halfW = (widthM * px) / 2;
  const lineW = Math.max(pxToWorld(1), 0.1 * px);
  const offset = Math.max(0, halfW - lineW / 2);
  const dash: [number, number] = [
    Math.max(pxToWorld(4), 0.5 * px),
    Math.max(pxToWorld(3), 0.35 * px),
  ];

  const pts: Pt[] = [];
  const normals: Pt[] = [];
  for (let i = 0; i < cr.coords.length; i++) {
    pts.push([lonToX(cr.coords[i][0] / Q), latToY(cr.coords[i][1] / Q)]);
    if (i > 0) {
      const dx = pts[i][0] - pts[i - 1][0],
        dy = pts[i][1] - pts[i - 1][1];
      const len = Math.hypot(dx, dy);
      normals.push(len === 0 ? [0, 0] : [-dy / len, dx / len]);
    }
  }

  for (const side of [-1, 1] as const) {
    const off: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      let nx: number, ny: number;
      if (i === 0) {
        [nx, ny] = normals[0];
      } else if (i === pts.length - 1) {
        [nx, ny] = normals[normals.length - 1];
      } else {
        const [nx1, ny1] = normals[i - 1],
          [nx2, ny2] = normals[i];
        const bl = Math.hypot(nx1 + nx2, ny1 + ny2);
        [nx, ny] = bl === 0 ? [nx1, ny1] : [(nx1 + nx2) / bl, (ny1 + ny2) / bl];
      }
      off.push([pts[i][0] + nx * offset * side, pts[i][1] + ny * offset * side]);
    }
    g.stroke(off, lineW, { color: rgba(color), dash, cap: "butt" });
  }
}

function cellsForBbox(
  bbox: [number, number, number, number],
  cell: number,
): number[] {
  const keys: number[] = [];
  const x0 = Math.floor(bbox[0] / cell),
    x1 = Math.floor(bbox[2] / cell);
  const y0 = Math.floor(bbox[1] / cell),
    y1 = Math.floor(bbox[3] / cell);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 20000) return keys;
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) keys.push(x * 100000 + y);
  return keys;
}

/** highway area containing a crossing (for clipping markings), by feature id */
function areaById(id: string): AreaFeature | null {
  if (!dataset || !areaIndex) return null;
  for (const a of dataset.areas) {
    if (a.id === id) return a;
  }
  return null;
}

/** push a stencil clip from area rings onto the GL batch; false if not found */
function clipToAreas(areaIds: string[] | undefined): boolean {
  if (!areaIds || areaIds.length === 0) return false;
  const found = areaIds
    .map((id) => areaById(id))
    .filter((a) => a !== null) as AreaFeature[];
  if (found.length === 0) return false;
  const outer: Pt[][] = [],
    holes: Pt[][] = [];
  for (const area of found) {
    for (const ring of area.outer) outer.push(ringPts(ring));
    for (const hole of area.holes) holes.push(ringPts(hole));
  }
  g.pushClip(outer, holes);
  return true;
}

/**
 * Lane markings for a lane-bearing centerline: the road width is inferred
 * from the containing highway area (cl.areaIds), lanes split it equally.
 * Border between opposite directions is solid; borders between lanes of
 * the same direction are dashed. Clipped to the area so markings never
 * extend past the street outline.
 */
/**
 * Chaikin corner-cutting: rounds each corner into a smooth curve. Two
 * iterations give a visually continuous line while staying close to the
 * original geometry.
 */
function chaikin(pts: [number, number][], iterations = 2): [number, number][] {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const out: [number, number][] = [cur[0]];
    for (let i = 1; i < cur.length; i++) {
      const a = cur[i - 1],
        b = cur[i];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

/**
 * Lane markings for a lane-bearing centerline. The road width is inferred
 * from the containing highway area minus parking lanes; lanes split the
 * remaining width equally. Each lane boundary is one continuous offset
 * curve with averaged vertex normals and Chaikin smoothing, so markings
 * flow smoothly around corners instead of breaking at each vertex.
 * Border between opposite directions is solid; same-direction borders are
 * dashed. Clipped to the area so markings never extend past the outline.
 */
function drawLaneMarkings(cl: LineFeature) {
  if (cl.lanes === undefined || cl.laneW === undefined || cl.lanes! < 2) return;
  const px = pxPerMeter();
  const lineW = Math.max(pxToWorld(1), 0.12 * px);
  // forward lane count EXACTLY like the extractor's fwdOf: a one-way
  // road runs ALL its lanes forward — the bidirectional fallback here
  // misread one-way roads and misplaced the middle line and the turn
  // arrows' lane mapping
  const fwd = cl.lanesFwd ?? (cl.oneway ? cl.lanes : Math.ceil(cl.lanes / 2));
  const total = cl.lanes;

  // centerline in screen coordinates
  const base: [number, number][] = cl.coords.map((c) => [
    lonToX(c[0] / Q),
    latToY(c[1] / Q),
  ]);
  if (base.length < 2) return;

  // averaged vertex normals for continuous offsets across corners
  const normals: [number, number][] = [];
  for (let i = 0; i < base.length; i++) {
    let nx = 0,
      ny = 0;
    if (i > 0) {
      const dx = base[i][0] - base[i - 1][0],
        dy = base[i][1] - base[i - 1][1];
      const l = Math.hypot(dx, dy);
      if (l > 0) {
        nx += -dy / l;
        ny += dx / l;
      }
    }
    if (i < base.length - 1) {
      const dx = base[i + 1][0] - base[i][0],
        dy = base[i + 1][1] - base[i][1];
      const l = Math.hypot(dx, dy);
      if (l > 0) {
        nx += -dy / l;
        ny += dx / l;
      }
    }
    const l = Math.hypot(nx, ny);
    normals.push(l > 0 ? [nx / l, ny / l] : [0, 0]);
  }

  // traffic-lane region: from the left edge to the right edge of the road,
  // parking lanes virtually subtracted (lane 1 starts at the left edge)
  const leftM = cl.laneLeftM ?? (total * cl.laneW!) / 2;

  // the road width can change along the area: with a measured per-vertex
  // edge profile, every lane boundary follows the LOCAL road span instead
  // of the piece-wide median, so the block fills the road exactly at every
  // vertex (lane k keeps its fraction of the local width)
  // densified spline centerline with per-sample measured road edges: the
  // road width can change along the area, so every boundary follows the
  // LOCAL span at each sample (the block fills the road exactly), while
  // the sample points/normals come from the fitted spline — smooth
  // curves even where the mapped way is a coarse polyline
  const sp = cl.spline;
  const hasSpline =
    sp !== undefined &&
    sp.length >= 2 &&
    sp.every((s) => s.pt.length === 2);
  const splineBase: [number, number][] | null = hasSpline
    ? sp!.map((s) => {
        // PIECE-WISE LINEAR mode: shift the sample point back onto the
        // RAW (unsmoothed) middle-line offset — meters to quantized
        // degrees like the extractor's re-basing — so the straight
        // segments genuinely differ from the smoothed spline
        if (laneSmoothness === "linear" && s.midRawM !== undefined && s.midM !== undefined) {
          const dm = s.midRawM - s.midM;
          const cosLat = Math.cos((s.pt[1] / Q) * (Math.PI / 180));
          const lonQ = s.pt[0] + (s.nx * dm * 1e7) / (111320 * cosLat);
          const latQ = s.pt[1] + (s.ny * dm * 1e7) / 111320;
          return [lonToX(lonQ / Q), latToY(latQ / Q)] as [number, number];
        }
        return [lonToX(s.pt[0] / Q), latToY(s.pt[1] / Q)] as [number, number];
      })
    : null;
  // screen-space normals of the spline polyline: the offset direction
  // must be perpendicular IN SCREEN SPACE, and offM * px (ground scale)
  // then gives the metrically correct distance
  const splineNormals: [number, number][] | null = hasSpline
    ? (() => {
        const b = sp!.map((s) => [lonToX(s.pt[0] / Q), latToY(s.pt[1] / Q)] as [number, number]);
        const ns: [number, number][] = b.map((_, i) => {
          let nx = 0,
            ny = 0;
          if (i > 0) {
            const dx = b[i][0] - b[i - 1][0],
              dy = b[i][1] - b[i - 1][1];
            const l = Math.hypot(dx, dy);
            if (l > 0) {
              nx += -dy / l;
              ny += dx / l;
            }
          }
          if (i < b.length - 1) {
            const dx = b[i + 1][0] - b[i][0],
              dy = b[i + 1][1] - b[i][1];
            const l = Math.hypot(dx, dy);
            if (l > 0) {
              nx += -dy / l;
              ny += dx / l;
            }
          }
          const l = Math.hypot(nx, ny);
          return l > 0 ? ([nx / l, ny / l] as [number, number]) : ([0, 0] as [number, number]);
        });
        return ns;
      })()
    : null;
  // meters-left convention: block spans laneLeftM (left edge) down to
  // laneLeftM - lanes*laneW (right edge). The lane width is the road
  // group's SHARED fitted width — one even width along the whole road —
  // so every traffic boundary is a PIECE-CONSTANT offset extruded along
  // the spline normals (curve handling); rescaling per sample would vary
  // the lane width along the road. The extractor's clamp keeps the block
  // inside each piece's fitted span, and where the road is wider than
  // the block the parking strips (drawn at the block's outer edges)
  // absorb the remaining width
  const localOffsetM = (i: number, offM: number): number => {
    if (!hasSpline) return offM;
    // never paint outside the highway area: clamp the boundary into
    // this sample's measured half-width around the middle line. Lane
    // widths stay even everywhere the road is wide enough; only where
    // the road genuinely narrows below the block does the outer
    // boundary follow the road edge
    const s = sp![i];
    const MARGIN = 0.15;
    const leftEdge = s.leftM;
    const rightEdge = s.rightM;
    return Math.max(
      -(rightEdge - MARGIN),
      Math.min(leftEdge - MARGIN, offM),
    );
  };
  // RENDERING MODES: "spline" interpolates the offset samples with
  // Chaikin smoothing (the default — flowing curves), "linear" draws
  // the piece-wise linear polyline through the same offset samples
  // exactly as extracted — crisp segments, no interpolation
  const linear = laneSmoothness === "linear";
  const samplesOnly = laneSmoothness === "samples";
  const drawOffsetLine = (
    offAt: (i: number) => number,
    solid: boolean,
  ): void => {
    // prefer the spline; fall back to the way polyline
    const pts: [number, number][] =
      splineBase !== null
        ? splineBase.map((p, i) => [
            p[0] + splineNormals![i][0] * offAt(i),
            p[1] + splineNormals![i][1] * offAt(i),
          ])
        : base.map((p, i) => [
            p[0] + normals[i][0] * offAt(i),
            p[1] + normals[i][1] * offAt(i),
          ]);
    // SMOOTHNESS MODES: "spline" interpolates the offset samples with
    // Chaikin smoothing (the default — flowing curves), "linear" draws
    // the piece-wise linear polyline through the same offset samples
    // exactly as extracted — crisp segments, no interpolation
    const smooth = linear ? pts : chaikin(pts, 2);
    g.stroke(smooth, lineW, {
      color: rgba("#e8e8e8"),
      dash: solid
        ? undefined
        : [Math.max(pxToWorld(3), 1.2 * px), Math.max(pxToWorld(2), 1.0 * px)],
      cap: "round",
    });
    if (samplesOnly) {
      const dot = rgba("#ff3355");
      for (const p of pts) g.circle(p, pxToWorld(2), dot);
    }
  };

  // draw a boundary between a parking unit and the adjacent traffic lane so
  // all width units are visible (parking occupies the outer strips)
  const boundaryOffsets: number[] = [];
  if (cl.parkingLeft) boundaryOffsets.push(-leftM);
  if (cl.parkingRight) boundaryOffsets.push(-leftM + total * cl.laneW!);
  for (const offPx of boundaryOffsets.map((o) => o * px)) {
    if (hasSpline) break;
    if (samplesOnly) break;
    const offset: [number, number][] = base.map((p, i) => [
      p[0] + normals[i][0] * offPx,
      p[1] + normals[i][1] * offPx,
    ]);
    const smooth = chaikin(offset, 2);
    g.stroke(smooth, lineW, {
      color: rgba("#e8e8e8"),
      dash: [Math.max(pxToWorld(3), 1.2 * px), Math.max(pxToWorld(2), 1.0 * px)],
      cap: "round",
    });
  }
  if (hasSpline && sp && !samplesOnly) {
    // parking boundaries sit at the block's outer edges — the SAME
    // offsets as the non-spline path (negative = left of the centerline):
    // the parking strip occupies the unit between the block edge and the
    // road edge on its side
    if (cl.parkingLeft)
      drawOffsetLine((i) => localOffsetM(i, -leftM) * px, false);
    if (cl.parkingRight)
      drawOffsetLine(
        (i) => localOffsetM(i, -leftM + total * cl.laneW!) * px,
        false,
      );
  }
  for (let k = 1; k < total; k++) {
    if (samplesOnly && !(fwd > 0 && fwd < total && k === total - fwd))
      continue;
    // distance from the centerline, negative = left side
    const offPx = (-leftM + k * cl.laneW!) * px;
    // solid only between opposite directions: exists when some (but not
    // all) lanes run forward — a one-way road has no solid separator.
    // RIGHT-HAND TRAFFIC: the forward lanes keep RIGHT of the border, so
    // the border sits BWD lanes counted from the LEFT (k counts
    // boundaries from the block's left edge; fwd counts from the right).
    // For symmetric splits (2+2, 1+1) bwd == fwd and the two coincide;
    // for asymmetric splits (way 396518419: 2 fwd + 1 bwd) the border
    // is at k = bwd = total - fwd, NOT k = fwd — drawing it at k = fwd
    // put the middle line between the two FORWARD lanes
    const solid = fwd > 0 && fwd < total && k === total - fwd;
    if (hasSpline)
      drawOffsetLine(
        (i) => localOffsetM(i, -leftM + k * cl.laneW!) * px,
        solid,
      );
    else drawOffsetLine(() => offPx, solid);
  }
  // SAMPLES MODE on a road WITHOUT a solid middle line (a one-way road
  // never draws a border): the middle line itself carries the sample
  // dots, so every piece shows them
  if (samplesOnly && !(fwd > 0 && fwd < total))
    drawOffsetLine((i) => localOffsetM(i, 0) * px, true);
  // stop line: the shared boundary polyline between the entering road
  // area and the junction area (not necessarily orthogonal to the road),
  // already clipped to the lanes flowing into the signal
  if (cl.stopLinesQ && !samplesOnly) {
    for (const line of cl.stopLinesQ) {
      if (line.length < 2) continue;
      g.stroke(linePts(line), Math.max(pxToWorld(2), 0.4 * px), {
        color: rgba("#e8e8e8"),
      });
    }
  }
  if (!samplesOnly) drawTurnArrows(cl);
}

/**
 * Turn lane indicators: white arrows painted inside each lane on the
 * approach to a junction. The extractor attaches turnLanesFwd only when
 * the way flows into a junction area at its END (and turnLanesBwd for
 * the backward direction at its START), so the arrows stop at the
 * junction mouth and never paint the junction area itself.
 *
 * Geometry: the lane's centreline is the spline offset laterally into
 * the lane's middle; the arrow sits in the last ~5 m of the approach,
 * aligned with the road's direction there.
 */
function drawTurnArrows(cl: LineFeature) {
  if (!cl.turnLanesFwd && !cl.turnLanesBwd) return;
  const px = pxPerMeter();
  const fwd = cl.lanesFwd ?? (cl.oneway ? cl.lanes! : Math.ceil(cl.lanes! / 2));
  const total = cl.lanes!;
  const leftM = cl.laneLeftM ?? (total * cl.laneW!) / 2;
  // ARROW REPEAT: one arrow every ARROW_STEP meters of arc along the
  // lane centreline, starting ARROW_INSET from the piece's ends so
  // arrows never touch the piece boundaries
  const ARROW_STEP = 4;
  const ARROW_INSET = 1.5;
  const sp = cl.spline;
  const hasSpline =
    sp !== undefined && sp.length >= 2 && sp.every((s) => s.pt.length === 2);
  // lane centreline polyline in screen coords
  // the lane centreline uses the SAME per-sample clamped offsets as the
  // drawn lane boundaries: where the measured road is narrower than the
  // block (a junction mouth, a bus platform), the boundaries pull
  // toward the middle line — the arrows must follow them, otherwise
  // they sit centred on the marking lines instead of inside the lanes.
  // clampOf replicates drawLaneMarkings' localOffsetM
  const MARGIN = 0.15;
  const clampOf = (i: number, offM: number): number => {
    const s = sp![i];
    return Math.max(
      -(s.rightM - MARGIN),
      Math.min(s.leftM - MARGIN, offM),
    );
  };
  // screen-space normals of the spline polyline, computed EXACTLY
  // like drawLaneMarkings' splineNormals: averaged vertex normals in
  // SCREEN coordinates. The boundary offsets are RIGHT-positive in
  // this convention, and reusing the extractor's geographic normal
  // (left of travel, north-positive) mirrors the lanes depending on
  // the way's compass direction (north-south ways mirrored,
  // east-west ones not) — way 319894492's left|left|through|none
  // rendered as none|through|right|right
  const screenPts: [number, number][] = hasSpline
    ? sp!.map((s) => [lonToX(s.pt[0] / Q), latToY(s.pt[1] / Q)] as [number, number])
    : [];
  const screenNormals: [number, number][] = screenPts.map((_, i) => {
    let nx = 0,
      ny = 0;
    for (const [a, b] of [
      [Math.max(0, i - 1), i],
      [i, Math.min(screenPts.length - 1, i + 1)],
    ] as [number, number][]) {
      const dx = screenPts[b][0] - screenPts[a][0],
        dy = screenPts[b][1] - screenPts[a][1];
      const l = Math.hypot(dx, dy);
      if (l > 0) {
        nx += -dy / l;
        ny += dx / l;
      }
    }
    const l = Math.hypot(nx, ny);
    return l > 0 ? ([nx / l, ny / l] as [number, number]) : ([0, 0] as [number, number]);
  });
  const laneCentreM = (k: number): number => -leftM + (k + 0.5) * cl.laneW!;
  const laneBoundaryM = (k: number): number => -leftM + k * cl.laneW!;
  const lanePts = (k: number): [number, number][] =>
    hasSpline
      ? sp!.map((s, i) => {
          // lane k spans the clamped boundaries k and k+1; the arrow
          // runs between them (their mean is the lane centre when the
          // road is wide enough, and follows the narrowing when not)
          const centre =
            (clampOf(i, laneBoundaryM(k)) + clampOf(i, laneBoundaryM(k + 1))) / 2;
          return [
            screenPts[i][0] + screenNormals[i][0] * centre * px,
            screenPts[i][1] + screenNormals[i][1] * centre * px,
          ];
        })
      : cl.coords.map((c, i) => {
          const centre = laneCentreM(k);
          return [
            lonToX(c[0] / Q) + normalOf(cl, i)[0] * centre * px,
            latToY(c[1] / Q) + normalOf(cl, i)[1] * centre * px,
          ];
        });
  const drawArrowAt = (
    turns: string[],
    pts: [number, number][],
    arcAt: number,
  ): void => {
    // position + DRIVING DIRECTION of the lane centreline at arc
    // distance arcAt, measured from the polyline's front (the array
    // runs along the driving direction after drawRepeat's reversal)
    const here = pointAndDirAtArc(pts, arcAt);
    if (!here) return;
    const ux = here.u[0],
      uy = here.u[1];
    const nx = -uy,
      ny = ux;
    // CLASSIC GERMAN ROAD-MARKING ARROW (filled look, like the
    // through-marking reference): a solid shaft that runs straight
    // along the lane and then BENDS into the turn, with a solid
    // triangular head at its end pointing along the bend's exit
    // direction. through: straight shaft, forward head. left/right:
    // elbow bend, head sideways. slight/sharp: gentler/steeper bend.
    // reverse: a U-shaped hook, head pointing back. All dimensions in
    // METERS scaled by the ground scale
    const lanePx = cl.laneW! * px;
    const len = Math.min(1.8 * px, lanePx * 0.72);
    const w = Math.min(len * 0.52, lanePx * 0.45);
    const headLen = w * 0.5;
    const shaftW = w * 0.33;
    // the arrow is CENTRED on arcAt along the lane; local frame:
    // fwd along the driving direction, left perpendicular
    const cx = here.p[0] - (ux * len) / 2,
      cy = here.p[1] - (uy * len) / 2;
    const loc = (fwd: number, left: number): [number, number] => [
      cx + ux * fwd + nx * left,
      cy + uy * fwd + ny * left,
    ];
    const arrowCol = rgba("#e8e8e8");
    // SCREEN SPACE has y pointing down, so a geographic LEFT turn is a
    // NEGATIVE math rotation here — left/slight_left/sharp_left take
    // negative angles, the right variants positive
    // merge_to_left / merge_to_right render as SLIGHT turns (a merge
    // is a shallow lateral move); through stays straight
    const dirAngle = (v: string): number =>
      v === "left"
        ? -Math.PI / 2
        : v === "slight_left" || v === "merge_to_left"
          ? -Math.PI / 4
          : v === "sharp_left"
            ? (-3 * Math.PI) / 4
            : v === "right"
              ? Math.PI / 2
              : v === "slight_right" || v === "merge_to_right"
                ? Math.PI / 4
                : v === "sharp_right"
                  ? (3 * Math.PI) / 4
                  : v === "reverse"
                    ? Math.PI
                    : 0; // through -> straight
    const dirs = turns.map(dirAngle).sort((a, b) => a - b);
    if (dirs.length === 0) return;
    // MERGED ARROW for multiple turn values (like through;right): ONE
    // shared straight shaft with the through head pointing forward,
    // plus one diagonal branch from the shaft's upper end for each
    // additional turn, each branch carrying its own head (the German
    // merged marking). A single turn keeps the classic elbow shape
    const drawHead = (
      p: [number, number],
      tx: number,
      ty: number,
    ): void => {
      // solid triangular head at p, pointing along (tx, ty):
      // base perpendicular to the direction, width w, length headLen
      const bx = -ty,
        by = tx;
      const b1: [number, number] = [
        p[0] + bx * (w / 2),
        p[1] + by * (w / 2),
      ];
      const b2: [number, number] = [
        p[0] - bx * (w / 2),
        p[1] - by * (w / 2),
      ];
      const tip: [number, number] = [
        p[0] + tx * headLen,
        p[1] + ty * headLen,
      ];
      g.fillPolygon([[b1, tip, b2]], [], { color: arrowCol });
    };
    if (dirs.length === 1 && dirs[0] === Math.PI) {
      // REVERSE: straight shaft, then a U-shaped hook turning
      // back; the head points backwards at the hook's end
      const r = Math.min(lanePx * 0.18, len * 0.22);
      const fEnd = len / 2 - r * 2;
      const hook: Pt[] = [loc(-len / 2, 0), loc(fEnd, 0)];
      // semicircle: from direction (1,0) turning to (-1,0) in the
      // local frame, approximated with segments; the hook bends LEFT
      // of the driving direction (nx is the right vector -> negative
      // lateral)
      for (let k = 1; k <= 10; k++) {
        const t = (k / 10) * Math.PI;
        hook.push(loc(fEnd + r * Math.sin(t), -r * (1 - Math.cos(t))));
      }
      g.stroke(hook, shaftW, { color: arrowCol, cap: "round" });
      const hp = loc(fEnd, -2 * r);
      drawHead(hp, -ux, -uy);
      return;
    }
    if (dirs.length > 1 || (dirs.length === 1 && dirs[0] !== 0)) {
      // has a non-through component: shared shaft + branch per turn.
      // The shaft runs to the through head base (or to the branch
      // fork when no through is present)
      const through = dirs.includes(0);
      const turns2 = dirs.filter((a) => a !== 0);
      const shaftTop = through ? len / 2 - headLen : len / 2 - headLen * 0.5;
      const p0 = loc(-len / 2, 0);
      const pTop = loc(shaftTop, 0);
      g.stroke([p0, pTop], shaftW, { color: arrowCol, cap: "round" });
      if (through) drawHead(loc(len / 2 - headLen, 0), ux, uy);
      for (const angle of turns2) {
        // branch: from the shaft's upper end diagonally into the
        // turn direction, capped to stay inside the lane
        const ex = Math.cos(angle),
          ey = Math.sin(angle);
        // PURE turn (no through on the shaft): the branch starts at
        // the shaft's very END — a true L. With a through head
        // sharing the shaft (through;right, left;through), the branch
        // leaves ~one head length below the end so the two heads stay
        // clearly apart
        const fork = loc(through ? shaftTop - headLen * 0.9 : shaftTop, 0);
        let dBranch = w * 1.1;
        const room = Math.max(lanePx / 2 - shaftW / 2 - w / 4, len * 0.05);
        if (Math.abs(ey) > 1e-6) {
          const dMax =
            (room - headLen * Math.abs(ey) - (w / 2) * Math.abs(ex)) /
            Math.abs(ey);
          if (dBranch > dMax) dBranch = Math.max(dMax, w * 0.3);
        }
        const P2: [number, number] = [
          fork[0] + (ux * ex - uy * ey) * dBranch,
          fork[1] + (ux * ey + uy * ex) * dBranch,
        ];
        g.stroke([fork, P2], shaftW, { color: arrowCol, cap: "round" });
        drawHead(P2, ux * ex - uy * ey, ux * ey + uy * ex);
      }
      return;
    }
    // single THROUGH: the classic straight shaft + forward head
    {
      const p0 = loc(-len / 2, 0);
      const pTop = loc(len / 2 - headLen, 0);
      g.stroke([p0, pTop], shaftW, { color: arrowCol, cap: "round" });
      drawHead(loc(len / 2 - headLen, 0), ux, uy);
    }
  };
  const drawRepeat = (turns: string[], laneIdx: number, dir: 1 | -1) => {
    let pts = lanePts(laneIdx);
    if (pts.length < 2) return;
    if (dir === -1) pts = pts.slice().reverse();
    // total arc length of the lane centreline in pixels
    let arc = 0;
    for (let i = 1; i < pts.length; i++)
      arc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const stepPx = ARROW_STEP * px;
    const insetPx = ARROW_INSET * px;
    if (arc < 2 * insetPx + stepPx * 0.5) {
      // very short piece: one centred arrow
      drawArrowAt(turns, pts, arc / 2);
      return;
    }
    for (let pos = insetPx; pos <= arc - insetPx; pos += stepPx)
      drawArrowAt(turns, pts, pos);
  };
  if (cl.turnLanesFwd && fwd > 0) {
    // forward lanes are the RIGHTMOST fwd lanes: lane index (from the
    // block's left) total-fwd .. total-1; turn:lanes lists the leftmost
    // FORWARD lane first. oneway=-1 flows against the way: the arrows
    // point at the way's start (dir -1) and each lane's offset in the
    // way frame flips sign (the leftmost lane in travel order is the
    // way frame's RIGHTMOST)
    const dir: 1 | -1 = cl.turnRev ? -1 : 1;
    for (let j = 0; j < fwd; j++) {
      const turns = cl.turnLanesFwd[j] ?? [];
      if (turns.length === 0) continue;
      drawRepeat(turns, cl.turnRev ? total - 1 - j : total - fwd + j, dir);
    }
  }
  if (cl.turnLanesBwd && fwd < total) {
    const bwd = total - fwd;
    // turn:lanes:backward lists the BACKWARD driver's leftmost lane
    // first; the backward lanes occupy the block's LEFT range in the
    // WAY frame, and the backward driver's leftmost is that range's
    // HIGHEST index (the driver travels against the way) — list index
    // j maps to block lane bwd-1-j (left|through rendered through|left
    // before)
    for (let j = 0; j < bwd; j++) {
      const turns = cl.turnLanesBwd[j] ?? [];
      if (turns.length === 0) continue;
      drawRepeat(turns, bwd - 1 - j, -1);
    }
  }
}

/** unit normal (left of the way) at vertex i of a centerline, in screen
 *  coords — helper for the non-spline fallback of the arrow renderer */
function normalOf(cl: LineFeature, i: number): [number, number] {
  const a = cl.coords[Math.max(0, i - 1)];
  const b = cl.coords[Math.min(cl.coords.length - 1, i + 1)];
  const ax = lonToX(a[0] / Q),
    ay = latToY(a[1] / Q);
  const bx = lonToX(b[0] / Q),
    by = latToY(b[1] / Q);
  const dx = bx - ax,
    dy = by - ay;
  const l = Math.hypot(dx, dy);
  return l > 0 ? [-dy / l, dx / l] : [0, 0];
}

/** walk a screen-space polyline backwards from its last point by the given
 *  pixel distance; null when the polyline is shorter than that */
/** position + unit direction of a screen-space polyline at `dist` pixels
 *  along its arc from the FRONT; null when the polyline is shorter */
function pointAndDirAtArc(
  pts: [number, number][],
  dist: number,
): { p: [number, number]; u: [number, number] } | null {
  let remaining = dist;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0],
      dy = pts[i][1] - pts[i - 1][1];
    const l = Math.hypot(dx, dy);
    if (l >= remaining) {
      const t = remaining / l;
      return {
        p: [pts[i - 1][0] + dx * t, pts[i - 1][1] + dy * t],
        u: [dx / l, dy / l],
      };
    }
    remaining -= l;
  }
  return null;
}

// ---------------- interaction ----------------
// Google Earth style: left-drag pans, wheel zooms to the cursor,
// right/middle-drag (or ctrl+drag) orbits heading+pitch, click picks.
let dragMode = 0; // 0 = none, 1 = pan, 2 = orbit
let lastX = 0,
  lastY = 0;
let moved = 0;

canvas.addEventListener("mousedown", (e) => {
  dragMode = e.button === 2 || e.button === 1 || e.ctrlKey ? 2 : 1;
  moved = 0;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.classList.add("dragging");
  if (e.button === 2 || e.button === 1) e.preventDefault();
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

function setViewFromWorld(tx: number, ty: number): void {
  view.cx = xToLon(tx);
  view.cy = yToLat(ty);
}

window.addEventListener("mousemove", (e) => {
  if (!dragMode) return;
  const dx = e.clientX - lastX,
    dy = e.clientY - lastY;
  moved += Math.abs(dx) + Math.abs(dy);
  lastX = e.clientX;
  lastY = e.clientY;
  if (dragMode === 2) {
    // orbit: horizontal drag turns heading, vertical drag tilts pitch
    cam.heading += dx * 0.005;
    cam.pitch = Math.max(0, Math.min(1.45, cam.pitch - dy * 0.005));
  } else {
    // pan: move the ground target opposite to the drag so the map follows
    // the cursor (camera right / ground-projected up axes)
    const s = view.scale / 2000;
    const r = g.groundRight(),
      u = g.groundUp();
    const tx = lonToX(view.cx),
      ty = latToY(view.cy);
    setViewFromWorld(
      tx - (dx * r[0] - dy * u[0]) / s,
      ty - (dx * r[1] - dy * u[1]) / s,
    );
  }
  requestDraw();
});
window.addEventListener("mouseup", () => {
  dragMode = 0;
  canvas.classList.remove("dragging");
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left,
      my = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const newScale = Math.max(500, Math.min(3_000_000, view.scale * factor));
    if (newScale === view.scale) return;
    // zoom towards the cursor: remember the ground point under it
    const under = g.screenToWorld(mx, my);
    view.scale = newScale;
    if (under) {
      g.setCamera(
        lonToX(view.cx),
        latToY(view.cy),
        newScale,
        cam.heading,
        cam.pitch,
      );
      const p = g.worldToScreen(under);
      const s2 = newScale / 2000;
      const r = g.groundRight(),
        u = g.groundUp();
      const tx = lonToX(view.cx),
        ty = latToY(view.cy);
      setViewFromWorld(
        tx + ((p[0] - mx) / s2) * r[0] + ((my - p[1]) / s2) * u[0],
        ty + ((p[0] - mx) / s2) * r[1] + ((my - p[1]) / s2) * u[1],
      );
    }
    requestDraw();
    statusEl.textContent = `zoom ${zoomLevel().toFixed(1)} (scale ${Math.round(view.scale)}) · ${__COMMIT__}`;
  },
  { passive: false },
);

// click -> feature inspection
canvas.addEventListener("click", (e) => {
  if (moved > 6 || !dataset) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left,
    my = e.clientY - rect.top;
  const gp = g.screenToWorld(mx, my);
  if (!gp) return;
  const bbox = viewBboxQ();
  const feature = pickFeature(
    Math.round(xToLon(gp[0]) * Q),
    Math.round(yToLat(gp[1]) * Q),
    bbox,
  );
  showInfo(feature);
});

function pickFeature(
  lonQ: number,
  latQ: number,
  bbox: [number, number, number, number],
):
  | (
      | AreaFeature
      | BuildingFeature
      | GrassFeature
      | LineFeature
      | KerbFeature
      | KerbWayFeature
      | BollardFeature
      | FenceFeature
      | LanduseFeature
      | StreetLampFeature
      | ParkingFeature
      | ManholeFeature
    )
  | null {
  const tol = 6;
  const tolQ = Math.round((tol / view.scale) * Q);

  // areas: point-in-polygon
  if (lodVisible("areas") && areaIndex) {
    const areaHits = queryIndex(areaIndex, [lonQ, latQ, lonQ, latQ]).filter(
      (a) => areaLodVisible(a) && layerVisible(a),
    );
    // bird's eye: prefer the locally highest layer at the click point
    if (selectedLayer === null && areaHits.length > 1) {
      areaHits.sort((a, b) => layerSortKey(b) - layerSortKey(a));
    }
    for (const area of areaHits) {
      let inOuter = false;
      for (const ring of area.outer)
        if (pointInRingQ(lonQ, latQ, ring)) {
          inOuter = true;
          break;
        }
      if (!inOuter) continue;
      let inHole = false;
      for (const hole of area.holes)
        if (pointInRingQ(lonQ, latQ, hole)) {
          inHole = true;
          break;
        }
      if (!inHole) return area;
    }
  }

  // grass: point-in-polygon
  if (lodVisible("grass") && grassIndex) {
    const gHits = queryIndex(grassIndex, [lonQ, latQ, lonQ, latQ]).filter((g) =>
      layerVisible(g),
    );
    if (selectedLayer === null && gHits.length > 1) {
      gHits.sort((a, b) => layerSortKey(b) - layerSortKey(a));
    }
    for (const g of gHits) {
      let inOuter = false;
      for (const ring of g.outer)
        if (pointInRingQ(lonQ, latQ, ring)) {
          inOuter = true;
          break;
        }
      if (!inOuter) continue;
      let inHole = false;
      for (const hole of g.holes)
        if (pointInRingQ(lonQ, latQ, hole)) {
          inHole = true;
          break;
        }
      if (!inHole) return g;
    }
  }
  // parking areas: point-in-polygon
  if (lodVisible("parking") && parkingIndex) {
    const pkHits = queryIndex(parkingIndex, [lonQ, latQ, lonQ, latQ]).filter(
      (pk) => layerVisible(pk),
    );
    if (selectedLayer === null && pkHits.length > 1) {
      pkHits.sort((a, b) => layerSortKey(b) - layerSortKey(a));
    }
    for (const pk of pkHits) {
      let inOuter = false;
      for (const ring of pk.outer)
        if (pointInRingQ(lonQ, latQ, ring)) {
          inOuter = true;
          break;
        }
      if (!inOuter) continue;
      let inHole = false;
      for (const hole of pk.holes)
        if (pointInRingQ(lonQ, latQ, hole)) {
          inHole = true;
          break;
        }
      if (!inHole) return pk;
    }
  }
  // landuse areas: point-in-polygon
  if (lodVisible("landuse") && landuseIndex) {
    const luHits = queryIndex(landuseIndex, [lonQ, latQ, lonQ, latQ]).filter(
      (lu) => layerVisible(lu),
    );
    if (selectedLayer === null && luHits.length > 1) {
      luHits.sort((a, b) => layerSortKey(b) - layerSortKey(a));
    }
    for (const lu of luHits) {
      let inOuter = false;
      for (const ring of lu.outer)
        if (pointInRingQ(lonQ, latQ, ring)) {
          inOuter = true;
          break;
        }
      if (!inOuter) continue;
      let inHole = false;
      for (const hole of lu.holes)
        if (pointInRingQ(lonQ, latQ, hole)) {
          inHole = true;
          break;
        }
      if (!inHole) return lu;
    }
  }
  // buildings: outline hit (point-in-polygon)
  if (lodVisible("buildings") && buildingIndex) {
    const bHits = queryIndex(buildingIndex, [lonQ, latQ, lonQ, latQ]).filter(
      (b) => layerVisible(b),
    );
    if (selectedLayer === null && bHits.length > 1) {
      bHits.sort((a, b) => layerSortKey(b) - layerSortKey(a));
    }
    for (const b of bHits) {
      for (const ring of b.outer) {
        if (pointInRingQ(lonQ, latQ, ring)) return b;
      }
    }
  }
  // fences: nearest segment within tolerance
  if (lodVisible("fences") && fenceIndex) {
    let best: { d: number; f: FenceFeature | null } = {
      d: tolQ * tolQ * 4,
      f: null,
    };
    const fHits = queryIndex(fenceIndex, [
      lonQ - tolQ * 6,
      latQ - tolQ * 6,
      lonQ + tolQ * 6,
      latQ + tolQ * 6,
    ]).filter((f) => layerVisible(f));
    for (const f of fHits) {
      for (let i = 1; i < f.coords.length; i++) {
        const d = distToSegQ(lonQ, latQ, f.coords[i - 1], f.coords[i]);
        if (d < best.d) {
          best.d = d;
          best.f = f;
        }
      }
    }
    if (best.f) return best.f;
  }
  // street lamps (points, closest)
  if (lodVisible("streetLamps") && streetLampGrid) {
    let best: { d: number; sl: StreetLampFeature | null } = {
      d: tolQ * tolQ * 4,
      sl: null,
    };
    const cx0 = Math.floor((lonQ - tolQ * 4) / 50000),
      cx1 = Math.floor((lonQ + tolQ * 4) / 50000);
    const cy0 = Math.floor((latQ - tolQ * 4) / 50000),
      cy1 = Math.floor((latQ + tolQ * 4) / 50000);
    for (let x = cx0; x <= cx1; x++) {
      for (let y = cy0; y <= cy1; y++) {
        const arr = streetLampGrid.get(x * 100000 + y);
        if (!arr) continue;
        for (const sl of arr) {
          if (!layerVisible(sl)) continue;
          const d = (sl.lon - lonQ) ** 2 + (sl.lat - latQ) ** 2;
          if (d < best.d) {
            best.d = d;
            best.sl = sl;
          }
        }
      }
    }
    if (best.sl) return best.sl;
  }
  // manholes (points, closest)
  if (lodVisible("manholes") && manholeGrid) {
    let best: { d: number; mh: ManholeFeature | null } = {
      d: tolQ * tolQ * 4,
      mh: null,
    };
    const cx0 = Math.floor((lonQ - tolQ * 4) / 50000),
      cx1 = Math.floor((lonQ + tolQ * 4) / 50000);
    const cy0 = Math.floor((latQ - tolQ * 4) / 50000),
      cy1 = Math.floor((latQ + tolQ * 4) / 50000);
    for (let x = cx0; x <= cx1; x++) {
      for (let y = cy0; y <= cy1; y++) {
        const arr = manholeGrid.get(x * 100000 + y);
        if (!arr) continue;
        for (const mh of arr) {
          if (!layerVisible(mh)) continue;
          const d = (mh.lon - lonQ) ** 2 + (mh.lat - latQ) ** 2;
          if (d < best.d) {
            best.d = d;
            best.mh = mh;
          }
        }
      }
    }
    if (best.mh) return best.mh;
  }
  // bollards (points, closest)
  if (lodVisible("bollards") && bollardGrid) {
    let best: { d: number; b: BollardFeature | null } = {
      d: tolQ * tolQ * 4,
      b: null,
    };
    const cx0 = Math.floor((lonQ - tolQ * 4) / 50000),
      cx1 = Math.floor((lonQ + tolQ * 4) / 50000);
    const cy0 = Math.floor((latQ - tolQ * 4) / 50000),
      cy1 = Math.floor((latQ + tolQ * 4) / 50000);
    for (let x = cx0; x <= cx1; x++) {
      for (let y = cy0; y <= cy1; y++) {
        const arr = bollardGrid.get(x * 100000 + y);
        if (!arr) continue;
        for (const b of arr) {
          if (!layerVisible(b)) continue;
          const d = (b.lon - lonQ) ** 2 + (b.lat - latQ) ** 2;
          if (d < best.d) {
            best.d = d;
            best.b = b;
          }
        }
      }
    }
    if (best.b) return best.b;
  }
  // kerb nodes (points, closest)
  if (lodVisible("kerbs") && kerbGrid) {
    let best: KerbFeature | null = null;
    let bestD = tolQ * tolQ * 4;
    const cx0 = Math.floor((lonQ - tolQ * 4) / 50000),
      cx1 = Math.floor((lonQ + tolQ * 4) / 50000);
    const cy0 = Math.floor((latQ - tolQ * 4) / 50000),
      cy1 = Math.floor((latQ + tolQ * 4) / 50000);
    for (let x = cx0; x <= cx1; x++) {
      for (let y = cy0; y <= cy1; y++) {
        const arr = kerbGrid.get(x * 100000 + y);
        if (!arr) continue;
        for (const k of arr) {
          if (!layerVisible(k)) continue;
          const d = (k.lon - lonQ) ** 2 + (k.lat - latQ) ** 2;
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
      }
    }
    if (best) return best;
  }

  // kerb ways: nearest segment within tolerance
  if (lodVisible("kerbs") && kerbWayIndex) {
    let best: { d: number; f: KerbWayFeature | null } = {
      d: tolQ * tolQ * 4,
      f: null,
    };
    const kwHits = queryIndex(kerbWayIndex, [
      lonQ - tolQ * 6,
      latQ - tolQ * 6,
      lonQ + tolQ * 6,
      latQ + tolQ * 6,
    ]).filter((kw) => layerVisible(kw));
    if (selectedLayer === null && kwHits.length > 1)
      kwHits.sort((a, b) => layerSortKey(b) - layerSortKey(a));
    for (const kw of kwHits) {
      for (let i = 1; i < kw.coords.length; i++) {
        const d = distToSegQ(lonQ, latQ, kw.coords[i - 1], kw.coords[i]);
        if (d < best.d) {
          best.d = d;
          best.f = kw;
        }
      }
    }
    if (best.f) return best.f;
  }

  // lines: nearest segment within tolerance
  if (lineIndexes) {
    const check = (
      feat: LineFeature,
      bestD: { d: number; f: LineFeature | null },
    ) => {
      for (let i = 1; i < feat.coords.length; i++) {
        const d = distToSegQ(lonQ, latQ, feat.coords[i - 1], feat.coords[i]);
        if (d < bestD.d) {
          bestD.d = d;
          bestD.f = feat;
        }
      }
    };
    let best: { d: number; f: LineFeature | null } = {
      d: tolQ * tolQ * 4,
      f: null,
    };
    const order: ("crossings" | "footways" | "centerlines")[] = [
      "crossings",
      "footways",
      "centerlines",
    ];
    for (const kind of order) {
      if (!lodVisible(kind)) continue;
      const hits = queryIndex(lineIndexes[kind], [
        lonQ - tolQ * 6,
        latQ - tolQ * 6,
        lonQ + tolQ * 6,
        latQ + tolQ * 6,
      ]).filter((f) => layerVisible(f));
      if (selectedLayer === null)
        hits.sort((a, b) => layerSortKey(b) - layerSortKey(a));
      for (const f of hits) {
        if (f.bbox[0] > lonQ + tolQ * 6 || f.bbox[2] < lonQ - tolQ * 6)
          continue;
        if (f.bbox[1] > latQ + tolQ * 6 || f.bbox[3] < latQ - tolQ * 6)
          continue;
        check(f, best);
      }
    }
    if (best.f) return best.f;
  }

  return null;
}

function pointInRingQ(x: number, y: number, ring: Q[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1];
    const xj = ring[j][0],
      yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function distToSegQ(px: number, py: number, a: Q[], b: Q[]): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - a[0]) * dx + (py - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return (px - (a[0] + t * dx)) ** 2 + (py - (a[1] + t * dy)) ** 2;
}

// ---------------- info panel ----------------
function showInfo(
  f:
    | AreaFeature
    | BuildingFeature
    | GrassFeature
    | LineFeature
    | KerbFeature
    | KerbWayFeature
    | BollardFeature
    | FenceFeature
    | LanduseFeature
    | StreetLampFeature
    | ParkingFeature
    | ManholeFeature
    | null,
) {
  if (!f) {
    infoEl.style.display = "none";
    return;
  }
  const rows: [string, string][] = [];
  const push = (k: string, v?: string | number) => {
    if (v !== undefined && v !== "") rows.push([k, String(v)]);
  };
  const feature = f as Feature;
  // captured before the per-type branches narrow f's type
  const ftype = feature.type;
  const fbbox = (feature as { bbox?: [number, number, number, number] }).bbox;

  push("layer", feature.layer);
  push("level", feature.level);
  if (f.type === "manhole") {
    rows.push(["feature", `man_made=manhole (${f.id})`]);
    return;
  }
  if (f.type === "parking") {
    rows.push(["feature", `amenity=parking (${f.id})`]);
    push("surface", f.surface);
    push("surface:colour", f.surfaceColour);
    return;
  }
  if (f.type === "streetlamp") {
    rows.push(["feature", `highway=street_lamp (${f.id})`]);
    return;
  }
  if (f.type === "landuse") {
    rows.push(["feature", `landuse=${f.kind} (${f.id})`]);
    return;
  }
  if (f.type === "bollard") {
    rows.push(["feature", `barrier=bollard (${f.id})`]);
    return;
  }
  if (f.type === "fence") {
    rows.push(["feature", `barrier=fence (${f.id})`]);
    push("fence_type", f.fence);
    return;
  }
  if (f.type === "grass") {
    rows.push(["feature", `green area (${f.id})`]);
    push("kind", f.kind);
    return;
  }
  if (f.type === "building") {
    rows.push(["feature", `building (${f.id})`]);
    push("building", f.building);
    push("usage", f.usage);
    push("name", f.name);
    return;
  }
  if (f.type === "area") {
    rows.push(["feature", `area:highway (${f.id})`]);
    push("highway (area)", f.highway);
    push("surface", f.surface);
    push("surface:colour", f.surfaceColour);
    push("name", f.name);
    push("wheelchair", f.wheelchair);
    push("lit", f.lit);
  } else if (f.type === "kerb") {
    rows.push(["feature", `kerb (${f.id})`]);
    push("kerb", f.kerb);
    push("tactile_paving", f.tactilePaving);
  } else if (f.type === "kerbway") {
    rows.push(["feature", `kerb way (${f.id})`]);
    push("kerb", f.kerb);
    push("tactile_paving", f.tactilePaving);
  } else {
    rows.push(["feature", `${f.type} (${f.id})`]);
    push("highway", f.highway);
    push("footway", f.footway);
    push("crossing", f.crossing);
    push("crossing:markings", f.crossingMarkings);
    push("surface", f.surface);
    push("width", f.width ? `${f.width} m` : undefined);
    push("lit", f.lit);
    push("name", f.name);
  }

  const osmLink = (id: string): string | null => {
    const m = /^([wnr])(\d+)$/.exec(id);
    if (!m) return null;
    const type = m[1] === "w" ? "way" : m[1] === "n" ? "node" : "relation";
    return `https://www.openstreetmap.org/${type}/${m[2]}`;
  };

  const link = osmLink(f.id);
  // Overpass query fetching everything relevant in/around the feature, so a
  // bug report can include all the data the extractor sees: polygon
  // features (areas, buildings, grass, parking, landuse) query their bbox
  // for ways/nodes the extractor consumes; anything else queries a small
  // radius around its own bbox
  const overpassLink = (): string | null => {
    const b = fbbox;
    if (!b) return null;
    const minLat = b[1] / 1e7,
      minLon = b[0] / 1e7,
      maxLat = b[3] / 1e7,
      maxLon = b[2] / 1e7;
    const isPolygon =
      ftype === "area" ||
      ftype === "parking" ||
      ftype === "building" ||
      ftype === "grass" ||
      ftype === "landuse";
    const bboxQ = `(${minLat},${minLon},${maxLat},${maxLon})`;
    let query: string;
    if (isPolygon) {
      query =
        "[out:json][timeout:60];(" +
        `way["highway"]${bboxQ};` +
        `way["area:highway"]${bboxQ};` +
        `way["barrier"="kerb"]${bboxQ};` +
        `way["amenity"="parking"]${bboxQ};` +
        `node["barrier"="kerb"]${bboxQ};` +
        `node["barrier"="bollard"]${bboxQ};` +
        `node["highway"="traffic_signals"]${bboxQ};` +
        ");out geom tags;";
    } else {
      query =
        "[out:json][timeout:60];(" +
        `way(around:15,${minLat},${minLon})["highway"];` +
        `way(around:15,${minLat},${minLon})["area:highway"];` +
        `node(around:15,${minLat},${minLon})["highway"="traffic_signals"];` +
        ");out geom tags;";
    }
    return "https://overpass-turbo.eu/?Q=" + encodeURIComponent(query) + "&R";
  };
  const oplink = overpassLink();
  infoEl.innerHTML =
    `<span class="close" onclick="this.parentElement.style.display='none'">✕</span>` +
    rows
      .map(
        ([k, v]) =>
          `<div class="tag"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>`,
      )
      .join("") +
    (link
      ? `<div class="tag"><span class="k">osm</span><span class="v"><a href="${link}" target="_blank" rel="noopener">${link}</a></span></div>`
      : "") +
    (oplink
      ? `<div class="tag"><span class="k">overpass</span><span class="v"><a href="${oplink}" target="_blank" rel="noopener">fetch relevant elements</a></span></div>`
      : "");
  infoEl.style.display = "block";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------- layer panel ----------------

const SELECT_STYLE =
  "width:100%;margin-bottom:10px;padding:4px 6px;border-radius:6px;" +
  "background:#2a2a30;color:#eee;border:1px solid #444;font-size:12px;";

let layerSelect: HTMLSelectElement | null = null;
let levelSelect: HTMLSelectElement | null = null;

/** values present among features intersecting the current viewport */
function viewportValues(): { layers: Set<number>; levels: Set<number> } {
  const bbox = viewBboxQ();
  const layers = new Set<number>();
  const levels = new Set<number>();
  const seen = new Set<Feature>();
  const add = (f: Feature) => {
    if (seen.has(f)) return;
    seen.add(f);
    layers.add(f.layer ?? 0);
    if (f.level !== undefined) levels.add(f.level);
  };
  if (dataset) {
    if (areaIndex) for (const a of queryIndex(areaIndex, bbox)) add(a);
    if (buildingIndex) for (const b of queryIndex(buildingIndex, bbox)) add(b);
    if (grassIndex) for (const g of queryIndex(grassIndex, bbox)) add(g);
    if (lineIndexes) {
      for (const c of queryIndex(lineIndexes.centerlines, bbox)) add(c);
      for (const f of queryIndex(lineIndexes.footways, bbox)) add(f);
      for (const c of queryIndex(lineIndexes.crossings, bbox)) add(c);
    }
    if (laneMarkingIndex)
      for (const lm of queryIndex(laneMarkingIndex, bbox)) add(lm);
    if (kerbWayIndex) for (const k of queryIndex(kerbWayIndex, bbox)) add(k);
    if (fenceIndex) for (const f of queryIndex(fenceIndex, bbox)) add(f);
    if (landuseIndex) for (const lu of queryIndex(landuseIndex, bbox)) add(lu);
    if (parkingIndex) for (const pk of queryIndex(parkingIndex, bbox)) add(pk);
    if (manholeGrid) {
      for (const cell of cellsForBbox(bbox, 50000)) {
        const arr = manholeGrid.get(cell);
        if (arr) for (const mh of arr) add(mh);
      }
    }
    if (streetLampGrid) {
      for (const cell of cellsForBbox(bbox, 50000)) {
        const arr = streetLampGrid.get(cell);
        if (arr) for (const sl of arr) add(sl);
      }
    }
    if (bollardGrid) {
      for (const cell of cellsForBbox(bbox, 50000)) {
        const arr = bollardGrid.get(cell);
        if (arr) for (const b of arr) add(b);
      }
    }
    if (kerbGrid) {
      for (const cell of cellsForBbox(bbox, 50000)) {
        const arr = kerbGrid.get(cell);
        if (arr) for (const k of arr) add(k);
      }
    }
  }
  return { layers, levels };
}

/**
 * Rebuild the layer and level selector options from the features currently in
 * the viewport. Only values present in the viewport are offered; the selectors
 * are hidden entirely when the viewport has fewer than two distinct values.
 */
function updateSelectors() {
  const inView = viewportValues();

  // layer selector
  const viewLayers = [...inView.layers].sort((a, b) => b - a);
  if (layerSelect) {
    const prev = layerSelect.value;
    layerSelect.innerHTML = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "all layers (highest visible)";
    layerSelect.appendChild(def);
    for (const l of viewLayers) {
      const opt = document.createElement("option");
      opt.value = String(l);
      opt.textContent = `layer ${l} only`;
      layerSelect.appendChild(opt);
    }
    layerSelect.value = viewLayers.some((l) => String(l) === prev) ? prev : "";
    if (!viewLayers.some((l) => String(l) === prev)) selectedLayer = null;
    layerSelect.style.display = viewLayers.length > 1 ? "" : "none";
  }

  // level selector
  const viewLevels = [...inView.levels].sort((a, b) => b - a);
  if (levelSelect) {
    const prev = levelSelect.value;
    levelSelect.innerHTML = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "all levels";
    levelSelect.appendChild(def);
    for (const l of viewLevels) {
      const opt = document.createElement("option");
      opt.value = String(l);
      opt.textContent = `level ${l} only`;
      levelSelect.appendChild(opt);
    }
    levelSelect.value = viewLevels.some((l) => String(l) === prev) ? prev : "";
    if (!viewLevels.some((l) => String(l) === prev)) selectedLevel = null;
    levelSelect.style.display = viewLevels.length > 1 ? "" : "none";
  }
}

function buildLayerPanel() {
  const wrap = document.getElementById("layers")!;
  wrap.innerHTML = "";

  // OSM layer selector
  layerSelect = document.createElement("select");
  layerSelect.id = "layerSelect";
  layerSelect.style.cssText = SELECT_STYLE;
  layerSelect.addEventListener("change", () => {
    const v = layerSelect!.value;
    selectedLayer = v === "" ? null : parseInt(v, 10);
    requestDraw();
  });
  wrap.appendChild(layerSelect);

  // OSM level selector
  levelSelect = document.createElement("select");
  levelSelect.id = "levelSelect";
  levelSelect.style.cssText = SELECT_STYLE;
  levelSelect.addEventListener("change", () => {
    const v = levelSelect!.value;
    selectedLevel = v === "" ? null : parseFloat(v);
    requestDraw();
  });
  wrap.appendChild(levelSelect);

  updateSelectors();

  // lane marking smoothness selector: piece-wise linear vs interpolating
  const smoothSelect = document.createElement("select");
  smoothSelect.id = "laneSmoothSelect";
  smoothSelect.style.cssText = SELECT_STYLE;
  for (const [value, label] of [
    ["spline", "lane markings: smooth (spline)"],
    ["linear", "lane markings: piece-wise linear"],
    ["samples", "lane markings: middle line sample points"],
  ] as [string, string][]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    smoothSelect.appendChild(opt);
  }
  smoothSelect.value = laneSmoothness;
  smoothSelect.addEventListener("change", () => {
    laneSmoothness = smoothSelect.value as "spline" | "linear" | "samples";
    requestDraw();
  });
  wrap.appendChild(smoothSelect);

  // wireframe mode toggle (also on the "w" key)
  const wireRow = document.createElement("div");
  wireRow.className = "layer";
  wireRow.innerHTML =
    `<div class="swatch" style="background:transparent;border:1px solid #7ec8ff"></div>` +
    `<label><input type="checkbox" id="wireframeToggle"/> wireframe (w)</label>`;
  (wireRow.querySelector("input") as HTMLInputElement).addEventListener(
    "change",
    (e) => {
      wireframe = (e.target as HTMLInputElement).checked;
      requestDraw();
    },
  );
  wrap.appendChild(wireRow);
  window.addEventListener("keydown", (e) => {
    if (e.key === "w" && !(e.target instanceof HTMLInputElement)) {
      wireframe = !wireframe;
      const cb = document.getElementById("wireframeToggle") as HTMLInputElement | null;
      if (cb) cb.checked = wireframe;
      requestDraw();
    }
  });

  const defs: { key: keyof typeof layers; label: string; swatch: string }[] = [
    { key: "areas", label: "highway areas (surface fill)", swatch: "#6d6055" },
    { key: "buildings", label: "buildings", swatch: "#f0b98a" },
    {
      key: "landuse",
      label: "landuse res./comm.",
      swatch: PATTERN_AVG.paving_stones,
    },
    { key: "parking", label: "parking", swatch: "#4a4a50" },
    { key: "grass", label: "grass / garden / scrub", swatch: "#5d7a44" },
    { key: "centerlines", label: "centerlines (surface)", swatch: "#7a6a52" },
    { key: "laneMarkings", label: "lane markings", swatch: "#e8e8e8" },
    { key: "footways", label: "footways / sidewalks", swatch: "#cfcfd6" },
    { key: "crossings", label: "crossings (markings)", swatch: "#e8e8e8" },
    { key: "kerbs", label: "kerbs", swatch: "#3a3a3e" },
    { key: "bollards", label: "bollards", swatch: "#2f3134" },
    { key: "streetLamps", label: "street lamps", swatch: "#ffe178" },
    { key: "manholes", label: "manholes", swatch: "#2f3134" },
    { key: "fences", label: "fences", swatch: "#1a1a1a" },
  ];
  for (const d of defs) {
    const row = document.createElement("div");
    row.className = "layer";
    row.innerHTML =
      `<div class="swatch" style="background:${d.swatch}"></div>` +
      `<label><input type="checkbox" ${layers[d.key] ? "checked" : ""}/> ${d.label}</label>` +
      `<span class="count">${countFor(d.key)}</span>`;
    (row.querySelector("input") as HTMLInputElement).addEventListener(
      "change",
      (e) => {
        layers[d.key] = (e.target as HTMLInputElement).checked;
        requestDraw();
      },
    );
    wrap.appendChild(row);
  }

  // legend
  const legend = document.getElementById("legendSurfaces")!;
  legend.innerHTML = "";
  const surfaces = [
    "asphalt",
    "concrete",
    "sett",
    "paving_stones",
    "cobblestone",
    "gravel",
    "grass",
    "compacted",
  ];
  for (const s of surfaces) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div class="sw" style="background:${surfaceColor(s)}"></div>${s}`;
    legend.appendChild(row);
  }
  const kerbLegend = document.createElement("div");
  kerbLegend.style.cssText = "color:#888;margin-top:6px;margin-bottom:4px";
  kerbLegend.textContent = "kerbs";
  legend.appendChild(kerbLegend);
  for (const [label, color] of [
    ["raised", "#e86e6e"],
    ["lowered", "#4ac8e8"],
    ["flush", "#9a6ee8"],
    ["tactile", "#e8c04a"],
  ] as [string, string][]) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div class="sw" style="background:${color};border-radius:50%;width:10px"></div>${label}`;
    legend.appendChild(row);
  }
}

function countFor(key: keyof typeof layers): string {
  if (!dataset) return "";
  switch (key) {
    case "areas":
      return dataset.areas.length.toLocaleString();
    case "buildings":
      return dataset.buildings.length.toLocaleString();
    case "landuse":
      return dataset.landuse.length.toLocaleString();
    case "parking":
      return dataset.parking.length.toLocaleString();
    case "manholes":
      return dataset.manholes.length.toLocaleString();
    case "grass":
      return dataset.grass.length.toLocaleString();
    case "centerlines":
      return dataset.centerlines.length.toLocaleString();
    case "laneMarkings":
      return dataset.laneMarkings.length.toLocaleString();
    case "footways":
      return dataset.footways.length.toLocaleString();
    case "crossings":
      return dataset.crossings.length.toLocaleString();
    case "kerbs":
      return (dataset.kerbs.length + dataset.kerbWays.length).toLocaleString();
    case "bollards":
      return dataset.bollards.length.toLocaleString();
    case "streetLamps":
      return dataset.streetLamps.length.toLocaleString();
    case "fences":
      return dataset.fences.length.toLocaleString();
    default:
      return "";
  }
}

// ---------------- boot ----------------
let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
    updateSelectors();
    syncUrl();
  });
}

window.addEventListener("resize", requestDraw);
/** whether the URL carried a viewport hash at page load — if so, the
 *  restored view is kept on load; otherwise the first load centers on the
 *  data bounds (a hash written by our own boot draw must not count) */
let urlHashAtBoot = viewFromUrl();
void triReady.then(() => requestDraw());
// when deployed with the bundled example (public/data), open straight into
// it — the camera centers on the data bounds via fitToBounds()
void loadBundledExample();

// ---------------- URL viewport sync ----------------

/** write the current viewport (zoom, center, heading, pitch) into the URL hash */
function syncUrl(): void {
  const z = zoomLevel().toFixed(2);
  const hdg = ((cam.heading * 180) / Math.PI).toFixed(1);
  const pitch = ((cam.pitch * 180) / Math.PI).toFixed(1);
  const hash = `#map=${z}/${view.cy.toFixed(6)}/${view.cx.toFixed(6)}/${hdg}/${pitch}`;
  if (location.hash !== hash) {
    history.replaceState(null, "", hash);
  }
}

/** restore the viewport from the URL hash; false when absent/invalid */
function viewFromUrl(): boolean {
  const m = /^#map=([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)(?:\/(-?[\d.]+)\/(-?[\d.]+))?$/.exec(
    location.hash,
  );
  if (!m) return false;
  const z = parseFloat(m[1]);
  const lat = parseFloat(m[2]);
  const lon = parseFloat(m[3]);
  if (!Number.isFinite(z) || !Number.isFinite(lat) || !Number.isFinite(lon))
    return false;
  if (lat < -85 || lat > 85 || lon < -180 || lon > 180) return false;
  // the app clamps scale to [500, 3_000_000] ~ zoom [2.1, 33.6]
  if (z < 2 || z > 34) return false;
  // zoom -> scale: invert zoomLevel() = log2(scale/1200)*2 + 11
  const scale = 1200 * Math.pow(2, (z - 11) / 2);
  view = { cx: lon, cy: lat, scale: Math.max(500, Math.min(3_000_000, scale)) };
  if (m[4] !== undefined && m[5] !== undefined) {
    const hdg = parseFloat(m[4]);
    const pitch = parseFloat(m[5]);
    if (Number.isFinite(hdg) && Number.isFinite(pitch)) {
      cam.heading = (hdg * Math.PI) / 180;
      cam.pitch = Math.max(0, Math.min(1.45, (pitch * Math.PI) / 180));
    }
  }
  return true;
}

function fitToBounds(bounds: [number, number, number, number]) {
  const [minX, minY, maxX, maxY] = bounds;
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;
  const cx = (minX + maxX) / 2 / Q;
  const cy = (minY + maxY) / 2 / Q;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const fitW = (w * 0.9) / Math.max((maxX - minX) / Q, 1e-9);
  const fitH =
    (h * 0.9) /
    Math.max(((maxY - minY) / Q) * Math.cos((cy * Math.PI) / 180), 1e-9);
  view = {
    cx,
    cy,
    scale: Math.max(500, Math.min(3_000_000, Math.min(fitW, fitH))),
  };
  statusEl.textContent = `zoom ${zoomLevel().toFixed(1)} (scale ${Math.round(view.scale)}) · ${__COMMIT__}`;
  requestDraw();
}

let currentWorker: Worker | null = null;

function loadPbfFile(file: File) {
  file.arrayBuffer().then((buf) => loadPbfBuffer(buf, file.name));
}

/** load the bundled Berlin example (public/data) when the page is deployed
 *  with it; false when there is none (plain drag & drop then). With no URL
 *  hash, ingestResult falls back to fitToBounds(), so the camera centers on
 *  the loaded data and something is visible immediately. */
async function loadBundledExample(): Promise<boolean> {
  try {
    const res = await fetch("data/berlin-example.osm.pbf");
    if (!res.ok) return false;
    const h = new HeightField();
    await h.loadDem("data/dem/dgm1-berlin-example.json");
    await h.loadDom("data/dem/dom1-berlin-example.json");
    hf = h.ready ? h : null;
    const buf = await res.arrayBuffer();
    loadPbfBuffer(buf, "berlin-example.osm.pbf");
    return true;
  } catch {
    return false;
  }
}

function loadPbfBuffer(buf: ArrayBuffer, name: string) {
  if (currentWorker) currentWorker.terminate();
  const worker = new Worker(new URL("./src/worker.ts", import.meta.url), {
    type: "module",
  });
  currentWorker = worker;
  const loadStart = performance.now();

  const dropzone = document.getElementById("dropzone")!;
  const pbar = document.getElementById("progressbar")!;
  const pfill = document.getElementById("pbrfill") as HTMLDivElement;
  const plabel = document.getElementById("pbrlabel")!;
  const spinner = document.getElementById("spinner")!;
  const spinnerTxt = document.getElementById("spinnertxt")!;
  dropzone.style.display = "none";
  pbar.style.display = "block";
  spinner.style.display = "block";
  spinnerTxt.textContent = `loading ${name}…`;
  document.getElementById("layers")!.style.display = "none";
  statusEl.textContent = `loading ${name} (${(buf.byteLength / 1e6).toFixed(1)} MB)…`;

  worker.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.type === "progress") {
      pfill.style.width = `${Math.min(100, m.pct).toFixed(1)}%`;
      plabel.textContent = `${m.phase} — ${Math.min(100, m.pct).toFixed(0)}% (${m.msg})`;
      statusEl.textContent = `${m.phase}…`;
      spinnerTxt.textContent = `${m.phase} — ${Math.min(100, m.pct).toFixed(0)}%`;
    } else if (m.type === "timing") {
      // step runtimes so far, newest last — logged as a whole on done
      (worker as unknown as { __timings: unknown[] }).__timings = m.timings;
    } else if (m.type === "done") {
      const t1 = performance.now();
      ingestResult(m.result as ExtractResult, name);
      const t2 = performance.now();
      const timings = (m.timings ?? []) as { step: string; sec: number }[];
      const pbfMs = (timings.find((t) => t.step === "parse PBF")?.sec ?? 0) * 1000;
      const extractMs = timings
        .filter((t) => t.step.startsWith("extract:"))
        .reduce((sum, t) => sum + t.sec * 1000, 0);
      timings.push({ step: "main: ingest + index", sec: (t2 - t1) / 1000 });
      timings.push({ step: "TOTAL", sec: (t2 - loadStart) / 1000 });
      console.group(`load ${name}: step runtimes (ms)`);
      for (const { step, sec } of timings)
        console.log(`${step.padEnd(48)} ${(sec * 1000).toFixed(0)} ms`);
      console.groupEnd();
      console.log(
        `PBF parsed in ${pbfMs.toFixed(0)} ms, features extracted in ${extractMs.toFixed(0)} ms (total ${(t2 - loadStart).toFixed(0)} ms)`,
      );
      worker.terminate();
      currentWorker = null;
      pbar.style.display = "none";
      spinner.style.display = "none";
      dropzone.style.display = "block";
      document.getElementById("layers")!.style.display = "block";
      document.getElementById("zoomhint")!.style.display = "block";
      document.getElementById("legend")!.style.display = "block";
    } else if (m.type === "error") {
      statusEl.textContent = `error: ${m.message}`;
      pbar.style.display = "none";
      spinner.style.display = "none";
      dropzone.style.display = "block";
      worker.terminate();
      currentWorker = null;
    }
  };

  worker.postMessage({ type: "parse", buffer: buf, name }, [buf]);
}

function ingestResult(result: ExtractResult, name: string) {
  g.clearPatternCache();
  const t0 = performance.now();
  datasetBounds = result.bounds;
  osmLayers = result.layers ?? [];
  osmLevels = result.levels ?? [];
  selectedLayer = null;
  selectedLevel = null;
  buildingIndex = buildIndex(result.buildings);
  grassIndex = buildIndex(result.grass);
  dataset = {
    areas: result.areas,
    buildings: result.buildings,
    grass: result.grass,
    centerlines: result.centerlines,
    footways: result.footways,
    crossings: result.crossings,
    kerbs: result.kerbs,
    kerbWays: result.kerbWays,
    bollards: result.bollards,
    fences: result.fences,
    landuse: result.landuse,
    streetLamps: result.streetLamps,
    parking: result.parking,
    manholes: result.manholes,
    laneMarkings: result.laneMarkings,
    stopLines: result.stopLines,
  };
  areaIndex = buildIndex(dataset.areas);
  lineIndexes = {
    centerlines: buildIndex(dataset.centerlines),
    footways: buildIndex(dataset.footways),
    crossings: buildIndex(dataset.crossings),
  };
  kerbWayIndex = buildIndex(dataset.kerbWays);
  fenceIndex = buildIndex(dataset.fences);
  landuseIndex = buildIndex(dataset.landuse);
  parkingIndex = buildIndex(result.parking);
  manholeGrid = new Map();
  for (const mh of result.manholes) {
    const key =
      Math.floor(mh.lon / 50000) * 100000 + Math.floor(mh.lat / 50000);
    let arr = manholeGrid.get(key);
    if (!arr) manholeGrid.set(key, (arr = []));
    arr.push(mh);
  }
  streetLampGrid = new Map();
  for (const sl of dataset.streetLamps) {
    const key =
      Math.floor(sl.lon / 50000) * 100000 + Math.floor(sl.lat / 50000);
    let arr = streetLampGrid.get(key);
    if (!arr) streetLampGrid.set(key, (arr = []));
    arr.push(sl);
  }
  bollardGrid = new Map();
  for (const b of dataset.bollards) {
    const key = Math.floor(b.lon / 50000) * 100000 + Math.floor(b.lat / 50000);
    let barr = bollardGrid.get(key);
    if (!barr) bollardGrid.set(key, (barr = []));
    barr.push(b);
  }
  laneMarkingIndex = buildIndex(dataset.laneMarkings);
  stopLineIndex = buildIndex(dataset.stopLines);
  setupHeights();
  // strokes/points without an explicit zAt (kerbs, lane markings, lamps, ...)
  // stick to the road/landuse area they belong to
  g.zAtDefault = hf && hf.ready ? stickZAt : null;
  kerbGrid = new Map();
  for (const k of dataset.kerbs) {
    const key = Math.floor(k.lon / 50000) * 100000 + Math.floor(k.lat / 50000);
    let arr = kerbGrid.get(key);
    if (!arr) kerbGrid.set(key, (arr = []));
    arr.push(k);
  }
  const total =
    dataset.areas.length +
    dataset.buildings.length +
    dataset.grass.length +
    dataset.centerlines.length +
    dataset.footways.length +
    dataset.crossings.length +
    dataset.kerbs.length +
    dataset.kerbWays.length +
    dataset.bollards.length +
    dataset.fences.length +
    dataset.landuse.length +
    dataset.streetLamps.length +
    dataset.parking.length +
    dataset.manholes.length;
  if (total === 0) {
    statusEl.textContent = `no micromapping features found in ${name} (try a region with area:highway mapping)`;
    return;
  }
  buildLayerPanel();
  // keep the current viewport when the URL carries one (hot-reload style
  // testing: reload, drop the PBF, land on the same spot); otherwise fit
  if (!urlHashAtBoot) {
    fitToBounds(result.bounds);
    urlHashAtBoot = true; // later loads keep the current viewport
  }
  statusEl.textContent = `${name}: loaded ${total.toLocaleString()} features in ${((performance.now() - t0) / 1000).toFixed(1)}s — scroll to zoom, drag to pan, right-drag to orbit · ${__COMMIT__}`;
  requestDraw();
}

// ---- drag & drop wiring ----
const dropzone = document.getElementById("dropzone")!;
const fileInput = document.getElementById("fileinput") as HTMLInputElement;

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) loadPbfFile(f);
  fileInput.value = "";
});

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("over");
});
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) dropzone.classList.remove("over");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("over");
  const f = e.dataTransfer?.files?.[0];
  if (f) loadPbfFile(f);
});

// expose view control + picking probe for tests/tools
(window as any).__setView = (cx: number, cy: number, scale: number) => {
  view = { cx, cy, scale };
  requestDraw();
};
(window as any).__pick = (px: number, py: number) => {
  const gp = g.screenToWorld(px, py);
  if (!gp) return null;
  return pickFeature(
    Math.round(xToLon(gp[0]) * Q),
    Math.round(yToLat(gp[1]) * Q),
    viewBboxQ(),
  );
};
(window as any).__scene = () => scene;
(window as any).__state = () => ({
  hasDataset: dataset !== null,
  sceneCmds: scene?.totalCmds ?? -1,
  areas: dataset?.areas.length ?? 0,
  buildings: dataset?.buildings.length ?? 0,
  grass: dataset?.grass.length ?? 0,
  footways: dataset?.footways.length ?? 0,
  osmLayers,
  selectedLayer,
});
