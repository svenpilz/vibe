/**
 * Pure geometry builders for the heightfield POC. No three.js imports, so
 * everything here is unit-testable in Node. Meshes are plain arrays in the
 * local frame: positions are [east, up, north] meters (three.js x/y/z).
 */
import type { BakedData, BakedWay, TerrainGrid } from "./schema";
import { getTag, wayTags, sampleTerrainM, buildingHeightM, minHeightM, osmLayer, layerElevationM, roadWidthM, surfaceColor, buildingColor } from "./schema";
import { dequantizeDeg, lonLatToMeters, LAYER_H } from "./geo";

export interface MeshData {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
}

export function emptyMesh(): MeshData {
  return { positions: [], normals: [], colors: [], indices: [] };
}

function pushVert(m: MeshData, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: [number, number, number]): number {
  m.positions.push(x, y, z);
  m.normals.push(nx, ny, nz);
  m.colors.push(c[0], c[1], c[2]);
  return m.positions.length / 3 - 1;
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
    return pushVert(m, x, h, z, 0, 1, 0, [0.42, 0.5, 0.34]);
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

export interface RoadSegment {
  ax: number; ay: number; bx: number; by: number;
  elevA: number; elevB: number;
  halfW: number;
  layer: number;
  wayIdx: number;
}

/** node id -> max incident road layer (ramps blend up to the highest deck) */
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

  const nodeElev = (localIdx: number): number => {
    const [x, y] = nodeXY(data, localIdx);
    return sampleTerrainM(data.terrain, x, y) + (maxLayer.get(localIdx) ?? 0) * LAYER_H;
  };

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
    const elevs = way.r.map((r) => nodeElev(r));

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
    const col = buildingColor(h);
    const wallCol: [number, number, number] = [col[0] * 0.92, col[1] * 0.92, col[2] * 0.92];
    const roofCol: [number, number, number] = [col[0] * 0.55, col[1] * 0.55, col[2] * 0.55];
    const baseElev = pts.map(([x, y]) => sampleTerrainM(data.terrain, x, y));
    const top = baseElev.map((e) => e + base + h);
    const bottom = baseElev.map((e) => e + base);
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = pts[j][0] - pts[i][0];
      const dy = pts[j][1] - pts[i][1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = dy / len;
      const nz = -dx / len;
      const a = pushVert(mesh, pts[i][0], bottom[i], pts[i][1], nx, 0, nz, wallCol);
      const b = pushVert(mesh, pts[j][0], bottom[j], pts[j][1], nx, 0, nz, wallCol);
      const c = pushVert(mesh, pts[j][0], top[j], pts[j][1], nx, 0, nz, wallCol);
      const d = pushVert(mesh, pts[i][0], top[i], pts[i][1], nx, 0, nz, wallCol);
      pushTri(mesh, a, c, b);
      pushTri(mesh, a, d, c);
    }
    const roofBase = pts.map(([x, y], i) => pushVert(mesh, x, top[i], y, 0, 1, 0, roofCol));
    const tris = triangulatePolygon(pts);
    for (let k = 0; k + 2 < tris.length; k += 3) {
      pushTri(mesh, roofBase[tris[k]], roofBase[tris[k + 2]], roofBase[tris[k + 1]]);
    }
  }
  return mesh;
}

const GROUND_COLORS: Record<string, [number, number, number]> = {
  grass: [0.4, 0.58, 0.32],
  forest: [0.3, 0.48, 0.26],
  park: [0.42, 0.6, 0.34],
  residential: [0.52, 0.5, 0.46],
  commercial: [0.55, 0.52, 0.47],
  retail: [0.55, 0.52, 0.47],
  industrial: [0.55, 0.53, 0.48],
  water: [0.25, 0.45, 0.65],
  cemetery: [0.45, 0.56, 0.36],
  meadow: [0.46, 0.6, 0.36],
 scrub: [0.4, 0.52, 0.32],
};

function groundColor(tags: Record<string, string>): [number, number, number] {
  if (tags["natural"] === "water" || tags["waterway"]) return GROUND_COLORS.water;
  const lu = tags["landuse"] ?? tags["leisure"] ?? tags["natural"] ?? "";
  return GROUND_COLORS[lu] ?? [0.5, 0.52, 0.44];
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

  nearest(x: number, y: number, maxDist = 60): RoadQuery | undefined {
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const range = Math.ceil(maxDist / this.cell);
    let best: RoadQuery | undefined;
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
          if (!best || dist < best.dist) {
            best = {
              dist,
              t,
              elev: s.elevA + (s.elevB - s.elevA) * t,
              halfW: s.halfW,
              layer: s.layer,
              seg: s,
            };
          }
        }
      }
    }
    return best;
  }
}
