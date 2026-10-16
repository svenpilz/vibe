import { buildIndex, queryIndex, type Indexed } from "./src/loader";
import type { ExtractResult } from "./src/extract";
import type { AreaFeature, BuildingFeature, GrassFeature, LineFeature, KerbFeature, KerbWayFeature, Dataset, Feature, Q } from "./src/features";
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

const layers = {
  areas: true,
  buildings: true,
  grass: true,
  centerlines: true,
  footways: true,
  crossings: true,
  kerbs: true,
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
  grass: 0,       // always
  buildings: 2,   // 2 px/m: outlines readable, dense clusters culled
  centerlines: 2, // 2 px/m: 2m-wide road detail visible
  footways: 3,    // 3 px/m: ~2m sidewalks resolved
  crossings: 5,   // 5 px/m: 50cm markings resolved, not smudged
  kerbs: 7,       // 7 px/m: 10-30cm kerbs resolved
};

function lodVisible(key: keyof typeof layers): boolean {
  if (!layers[key]) return false;
  if (LOD[key] === 0) return true;
  return pxPerMeter() >= LOD[key];
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
function pxPerMeter(): number {
  return R() / 6_371_000;
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
  return surfaceColor(normalizeSurface(surface) ?? undefined);
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
  const visibleAreas = layers.areas && areaIndex ? queryIndex(areaIndex, bbox) : [];

  // --- landuse=grass (background fill) ---
  if (lodVisible("grass") && grassIndex) {
    const gs = queryIndex(grassIndex, bbox);
    if (selectedLayer === null) gs.sort((a, b) => layerSortKey(a) - layerSortKey(b));
    ctx.fillStyle = "#5d7a44";
    for (const g of gs) {
      if (!layerVisible(g)) continue;
      ctx.beginPath();
      for (const ring of g.outer) drawRing(ring, true);
      for (const hole of g.holes) drawRing(hole, true);
      ctx.fill("evenodd");
    }
  }

  // --- areas (bird's eye: ascending layer order, highest paints on top) ---
  if (lodVisible("areas") && areaIndex) {
    if (selectedLayer === null) visibleAreas.sort((a, b) => layerSortKey(a) - layerSortKey(b));
    for (const area of visibleAreas) {
      if (!layerVisible(area)) continue;
      ctx.fillStyle = area.surface || area.surfaceColour ? featureColor(area.surface, area.surfaceColour) : "#4a4a50";
      ctx.beginPath();
      for (const ring of area.outer) drawRing(ring, true);
      if (area.holes.length > 0) {
        for (const hole of area.holes) {
          drawRing(hole, true);
        }
      }
      ctx.fill("evenodd");

      // stroke the ring in the fill color, wide enough to cover both the
      // antialiased boundary pixels and small (cm-scale) geometric gaps
      // between neighboring OSM polygons, so areas read as one continuous
      // surface instead of showing white seams
      ctx.lineWidth = 4;
      ctx.lineJoin = "round";
      ctx.strokeStyle = ctx.fillStyle as string;
      ctx.stroke();
    }
  }

  // --- building outlines ---
  if (lodVisible("buildings") && buildingIndex) {
    const bl = queryIndex(buildingIndex, bbox);
    if (selectedLayer === null) bl.sort((a, b) => layerSortKey(a) - layerSortKey(b));
    ctx.strokeStyle = "#8a8a94";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    for (const b of bl) {
      if (!layerVisible(b)) continue;
      ctx.beginPath();
      for (const ring of b.outer) drawRing(ring, true);
      ctx.stroke();
    }
  }

  // --- centerlines (surface detail) ---
  if (lodVisible("centerlines") && lineIndexes) {
    const px = pxPerMeter();
    const cls = queryIndex(lineIndexes.centerlines, bbox);
    if (selectedLayer === null) cls.sort((a, b) => layerSortKey(a) - layerSortKey(b));
    for (const cl of cls) {
      if (!layerVisible(cl)) continue;
      ctx.strokeStyle = featureColor(cl.surface, cl.surfaceColour);
      ctx.lineWidth = Math.max(1, (cl.width ?? 1.5) * px * 0.5);
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      strokePolyline(cl.coords);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // --- footways ---
  if (lodVisible("footways") && lineIndexes) {
    const px = pxPerMeter();
    const fws = queryIndex(lineIndexes.footways, bbox);
    if (selectedLayer === null) fws.sort((a, b) => layerSortKey(a) - layerSortKey(b));
    for (const fw of fws) {
      if (!layerVisible(fw)) continue;
      ctx.strokeStyle = fw.surface || fw.surfaceColour ? featureColor(fw.surface, fw.surfaceColour) : "#cfcfd6";
      ctx.lineWidth = Math.max(0.8, (fw.width ?? 1.8) * px * 0.3);
      ctx.beginPath();
      strokePolyline(fw.coords);
      ctx.stroke();
    }
  }

  // --- crossings with markings ---
  if (lodVisible("crossings") && lineIndexes) {
    const px = pxPerMeter();
    const crs = queryIndex(lineIndexes.crossings, bbox);
    if (selectedLayer === null) crs.sort((a, b) => layerSortKey(a) - layerSortKey(b));
    for (const cr of crs) {
      if (!layerVisible(cr)) continue;
      const stripe = crossingStripeColor(cr.crossingMarkings);
      const m = (cr.crossingMarkings ?? "").toLowerCase();
      const widthM = cr.width ?? (m.includes("zebra") ? 3 : 1.5);
      ctx.lineCap = "butt";
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
    }
    ctx.lineCap = "round";
  }

  // --- kerb ways (lines) ---
  if (lodVisible("kerbs") && kerbWayIndex) {
    const px = pxPerMeter();
    ctx.lineCap = "round";
    const kws = queryIndex(kerbWayIndex, bbox);
    if (selectedLayer === null) kws.sort((a, b) => layerSortKey(a) - layerSortKey(b));
    for (const kw of kws) {
      if (!layerVisible(kw)) continue;
      ctx.strokeStyle = kerbColor(kw.kerb, kw.tactilePaving);
      ctx.lineWidth = Math.max(1, 0.3 * px);
      ctx.beginPath();
      strokePolyline(kw.coords);
      ctx.stroke();
    }
  }

  // --- kerb nodes ---
  if (lodVisible("kerbs") && kerbGrid) {
    const px = pxPerMeter();
    const r = Math.max(1.5, Math.min(10, 0.6 * px));
    const cells = cellsForBbox(bbox, 50000);
    for (const cell of cells) {
      const arr = kerbGrid.get(cell);
      if (!arr) continue;
      arr.sort((a, b) => layerSortKey(a) - layerSortKey(b));
      for (const k of arr) {
        if (!layerVisible(k)) continue;
        const x = lonToX(k.lon / Q), y = latToY(k.lat / Q);
        if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = kerbColor(k.kerb, k.tactilePaving);
        ctx.fill();
      }
    }
  }
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
 * the crossing band so the stroke stays within the tagged width.
 */
function drawBoundaryDashes(cr: LineFeature, widthM: number, color: string) {
  const px = pxPerMeter();
  const halfW = (widthM * px) / 2;
  const lineW = Math.max(1, 0.1 * px);
  const offset = Math.max(0, halfW - lineW / 2);
  const dash = Math.max(4, 0.5 * px);
  const gap = Math.max(3, 0.35 * px);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
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

  // arc length the markings cover: the full way, or the stretch between the
  // kerb lines it crosses (kerbTrimStart/End as fractions along the way)
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const t0 = cr.kerbTrimStart ?? 0;
  const t1 = cr.kerbTrimEnd ?? 1;
  const s0 = t0 * total;
  const s1 = t1 * total;

  for (const side of [-1, 1] as const) {
    // offset boundary polyline (left / right edge of the footway)
    const off: [number, number][] = [];
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
      off.push([pts[i][0] + nx * offset * side, pts[i][1] + ny * offset * side]);
    }

    // cumulative arc length
    const cum: number[] = [0];
    let totalOff = 0;
    for (let i = 1; i < off.length; i++) {
      totalOff += Math.hypot(off[i][0] - off[i - 1][0], off[i][1] - off[i - 1][1]);
      cum.push(totalOff);
    }
    if (totalOff === 0) continue;

    // dash start distances within [s0, s1]: the pattern is distributed so it
    // begins and ends flush with a full dash (no marking spills past a kerb)
    const span = (s1 - s0) * (totalOff / (total || 1));
    const period = dash + gap;
    const starts: number[] = [];
    if (span > 0) {
      let n = Math.max(1, Math.round((span + gap) / period));
      while (n > 1 && n * dash + (n - 1) * gap > span) n--;
      const slack = span - (n * dash + (n - 1) * gap);
      for (let i = 0; i < n; i++) starts.push(s0 * (totalOff / (total || 1)) + slack / 2 + i * period);
    }

    // stroke each dash along the offset polyline
    for (let si = 0; si < starts.length; si++) {
      const d0 = starts[si];
      const d1 = d0 + dash;
      if (d0 >= totalOff) break;
      ctx.beginPath();
      let placed = false;
      for (let i = 1; i < off.length; i++) {
        if (cum[i] < d0) continue;
        const segLen = cum[i] - cum[i - 1];
        const a0 = segLen === 0 ? 0 : Math.max(0, (d0 - cum[i - 1]) / segLen);
        const a1 = segLen === 0 ? 0 : Math.min(1, (d1 - cum[i - 1]) / segLen);
        if (a1 <= a0) continue;
        const x0 = off[i - 1][0] + (off[i][0] - off[i - 1][0]) * a0;
        const y0 = off[i - 1][1] + (off[i][1] - off[i - 1][1]) * a0;
        const x1 = off[i - 1][0] + (off[i][0] - off[i - 1][0]) * a1;
        const y1 = off[i - 1][1] + (off[i][1] - off[i - 1][1]) * a1;
        if (!placed) { ctx.moveTo(x0, y0); placed = true; }
        ctx.lineTo(x1, y1);
        if (cum[i] >= d1) break;
      }
      if (placed) ctx.stroke();
    }
  }
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
  statusEl.textContent = `zoom ${(Math.log2(view.scale / 1200) * 2 + 11).toFixed(1)} (scale ${Math.round(view.scale)})`;
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

function pickFeature(px: number, py: number, bbox: [number, number, number, number]): (AreaFeature | BuildingFeature | GrassFeature | LineFeature | KerbFeature | KerbWayFeature) | null {
  const tol = 6;
  const lon = view.cx + (((px - canvas.width / 2) / R()) * 180) / Math.PI;
  const mercC = mercY(view.cy) - (py - canvas.height / 2) / R();
  const lat = (2 * Math.atan(Math.exp(mercC)) - Math.PI / 2) * 180 / Math.PI;
  const lonQ = Math.round(lon * Q), latQ = Math.round(lat * Q);
  const tolQ = Math.round((tol / view.scale) * Q);

  // areas: point-in-polygon
  if (lodVisible("areas") && areaIndex) {
    const areaHits = queryIndex(areaIndex, [lonQ, latQ, lonQ, latQ])
      .filter((a) => layerVisible(a));
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
function showInfo(f: AreaFeature | BuildingFeature | GrassFeature | LineFeature | KerbFeature | KerbWayFeature | null) {
  if (!f) { infoEl.style.display = "none"; return; }
  const rows: [string, string][] = [];
  const push = (k: string, v?: string | number) => {
    if (v !== undefined && v !== "") rows.push([k, String(v)]);
  };
  const feature = f as Feature;

  push("layer", feature.layer);
  push("level", feature.level);
  if (f.type === "grass") {
    rows.push(["feature", `landuse=grass (${f.id})`]);
    return;
  }
  if (f.type === "building") {
    rows.push(["feature", `building (${f.id})`]);
    push("building", f.building);
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
    if (kerbWayIndex) for (const k of queryIndex(kerbWayIndex, bbox)) add(k);
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
    { key: "buildings", label: "building outlines", swatch: "#8a8a94" },
    { key: "grass", label: "landuse grass", swatch: "#5d7a44" },
    { key: "centerlines", label: "centerlines (surface)", swatch: "#7a6a52" },
    { key: "footways", label: "footways / sidewalks", swatch: "#cfcfd6" },
    { key: "crossings", label: "crossings (markings)", swatch: "#e8e8e8" },
    { key: "kerbs", label: "kerbs", swatch: "#e86e6e" },
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
    case "grass": return dataset.grass.length.toLocaleString();
    case "centerlines": return dataset.centerlines.length.toLocaleString();
    case "footways": return dataset.footways.length.toLocaleString();
    case "crossings": return dataset.crossings.length.toLocaleString();
    case "kerbs": return (dataset.kerbs.length + dataset.kerbWays.length).toLocaleString();
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
  });
}

window.addEventListener("resize", requestDraw);

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
  };
  areaIndex = buildIndex(dataset.areas);
  lineIndexes = {
    centerlines: buildIndex(dataset.centerlines),
    footways: buildIndex(dataset.footways),
    crossings: buildIndex(dataset.crossings),
  };
  kerbWayIndex = buildIndex(dataset.kerbWays);
  kerbGrid = new Map();
  for (const k of dataset.kerbs) {
    const key = Math.floor(k.lon / 50000) * 100000 + Math.floor(k.lat / 50000);
    let arr = kerbGrid.get(key);
    if (!arr) kerbGrid.set(key, (arr = []));
    arr.push(k);
  }
  const total = dataset.areas.length + dataset.buildings.length + dataset.grass.length + dataset.centerlines.length + dataset.footways.length +
    dataset.crossings.length + dataset.kerbs.length + dataset.kerbWays.length;
  if (total === 0) {
    statusEl.textContent = `no micromapping features found in ${name} (try a region with area:highway mapping)`;
    return;
  }
  buildLayerPanel();
  fitToBounds(result.bounds);
  statusEl.textContent = `${name}: loaded ${total.toLocaleString()} features in ${((performance.now() - t0) / 1000).toFixed(1)}s — scroll to zoom, drag to pan`;
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
