// Tests for the CPU tessellation / color parsing / pattern tiles used by the
// WebGL renderer (src/gl.ts). Run with: tsx tests/gl-tessellation.ts
import "./tri-init";
import {
  triangulatePolygon,
  parseColor,
  grassTileData,
  stoneTileData,
  type Pt,
} from "../src/gl";

let failures = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
}

function triArea(a: Pt, b: Pt, c: Pt): number {
  return Math.abs(
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  ) / 2;
}
function ringArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i],
      q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
function orient(a: Pt, b: Pt, c: Pt): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function segsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  // epsilon: Steiner points on split boundary segments lie exactly on ring
  // edges, and float error must not count that as a proper crossing
  const s = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.sign(v));
  const d1 = s(orient(c, d, a)),
    d2 = s(orient(c, d, b)),
    d3 = s(orient(a, b, c)),
    d4 = s(orient(a, b, d));
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}
function pointInPolygon(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a[1] > p[1] !== b[1] > p[1]) {
      const xint = ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (p[0] < xint) inside = !inside;
    }
  }
  return inside;
}
function cleanRing(ring: Pt[]): Pt[] {
  const pts: Pt[] = [];
  for (const p of ring) {
    const l = pts[pts.length - 1];
    if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 1e-9) pts.push([p[0], p[1]]);
  }
  if (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= 1e-9)
    pts.pop();
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length],
      b = pts[i],
      c = pts[(i + 1) % pts.length];
    if (Math.abs(orient(a, b, c)) > 1e-12) out.push(b);
  }
  return out;
}

// Full FEM-readiness check: exact coverage, every triangle inside the polygon,
// no mesh edge crossing the boundary, every boundary edge present, and
// quality bounds (min angle, max edge length).
function checkTriangulation(ring: Pt[], label: string): void {
  const { verts, tris } = triangulatePolygon(ring);
  ok(tris.length % 3 === 0 && tris.length >= 3, `${label}: produces triangles`);
  let area = 0;
  for (let i = 0; i < tris.length; i += 3)
    area += triArea(verts[tris[i]], verts[tris[i + 1]], verts[tris[i + 2]]);
  const want = Math.abs(ringArea(ring));
  ok(
    Math.abs(area - want) < 1e-6 * Math.max(1, want),
    `${label}: triangle area ${area.toFixed(3)} == polygon area ${want.toFixed(3)}`,
  );
  const n = ring.length;
  ok(
    tris.length / 3 >= Math.max(1, n - 2),
    `${label}: ${tris.length / 3} triangles for ${n} vertices (>= n-2 expected)`,
  );

  const clean = cleanRing(ring);
  const edges = new Set<string>();
  let minAngle = 180,
    maxEdge = 0;
  let inside = true,
    noCross = true;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of clean) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const maxEdgeAllowed = Math.hypot(maxX - minX, maxY - minY) / 8;
  for (let i = 0; i < tris.length; i += 3) {
    const A = verts[tris[i]],
      B = verts[tris[i + 1]],
      C = verts[tris[i + 2]];
    for (const [u, v] of [
      [tris[i], tris[i + 1]],
      [tris[i + 1], tris[i + 2]],
      [tris[i + 2], tris[i]],
    ] as const)
      edges.add(u < v ? `${u}:${v}` : `${v}:${u}`);
    const cx = (A[0] + B[0] + C[0]) / 3,
      cy = (A[1] + B[1] + C[1]) / 3;
    if (!pointInPolygon([cx, cy], clean)) inside = false;
    for (let e = 0; e < clean.length; e++) {
      const r1 = clean[e],
        r2 = clean[(e + 1) % clean.length];
      if (segsCross(A, B, r1, r2) || segsCross(B, C, r1, r2) || segsCross(C, A, r1, r2))
        noCross = false;
    }
    const ls = [
      Math.hypot(A[0] - B[0], A[1] - B[1]),
      Math.hypot(B[0] - C[0], B[1] - C[1]),
      Math.hypot(C[0] - A[0], C[1] - A[1]),
    ];
    maxEdge = Math.max(maxEdge, ...ls);
    const s = Math.min(...ls);
    if (s > 0) {
      for (let e = 0; e < 3; e++) {
        const p = [A, B, C][e],
          q = [A, B, C][(e + 1) % 3],
          r = [A, B, C][(e + 2) % 3];
        const ll = Math.hypot(p[0] - q[0], p[1] - q[1]);
        const m = Math.hypot(p[0] - r[0], p[1] - r[1]);
        const dot = (q[0] - p[0]) * (r[0] - p[0]) + (q[1] - p[1]) * (r[1] - p[1]);
        const ang = (Math.acos(Math.max(-1, Math.min(1, dot / (ll * m)))) * 180) / Math.PI;
        minAngle = Math.min(minAngle, ang);
      }
    }
  }
  ok(inside, `${label}: all triangle centroids inside the polygon`);
  ok(noCross, `${label}: no triangle edge leaves the polygon`);
  let boundaryOk = true;
  for (let e = 0; e < clean.length; e++) {
    // every boundary segment must be covered by mesh edges (possibly split)
    const r1 = clean[e],
      r2 = clean[(e + 1) % clean.length];
    let covered = 0;
    for (let i = 0; i < verts.length; i++) {
      for (let j = i + 1; j < verts.length; j++) {
        if (!edges.has(`${i}:${j}`)) continue;
        const a = verts[i],
          b = verts[j];
        if (
          Math.abs(orient(r1, r2, a)) < 1e-9 &&
          Math.abs(orient(r1, r2, b)) < 1e-9 &&
          Math.min(r1[0], r2[0]) - 1e-9 <= Math.min(a[0], b[0]) &&
          Math.max(a[0], b[0]) <= Math.max(r1[0], r2[0]) + 1e-9 &&
          Math.min(r1[1], r2[1]) - 1e-9 <= Math.min(a[1], b[1]) &&
          Math.max(a[1], b[1]) <= Math.max(r1[1], r2[1]) + 1e-9
        )
          covered += Math.hypot(a[0] - b[0], a[1] - b[1]);
      }
    }
    const len = Math.hypot(r2[0] - r1[0], r2[1] - r1[1]);
    if (Math.abs(covered - len) > 1e-6 * Math.max(1, len)) boundaryOk = false;
  }
  ok(boundaryOk, `${label}: every boundary edge is a mesh edge (constrained)`);
  // Triangle's -q22 bounds the min angle unless a sharper input corner forces it
  ok(minAngle >= 15, `${label}: min angle ${minAngle.toFixed(1)} deg >= 15 deg (no sharp angles)`);
  // -a bounds triangle area; with the min-angle bound this caps edges at
  // ~2x the target edge length (diag/8)
  ok(
    maxEdge <= maxEdgeAllowed * 2 + 1e-9,
    `${label}: max edge ${maxEdge.toFixed(3)} <= ${((maxEdgeAllowed * 2).toFixed(3))} (no long edges)`,
  );
}

console.log("gl tessellation tests");
checkTriangulation(
  [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
  "square",
);
// concave (L-shape), given clockwise (negative area) on purpose
checkTriangulation(
  [
    [0, 0],
    [0, 10],
    [4, 10],
    [4, 4],
    [10, 4],
    [10, 0],
  ],
  "concave L (cw input)",
);
// strongly concave U-shape
checkTriangulation(
  [
    [0, 0],
    [12, 0],
    [12, 10],
    [8, 10],
    [8, 3],
    [4, 3],
    [4, 10],
    [0, 10],
  ],
  "concave U",
);
// ring with duplicate + collinear points mixed in
checkTriangulation(
  [
    [0, 0],
    [5, 0],
    [5, 0],
    [10, 0],
    [10, 10],
    [5, 10],
    [0, 10],
    [0, 5],
    [0, 0],
  ],
  "square with dup/collinear points",
);
// long thin rectangle (road-area shape)
checkTriangulation(
  [
    [0, 0],
    [200, 0],
    [200, 3],
    [0, 3],
  ],
  "long thin strip",
);
// randomized star-shaped (always simple) polygons
let seed = 12345;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
for (let k = 0; k < 25; k++) {
  const m = 6 + Math.floor(rnd() * 14);
  const ring: Pt[] = [];
  for (let i = 0; i < m; i++) {
    const ang = (i / m) * Math.PI * 2;
    const r = 3 + rnd() * 9;
    ring.push([10 + r * Math.cos(ang), 10 + r * Math.sin(ang)]);
  }
  checkTriangulation(ring, `random star #${k}`);
}

// colors
const c1 = parseColor("#ff0000");
ok(c1 !== null && c1[0] === 1 && c1[1] === 0 && c1[2] === 0 && c1[3] === 1, "parse #rrggbb");
const c2 = parseColor("#f008");
ok(c2 !== null && Math.abs(c2[3] - 8 / 15) < 1e-9, "parse #rgba");
const c3 = parseColor("rgb(255, 0, 0)");
ok(c3 !== null && c3[0] === 1 && c3[3] === 1, "parse rgb()");
const c4 = parseColor("rgba(255, 210, 80, 0.45)");
ok(c4 !== null && Math.abs(c4[3] - 0.45) < 1e-9, "parse rgba()");
const c5 = parseColor("red");
ok(c5 !== null && c5[0] === 1 && c5[1] === 0, "parse named color");
ok(parseColor("not-a-color") === null, "invalid color -> null");
ok(parseColor("#12") === null, "bad hex -> null");

// pattern tiles
const gt = grassTileData("grass");
ok(gt.w === 12 && gt.h === 12 && gt.data.length === 12 * 12 * 4, "grass tile 12x12 RGBA");
ok(gt.data[3] === 255, "grass tile opaque");
const st = stoneTileData("sett");
ok(st !== null && st.w === 12 && st.h === 12, "sett tile 12x12");
const sp = stoneTileData("paving_stones");
ok(sp !== null && sp.w === 18 && sp.h === 18, "paving_stones tile 18x18");
ok(stoneTileData("asphalt") === null, "asphalt has no stone tile");

if (failures > 0) {
  console.error(`${failures} gl tessellation test(s) FAILED`);
  process.exit(1);
}
console.log("all gl tessellation tests passed");
