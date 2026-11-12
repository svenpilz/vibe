/**
 * Pure geometry builders for the heightfield POC. No three.js imports, so
 * everything here is unit-testable in Node. Meshes are plain arrays in the
 * local frame: positions are [east, up, north] meters (three.js x/y/z).
 */
import type { BakedData, BakedWay, TerrainGrid } from "./schema";
import { getTag, wayTags, sampleTerrainM, buildingHeightM, minHeightM, osmLayer, layerElevationM, roadWidthM, surfaceColor, buildingPaletteColor, parseHeightM, parseLevels } from "./schema";
import { dequantizeDeg, lonLatToMeters, LAYER_H } from "./geo";

export interface MeshData {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
  /** uv per vertex (0,0 default); used for the building facade texture */
  uvs: number[];
}

export function emptyMesh(): MeshData {
  return { positions: [], normals: [], colors: [], indices: [], uvs: [] };
}

function pushVert(m: MeshData, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: [number, number, number]): number {
  m.positions.push(x, y, z);
  m.normals.push(nx, ny, nz);
  m.colors.push(c[0], c[1], c[2]);
  m.uvs.push(0, 0);
  return m.positions.length / 3 - 1;
}

function pushVertUV(m: MeshData, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: [number, number, number], u: number, v: number): number {
  const i = pushVert(m, x, y, z, nx, ny, nz, c);
  m.uvs[i * 2] = u;
  m.uvs[i * 2 + 1] = v;
  return i;
}

function pushTri(m: MeshData, a: number, b: number, c: number): void {
  m.indices.push(a, b, c);
}

/** point-in-triangle for a CCW triangle in the (east, north) plane */
function pointInTri(p: [number, number], a: [number, number], b: [number, number], c: [number, number]): boolean {
  const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
  const d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
  const hasNeg = d1 < -1e-12 || d2 < -1e-12 || d3 < -1e-12;
  const hasPos = d1 > 1e-12 || d2 > 1e-12 || d3 > 1e-12;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation of a simple polygon given as [east, north]
 * points. Returns triangle indices (CCW in the east/north plane).
 */
export function triangulatePolygon(pts: Array<[number, number]>): number[] {
  const n = pts.length;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  const remaining = pts.map((_, i) => i);
  if (area < 0) remaining.reverse();
  const cross = (o: number, a: number, b: number): number =>
    (pts[a][0] - pts[o][0]) * (pts[b][1] - pts[o][1]) - (pts[a][1] - pts[o][1]) * (pts[b][0] - pts[o][0]);
  const out: number[] = [];
  let guard = 0;
  while (remaining.length > 3 && guard++ < 100000) {
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[(i - 1 + remaining.length) % remaining.length];
      const b = remaining[i];
      const c = remaining[(i + 1) % remaining.length];
      if (cross(a, b, c) <= 1e-9) continue;
      let contains = false;
      for (const p of remaining) {
        if (p === a || p === b || p === c) continue;
        if (pointInTri(pts[p], pts[a], pts[b], pts[c])) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      out.push(a, b, c);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (remaining.length === 3) out.push(remaining[0], remaining[1], remaining[2]);
  else if (remaining.length > 3) {
    for (let i = 1; i + 1 < remaining.length; i++) out.push(remaining[0], remaining[i], remaining[i + 1]);
  }
  return out;
}

/** Terrain heightfield mesh from the baked DEM grid. */
export function buildTerrainMesh(g: TerrainGrid): MeshData {
  const m = emptyMesh();
  const n = g.n;
  const cell = g.sizeM / n;
  const vid = (i: number, j: number): number => {
    const x = g.originX + i * cell;
    const z = g.originY + j * cell;
    const h = g.heightsDm[j * (n + 1) + i] * 0.1;
    return pushVert(m, x, h, z, 0, 1, 0, [0.56, 0.7, 0.44]);
  };
  const grid: number[][] = [];
  for (let j = 0; j <= n; j++) {
    grid.push([]);
    for (let i = 0; i <= n; i++) grid[j].push(vid(i, j));
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      pushTri(m, grid[j][i], grid[j][i + 1], grid[j + 1][i + 1]);
      pushTri(m, grid[j][i], grid[j + 1][i + 1], grid[j + 1][i]);
    }
  }
  return m;
}

/**
 * Cleaned DOM terrain: use the DOM1 surface everywhere, except where the DOM
 * stands > threshold above the DGM1 bare earth AND the point is not inside an
 * OSM building footprint — there fall back to the DGM1 (this removes trees,
 * traffic signs, cars, ... that OSM does not model as 3D objects).
 */
export function cleanDomTerrain(dom: TerrainGrid, dgm: TerrainGrid, buildingPolys: Array<Array<[number, number]>>, thresholdM = 1.5): TerrainGrid {
  const n = dom.n;
  const cell = dom.sizeM / n;
  const index = new BuildingIndex(buildingPolys);
  const heightsDm: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = j * (n + 1) + i;
      const d = dom.heightsDm[k];
      const g = dgm.heightsDm[k];
      // dilate the building mask by ~0.75 cell so buildings smaller than one
      // grid cell still get DGM ground (otherwise the DOM roof buries them)
      if (d - g > thresholdM * 10 && !index.collides(dom.originX + i * cell, dom.originY + j * cell, cell * 0.75)) {
        heightsDm.push(g);
      } else {
        heightsDm.push(d);
      }
    }
  }
  return { n, sizeM: dom.sizeM, originX: dom.originX, originY: dom.originY, heightsDm };
}

export interface RoadSegment {
  ax: number; ay: number; bx: number; by: number;
  elevA: number; elevB: number;
  halfW: number;
  layer: number;
  wayIdx: number;
}

/** node id -> max incident road layer */
function nodeMaxLayer(data: BakedData, roadWays: { way: BakedWay; idx: number }[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const { way } of roadWays) {
    const l = osmLayer(wayTags(data, way));
    for (const r of way.r) {
      const cur = map.get(r);
      if (cur === undefined || l > cur) map.set(r, l);
    }
  }
  return map;
}

/** ramp length in meters over which a road climbs to a higher adjacent layer */
export const RAMP_M = 60;

/** max road grade (rise/run) — real roads are graded, not glued to the terrain */
export const MAX_GRADE = 0.08;

/**
 * Grade-limit an elevation profile along a polyline: no segment may exceed
 * MAX_GRADE, forward then backward pass. Makes roads look engineered/flat
 * instead of following every terrain bump.
 */
export function smoothElevations(elevs: number[], pts: Array<[number, number]>, maxGrade = MAX_GRADE): number[] {
  const n = elevs.length;
  const out = [...elevs];
  for (let i = 1; i < n; i++) {
    const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const maxRise = maxGrade * Math.max(len, 1);
    if (out[i] > out[i - 1] + maxRise) out[i] = out[i - 1] + maxRise;
    if (out[i] < out[i - 1] - maxRise) out[i] = out[i - 1] - maxRise;
  }
  for (let i = n - 2; i >= 0; i--) {
    const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    const maxRise = maxGrade * Math.max(len, 1);
    if (out[i] > out[i + 1] + maxRise) out[i] = out[i + 1] + maxRise;
    if (out[i] < out[i + 1] - maxRise) out[i] = out[i + 1] - maxRise;
  }
  return out;
}

/**
 * Per-node elevation factor for one way: the way's own layer in the middle,
 * blending up to the max incident layer within RAMP_M of a layer transition,
 * so connecting roads visibly ramp up to bridge decks instead of tilting
 * over their whole length (and stay continuous at shared nodes).
 */
export function wayNodeLayers(way: BakedWay, ownLayer: number, maxLayer: Map<number, number>, pts: Array<[number, number]>): number[] {
  const n = way.r.length;
  const factor = new Array<number>(n).fill(ownLayer);
  const cum = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  for (let i = 0; i < n; i++) {
    const m = maxLayer.get(way.r[i]) ?? 0;
    if (m <= ownLayer) continue;
    for (let j = 0; j < n; j++) {
      const d = Math.abs(cum[j] - cum[i]);
      if (d > RAMP_M) continue;
      const f = m - (d / RAMP_M) * (m - ownLayer);
      if (f > factor[j]) factor[j] = f;
    }
  }
  return factor;
}

function nodeXY(data: BakedData, localIdx: number): [number, number] {
  const lon = dequantizeDeg(data.nodes[localIdx * 2]);
  const lat = dequantizeDeg(data.nodes[localIdx * 2 + 1]);
  return lonLatToMeters(lon, lat);
}

export interface RoadBuild {
  mesh: MeshData;
  segments: RoadSegment[];
}

/**
 * Road ribbons for all highway ways. Deck elevation = terrain height at the
 * node + max incident layer * LAYER_H, so bridges pass over lower roads and
 * the car can drive underneath them. Bridge decks get parapet walls.
 */
export function buildRoads(data: BakedData): RoadBuild {
  const mesh = emptyMesh();
  const segments: RoadSegment[] = [];
  const roadWays: { way: BakedWay; idx: number }[] = [];
  data.ways.forEach((way, idx) => {
    if (getTag(data, way, "highway") && getTag(data, way, "area:highway") === undefined) roadWays.push({ way, idx });
  });
  const maxLayer = nodeMaxLayer(data, roadWays);

  for (const { way, idx } of roadWays) {
    const tags = wayTags(data, way);
    const hw = tags["highway"] ?? "";
    if (hw === "steps" || hw === "elevator") continue;
    const w = roadWidthM(tags);
    const halfW = w / 2;
    const layer = osmLayer(tags);
    const isBridge = layer > 0;
    const col = surfaceColor(tags);
    const pts = way.r.map((r) => nodeXY(data, r));
    const factors = wayNodeLayers(way, layer, maxLayer, pts);
    // +0.12 m so road decks render above the landuse ground polygons (+0.06);
    // footways/paths/sidewalks get another +0.12 m kerb lift
    const isFootway = hw === "footway" || hw === "path" || hw === "steps" || hw === "pedestrian" || hw === "cycleway";
    const lift = 0.12 + (isFootway ? 0.12 : 0);
    const rawElevs = pts.map(([x, y], i) => sampleTerrainM(data.terrain, x, y) + factors[i] * LAYER_H + lift);
    const elevs = smoothElevations(rawElevs, pts);

    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const eA = elevs[i];
      const eB = elevs[i + 1];
      const v0 = pushVert(mesh, ax + nx * halfW, eA, ay + ny * halfW, 0, 1, 0, col);
      const v1 = pushVert(mesh, ax - nx * halfW, eA, ay - ny * halfW, 0, 1, 0, col);
      const v2 = pushVert(mesh, bx - nx * halfW, eB, by - ny * halfW, 0, 1, 0, col);
      const v3 = pushVert(mesh, bx + nx * halfW, eB, by + ny * halfW, 0, 1, 0, col);
      pushTri(mesh, v0, v1, v2);
      pushTri(mesh, v0, v2, v3);
      segments.push({ ax, ay, bx, by, elevA: eA, elevB: eB, halfW, layer, wayIdx: idx });
      if (isBridge) {
        const pc: [number, number, number] = [0.55, 0.55, 0.58];
        for (const side of [1, -1]) {
          const ox = nx * side * (halfW + 0.15);
          const oy = ny * side * (halfW + 0.15);
          const p0 = pushVert(mesh, ax + ox, eA + 1.1, ay + oy, nx * side, 0, ny * side, pc);
          const p1 = pushVert(mesh, ax + ox, eA, ay + oy, nx * side, 0, ny * side, pc);
          const p2 = pushVert(mesh, bx + ox, eB, by + oy, nx * side, 0, ny * side, pc);
          const p3 = pushVert(mesh, bx + ox, eB + 1.1, by + oy, nx * side, 0, ny * side, pc);
          if (side > 0) {
            pushTri(mesh, p0, p2, p1);
            pushTri(mesh, p0, p3, p2);
          } else {
            pushTri(mesh, p0, p1, p2);
            pushTri(mesh, p0, p2, p3);
          }
        }
      }
    }
    // joint fan at interior nodes to close gaps on curves
    for (let i = 1; i + 1 < pts.length; i++) {
      const [cx, cy] = pts[i];
      const e = elevs[i];
      const ring: number[] = [];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        ring.push(pushVert(mesh, cx + Math.cos(a) * halfW, e, cy + Math.sin(a) * halfW, 0, 1, 0, col));
      }
      const c = pushVert(mesh, cx, e, cy, 0, 1, 0, col);
      for (let k = 0; k < 8; k++) pushTri(mesh, c, ring[k], ring[(k + 1) % 8]);
    }
    // support piers under bridge decks, down to the terrain, so the
    // vertical stacking is visible from the map view
    if (isBridge) {
      const pierCol: [number, number, number] = [0.6, 0.6, 0.62];
      const pierHalf = 0.9;
      for (let i = 0; i < pts.length; i++) {
        const [cx, cy] = pts[i];
        const deck = elevs[i];
        const ground = sampleTerrainM(data.terrain, cx, cy);
        if (deck - ground < 1) continue;
        const corners: Array<[number, number]> = [
          [-pierHalf, -pierHalf], [pierHalf, -pierHalf], [pierHalf, pierHalf], [-pierHalf, pierHalf],
        ];
        for (let k = 0; k < 4; k++) {
          const [ox1, oy1] = corners[k];
          const [ox2, oy2] = corners[(k + 1) % 4];
          const dx = ox2 - ox1;
          const dy = oy2 - oy1;
          const len = Math.hypot(dx, dy) || 1;
          const nx = dy / len;
          const nz = -dx / len;
          const a = pushVert(mesh, cx + ox1, ground, cy + oy1, nx, 0, nz, pierCol);
          const b = pushVert(mesh, cx + ox2, ground, cy + oy2, nx, 0, nz, pierCol);
          const c = pushVert(mesh, cx + ox2, deck, cy + oy2, nx, 0, nz, pierCol);
          const d = pushVert(mesh, cx + ox1, deck, cy + oy1, nx, 0, nz, pierCol);
          pushTri(mesh, a, c, b);
          pushTri(mesh, a, d, c);
        }
      }
    }
  }
  return { mesh, segments };
}

/** Extruded building blocks: walls + triangulated flat roof, one merged mesh. */
export function buildBuildings(data: BakedData): MeshData {
  const mesh = emptyMesh();
  for (const way of data.ways) {
    if (!getTag(data, way, "building")) continue;
    if (way.r.length < 4 || way.r[0] !== way.r[way.r.length - 1]) continue;
    const tags = wayTags(data, way);
    const ring = way.r.slice(0, -1);
    const pts = ring.map((r) => nodeXY(data, r));
    if (pts.length < 3) continue;
    const h = buildingHeightM(tags);
    const base = minHeightM(tags);
    const cxy = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0] as [number, number]);
    const col = buildingPaletteColor(cxy[0], cxy[1]);
    const wallCol: [number, number, number] = [col[0] * 0.92, col[1] * 0.92, col[2] * 0.92];
    const roofCol: [number, number, number] = [col[0] * 0.55, col[1] * 0.55, col[2] * 0.55];
    const baseElev = pts.map(([x, y]) => sampleTerrainM(data.terrain, x, y));
    const top = baseElev.map((e) => e + base + h);
    const bottom = baseElev.map((e) => e + base);
    const n = pts.length;
    let cumLen = 0;
    const edgeLen: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      edgeLen.push(Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]));
      cumLen += edgeLen[i];
    }
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const len = edgeLen[i] || 1;
      const nx = (pts[j][1] - pts[i][1]) / len;
      const nz = -(pts[j][0] - pts[i][0]) / len;
      // facade uv: u along the wall every 3 m, v one texture tile per 3 m of height
      const u0 = acc / 3, u1 = (acc + len) / 3;
      const v0 = (bottom[i] - baseElev[0]) / 3, v1 = (top[i] - baseElev[0]) / 3;
      const a = pushVertUV(mesh, pts[i][0], bottom[i], pts[i][1], nx, 0, nz, wallCol, u0, v0);
      const b = pushVertUV(mesh, pts[j][0], bottom[j], pts[j][1], nx, 0, nz, wallCol, u1, v0);
      const c = pushVertUV(mesh, pts[j][0], top[j], pts[j][1], nx, 0, nz, wallCol, u1, v1);
      const d = pushVertUV(mesh, pts[i][0], top[i], pts[i][1], nx, 0, nz, wallCol, u0, v1);
      pushTri(mesh, a, c, b);
      pushTri(mesh, a, d, c);
      acc += len;
    }
    const roofH = ["gabled", "hipped", "pyramidal", "gambrel", "round"].includes(tags["roof:shape"] ?? "")
      ? (parseHeightM(tags["roof:height"]) ?? 2.5)
      : 0;
    if (roofH > 0 && pts.length >= 3) {
      // pyramidal approximation: apex above the centroid, one triangle per edge
      let cx = 0, cy = 0;
      for (const [px, py] of pts) { cx += px; cy += py; }
      cx /= pts.length; cy /= pts.length;
      const apexH = top.reduce((a, b) => a + b, 0) / top.length + roofH;
      const apex = pushVert(mesh, cx, apexH, cy, 0, 1, 0, roofCol);
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        const a = pushVert(mesh, pts[i][0], top[i], pts[i][1], 0, 1, 0, roofCol);
        const b = pushVert(mesh, pts[j][0], top[j], pts[j][1], 0, 1, 0, roofCol);
        pushTri(mesh, a, b, apex);
      }
    } else {
      const roofBase = pts.map(([x, y], i) => pushVert(mesh, x, top[i], y, 0, 1, 0, roofCol));
      const tris = triangulatePolygon(pts);
      for (let k = 0; k + 2 < tris.length; k += 3) {
        pushTri(mesh, roofBase[tris[k]], roofBase[tris[k + 2]], roofBase[tris[k + 1]]);
      }
    }
  }
  return mesh;
}

const GROUND_COLORS: Record<string, [number, number, number]> = {
  grass: [0.52, 0.68, 0.4],
  forest: [0.44, 0.62, 0.38],
  park: [0.5, 0.68, 0.42],
  residential: [0.68, 0.66, 0.6],
  commercial: [0.66, 0.64, 0.58],
  retail: [0.66, 0.64, 0.58],
  industrial: [0.64, 0.62, 0.56],
  water: [0.36, 0.6, 0.82],
  cemetery: [0.52, 0.66, 0.42],
  meadow: [0.55, 0.69, 0.42],
  scrub: [0.48, 0.63, 0.4],
};

function groundColor(tags: Record<string, string>): [number, number, number] {
  if (tags["natural"] === "water" || tags["waterway"]) return GROUND_COLORS.water;
  const lu = tags["landuse"] ?? tags["leisure"] ?? tags["natural"] ?? "";
  return GROUND_COLORS[lu] ?? [0.62, 0.63, 0.58];
}

/** Flat ground polygons (landuse / water / area:highway) draped on the DEM. */
export function buildGround(data: BakedData): MeshData {
  const mesh = emptyMesh();
  for (const way of data.ways) {
    const isArea = way.r.length >= 4 && way.r[0] === way.r[way.r.length - 1];
    if (!isArea) continue;
    const tags = wayTags(data, way);
    const isGround = tags["landuse"] || tags["leisure"] || tags["natural"] === "water" || tags["waterway"];
    const isAreaHighway = tags["area:highway"];
    if (!isGround && !isAreaHighway) continue;
    const ring = way.r.slice(0, -1);
    const pts = ring.map((r) => nodeXY(data, r));
    if (pts.length < 3) continue;
    const col = isAreaHighway ? surfaceColor(tags) : groundColor(tags);
    const layer = osmLayer(tags);
    const lift = isAreaHighway ? layerElevationM(tags) + 0.06 : 0.06;
    const idx = pts.map(([x, y]) => pushVert(mesh, x, sampleTerrainM(data.terrain, x, y) + lift, y, 0, 1, 0, col));
    const tris = triangulatePolygon(pts);
    for (let k = 0; k + 2 < tris.length; k += 3) {
      pushTri(mesh, idx[tris[k]], idx[tris[k + 1]], idx[tris[k + 2]]);
    }
  }
  return mesh;
}

export interface RoadQuery {
  dist: number;
  t: number;
  elev: number;
  halfW: number;
  layer: number;
  seg: RoadSegment;
}

/** Uniform-grid spatial index over road segments for car snapping. */
export class RoadIndex {
  private cell = 25;
  private grid = new Map<number, number[]>();
  constructor(private segs: RoadSegment[]) {
    segs.forEach((s, i) => {
      const x0 = Math.min(s.ax, s.bx) - s.halfW;
      const x1 = Math.max(s.ax, s.bx) + s.halfW;
      const y0 = Math.min(s.ay, s.by) - s.halfW;
      const y1 = Math.max(s.ay, s.by) + s.halfW;
      for (let cx = Math.floor(x0 / this.cell); cx <= Math.floor(x1 / this.cell); cx++) {
        for (let cy = Math.floor(y0 / this.cell); cy <= Math.floor(y1 / this.cell); cy++) {
          const key = cx * 100000 + cy;
          let arr = this.grid.get(key);
          if (!arr) {
            arr = [];
            this.grid.set(key, arr);
          }
          arr.push(i);
        }
      }
    });
  }

  /**
   * Nearest segment to (x, y). When refElev is given (the car's current deck
   * height), segments on other levels — e.g. a bridge passing overhead — get
   * an elevation penalty, so the car stays on the road it is driving on and
   * can pass under bridges.
   */
  nearest(x: number, y: number, maxDist = 60, refElev?: number): RoadQuery | undefined {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const range = Math.ceil(maxDist / this.cell);
    let best: RoadQuery | undefined;
    let bestScore = Infinity;
    for (let dx = -range; dx <= range; dx++) {
      for (let dy = -range; dy <= range; dy++) {
        const arr = this.grid.get((cx + dx) * 100000 + (cy + dy));
        if (!arr) continue;
        for (const i of arr) {
          const s = this.segs[i];
          const abx = s.bx - s.ax;
          const aby = s.by - s.ay;
          const len2 = abx * abx + aby * aby;
          let t = len2 > 0 ? ((x - s.ax) * abx + (y - s.ay) * aby) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          const px = s.ax + abx * t;
          const py = s.ay + aby * t;
          const dist = Math.hypot(x - px, y - py);
          if (dist > maxDist) continue;
          const elev = s.elevA + (s.elevB - s.elevA) * t;
          let score = dist;
          if (refElev !== undefined) score += Math.max(0, Math.abs(elev - refElev) - 2.5) * 4;
          if (score < bestScore) {
            bestScore = score;
            best = { dist, t, elev, halfW: s.halfW, layer: s.layer, seg: s };
          }
        }
      }
    }
    return best;
  }
}

function pointInPolygon(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Spatial index of building footprints for car collision. */
export class BuildingIndex {
  private cell = 50;
  private grid = new Map<number, Array<Array<[number, number]>>>();
  constructor(polygons: Array<Array<[number, number]>>) {
    polygons.forEach((poly) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of poly) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      for (let cx = Math.floor(x0 / this.cell); cx <= Math.floor(x1 / this.cell); cx++) {
        for (let cy = Math.floor(y0 / this.cell); cy <= Math.floor(y1 / this.cell); cy++) {
          const key = cx * 100000 + cy;
          let arr = this.grid.get(key);
          if (!arr) {
            arr = [];
            this.grid.set(key, arr);
          }
          arr.push(poly);
        }
      }
    });
  }

  /** true when a circle at (x, y) with radius margin touches any footprint */
  collides(x: number, y: number, margin: number): boolean {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const range = Math.ceil((margin + this.cell) / this.cell);
    for (let dx = -range; dx <= range; dx++) {
      for (let dy = -range; dy <= range; dy++) {
        const arr = this.grid.get((cx + dx) * 100000 + (cy + dy));
        if (!arr) continue;
        for (const poly of arr) {
          if (pointInPolygon(x, y, poly)) return true;
          for (let i = 0; i < poly.length; i++) {
            const [ax, ay] = poly[i];
            const [bx, by] = poly[(i + 1) % poly.length];
            if (distToSegment(x, y, ax, ay, bx, by) < margin) return true;
          }
        }
      }
    }
    return false;
  }
}

/** Building footprint polygons in local meters, for the collision index. */
export function buildingPolygons(data: BakedData): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  for (const way of data.ways) {
    if (!getTag(data, way, "building")) continue;
    if (way.r.length < 4 || way.r[0] !== way.r[way.r.length - 1]) continue;
    out.push(way.r.slice(0, -1).map((r) => nodeXY(data, r)));
  }
  return out;
}


/* ---------- lane markings ---------- */

const MARKED_CLASSES = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"]);

/**
 * Dashed white center line (roads with >= 2 lanes) and solid edge lines on
 * major roads, laid 1 cm above the deck. Segments must come from buildRoads.
 */
export function buildLaneMarkings(data: BakedData, segments: RoadSegment[]): MeshData {
  const mesh = emptyMesh();
  const byWay = new Map<number, RoadSegment[]>();
  for (const s of segments) {
    let arr = byWay.get(s.wayIdx);
    if (!arr) {
      arr = [];
      byWay.set(s.wayIdx, arr);
    }
    arr.push(s);
  }
  const white: [number, number, number] = [0.85, 0.85, 0.85];
  for (const way of data.ways) {
    const segs = byWay.get(data.ways.indexOf(way));
    if (!segs || segs.length === 0) continue;
    const tags = wayTags(data, way);
    const hw = tags["highway"] ?? "";
    if (!MARKED_CLASSES.has(hw)) continue;
    const lanes = parseLevels(tags["lanes"]) ?? (hw.includes("motorway") ? 2 : hw.includes("link") ? 1 : 2);
    const halfW = segs[0].halfW;
    let dist = 0;
    for (const s of segs) {
      const len = Math.hypot(s.bx - s.ax, s.by - s.ay);
      if (len < 1e-6) continue;
      const nx = -(s.by - s.ay) / len;
      const ny = (s.bx - s.ax) / len;
      const elev = (t: number) => s.elevA + (s.elevB - s.elevA) * t + 0.01;
      if (lanes >= 2) {
        // dashed center line: 3 m dash, 3 m gap
        let t = 0;
        let dashOn = (Math.floor(dist / 3) % 2) === 0;
        let dashStart = dist % 3;
        while (t < 1) {
          const segLen = len * (1 - t);
          const remaining = dashOn ? 3 - dashStart : dashStart;
          const d = Math.min(remaining, segLen);
          if (dashOn && d > 0.3) {
            const t0 = t;
            const t1 = t + d / len;
            const w2 = 0.075;
            const v0 = pushVert(mesh, s.ax + (s.bx - s.ax) * t0 + nx * w2, elev(t0), s.ay + (s.by - s.ay) * t0 + ny * w2, 0, 1, 0, white);
            const v1 = pushVert(mesh, s.ax + (s.bx - s.ax) * t0 - nx * w2, elev(t0), s.ay + (s.by - s.ay) * t0 - ny * w2, 0, 1, 0, white);
            const v2 = pushVert(mesh, s.ax + (s.bx - s.ax) * t1 - nx * w2, elev(t1), s.ay + (s.by - s.ay) * t1 - ny * w2, 0, 1, 0, white);
            const v3 = pushVert(mesh, s.ax + (s.bx - s.ax) * t1 + nx * w2, elev(t1), s.ay + (s.by - s.ay) * t1 + ny * w2, 0, 1, 0, white);
            pushTri(mesh, v0, v1, v2);
            pushTri(mesh, v0, v2, v3);
          }
          t += d / len;
          dist += d;
          dashOn = !dashOn;
          dashStart = 0;
        }
      }
      if (lanes >= 2 || hw === "motorway" || hw === "trunk" || hw === "primary" || hw === "secondary") {
        // solid edge lines
        for (const side of [1, -1]) {
          const o = side * (halfW - 0.4);
          const w2 = 0.06;
          const v0 = pushVert(mesh, s.ax + nx * (o + w2), elev(0), s.ay + ny * (o + w2), 0, 1, 0, white);
          const v1 = pushVert(mesh, s.ax + nx * (o - w2), elev(0), s.ay + ny * (o - w2), 0, 1, 0, white);
          const v2 = pushVert(mesh, s.bx + nx * (o - w2), elev(1), s.by + ny * (o - w2), 0, 1, 0, white);
          const v3 = pushVert(mesh, s.bx + nx * (o + w2), elev(1), s.by + ny * (o + w2), 0, 1, 0, white);
          pushTri(mesh, v0, v1, v2);
          pushTri(mesh, v0, v2, v3);
        }
      }
    }
  }
  return mesh;
}

/* ---------- kerbs ---------- */

/** barrier=kerb ways as low raised strips (0.3 m wide, 0.15 m high). */
export function buildKerbs(data: BakedData): MeshData {
  const mesh = emptyMesh();
  const col: [number, number, number] = [0.62, 0.62, 0.6];
  for (const way of data.ways) {
    if (getTag(data, way, "barrier") !== "kerb") continue;
    const pts = way.r.map((r) => nodeXY(data, r));
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const hW = 0.15;
      const g0 = sampleTerrainM(data.terrain, ax, ay);
      const g1 = sampleTerrainM(data.terrain, bx, by);
      const top0 = g0 + 0.15;
      const top1 = g1 + 0.15;
      const p0 = pushVert(mesh, ax + nx * hW, g0, ay + ny * hW, nx, 0, ny, col);
      const p1 = pushVert(mesh, ax - nx * hW, g0, ay - ny * hW, -nx, 0, -ny, col);
      const p2 = pushVert(mesh, bx - nx * hW, g1, by - ny * hW, -nx, 0, -ny, col);
      const p3 = pushVert(mesh, bx + nx * hW, g1, by + ny * hW, nx, 0, ny, col);
      const q0 = pushVert(mesh, ax + nx * hW, top0, ay + ny * hW, nx, 0, ny, col);
      const q1 = pushVert(mesh, ax - nx * hW, top0, ay - ny * hW, -nx, 0, -ny, col);
      const q2 = pushVert(mesh, bx - nx * hW, top1, by - ny * hW, -nx, 0, -ny, col);
      const q3 = pushVert(mesh, bx + nx * hW, top1, by + ny * hW, nx, 0, ny, col);
      pushTri(mesh, p0, q0, q3);
      pushTri(mesh, p0, q3, p3);
      pushTri(mesh, p1, p2, q2);
      pushTri(mesh, p1, q2, q1);
      const t0 = pushVert(mesh, ax + nx * hW, top0, ay + ny * hW, 0, 1, 0, col);
      const t1 = pushVert(mesh, ax - nx * hW, top0, ay - ny * hW, 0, 1, 0, col);
      const t2 = pushVert(mesh, bx - nx * hW, top1, by - ny * hW, 0, 1, 0, col);
      const t3 = pushVert(mesh, bx + nx * hW, top1, by + ny * hW, 0, 1, 0, col);
      pushTri(mesh, t0, t1, t2);
      pushTri(mesh, t0, t2, t3);
    }
  }
  return mesh;
}

/* ---------- street furniture: lamps, signals, trees, bollards ---------- */

function prism(mesh: MeshData, x: number, y0: number, z: number, r: number, h: number, sides: number, c: [number, number, number]): void {
  const ring: number[] = [];
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2;
    ring.push(pushVert(mesh, x + Math.cos(a) * r, y0, z + Math.sin(a) * r, Math.cos(a), 0, Math.sin(a), c));
  }
  const top: number[] = [];
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2;
    top.push(pushVert(mesh, x + Math.cos(a) * r, y0 + h, z + Math.sin(a) * r, 0, 1, 0, c));
  }
  const center = pushVert(mesh, x, y0 + h, z, 0, 1, 0, c);
  for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides;
    pushTri(mesh, ring[k], ring[k2], top[k2]);
    pushTri(mesh, ring[k], top[k2], top[k]);
    pushTri(mesh, center, top[k], top[k2]);
  }
}

function cone(mesh: MeshData, x: number, y0: number, z: number, r: number, h: number, sides: number, c: [number, number, number]): void {
  const apex = pushVert(mesh, x, y0 + h, z, 0, 1, 0, c);
  const ring: number[] = [];
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2;
    ring.push(pushVert(mesh, x + Math.cos(a) * r, y0, z + Math.sin(a) * r, 0, 0, 1, c));
  }
  for (let k = 0; k < sides; k++) pushTri(mesh, ring[k], ring[(k + 1) % sides], apex);
}

/** Street lamps, traffic signals, trees, bollards, benches from baked points. */
export function buildFurniture(data: BakedData): MeshData {
  const mesh = emptyMesh();
  const pole: [number, number, number] = [0.25, 0.26, 0.28];
  const lampHead: [number, number, number] = [0.95, 0.9, 0.7];
  const trunk: [number, number, number] = [0.35, 0.25, 0.15];
  const leaf: [number, number, number] = [0.2, 0.45, 0.2];
  const leaf2: [number, number, number] = [0.28, 0.52, 0.24];
  for (const pt of data.points) {
    if (pt.r.length < 1) continue;
    const tags = wayTags(data, pt);
    const [x, y] = nodeXY(data, pt.r[0]);
    const g = sampleTerrainM(data.terrain, x, y);
    const hw = tags["highway"];
    if (hw === "street_lamp") {
      prism(mesh, x, g, y, 0.07, 6, 6, pole);
      prism(mesh, x + 0.8, g + 5.4, y, 0.05, 0.6, 6, pole);
      prism(mesh, x + 1.1, g + 5.2, y, 0.22, 0.18, 6, lampHead);
    } else if (hw === "traffic_signals") {
      prism(mesh, x, g, y, 0.06, 3.2, 6, pole);
      prism(mesh, x, g + 3.2, y, 0.16, 0.75, 4, [0.12, 0.12, 0.12]);
      const red: [number, number, number] = [0.8, 0.1, 0.1];
      const amber: [number, number, number] = [0.95, 0.7, 0.1];
      const green: [number, number, number] = [0.1, 0.7, 0.2];
      prism(mesh, x + 0.17, g + 3.75, y, 0.05, 0.14, 6, red);
      prism(mesh, x + 0.17, g + 3.5, y, 0.05, 0.14, 6, amber);
      prism(mesh, x + 0.17, g + 3.25, y, 0.05, 0.14, 6, green);
    } else if (tags["natural"] === "tree") {
      prism(mesh, x, g, y, 0.12, 1.6, 5, trunk);
      cone(mesh, x, g + 1.2, y, 1.3, 3.2, 7, leaf);
      cone(mesh, x, g + 2.8, y, 0.9, 2.4, 7, leaf2);
    } else if (tags["barrier"] === "bollard") {
      prism(mesh, x, g, y, 0.09, 0.8, 6, [0.5, 0.2, 0.15]);
    } else if (tags["amenity"] === "bench") {
      prism(mesh, x, g, y, 0.5, 0.45, 4, [0.45, 0.33, 0.2]);
    } else if (hw === "bus_stop" || tags["public_transport"] === "stop_position") {
      prism(mesh, x, g, y, 0.05, 2.4, 6, pole);
      prism(mesh, x, g + 2.1, y, 0.22, 0.22, 6, [0.95, 0.75, 0.1]);
    } else if (tags["amenity"] === "bus_station" || tags["public_transport"] === "platform") {
      for (const [ox, oz] of [[-1.4, -0.6], [1.4, -0.6], [-1.4, 0.6], [1.4, 0.6]] as const) {
        prism(mesh, x + ox, g, y + oz, 0.05, 2.2, 4, pole);
      }
      prism(mesh, x, g + 2.2, y, 1.6, 0.08, 4, [0.7, 0.72, 0.75]);
      prism(mesh, x, g, y, 0.9, 0.45, 4, [0.45, 0.33, 0.2]);
    }
  }
  return mesh;
}


/* ---------- railways ---------- */

/** Ballast bed + two steel rails for railway ways, respecting layer stacking. */
export function buildRails(data: BakedData): MeshData {
  const mesh = emptyMesh();
  const ballast: [number, number, number] = [0.38, 0.37, 0.36];
  const steel: [number, number, number] = [0.75, 0.76, 0.78];
  for (const way of data.ways) {
    const rw = getTag(data, way, "railway");
    if (!rw || !["rail", "light_rail", "subway", "tram"].includes(rw)) continue;
    const tags = wayTags(data, way);
    const layer = osmLayer(tags);
    const pts = way.r.map((r) => nodeXY(data, r));
    const factors = wayNodeLayers(way, layer, nodeMaxLayerOf(data), pts);
    const elevs = pts.map(([x, y], i) => sampleTerrainM(data.terrain, x, y) + factors[i] * LAYER_H);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const e0 = elevs[i] + 0.1;
      const e1 = elevs[i + 1] + 0.1;
      const strip = (halfW: number, lift: number, c: [number, number, number]) => {
        const v0 = pushVert(mesh, ax + nx * halfW, e0 + lift, ay + ny * halfW, 0, 1, 0, c);
        const v1 = pushVert(mesh, ax - nx * halfW, e0 + lift, ay - ny * halfW, 0, 1, 0, c);
        const v2 = pushVert(mesh, bx - nx * halfW, e1 + lift, by - ny * halfW, 0, 1, 0, c);
        const v3 = pushVert(mesh, bx + nx * halfW, e1 + lift, by + ny * halfW, 0, 1, 0, c);
        pushTri(mesh, v0, v1, v2);
        pushTri(mesh, v0, v2, v3);
      };
      strip(1.9, 0, ballast);
      strip(0.08, 0.08, steel);
      // second rail offset to the other side
      const o = 0.75;
      const r0 = pushVert(mesh, ax + nx * o + nx * 0.08, e0 + 0.08, ay + ny * o + ny * 0.08, 0, 1, 0, steel);
      const r1 = pushVert(mesh, ax + nx * o - nx * 0.08, e0 + 0.08, ay + ny * o - ny * 0.08, 0, 1, 0, steel);
      const r2 = pushVert(mesh, bx + nx * o - nx * 0.08, e1 + 0.08, by + ny * o - ny * 0.08, 0, 1, 0, steel);
      const r3 = pushVert(mesh, bx + nx * o + nx * 0.08, e1 + 0.08, by + ny * o + ny * 0.08, 0, 1, 0, steel);
      pushTri(mesh, r0, r1, r2);
      pushTri(mesh, r0, r2, r3);
      const s0 = pushVert(mesh, ax - nx * o + nx * 0.08, e0 + 0.08, ay - ny * o + ny * 0.08, 0, 1, 0, steel);
      const s1 = pushVert(mesh, ax - nx * o - nx * 0.08, e0 + 0.08, ay - ny * o - ny * 0.08, 0, 1, 0, steel);
      const s2 = pushVert(mesh, bx - nx * o - nx * 0.08, e1 + 0.08, by - ny * o - ny * 0.08, 0, 1, 0, steel);
      const s3 = pushVert(mesh, bx - nx * o + nx * 0.08, e1 + 0.08, by - ny * o + ny * 0.08, 0, 1, 0, steel);
      pushTri(mesh, s0, s1, s2);
      pushTri(mesh, s0, s2, s3);
    }
  }
  return mesh;
}

function nodeMaxLayerOf(data: BakedData): Map<number, number> {
  const map = new Map<number, number>();
  for (const way of data.ways) {
    if (!getTag(data, way, "highway") && !getTag(data, way, "railway")) continue;
    const l = osmLayer(wayTags(data, way));
    for (const r of way.r) {
      const cur = map.get(r);
      if (cur === undefined || l > cur) map.set(r, l);
    }
  }
  return map;
}

/** Drivable path along an assembled route polyline (buses, trains). */
export class RouteTrack {
  readonly pts: Array<[number, number]>;
  readonly elevs: number[];
  private cum: number[];
  readonly length: number;
  constructor(pts: Array<[number, number]>, elevs: number[]) {
    this.pts = pts;
    this.elevs = elevs;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    this.length = this.cum[this.cum.length - 1];
  }
  pointAt(dist: number): { x: number; z: number; heading: number; elev: number } {
    const d = ((dist % this.length) + this.length) % this.length;
    let lo = 0, hi = this.cum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const segLen = this.cum[lo + 1] - this.cum[lo] || 1;
    const t = (d - this.cum[lo]) / segLen;
    const [ax, ay] = this.pts[lo];
    const [bx, by] = this.pts[lo + 1];
    return {
      x: ax + (bx - ax) * t,
      z: ay + (by - ay) * t,
      heading: Math.atan2(by - ay, bx - ax),
      elev: this.elevs[lo] + (this.elevs[lo + 1] - this.elevs[lo]) * t,
    };
  }
}

/* ---------- bus routes ---------- */

function hexColor(hex: string | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!hex) return fallback;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Colored line ribbons along assembled bus route relations, just above the deck. */
export function buildRoutes(data: BakedData): MeshData {
  const mesh = emptyMesh();
  for (const route of data.routes) {
    const tags = wayTags(data, route);
    const col = hexColor(tags["colour"], tags["route"] === "trolleybus" ? [0.2, 0.55, 0.85] : [0.85, 0.45, 0.1]);
    const pts = route.r.map((r) => nodeXY(data, r));
    const halfW = 0.3;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = -dy / len;
      const ny = dx / len;
      const e0 = sampleTerrainM(data.terrain, ax, ay) + 0.18;
      const e1 = sampleTerrainM(data.terrain, bx, by) + 0.18;
      const v0 = pushVert(mesh, ax + nx * halfW, e0, ay + ny * halfW, 0, 1, 0, col);
      const v1 = pushVert(mesh, ax - nx * halfW, e0, ay - ny * halfW, 0, 1, 0, col);
      const v2 = pushVert(mesh, bx - nx * halfW, e1, by - ny * halfW, 0, 1, 0, col);
      const v3 = pushVert(mesh, bx + nx * halfW, e1, by + ny * halfW, 0, 1, 0, col);
      pushTri(mesh, v0, v1, v2);
      pushTri(mesh, v0, v2, v3);
    }
  }
  return mesh;
}
