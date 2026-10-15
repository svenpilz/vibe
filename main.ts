import { loadDataset, buildIndex, queryIndex, type Indexed } from "./src/loader";
import type { AreaFeature, LineFeature, KerbFeature, KerbWayFeature, Dataset, Q } from "./src/features";
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

let view: View = { cx: 13.40, cy: 52.52, scale: 12000 };
let dataset: Dataset | null = null;
let areaIndex: Indexed<AreaFeature> | null = null;
let lineIndexes: {
  centerlines: Indexed<LineFeature>;
  footways: Indexed<LineFeature>;
  crossings: Indexed<LineFeature>;
} | null = null;
let kerbGrid: Map<number, KerbFeature[]> | null = null;
let kerbWayIndex: Indexed<KerbWayFeature> | null = null;

const layers = {
  areas: true,
  centerlines: true,
  footways: true,
  crossings: true,
  kerbs: true,
};

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

  // --- areas ---
  if (layers.areas && areaIndex) {
    for (const area of visibleAreas) {
      const fill = surfaceColor(normalizeSurface(area.surface) ?? undefined);
      ctx.fillStyle = area.surface ? fill : "#4a4a50";
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

  // --- centerlines (surface detail) ---
  if (layers.centerlines && lineIndexes) {
    const px = pxPerMeter();
    for (const cl of queryIndex(lineIndexes.centerlines, bbox)) {
      ctx.strokeStyle = surfaceColor(normalizeSurface(cl.surface) ?? undefined);
      ctx.lineWidth = Math.max(1, (cl.width ?? 1.5) * px * 0.5);
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      strokePolyline(cl.coords);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // --- footways ---
  if (layers.footways && lineIndexes) {
    const px = pxPerMeter();
    for (const fw of queryIndex(lineIndexes.footways, bbox)) {
      ctx.strokeStyle = "#cfcfd6";
      ctx.lineWidth = Math.max(0.8, (fw.width ?? 1.8) * px * 0.3);
      ctx.beginPath();
      strokePolyline(fw.coords);
      ctx.stroke();
    }
  }

  // --- crossings with markings ---
  if (layers.crossings && lineIndexes) {
    const px = pxPerMeter();
    for (const cr of queryIndex(lineIndexes.crossings, bbox)) {
      const stripe = crossingStripeColor(cr.crossingMarkings);
      const widthM = cr.width ?? 3;
      ctx.lineCap = "butt";
      if (stripe) {
        // base
        ctx.strokeStyle = "#5a5a60";
        ctx.lineWidth = Math.max(2, widthM * px * 0.5);
        ctx.beginPath();
        strokePolyline(cr.coords);
        ctx.stroke();

        // stripes perpendicular to direction
        const m = (cr.crossingMarkings ?? "").toLowerCase();
        if (m.includes("zebra")) {
          drawZebra(cr, widthM, stripe);
        } else {
          ctx.strokeStyle = stripe;
          ctx.setLineDash(m.includes("dash") ? [8, 6] : [2, 3]);
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
  if (layers.kerbs && kerbWayIndex) {
    const px = pxPerMeter();
    ctx.lineCap = "round";
    for (const kw of queryIndex(kerbWayIndex, bbox)) {
      ctx.strokeStyle = kerbColor(kw.kerb, kw.tactilePaving);
      ctx.lineWidth = Math.max(1, 0.3 * px);
      ctx.beginPath();
      strokePolyline(kw.coords);
      ctx.stroke();
    }
  }

  // --- kerb nodes ---
  if (layers.kerbs && kerbGrid) {
    const px = pxPerMeter();
    const r = Math.max(1.5, Math.min(10, 0.6 * px));
    const cells = cellsForBbox(bbox, 50000);
    for (const cell of cells) {
      const arr = kerbGrid.get(cell);
      if (!arr) continue;
      for (const k of arr) {
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
  const halfW = (widthM * px * 0.5) / 2;
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

canvas.addEventListener("click", (e) => {
  if (moved > 6 || !dataset) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const bbox = viewBboxQ();
  const feature = pickFeature(px, py, bbox);
  showInfo(feature);
});

function pickFeature(px: number, py: number, bbox: [number, number, number, number]): (AreaFeature | LineFeature | KerbFeature | KerbWayFeature) | null {
  const tol = 6;
  const lon = view.cx + (((px - canvas.width / 2) / R()) * 180) / Math.PI;
  const mercC = mercY(view.cy) - (py - canvas.height / 2) / R();
  const lat = (2 * Math.atan(Math.exp(mercC)) - Math.PI / 2) * 180 / Math.PI;
  const lonQ = Math.round(lon * Q), latQ = Math.round(lat * Q);
  const tolQ = Math.round((tol / view.scale) * Q);

  // areas: point-in-polygon
  if (layers.areas && areaIndex) {
    for (const area of queryIndex(areaIndex, [lonQ, latQ, lonQ, latQ])) {
      let inOuter = false;
      for (const ring of area.outer) if (pointInRingQ(lonQ, latQ, ring)) { inOuter = true; break; }
      if (!inOuter) continue;
      let inHole = false;
      for (const hole of area.holes) if (pointInRingQ(lonQ, latQ, hole)) { inHole = true; break; }
      if (!inHole) return area;
    }
  }

  // kerb nodes (points, closest)
  if (layers.kerbs && kerbGrid) {
    let best: KerbFeature | null = null;
    let bestD = tolQ * tolQ * 4;
    const cx0 = Math.floor((lonQ - tolQ * 4) / 50000), cx1 = Math.floor((lonQ + tolQ * 4) / 50000);
    const cy0 = Math.floor((latQ - tolQ * 4) / 50000), cy1 = Math.floor((latQ + tolQ * 4) / 50000);
    for (let x = cx0; x <= cx1; x++) {
      for (let y = cy0; y <= cy1; y++) {
        const arr = kerbGrid.get(x * 100000 + y);
        if (!arr) continue;
        for (const k of arr) {
          const d = (k.lon - lonQ) ** 2 + (k.lat - latQ) ** 2;
          if (d < bestD) { bestD = d; best = k; }
        }
      }
    }
    if (best) return best;
  }

  // kerb ways: nearest segment within tolerance
  if (layers.kerbs && kerbWayIndex) {
    let best: { d: number; f: KerbWayFeature | null } = { d: tolQ * tolQ * 4, f: null };
    for (const kw of queryIndex(kerbWayIndex, [lonQ - tolQ * 6, latQ - tolQ * 6, lonQ + tolQ * 6, latQ + tolQ * 6])) {
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
      if (!layers[kind]) continue;
      for (const f of queryIndex(lineIndexes[kind], [lonQ - tolQ * 6, latQ - tolQ * 6, lonQ + tolQ * 6, latQ + tolQ * 6])) {
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
function showInfo(f: AreaFeature | LineFeature | KerbFeature | KerbWayFeature | null) {
  if (!f) { infoEl.style.display = "none"; return; }
  const rows: [string, string][] = [];
  const push = (k: string, v?: string | number) => {
    if (v !== undefined && v !== "") rows.push([k, String(v)]);
  };

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

  infoEl.innerHTML = `<span class="close" onclick="this.parentElement.style.display='none'">✕</span>` +
    rows.map(([k, v]) => `<div class="tag"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>`).join("");
  infoEl.style.display = "block";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------- layer panel ----------------
function buildLayerPanel() {
  const wrap = document.getElementById("layers")!;
  const defs: { key: keyof typeof layers; label: string; swatch: string }[] = [
    { key: "areas", label: "highway areas (surface fill)", swatch: "#6d6055" },
    { key: "centerlines", label: "centerlines (surface)", swatch: "#7a6a52" },
    { key: "footways", label: "footways / sidewalks", swatch: "#cfcfd6" },
    { key: "crossings", label: "crossings (markings)", swatch: "#e8e8e8" },
    { key: "kerbs", label: "kerbs (nodes + ways)", swatch: "#e86e6e" },
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
  });
}

window.addEventListener("resize", requestDraw);

async function main() {
  try {
    dataset = await loadDataset((msg) => (statusEl.textContent = msg));
    const t0 = performance.now();
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
    buildLayerPanel();
    requestDraw();
    statusEl.textContent = `loaded ${(
      dataset.areas.length + dataset.centerlines.length + dataset.footways.length +
      dataset.crossings.length + dataset.kerbs.length + dataset.kerbWays.length
    ).toLocaleString()} features in ${((performance.now() - t0) / 1000).toFixed(1)}s — zoom ${view.scale > 50000 ? "detailed" : "city"}`;
  } catch (err) {
    statusEl.textContent = `error: ${err instanceof Error ? err.message : err}`;
  }
}

// expose view control for tests/tools
(window as any).__setView = (cx: number, cy: number, scale: number) => {
  view = { cx, cy, scale };
  requestDraw();
};

main();
