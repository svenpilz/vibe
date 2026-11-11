// Tests for the CPU tessellation / color parsing / pattern tiles used by the
// WebGL renderer (src/gl.ts). Run with: tsx tests/gl-tessellation.ts
import {
  earclip,
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
function checkTriangulation(ring: Pt[], label: string, exactCount = true): void {
  const tris = earclip(ring);
  ok(tris.length % 3 === 0 && tris.length >= 3, `${label}: produces triangles`);
  let area = 0;
  for (let i = 0; i < tris.length; i += 3)
    area += triArea(ring[tris[i]], ring[tris[i + 1]], ring[tris[i + 2]]);
  const want = Math.abs(ringArea(ring));
  ok(
    Math.abs(area - want) < 1e-6 * Math.max(1, want),
    `${label}: triangle area ${area.toFixed(3)} == polygon area ${want.toFixed(3)}`,
  );
  if (exactCount) {
    const n = ring.length;
    ok(
      tris.length === (n - 2) * 3,
      `${label}: ${tris.length / 3} triangles for ${n} vertices (n-2 expected)`,
    );
  }
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
  false, // collinear vertices are dropped, so fewer than n-2 triangles
);

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
