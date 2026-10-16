import { buildIndex, queryIndex, type Indexed } from "./src/loader";
import type { ExtractResult } from "./src/extract";
import type { AreaFeature, BuildingFeature, GrassFeature, LineFeature, KerbFeature, KerbWayFeature, BollardFeature, FenceFeature, LanduseFeature, Dataset, Feature, Q } from "./src/features";
import { surfaceColor, normalizeSurface } from "./src/features";

const canvas = document.getElementById("map") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const statusEl = document.getElementById("status")!;
const infoEl = document.getElementById("info")!;

interface View {
  cx: number;
  cy: number;
  scale: number; // pixels per degree longitude
}

let view: View = { cx: 10.0, cy: 51.0, scale: 2000 };
let dataset: Dataset | null = null;
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
let laneMarkingIndex: Indexed<LineFeature> | null = null;

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
};

/**
 * Level of detail: minimum pixels per meter at which a feature class is drawn.
 * Highway areas are the most interesting part and always render; everything
 * else fades out when its geometry would collapse below a few pixels and
 * only add visual noise. Thresholds chosen from typical OSM micromapping
 * dimensions (a kerb is ~10cm high, markings ~50cm wide, sidewalks ~2m).
 */
const LOD: Record<keyof typeof layers, number> = {
  areas: 0,        // always
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
};

const MAJOR_ROADS = new Set([
  "motorway", "trunk", "primary", "secondary",
  "motorway_link", "trunk_link", "primary_link", "secondary_link",
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
  if (selectedLevel !== null && f.level !== undefined && f.level !== selectedLevel) return false;
  return true;
}

/** sort key: bird's eye draws ascending layers first */
function layerSortKey(f: { layer?: number; level?: number }): number {
  return (f.layer ?? 0) * 100 + (f.level ?? 0);
}

// ---------------- projection ----------------
const Q = 1e7;
function mercY(latDeg: number): number {
  const clamped = Math.max(-85, Math.min(85, latDeg));
  const rad = (clamped * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + rad / 2));
}
function lonToX(lonDeg: number): number {
  return ((lonDeg - view.cx) * Math.PI) / 180 * R() + canvas.width / 2;
}
function latToY(latDeg: number): number {
  return -(mercY(latDeg) - mercY(view.cy)) * R() + canvas.height / 2;
}
/** R: pixels per radian of longitude. Keeps x/y scales equal (no distortion). */
function R(): number {
  return view.scale * (180 / Math.PI);
}
/**
 * Pixels per meter on the ground at the current view latitude. Mercator
 * stretches by 1/cos(lat): one radian of longitude spans 6_371_000 * cos(lat)
 * meters on the ground, so the equator-only formula underestimates by ~40%
 * at mid latitudes (e.g. Berlin) and lane/crossing sizes look too small.
 */
function pxPerMeter(): number {
  return R() / (6_371_000 * Math.cos((view.cy * Math.PI) / 180));
}
function viewBboxQ(): [number, number, number, number] {
  const degPerPx = 180 / (Math.PI * R());
  const halfW = (canvas.width / 2) * degPerPx;
  const halfH = (canvas.height / 2) * degPerPx * Math.cos((view.cy * Math.PI) / 180) * 1.1;
  return [
    Math.round((view.cx - halfW) * Q),
    Math.round((view.cy - halfH) * Q),
    Math.round((view.cx + halfW) * Q),
    Math.round((view.cy + halfH) * Q),
  ];
}

// ---------------- rendering ----------------
function drawRing(ring: Q[][], close: boolean) {
  if (ring.length === 0) return;
  ctx.moveTo(lonToX(ring[0][0] / Q), latToY(ring[0][1] / Q));
  for (let i = 1; i < ring.length; i++) {
    ctx.lineTo(lonToX(ring[i][0] / Q), latToY(ring[i][1] / Q));
  }
  if (close) ctx.closePath();
}

function strokePolyline(coords: Q[][]) {
  if (coords.length < 2) return;
  let lastX = lonToX(coords[0][0] / Q);
  let lastY = latToY(coords[0][1] / Q);
  ctx.moveTo(lastX, lastY);
  for (let i = 1; i < coords.length; i++) {
    const x = lonToX(coords[i][0] / Q);
    const y = latToY(coords[i][1] / Q);
    const dx = x - lastX, dy = y - lastY;
    // skip vertices closer than ~2px on screen to the last drawn vertex
    if (dx * dx + dy * dy < 4 && i < coords.length - 1) continue;
    ctx.lineTo(x, y);
    lastX = x; lastY = y;
  }
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
function featureColor(surface: string | undefined, colour: string | undefined): string {
  if (colour) {
    ctx.fillStyle = "#000";
    ctx.fillStyle = colour;
    if (ctx.fillStyle !== "#000000") return ctx.fillStyle as string;
  }
  const key = surface ? normalizeSurfaceKey(surface) : "";
  if (PATTERN_AVG[key]) return PATTERN_AVG[key];
  return surfaceColor(normalizeSurface(surface) ?? undefined);
}

// ---------------- surface patterns ----------------

/** deterministic pseudo-random from an integer seed */
function rand(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** stone tile pattern in a greyish tone; null for plain surfaces */
/** base green tone per green kind: scrub darker than grass/garden */
function greenBase(kind: string): [number, number, number] {
  if (kind === "scrub") return [73, 94, 55];
  return [93, 122, 68]; // #5d7a44
}

function greenColor(kind: string): string {
  const [r, g, b] = greenBase(kind);
  return `rgb(${r},${g},${b})`;
}

/**
 * Grass-like texture: mottled patches of varying greens over a base tone,
 * so large areas don't read as one flat color. Deterministic per tile cell.
 */
function grassPatternTile(kind: string): CanvasPattern | null {
  // constant screen-space patch size (see stone pattern)
  const cell = 6;
  const tile = document.createElement("canvas");
  tile.width = cell * 2;
  tile.height = cell * 2;
  const tctx = tile.getContext("2d")!;
  const base = greenBase(kind);
  tctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  tctx.fillRect(0, 0, tile.width, tile.height);
  // 2x2 patch cells, each seeded: mix of lighter/darker greens
  for (let ry = 0; ry < 2; ry++) {
    for (let rx = 0; rx < 2; rx++) {
      const seed = ry * 13 + rx * 7 + 5;
      // vary brightness and hue slightly per patch
      const d = Math.round((rand(seed) - 0.45) * 34);
      tctx.fillStyle = `rgb(${base[0] + d},${base[1] + d + Math.round((rand(seed+1)-0.5)*10)},${base[2] + d - Math.round((rand(seed+2)-0.5)*14)})`;
      tctx.fillRect(rx * cell, ry * cell, cell, cell);
      // sprinkle a few smaller darker/lighter blades-patches within
      for (let k = 0; k < 6; k++) {
        const sd = seed * 37 + k;
        const bx = rand(sd) * cell, by = rand(sd + 11) * cell;
        const bw = 2 + rand(sd + 21) * cell * 0.22;
        const bh = 2 + rand(sd + 31) * cell * 0.22;
        const dd = Math.round((rand(sd + 41) - 0.5) * 46);
        tctx.fillStyle = `rgb(${base[0] + dd},${base[1] + dd + 6},${base[2] + dd - 8})`;
        tctx.fillRect(rx * cell + bx, ry * cell + by, bw, bh);
      }
    }
  }
  return ctx.createPattern(tile, "repeat");
}

function stonePatternTile(surface: string): CanvasPattern | null {
  const s = normalizeSurfaceKey(surface);
  if (s !== "paving_stones" && s !== "sett" && s !== "cobblestone") return null;
  const isSett = s !== "paving_stones";
  // constant screen-space stone size so the pattern does not change with
  // zoom; sett stones are distinctly smaller than paving stones
  const size = isSett ? 5 : 8;
  const stoneGap = isSett ? 1 : 1;
  const gap = stoneGap;
  const tile = document.createElement("canvas");
  // 2x2 stones per tile for paving_stones (regular grid), running bond for sett
  const cell = size + gap;
  tile.width = cell * 2;
  tile.height = cell * 2;
  const tctx = tile.getContext("2d")!;
  const base = isSett ? 110 : 128; // greyish tone
  tctx.fillStyle = `rgb(${base - 22},${base - 22},${base - 22})`; // gap/joint color (darker)
  tctx.fillRect(0, 0, tile.width, tile.height);
  const drawStone = (x: number, y: number, w: number, h: number, seed: number): void => {
    // per-stone brightness variation, more irregular for sett
    const jitter = isSett ? 22 : 9;
    const v = base + Math.round((rand(seed) - 0.5) * jitter * 2);
    tctx.fillStyle = `rgb(${v},${v},${v + (isSett ? -4 : 0)})`;
    let px0 = x, py0 = y, pw = w, ph = h;
    if (isSett) {
      // irregular placement/size for sett
      px0 += (rand(seed + 1) - 0.5) * gap * 2;
      py0 += (rand(seed + 2) - 0.5) * gap * 2;
      pw *= 0.86 + rand(seed + 3) * 0.26;
      ph *= 0.86 + rand(seed + 4) * 0.26;
    }
    tctx.fillRect(Math.round(px0), Math.round(py0), Math.max(2, Math.round(pw)), Math.max(2, Math.round(ph)));
  };
  if (isSett) {
    // running bond: offset every other row by half a stone
    for (let ry = 0; ry < 2; ry++) {
      for (let rx = -1; rx < 3; rx++) {
        const x = rx * cell + (ry % 2 === 1 ? cell / 2 : 0);
        drawStone(x + gap / 2, ry * cell + gap / 2, size, size, ry * 31 + rx * 7 + 13);
      }
    }
  } else {
    // regular grid of larger stones with slight per-stone variance
    for (let ry = 0; ry < 2; ry++) {
      for (let rx = 0; rx < 2; rx++) {
        drawStone(rx * cell + gap / 2, ry * cell + gap / 2, size, size, ry * 17 + rx * 5 + 3);
      }
    }
  }
  const pat = ctx.createPattern(tile, "repeat");
  return pat;
}

function normalizeSurfaceKey(surface: string): string {
  const base = surface.split(";")[0].split(":")[0];
  return base;
}

const patternCache = new Map<string, CanvasPattern | null>();

/** patterns only render from zoom 25 — below that the average pattern color reads better */
const PATTERN_ZOOM = 25;

/** average fill color of a patterned surface (matches the pattern tone) */
const PATTERN_AVG: Record<string, string> = {
  paving_stones: "#808080",
  sett: "#6e6e6e",
  cobblestone: "#67625d",
};

/** anchor a cached pattern to the map so it pans with the scene */
function anchorPattern(pat: CanvasPattern | null, tileW: number, tileH: number): CanvasPattern | null {
  if (!pat) return null;
  // anchor to the map: use the screen position of the geographic origin
  // MODULO one tile period. The absolute screen position can be a huge
  // number far from the prime meridian, which overflows/invalidates the
  // pattern transform; the modulo keeps the same registration.
  const m = new DOMMatrix();
  const ox = lonToX(0), oy = latToY(0);
  const tx = tileW > 0 ? ((ox % tileW) + tileW) % tileW : 0;
  const ty = tileH > 0 ? ((oy % tileH) + tileH) % tileH : 0;
  m.translateSelf(tx - tileW, ty - tileH);
  pat.setTransform(m);
  return pat;
}

/** stone pattern for a surface at the current zoom, cached per surface+px */
function stonePattern(surface: string | undefined): CanvasPattern | null {
  if (!surface) return null;
  if (zoomLevel() < PATTERN_ZOOM) return null;
  // constant screen-space tile: no zoom dependence, so a single cached
  // pattern suffices (no scale in the cache key needed)
  const key = normalizeSurfaceKey(surface);
  const isSett = key !== "paving_stones";
  const cell = (isSett ? 5 : 8) + 1;
  if (patternCache.has(key)) return anchorPattern(patternCache.get(key)!, cell * 2, cell * 2);
  const pat = stonePatternTile(surface);
  patternCache.set(key, pat);
  return anchorPattern(pat, cell * 2, cell * 2);
}

/** grass-like texture at the current zoom, cached per kind */
function grassPattern(kind: string): CanvasPattern | null {
  if (zoomLevel() < PATTERN_ZOOM) return null;
  const key = `green:${kind}`;
  const cell = 6;
  if (patternCache.has(key)) return anchorPattern(patternCache.get(key)!, cell * 2, cell * 2);
  const pat = grassPatternTile(kind);
  patternCache.set(key, pat);
  return anchorPattern(pat, cell * 2, cell * 2);
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = "#222226";
  ctx.fillRect(0, 0, w, h);
  if (!dataset) return;

  const bbox = viewBboxQ();

  // Bird's eye: draw ALL classes in ascending layer order, so a higher layer
  // occludes everything below it regardless of feature class (previously
  // each class sorted internally, letting e.g. a layer-0 footway paint over
  // a layer-1 bridge's lane markings). Explicit layer selection draws only
  // that layer.
  const px = pxPerMeter();
  const visible = viewportValues();
  const layersToDraw: number[] =
    selectedLayer !== null ? [selectedLayer] : [...visible.layers].sort((a, b) => a - b);

  const gs = lodVisible("grass") && grassIndex ? queryIndex(grassIndex, bbox) : [];
  const areas = lodVisible("areas") && areaIndex ? visibleAreas(bbox) : [];
  const bl = lodVisible("buildings") && buildingIndex ? queryIndex(buildingIndex, bbox) : [];
  const cls = lodVisible("centerlines") && lineIndexes ? queryIndex(lineIndexes.centerlines, bbox) : [];
  const lms = lodVisible("laneMarkings") && laneMarkingIndex ? queryIndex(laneMarkingIndex, bbox) : [];
  const fws = lodVisible("footways") && lineIndexes ? queryIndex(lineIndexes.footways, bbox) : [];
  const crs = lodVisible("crossings") && lineIndexes ? queryIndex(lineIndexes.crossings, bbox) : [];
  const kws = lodVisible("kerbs") && kerbWayIndex ? queryIndex(kerbWayIndex, bbox) : [];
  const kns = lodVisible("kerbs") && kerbGrid ? kerbsInBbox(bbox) : [];

  for (const layer of layersToDraw) {
    const onLayer = (f: { layer?: number; level?: number }) =>
      (f.layer ?? 0) === layer && layerVisible(f);

    // --- landuse fills: residential (very light orange), commercial
    //     (light yellow) — translucent background, not the main focus
    if (lodVisible("landuse") && landuseIndex) {
      const lus = queryIndex(landuseIndex, bbox);
      for (const lu of lus) {
        if (!onLayer(lu)) continue;
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = lu.kind === "residential" ? "#f0c9a0" : "#eee4b3";
        ctx.beginPath();
        for (const ring of lu.outer) drawRing(ring, true);
        for (const hole of lu.holes) drawRing(hole, true);
        ctx.fill("evenodd");
        ctx.globalAlpha = 1;
      }
    }

    // --- green areas: landuse=grass / leisure=garden (same look),
    //     natural=scrub (darker) — mottled texture from zoom 25
    for (const g of gs) {
      if (!onLayer(g)) continue;
      const fill = grassPattern(g.kind) ?? greenColor(g.kind);
      ctx.fillStyle = fill;
      ctx.beginPath();
      for (const ring of g.outer) drawRing(ring, true);
      for (const hole of g.holes) drawRing(hole, true);
      ctx.fill("evenodd");
      ctx.lineWidth = Math.max(4, 0.3 * px);
      ctx.lineJoin = "round";
      ctx.strokeStyle = ctx.fillStyle as string;
      ctx.stroke();
    }

    // --- highway areas (surface fill) ---
    for (const area of areas) {
      if (!onLayer(area) || !areaLodVisible(area)) continue;
      const pat = !area.surfaceColour ? stonePattern(area.surface) : null;
      ctx.fillStyle = pat ?? (area.surface || area.surfaceColour ? featureColor(area.surface, area.surfaceColour) : "#4a4a50");
      ctx.beginPath();
      for (const ring of area.outer) drawRing(ring, true);
      if (area.holes.length > 0) {
        for (const hole of area.holes) {
          drawRing(hole, true);
        }
      }
      ctx.fill("evenodd");
      // same-color edge stroke: covers antialiased boundaries and cm-scale
      // geometric gaps between neighboring polygons so areas read as one
      // continuous surface — without letting lower layers shine through the
      // seams at high zoom, the stroke scales with the ground resolution
      ctx.lineWidth = Math.max(4, 0.3 * px);
      ctx.lineJoin = "round";
      ctx.strokeStyle = ctx.fillStyle as string;
      ctx.stroke();
    }

    // --- buildings: translucent fill (residential light orange, other
    //     even lighter) + outline; not the main focus of the rendering
    for (const b of bl) {
      if (!onLayer(b)) continue;
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = b.usage === "residential" ? "#f0b98a" : "#f5e9d8";
      ctx.beginPath();
      for (const ring of b.outer) drawRing(ring, true);
      ctx.fill("evenodd");
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#8a8a94";
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (const ring of b.outer) drawRing(ring, true);
      ctx.stroke();
    }

    // --- centerlines (surface detail) ---
    for (const cl of cls) {
      if (!onLayer(cl)) continue;
      ctx.strokeStyle = featureColor(cl.surface, cl.surfaceColour);
      ctx.lineWidth = Math.max(1, (cl.width ?? 1.5) * px * 0.5);
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      strokePolyline(cl.coords);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // --- lane markings ---
    for (const lm of lms) {
      if (!onLayer(lm)) continue;
      const clipped = clipToAreas(lm.areaIds);
      drawLaneMarkings(lm);
      if (clipped) ctx.restore();
    }

    // --- footways ---
    for (const fw of fws) {
      if (!onLayer(fw)) continue;
      ctx.strokeStyle = fw.surface || fw.surfaceColour ? featureColor(fw.surface, fw.surfaceColour) : "#cfcfd6";
      ctx.lineWidth = Math.max(0.8, (fw.width ?? 1.8) * px * 0.3);
      ctx.beginPath();
      strokePolyline(fw.coords);
      ctx.stroke();
    }

    // --- crossings with markings ---
    ctx.lineCap = "butt";
    for (const cr of crs) {
      if (!onLayer(cr)) continue;
      const stripe = crossingStripeColor(cr.crossingMarkings);
      const m = (cr.crossingMarkings ?? "").toLowerCase();
      const widthM = cr.width ?? (m.includes("zebra") ? 3 : 1.5);
      const clipped = clipToAreas(cr.areaIds);
      if (stripe) {
        ctx.strokeStyle = "#5a5a60";
        ctx.lineWidth = Math.max(2, widthM * px);
        ctx.beginPath();
        strokePolyline(cr.coords);
        ctx.stroke();

        if (m.includes("zebra")) {
          drawZebra(cr, widthM, stripe);
        } else if (m.includes("dash")) {
          drawBoundaryDashes(cr, widthM, stripe);
        } else {
          ctx.strokeStyle = stripe;
          ctx.setLineDash([2, 3]);
          ctx.lineWidth = Math.max(1.5, widthM * px * 0.35);
          ctx.beginPath();
          strokePolyline(cr.coords);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else {
        ctx.strokeStyle = "#8a8a92";
        ctx.lineWidth = Math.max(1.5, widthM * px * 0.4);
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        strokePolyline(cr.coords);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (clipped) ctx.restore();
    }
    ctx.lineCap = "round";

    // --- fences: black lines ---
    if (lodVisible("fences") && fenceIndex) {
      const fs = queryIndex(fenceIndex, bbox);
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = Math.max(1, 0.08 * px);
      ctx.lineJoin = "round";
      for (const f of fs) {
        if (!onLayer(f)) continue;
        ctx.beginPath();
        strokePolyline(f.coords);
        ctx.stroke();
      }
    }

    // --- kerb ways: dark edge between sidewalk and road ---
    drawKerbWays(kws, onLayer, px);

    // standalone kerb nodes (not part of a kerb way) are no longer drawn
    void kns;

    // --- bollards: black dots ---
    if (lodVisible("bollards") && bollardGrid) {
      const br = Math.max(1.2, Math.min(8, 0.25 * px));
      for (const cell of cellsForBbox(bbox, 50000)) {
        const arr = bollardGrid.get(cell);
        if (!arr) continue;
        for (const b of arr) {
          if (!onLayer(b)) continue;
          const x = lonToX(b.lon / Q), y = latToY(b.lat / Q);
          if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
          ctx.beginPath();
          ctx.arc(x, y, br, 0, Math.PI * 2);
          ctx.fillStyle = "#1a1a1a";
          ctx.fill();
        }
      }
    }
  }
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
  px: number
): void {
  const kerbW = Math.max(1.5, 0.18 * px); // ~18 cm kerb width
  const shadowW = kerbW * 0.3;
  // darker than paving-stone grey (#808080): the visual break
  const dark = "#3a3a3e";
  const bright = "#9a9a9e";

  for (const kw of kws) {
    if (!onLayer(kw)) continue;
    const base = kerbClass(kw.kerb);

    // screen coords + per-vertex normals (right side = road)
    const pts: [number, number][] = kw.coords.map((c) => [lonToX(c[0] / Q), latToY(c[1] / Q)]);
    if (pts.length < 2) continue;
    const normals: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      let nx = 0, ny = 0;
      // right-hand normal in screen coords (y down): direction (dx,dy) ->
      // (-dy,dx). Walking east, the right side is screen-down (south).
      if (i > 0) {
        const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
        const l = Math.hypot(dx, dy);
        if (l > 0) { nx += -dy / l; ny += dx / l; }
      }
      if (i < pts.length - 1) {
        const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
        const l = Math.hypot(dx, dy);
        if (l > 0) { nx += -dy / l; ny += dx / l; }
      }
      const l = Math.hypot(nx, ny);
      normals.push(l > 0 ? [nx / l, ny / l] : [0, 0]);
    }

    // local type per vertex: way's base type, overridden within ~1 m of a
    // kerb node on the way
    const types: ("high" | "lowered" | "flush")[] = pts.map(() => base);
    if (kw.overrides && kw.overrides.length > 0) {
      const rPx = Math.max(1, px); // 1 m radius
      for (const o of kw.overrides) {
        const cls = kerbClass(o.kerb);
        if (o.idx >= pts.length) continue;
        const ox = pts[o.idx][0], oy = pts[o.idx][1];
        for (let i = 0; i < pts.length; i++) {
          if (Math.hypot(pts[i][0] - ox, pts[i][1] - oy) <= rPx) types[i] = cls;
        }
      }
    }

    // draw segment by segment, grouped by local type
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    for (let i = 1; i < pts.length; i++) {
      const t = types[i];
      const tPrev = types[i - 1];
      const a = pts[i - 1], b = pts[i];
      const na = normals[i - 1], nb = normals[i];
      if (t === "flush" && tPrev === "flush") continue;

      if (t === "high" || tPrev === "high") {
        // solid dark kerb line
        ctx.strokeStyle = dark;
        ctx.lineWidth = kerbW;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
        // shadow on the road side (right)
        ctx.strokeStyle = "rgba(0,0,0,0.28)";
        ctx.lineWidth = kerbW;
        ctx.beginPath();
        ctx.moveTo(a[0] + na[0] * (kerbW + shadowW) / 2, a[1] + na[1] * (kerbW + shadowW) / 2);
        ctx.lineTo(b[0] + nb[0] * (kerbW + shadowW) / 2, b[1] + nb[1] * (kerbW + shadowW) / 2);
        ctx.stroke();
      } else if (t === "lowered" || tPrev === "lowered") {
        // gradient across the kerb width: bright (sidewalk, left) fading
        // to dark (road, right) — appears 3D-shaped
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const nmx = (na[0] + nb[0]) / 2, nmy = (na[1] + nb[1]) / 2;
        const grad = ctx.createLinearGradient(
          mx - nmx * kerbW / 2, my - nmy * kerbW / 2,
          mx + nmx * kerbW / 2, my + nmy * kerbW / 2
        );
        grad.addColorStop(0, bright);
        grad.addColorStop(1, dark);
        ctx.strokeStyle = grad;
        ctx.lineWidth = kerbW;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
    }
    ctx.lineCap = "round";
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
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, widthM * px * 0.14);
  const stripeGap = Math.max(widthM * px * 0.22, 3);

  let walked = 0;
  for (let i = 1; i < cr.coords.length; i++) {
    const [x0, y0] = cr.coords[i - 1];
    const [x1, y1] = cr.coords[i];
    const X0 = lonToX(x0 / Q), Y0 = latToY(y0 / Q);
    const X1 = lonToX(x1 / Q), Y1 = latToY(y1 / Q);
    const segLen = Math.hypot(X1 - X0, Y1 - Y0);
    if (segLen === 0) continue;
    const ux = (X1 - X0) / segLen, uy = (Y1 - Y0) / segLen;
    const nx = -uy, ny = ux;

    let t = -((walked % stripeGap));
    while (t < segLen) {
      const cxp = X0 + ux * t, cyp = Y0 + uy * t;
      ctx.beginPath();
      ctx.moveTo(cxp + nx * halfW, cyp + ny * halfW);
      ctx.lineTo(cxp - nx * halfW, cyp - ny * halfW);
      ctx.stroke();
      t += stripeGap;
    }
    walked += segLen;
  }
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
  const lineW = Math.max(1, 0.1 * px);
  const offset = Math.max(0, halfW - lineW / 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
  ctx.setLineDash([Math.max(4, 0.5 * px), Math.max(3, 0.35 * px)]);
  ctx.lineCap = "butt";

  const pts: [number, number][] = [];
  const normals: [number, number][] = [];
  for (let i = 0; i < cr.coords.length; i++) {
    pts.push([lonToX(cr.coords[i][0] / Q), latToY(cr.coords[i][1] / Q)]);
    if (i > 0) {
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
      const len = Math.hypot(dx, dy);
      normals.push(len === 0 ? [0, 0] : [-dy / len, dx / len]);
    }
  }

  for (const side of [-1, 1] as const) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      let nx: number, ny: number;
      if (i === 0) {
        [nx, ny] = normals[0];
      } else if (i === pts.length - 1) {
        [nx, ny] = normals[normals.length - 1];
      } else {
        const [nx1, ny1] = normals[i - 1], [nx2, ny2] = normals[i];
        const bl = Math.hypot(nx1 + nx2, ny1 + ny2);
        [nx, ny] = bl === 0 ? [nx1, ny1] : [(nx1 + nx2) / bl, (ny1 + ny2) / bl];
      }
      const ox = pts[i][0] + nx * offset * side, oy = pts[i][1] + ny * offset * side;
      if (i === 0) ctx.moveTo(ox, oy); else ctx.lineTo(ox, oy);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function cellsForBbox(bbox: [number, number, number, number], cell: number): number[] {
  const keys: number[] = [];
  const x0 = Math.floor(bbox[0] / cell), x1 = Math.floor(bbox[2] / cell);
  const y0 = Math.floor(bbox[1] / cell), y1 = Math.floor(bbox[3] / cell);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 20000) return keys;
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      keys.push(x * 100000 + y);
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

/** build a canvas clip path from an area's rings; returns false if not found */
function clipToAreas(areaIds: string[] | undefined): boolean {
  if (!areaIds || areaIds.length === 0) return false;
  const found = areaIds.map((id) => areaById(id)).filter((a) => a !== null) as AreaFeature[];
  if (found.length === 0) return false;
  ctx.save();
  ctx.beginPath();
  for (const area of found) {
    for (const ring of area.outer) drawRing(ring, true);
    for (const hole of area.holes) drawRing(hole, true);
  }
  ctx.clip("evenodd");
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
      const a = cur[i - 1], b = cur[i];
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
  const lineW = Math.max(1, 0.12 * px);
  const fwd = cl.lanesFwd ?? Math.ceil(cl.lanes / 2);
  const total = cl.lanes;
  ctx.lineWidth = lineW;
  ctx.lineCap = "round";

  // centerline in screen coordinates
  const base: [number, number][] = cl.coords.map((c) => [lonToX(c[0] / Q), latToY(c[1] / Q)]);
  if (base.length < 2) return;

  // averaged vertex normals for continuous offsets across corners
  const normals: [number, number][] = [];
  for (let i = 0; i < base.length; i++) {
    let nx = 0, ny = 0;
    if (i > 0) {
      const dx = base[i][0] - base[i - 1][0], dy = base[i][1] - base[i - 1][1];
      const l = Math.hypot(dx, dy);
      if (l > 0) { nx += -dy / l; ny += dx / l; }
    }
    if (i < base.length - 1) {
      const dx = base[i + 1][0] - base[i][0], dy = base[i + 1][1] - base[i][1];
      const l = Math.hypot(dx, dy);
      if (l > 0) { nx += -dy / l; ny += dx / l; }
    }
    const l = Math.hypot(nx, ny);
    normals.push(l > 0 ? [nx / l, ny / l] : [0, 0]);
  }

  // traffic-lane region: from the left edge to the right edge of the road,
  // parking lanes virtually subtracted (lane 1 starts at the left edge)
  const leftM = cl.laneLeftM ?? (total * cl.laneW!) / 2;

  // draw a boundary between a parking unit and the adjacent traffic lane so
  // all width units are visible (parking occupies the outer strips)
  const boundaryOffsets: number[] = [];
  if (cl.parkingLeft) boundaryOffsets.push(-leftM);
  if (cl.parkingRight) boundaryOffsets.push(-leftM + total * cl.laneW!);
  for (const offPx of boundaryOffsets.map((o) => o * px)) {
    const offset: [number, number][] = base.map((p, i) => [
      p[0] + normals[i][0] * offPx,
      p[1] + normals[i][1] * offPx,
    ]);
    const smooth = chaikin(offset, 2);
    ctx.strokeStyle = "#e8e8e8";
    ctx.setLineDash([Math.max(3, 1.2 * px), Math.max(2, 1.0 * px)]);
    ctx.beginPath();
    ctx.moveTo(smooth[0][0], smooth[0][1]);
    for (let i = 1; i < smooth.length; i++) ctx.lineTo(smooth[i][0], smooth[i][1]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (let k = 1; k < total; k++) {
    // distance from the centerline, negative = left side
    const offPx = (-leftM + k * cl.laneW!) * px;
    // solid only between opposite directions: exists when some (but not
    // all) lanes run forward — a one-way road has no solid separator
    const solid = fwd > 0 && fwd < total && k === fwd;

    // continuous offset curve through averaged normals, then smoothed
    const offset: [number, number][] = base.map((p, i) => [
      p[0] + normals[i][0] * offPx,
      p[1] + normals[i][1] * offPx,
    ]);
    const smooth = chaikin(offset, 2);

    ctx.strokeStyle = "#e8e8e8";
    if (!solid) ctx.setLineDash([Math.max(3, 1.2 * px), Math.max(2, 1.0 * px)]);
    ctx.beginPath();
    ctx.moveTo(smooth[0][0], smooth[0][1]);
    for (let i = 1; i < smooth.length; i++) ctx.lineTo(smooth[i][0], smooth[i][1]);
    ctx.stroke();
    if (!solid) ctx.setLineDash([]);
  }
}

// ---------------- interaction ----------------
let dragging = false;
let lastX = 0, lastY = 0;
let moved = 0;

canvas.addEventListener("mousedown", (e) => {
  dragging = true;
  moved = 0;
  lastX = e.clientX; lastY = e.clientY;
  canvas.classList.add("dragging");
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  moved += Math.abs(dx) + Math.abs(dy);
  lastX = e.clientX; lastY = e.clientY;
  const r = R();
  view.cx -= (dx / r) * (180 / Math.PI);
  view.cy += (dy / r) * (180 / Math.PI) * Math.cos((view.cy * Math.PI) / 180);
  requestDraw();
});
window.addEventListener("mouseup", () => {
  dragging = false;
  canvas.classList.remove("dragging");
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  view.scale = Math.max(500, Math.min(3_000_000, view.scale * factor));
  requestDraw();
  statusEl.textContent = `zoom ${zoomLevel().toFixed(1)} (scale ${Math.round(view.scale)}) · ${__COMMIT__}`;
}, { passive: false });

// click -> feature inspection
canvas.addEventListener("click", (e) => {
  if (moved > 6 || !dataset) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const bbox = viewBboxQ();
  const feature = pickFeature(px, py, bbox);
  showInfo(feature);
});

function pickFeature(px: number, py: number, bbox: [number, number, number, number]): (AreaFeature | BuildingFeature | GrassFeature | LineFeature | KerbFeature | KerbWayFeature | BollardFeature | FenceFeature | LanduseFeature) | null {
  const tol = 6;
  const lon = view.cx + (((px - canvas.width / 2) / R()) * 180) / Math.PI;
  const mercC = mercY(view.cy) - (py - canvas.height / 2) / R();
  const lat = (2 * Math.atan(Math.exp(mercC)) - Math.PI / 2) * 180 / Math.PI;
  const lonQ = Math.round(lon * Q), latQ = Math.round(lat * Q);
  const tolQ = Math.round((tol / view.scale) * Q);

  // areas: point-in-polygon
  if (lodVisible("areas") && areaIndex) {
    const areaHits = queryIndex(areaIndex, [lonQ, latQ, lonQ, latQ])
      .filter((a) => areaLodVisible(a) && layerVisible(a));
    // bird's eye: prefer the locally highest layer at the click point
    if (selectedLayer === null && areaHits.length > 1) {
      areaHits.sort((a, b) => layerSortKey(b) - layerSortKey(a));
    }
    for (const area of areaHits) {
      let inOuter = false;
      for (const ring of area.outer) if (pointInRingQ(lonQ, latQ, ring)) { inOuter = true; break; }
      if (!inOuter) continue;
      let inHole = false;
      for (const hole of area.holes) if (pointInRingQ(lonQ, latQ, hole)) { inHole = true; break; }
      if (!inHole) return area;
    }
  }

  // grass: point-in-polygon
  if (lodVisible("grass") && grassIndex) {
    const gHits = queryIndex(grassIndex, [lonQ, latQ, lonQ, latQ])
      .filter((g) => layerVisible(g));
    if (selectedLayer === null && gHits.length > 1) {
      gHits.sort((a, b) => layerSortKey(b) - layerSortKey(a));
    }
    for (const g of gHits) {
      let inOuter = false;
      for (const ring of g.outer) if (pointInRingQ(lonQ, latQ, ring)) { inOuter = true; break; }
      if (!inOuter) continue;
      let inHole = false;
      for (const hole of g.holes) if (pointInRingQ(lonQ, latQ, hole)) { inHole = true; break; }
      if (!inHole) return g;
    }
  }
  // landuse areas: point-in-polygon
  if (lodVisible("landuse") && landuseIndex) {
    const luHits = queryIndex(landuseIndex, [lonQ, latQ, lonQ, latQ])
      .filter((lu) => layerVisible(lu));
    if (selectedLayer === null && luHits.length > 1) {
      luHits.sort((a, b) => layerSortKey(b) - layerSortKey(a));
    }
    for (const lu of luHits) {
      let inOuter = false;
      for (const ring of lu.outer) if (pointInRingQ(lonQ, latQ, ring)) { inOuter = true; break; }
      if (!inOuter) continue;
      let inHole = false;
      for (const hole of lu.holes) if (pointInRingQ(lonQ, latQ, hole)) { inHole = true; break; }
      if (!inHole) return lu;
    }
  }
  // buildings: outline hit (point-in-polygon)
  if (lodVisible("buildings") && buildingIndex) {
    const bHits = queryIndex(buildingIndex, [lonQ, latQ, lonQ, latQ])
      .filter((b) => layerVisible(b));
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
    let best: { d: number; f: FenceFeature | null } = { d: tolQ * tolQ * 4, f: null };
    const fHits = queryIndex(fenceIndex, [lonQ - tolQ * 6, latQ - tolQ * 6, lonQ + tolQ * 6, latQ + tolQ * 6])
      .filter((f) => layerVisible(f));
    for (const f of fHits) {
      for (let i = 1; i < f.coords.length; i++) {
        const d = distToSegQ(lonQ, latQ, f.coords[i - 1], f.coords[i]);
        if (d < best.d) { best.d = d; best.f = f; }
      }
    }
    if (best.f) return best.f;
  }
  // bollards (points, closest)
  if (lodVisible("bollards") && bollardGrid) {
    let best: { d: number; b: BollardFeature | null } = { d: tolQ * tolQ * 4, b: null };
    const cx0 = Math.floor((lonQ - tolQ * 4) / 50000), cx1 = Math.floor((lonQ + tolQ * 4) / 50000);
    const cy0 = Math.floor((latQ - tolQ * 4) / 50000), cy1 = Math.floor((latQ + tolQ * 4) / 50000);
    for (let x = cx0; x <= cx1; x++) {
      for (let y = cy0; y <= cy1; y++) {
        const arr = bollardGrid.get(x * 100000 + y);
        if (!arr) continue;
        for (const b of arr) {
          if (!layerVisible(b)) continue;
          const d = (b.lon - lonQ) ** 2 + (b.lat - latQ) ** 2;
          if (d < best.d) { best.d = d; best.b = b; }
        }
      }
    }
    if (best.b) return best.b;
  }
  // kerb nodes (points, closest)
  if (lodVisible("kerbs") && kerbGrid) {
    let best: KerbFeature | null = null;
    let bestD = tolQ * tolQ * 4;
    const cx0 = Math.floor((lonQ - tolQ * 4) / 50000), cx1 = Math.floor((lonQ + tolQ * 4) / 50000);
    const cy0 = Math.floor((latQ - tolQ * 4) / 50000), cy1 = Math.floor((latQ + tolQ * 4) / 50000);
    for (let x = cx0; x <= cx1; x++) {
      for (let y = cy0; y <= cy1; y++) {
        const arr = kerbGrid.get(x * 100000 + y);
        if (!arr) continue;
        for (const k of arr) {
          if (!layerVisible(k)) continue;
          const d = (k.lon - lonQ) ** 2 + (k.lat - latQ) ** 2;
          if (d < bestD) { bestD = d; best = k; }
        }
      }
    }
    if (best) return best;
  }

  // kerb ways: nearest segment within tolerance
  if (lodVisible("kerbs") && kerbWayIndex) {
    let best: { d: number; f: KerbWayFeature | null } = { d: tolQ * tolQ * 4, f: null };
    const kwHits = queryIndex(kerbWayIndex, [lonQ - tolQ * 6, latQ - tolQ * 6, lonQ + tolQ * 6, latQ + tolQ * 6])
      .filter((kw) => layerVisible(kw));
    if (selectedLayer === null && kwHits.length > 1) kwHits.sort((a, b) => layerSortKey(b) - layerSortKey(a));
    for (const kw of kwHits) {
      for (let i = 1; i < kw.coords.length; i++) {
        const d = distToSegQ(lonQ, latQ, kw.coords[i - 1], kw.coords[i]);
        if (d < best.d) { best.d = d; best.f = kw; }
      }
    }
    if (best.f) return best.f;
  }

  // lines: nearest segment within tolerance
  if (lineIndexes) {
    const check = (feat: LineFeature, bestD: { d: number; f: LineFeature | null }) => {
      for (let i = 1; i < feat.coords.length; i++) {
        const d = distToSegQ(lonQ, latQ, feat.coords[i - 1], feat.coords[i]);
        if (d < bestD.d) { bestD.d = d; bestD.f = feat; }
      }
    };
    let best: { d: number; f: LineFeature | null } = { d: tolQ * tolQ * 4, f: null };
    const order: ("crossings" | "footways" | "centerlines")[] = ["crossings", "footways", "centerlines"];
    for (const kind of order) {
      if (!lodVisible(kind)) continue;
      const hits = queryIndex(lineIndexes[kind], [lonQ - tolQ * 6, latQ - tolQ * 6, lonQ + tolQ * 6, latQ + tolQ * 6])
        .filter((f) => layerVisible(f));
      if (selectedLayer === null) hits.sort((a, b) => layerSortKey(b) - layerSortKey(a));
      for (const f of hits) {
        if (f.bbox[0] > lonQ + tolQ * 6 || f.bbox[2] < lonQ - tolQ * 6) continue;
        if (f.bbox[1] > latQ + tolQ * 6 || f.bbox[3] < latQ - tolQ * 6) continue;
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
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegQ(px: number, py: number, a: Q[], b: Q[]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - a[0]) * dx + (py - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return (px - (a[0] + t * dx)) ** 2 + (py - (a[1] + t * dy)) ** 2;
}

// ---------------- info panel ----------------
function showInfo(f: AreaFeature | BuildingFeature | GrassFeature | LineFeature | KerbFeature | KerbWayFeature | BollardFeature | FenceFeature | LanduseFeature | null) {
  if (!f) { infoEl.style.display = "none"; return; }
  const rows: [string, string][] = [];
  const push = (k: string, v?: string | number) => {
    if (v !== undefined && v !== "") rows.push([k, String(v)]);
  };
  const feature = f as Feature;

  push("layer", feature.layer);
  push("level", feature.level);
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
  infoEl.innerHTML = `<span class="close" onclick="this.parentElement.style.display='none'">✕</span>` +
    rows.map(([k, v]) => `<div class="tag"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>`).join("") +
    (link ? `<div class="tag"><span class="k">osm</span><span class="v"><a href="${link}" target="_blank" rel="noopener">${link}</a></span></div>` : "");
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
    if (laneMarkingIndex) for (const lm of queryIndex(laneMarkingIndex, bbox)) add(lm);
    if (kerbWayIndex) for (const k of queryIndex(kerbWayIndex, bbox)) add(k);
    if (fenceIndex) for (const f of queryIndex(fenceIndex, bbox)) add(f);
    if (landuseIndex) for (const lu of queryIndex(landuseIndex, bbox)) add(lu);
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

  const defs: { key: keyof typeof layers; label: string; swatch: string }[] = [
    { key: "areas", label: "highway areas (surface fill)", swatch: "#6d6055" },
    { key: "buildings", label: "buildings", swatch: "#f0b98a" },
    { key: "landuse", label: "landuse res./comm.", swatch: "#f0c9a0" },
    { key: "grass", label: "grass / garden / scrub", swatch: "#5d7a44" },
    { key: "centerlines", label: "centerlines (surface)", swatch: "#7a6a52" },
    { key: "laneMarkings", label: "lane markings", swatch: "#e8e8e8" },
    { key: "footways", label: "footways / sidewalks", swatch: "#cfcfd6" },
    { key: "crossings", label: "crossings (markings)", swatch: "#e8e8e8" },
    { key: "kerbs", label: "kerbs", swatch: "#3a3a3e" },
    { key: "bollards", label: "bollards", swatch: "#1a1a1a" },
    { key: "fences", label: "fences", swatch: "#1a1a1a" },
  ];
  for (const d of defs) {
    const row = document.createElement("div");
    row.className = "layer";
    row.innerHTML = `<div class="swatch" style="background:${d.swatch}"></div>` +
      `<label><input type="checkbox" ${layers[d.key] ? "checked" : ""}/> ${d.label}</label>` +
      `<span class="count">${countFor(d.key)}</span>`;
    (row.querySelector("input") as HTMLInputElement).addEventListener("change", (e) => {
      layers[d.key] = (e.target as HTMLInputElement).checked;
      requestDraw();
    });
    wrap.appendChild(row);
  }

  // legend
  const legend = document.getElementById("legendSurfaces")!;
  legend.innerHTML = "";
  const surfaces = ["asphalt", "concrete", "sett", "paving_stones", "cobblestone", "gravel", "grass", "compacted"];
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
  for (const [label, color] of [["raised", "#e86e6e"], ["lowered", "#4ac8e8"], ["flush", "#9a6ee8"], ["tactile", "#e8c04a"]] as [string, string][]) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div class="sw" style="background:${color};border-radius:50%;width:10px"></div>${label}`;
    legend.appendChild(row);
  }
}

function countFor(key: keyof typeof layers): string {
  if (!dataset) return "";
  switch (key) {
    case "areas": return dataset.areas.length.toLocaleString();
    case "buildings": return dataset.buildings.length.toLocaleString();
    case "landuse": return dataset.landuse.length.toLocaleString();
    case "grass": return dataset.grass.length.toLocaleString();
    case "centerlines": return dataset.centerlines.length.toLocaleString();
    case "laneMarkings": return dataset.laneMarkings.length.toLocaleString();
    case "footways": return dataset.footways.length.toLocaleString();
    case "crossings": return dataset.crossings.length.toLocaleString();
    case "kerbs": return (dataset.kerbs.length + dataset.kerbWays.length).toLocaleString();
    case "bollards": return dataset.bollards.length.toLocaleString();
    case "fences": return dataset.fences.length.toLocaleString();
    default: return "";
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
viewFromUrl();

// ---------------- URL viewport sync ----------------

/** write the current viewport (center + zoom) into the URL hash */
function syncUrl(): void {
  const z = zoomLevel().toFixed(2);
  const hash = `#map=${z}/${view.cy.toFixed(6)}/${view.cx.toFixed(6)}`;
  if (location.hash !== hash) {
    history.replaceState(null, "", hash);
  }
}

/** restore the viewport from the URL hash; false when absent/invalid */
function viewFromUrl(): boolean {
  const m = /^#map=([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)$/.exec(location.hash);
  if (!m) return false;
  const z = parseFloat(m[1]);
  const lat = parseFloat(m[2]);
  const lon = parseFloat(m[3]);
  if (!Number.isFinite(z) || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -85 || lat > 85 || lon < -180 || lon > 180) return false;
  // the app clamps scale to [500, 3_000_000] ~ zoom [2.1, 33.6]
  if (z < 2 || z > 34) return false;
  // zoom -> scale: invert zoomLevel() = log2(scale/1200)*2 + 11
  const scale = 1200 * Math.pow(2, (z - 11) / 2);
  view = { cx: lon, cy: lat, scale: Math.max(500, Math.min(3_000_000, scale)) };
  return true;
}

function fitToBounds(bounds: [number, number, number, number]) {
  const [minX, minY, maxX, maxY] = bounds;
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;
  const cx = (minX + maxX) / 2 / Q;
  const cy = (minY + maxY) / 2 / Q;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const fitW = w * 0.9 / Math.max((maxX - minX) / Q, 1e-9);
  const fitH = h * 0.9 / Math.max(((maxY - minY) / Q) * Math.cos((cy * Math.PI) / 180), 1e-9);
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
  if (currentWorker) currentWorker.terminate();
  const worker = new Worker(new URL("./src/worker.ts", import.meta.url), { type: "module" });
  currentWorker = worker;

  const dropzone = document.getElementById("dropzone")!;
  const pbar = document.getElementById("progressbar")!;
  const pfill = document.getElementById("pbrfill") as HTMLDivElement;
  const plabel = document.getElementById("pbrlabel")!;
  dropzone.style.display = "none";
  pbar.style.display = "block";
  document.getElementById("layers")!.style.display = "none";
  statusEl.textContent = `loading ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…`;

  worker.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.type === "progress") {
      pfill.style.width = `${Math.min(100, m.pct).toFixed(1)}%`;
      plabel.textContent = `${m.phase} — ${Math.min(100, m.pct).toFixed(0)}% (${m.msg})`;
      statusEl.textContent = `${m.phase}…`;
    } else if (m.type === "done") {
      ingestResult(m.result as ExtractResult, file.name);
      worker.terminate();
      currentWorker = null;
      pbar.style.display = "none";
      dropzone.style.display = "block";
      document.getElementById("layers")!.style.display = "block";
      document.getElementById("zoomhint")!.style.display = "block";
      document.getElementById("legend")!.style.display = "block";
    } else if (m.type === "error") {
      statusEl.textContent = `error: ${m.message}`;
      pbar.style.display = "none";
      dropzone.style.display = "block";
      worker.terminate();
      currentWorker = null;
    }
  };

  file.arrayBuffer().then((buf) => {
    worker.postMessage({ type: "parse", buffer: buf, name: file.name }, [buf]);
  });
}

function ingestResult(result: ExtractResult, name: string) {
  patternCache.clear();
  const t0 = performance.now();
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
    laneMarkings: result.laneMarkings,
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
  bollardGrid = new Map();
  for (const b of dataset.bollards) {
    const key = Math.floor(b.lon / 50000) * 100000 + Math.floor(b.lat / 50000);
    let barr = bollardGrid.get(key);
    if (!barr) bollardGrid.set(key, (barr = []));
    barr.push(b);
  }
  laneMarkingIndex = buildIndex(dataset.laneMarkings);
  kerbGrid = new Map();
  for (const k of dataset.kerbs) {
    const key = Math.floor(k.lon / 50000) * 100000 + Math.floor(k.lat / 50000);
    let arr = kerbGrid.get(key);
    if (!arr) kerbGrid.set(key, (arr = []));
    arr.push(k);
  }
  const total = dataset.areas.length + dataset.buildings.length + dataset.grass.length + dataset.centerlines.length + dataset.footways.length +
    dataset.crossings.length + dataset.kerbs.length + dataset.kerbWays.length + dataset.bollards.length + dataset.fences.length + dataset.landuse.length;
  if (total === 0) {
    statusEl.textContent = `no micromapping features found in ${name} (try a region with area:highway mapping)`;
    return;
  }
  buildLayerPanel();
  // keep the current viewport when the URL carries one (hot-reload style
  // testing: reload, drop the PBF, land on the same spot); otherwise fit
  if (!viewFromUrl()) fitToBounds(result.bounds);
  statusEl.textContent = `${name}: loaded ${total.toLocaleString()} features in ${((performance.now() - t0) / 1000).toFixed(1)}s — scroll to zoom, drag to pan · ${__COMMIT__}`;
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
(window as any).__pick = (px: number, py: number) => pickFeature(px, py, viewBboxQ());
(window as any).__state = () => ({
  hasDataset: dataset !== null,
  areas: dataset?.areas.length ?? 0,
  buildings: dataset?.buildings.length ?? 0,
  grass: dataset?.grass.length ?? 0,
  footways: dataset?.footways.length ?? 0,
  osmLayers,
  selectedLayer,
});
