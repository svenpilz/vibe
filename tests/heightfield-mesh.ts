import type { BakedData, BakedWay } from "../src3d/schema";
import { triangulatePolygon, buildTerrainMesh, buildRoads, buildBuildings, buildGround, RoadIndex } from "../src3d/mesh";
import { metersToLonLat, quantizeDeg } from "../src3d/geo";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

function polygonArea(pts: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function triAreaSum(pts: Array<[number, number]>, tris: number[]): number {
  let a = 0;
  for (let k = 0; k + 2 < tris.length; k += 3) {
    const [ax, ay] = pts[tris[k]];
    const [bx, by] = pts[tris[k + 1]];
    const [cx, cy] = pts[tris[k + 2]];
    a += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
  return a;
}

const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
const sqTris = triangulatePolygon(square);
check("square -> 2 triangles", sqTris.length === 6, `${sqTris.length}`);
check("square area preserved", Math.abs(triAreaSum(square, sqTris) - 100) < 1e-9);

const concave: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [5, 5], [0, 10]];
const ccTris = triangulatePolygon(concave);
check("concave polygon area preserved", Math.abs(triAreaSum(concave, ccTris) - polygonArea(concave)) < 1e-6,
  `${triAreaSum(concave, ccTris)} vs ${polygonArea(concave)}`);

check("degenerate -> empty", triangulatePolygon([[0, 0], [1, 1]]).length === 0);

/** synthetic flat dataset: terrain 50 m everywhere, nodes placed via meters */
function mkData(ways: { ptsM: Array<[number, number]>; tags: Record<string, string> }[]): BakedData {
  const keys: string[] = [];
  const values: string[] = [];
  const keyIdx = new Map<string, number>();
  const valIdx = new Map<string, number>();
  const intern = (table: string[], map: Map<string, number>, s: string): number => {
    let i = map.get(s);
    if (i === undefined) {
      i = table.length;
      table.push(s);
      map.set(s, i);
    }
    return i;
  };
  const nodes: number[] = [];
  const nodeIdx = new Map<string, number>();
  const refOf = (x: number, y: number): number => {
    const key = `${x},${y}`;
    let i = nodeIdx.get(key);
    if (i === undefined) {
      const [lon, lat] = metersToLonLat(x, y);
      i = nodes.length / 2;
      nodes.push(quantizeDeg(lon), quantizeDeg(lat));
      nodeIdx.set(key, i);
    }
    return i;
  };
  const bakedWays: BakedWay[] = ways.map((w) => {
    const t: number[] = [];
    for (const [k, v] of Object.entries(w.tags)) t.push(intern(keys, keyIdx, k), intern(values, valIdx, v));
    return { r: w.ptsM.map(([x, y]) => refOf(x, y)), t };
  });
  const n = 4;
  const heightsDm = new Array((n + 1) * (n + 1)).fill(500);
  return {
    centerLon: 13.341, centerLat: 52.4784, radiusM: 2000, layerH: 5,
    terrain: { n, sizeM: 400, originX: -200, originY: -200, heightsDm },
    keys, values, nodes, ways: bakedWays,
  };
}

const terr = buildTerrainMesh({ n: 4, sizeM: 400, originX: -200, originY: -200, heightsDm: new Array(25).fill(500) });
check("terrain mesh vertices", terr.positions.length / 3 === 25, `${terr.positions.length / 3}`);
check("terrain mesh triangles", terr.indices.length / 3 === 4 * 4 * 2, `${terr.indices.length / 3}`);
check("terrain height 50 m", terr.positions[1] === 50);

const data = mkData([
  { ptsM: [[0, 0], [100, 0]], tags: { highway: "residential" } },
  { ptsM: [[0, 50], [100, 50]], tags: { highway: "primary", layer: "1", bridge: "yes" } },
  { ptsM: [[0, -50], [100, -50], [100, -60], [0, -60], [0, -50]], tags: { building: "yes", height: "12" } },
]);
const roads = buildRoads(data);
check("two road ways -> 2 segments", roads.segments.length === 2, `${roads.segments.length}`);
check("ground road at terrain 50 m", Math.abs(roads.segments[0].elevA - 50) < 1e-6, `${roads.segments[0].elevA}`);
check("bridge deck at 50+5=55 m", Math.abs(roads.segments[1].elevA - 55) < 1e-6, `${roads.segments[1].elevA}`);
check("residential half width 3.75", Math.abs(roads.segments[0].halfW - 3.75) < 1e-9);
check("road mesh has geometry", roads.mesh.indices.length > 0);
const bridgeVerts = roads.mesh.positions.length / 3;
check("bridge adds parapet verts", bridgeVerts > 8, `${bridgeVerts}`);

const idx = new RoadIndex(roads.segments);
const q = idx.nearest(50, 2, 60);
check("nearest finds ground road", q !== undefined && Math.abs(q.dist - 2) < 1e-9 && q.layer === 0, JSON.stringify(q && { dist: q.dist, layer: q.layer }));
const qb = idx.nearest(50, 52, 60);
check("nearest finds bridge deck above", qb !== undefined && qb.layer === 1 && Math.abs(qb.elev - 55) < 1e-6);
const qm = idx.nearest(50, 0, 60);
check("segment midpoint elevation interpolates", qm !== undefined && Math.abs(qm.elev - 50) < 1e-9);
check("far away -> undefined", idx.nearest(1000, 1000, 60) === undefined);

const buildings = buildBuildings(data);
const roofTop = Math.max(...buildings.positions.filter((_, i) => i % 3 === 1));
check("building roof at 50+12=62 m", Math.abs(roofTop - 62) < 1e-6, `${roofTop}`);
check("building mesh has geometry", buildings.indices.length > 0);

const ground = buildGround(mkData([
  { ptsM: [[-50, 100], [50, 100], [50, 150], [-50, 150], [-50, 100]], tags: { landuse: "grass" } },
]));
check("ground polygon mesh", ground.indices.length >= 6, `${ground.indices.length}`);

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all heightfield mesh tests passed");
