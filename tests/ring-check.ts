/**
 * Regression: a road forming a CLOSED RING of chained ways (e.g. a
 * roundabout mapped as several open ways) inside one highway area.
 * Three failure modes are asserted against:
 *  - CORNER OVERSHOOT: the chordal Catmull-Rom base curve bulged up to
 *    ~2.4 m outside sharp corners (samples left the road), so the offset
 *    boundaries doubled back near corners and rendered as doubled /
 *    closed loops inside the area. Samples must stay on the chain
 *    polyline corridor (< 0.5 m off).
 *  - TANGENTIAL OVERLAP: pieces of adjacent ways drew into each other's
 *    stretch near the shared seam vertices. Piece sample ranges must
 *    tile the ring without overlapping (each within its own way's
 *    extent, meeting at the shared vertices).
 *  - FULL COVERAGE: the four pieces' drawn extents together cover the
 *    ring once (total length ~= perimeter, not double).
 */
import { createOSMData } from "../src/osm-pbf";
import { extractFeatures } from "../src/extract";
import type { LineFeature } from "../src/features";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

const data = createOSMData();
const LAT = Math.round(52.52 * 1e7);
let nextNode = 1;
const node = (x: number, y: number): number => {
  const id = nextNode++;
  data.nodeCoords.set(id, x, LAT + y);
  return id;
};
let nextWay = 1;
const way = (refs: number[], tags: Record<string, string>): number => {
  const id = nextWay++;
  data.ways.set(id, { id, refs, tags });
  return id;
};

// ring of 4 chained bidirectional ways with intermediate vertices
const ringTags = { highway: "residential", surface: "asphalt", lanes: "2", name: "Rundweg" };
const n1 = node(2000, 0), n1b = node(5000, 0), n2 = node(8000, 0);
const n2b = node(8000, 3000), n3 = node(8000, 6000);
const n3b = node(5000, 6000), n4 = node(2000, 6000);
const n4b = node(2000, 3000);
way([n1, n1b, n2], ringTags);
way([n2, n2b, n3], ringTags);
way([n3, n3b, n4], ringTags);
way([n4, n4b, n1], ringTags);
{
  const p0 = node(1000, -900), p1 = node(9000, -900), p2 = node(9000, 6900), p3 = node(1000, 6900);
  way([p0, p1, p2, p3, p0], { "area:highway": "residential", area: "yes", surface: "asphalt" });
}

const result = extractFeatures(data);
const lm = result.laneMarkings.filter((m) => m.name === "Rundweg") as LineFeature[];
check("four marking pieces (one per way)", lm.length === 4, `pieces:${lm.length}`);

const cosLat = Math.cos((LAT / 1e7) * (Math.PI / 180));
const mPerLon = 1e-7 * 111320 * cosLat;
const mPerLat = 1e-7 * 111320;

// ring polyline (quantized) for corridor checks: the four sides
let worstCorridor = 0;
let totalLen = 0;
for (const p of lm) {
  const sp = p.spline ?? [];
  check(`${p.id}: piece carries a spline`, sp.length >= 2, `samples:${sp.length}`);
  let len = 0;
  for (let i = 1; i < sp.length; i++)
    len += Math.hypot(
      (sp[i].pt[0] - sp[i - 1].pt[0]) * mPerLon,
      (sp[i].pt[1] - sp[i - 1].pt[1]) * mPerLat,
    );
  totalLen += len;
  for (const s of sp) {
    const x = s.pt[0], y = s.pt[1];
    let best = Infinity;
    const segs: [number[], number[]][] = [
      [[2000, LAT], [8000, LAT]],
      [[8000, LAT], [8000, LAT + 6000]],
      [[8000, LAT + 6000], [2000, LAT + 6000]],
      [[2000, LAT + 6000], [2000, LAT]],
    ];
    for (const [a, b] of segs) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      let f = len2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / len2 : 0;
      f = Math.max(0, Math.min(1, f));
      const qx = a[0] + dx * f, qy = a[1] + dy * f;
      const d = Math.hypot((x - qx) * mPerLon, (y - qy) * mPerLat);
      if (d < best) best = d;
    }
    if (best > worstCorridor) worstCorridor = best;
  }
}
check(
  "no corner overshoot: every sample stays on the ring corridor (< 0.5 m)",
  worstCorridor < 0.5,
  `worst:${worstCorridor.toFixed(3)} m`,
);
const perimeter = 2 * (6000 * mPerLon + 6000 * mPerLat);
check(
  "the ring is covered once (total drawn length ~= perimeter)",
  Math.abs(totalLen - perimeter) < 0.15 * perimeter,
  `total:${totalLen.toFixed(1)} perimeter:${perimeter.toFixed(1)}`,
);

// TANGENTIAL OVERLAP: pieces must not draw into each other's stretch —
// each piece's samples must lie within its own way's vertex span
// (plus a small margin for the seam vertices)
for (const p of lm) {
  const cs = p.coords;
  const xs = cs.map((c) => c[0]);
  const ys = cs.map((c) => c[1]);
  const vertical = xs[0] === xs[xs.length - 1];
  const sp = p.spline ?? [];
  let inside = true;
  let detail = "";
  for (const s of sp) {
    if (vertical) {
      const lo = Math.min(...ys) - 100, hi = Math.max(...ys) + 100;
      if (s.pt[1] < lo || s.pt[1] > hi || Math.abs(s.pt[0] - xs[0]) > 100) {
        inside = false;
        detail = `sample ${s.pt.join(",")} outside way span x=${xs[0]} y[${lo},${hi}]`;
        break;
      }
    } else {
      const lo = Math.min(...xs) - 100, hi = Math.max(...xs) + 100;
      if (s.pt[0] < lo || s.pt[0] > hi || Math.abs(s.pt[1] - ys[0]) > 100) {
        inside = false;
        detail = `sample ${s.pt.join(",")} outside way span y=${ys[0]} x[${lo},${hi}]`;
        break;
      }
    }
  }
  check(`${p.id}: samples stay within the way's own extent (no tangential overlap)`, inside, detail);
}

if (failures > 0) {
  console.error(`${failures} ring regression test(s) failed`);
  process.exit(1);
}
console.log("all ring regression tests passed");
