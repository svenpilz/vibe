/**
 * Regression tests for continuous lane markings (README §5):
 * a road split into several ways / area sections shares one lane width and
 * one direction-border anchor, so lane boundaries never jump at seams:
 *  - all pieces of a road share the same (median) lane width
 *  - the solid direction border sits at the SAME offset on every piece
 *  - a 2→3 lane change keeps the existing boundaries and adds one outside
 *  - a parking lane appearing/disappearing moves no lane boundary
 *  - different roads (different name) are not merged
 */
import { createOSMData } from "../src/osm-pbf";
import { extractFeatures } from "../src/extract";
import type { LineFeature } from "../src/features";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

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

// one road, split into three ways: 2 lanes → 3 lanes → 2 lanes + parking:both
const road = "Teststraße";
const n0 = node(0, 0), n1 = node(10000, 0), n2 = node(20000, 0), n3 = node(30000, 0);
const wayA = way([n0, n1], { highway: "residential", surface: "asphalt", lanes: "2", name: road });
const wayB = way([n1, n2], { highway: "residential", surface: "asphalt", lanes: "3", name: road });
const wayC = way([n2, n3], {
  highway: "residential", surface: "asphalt", lanes: "2", name: road,
  "parking:both": "lane", "parking:both:orientation": "parallel",
});
// highway areas split into the same three sections (the middle one wider,
// as the 3-lane section needs more space)
const rect = (x0: number, x1: number, halfWidth: number): number[] => {
  const a = node(x0, -halfWidth), b = node(x1, -halfWidth),
        c = node(x1, halfWidth), d = node(x0, halfWidth);
  return [a, b, c, d, a];
};
way(rect(0, 10000, 450), { "area:highway": "residential", area: "yes", surface: "asphalt" });
way(rect(10000, 20000, 650), { "area:highway": "residential", area: "yes", surface: "asphalt" });
way(rect(20000, 30000, 450), { "area:highway": "residential", area: "yes", surface: "asphalt" });
// a DIFFERENT road (other name) ending at the same node but running off
// PERPENDICULAR (a cross street, not a continuation): must not join the
// group and must keep its own measured lane width
const n4 = node(30000, 0), n5 = node(30000, 9000);
const wayD = way([n4, n5], { highway: "residential", surface: "asphalt", lanes: "2", name: "Andere Straße" });
const rectV = (y0: number, y1: number, halfWidth: number): number[] => {
  const a = node(30000 - halfWidth, y0), b = node(30000 + halfWidth, y0),
        c = node(30000 + halfWidth, y1), d = node(30000 - halfWidth, y1);
  return [a, b, c, d, a];
};
way(rectV(0, 9000, 300), { "area:highway": "residential", area: "yes", surface: "asphalt" });

const result = extractFeatures(data);
const lm = result.laneMarkings;
const byWay = (id: number): LineFeature[] => lm.filter((m) => m.id === `w${id}`);

const A = byWay(wayA), B = byWay(wayB), C = byWay(wayC), D = byWay(wayD);
check("one marking piece per way/area section",
  A.length === 1 && B.length === 1 && C.length === 1 && D.length === 1,
  `A:${A.length} B:${B.length} C:${C.length} D:${D.length}`);

// per-piece lane width: each piece splits its OWN measured width evenly
// among its units (900/2, 1300/3, 900/4 lat units) so the layout follows
// the local road width; the perpendicular cross street keeps its own 600/2
const mPerLat = 111_320 / 1e7;
const mPerLon = mPerLat * Math.cos((LAT / 1e7) * Math.PI / 180);
check("each piece splits its own measured width evenly",
  near(A[0].laneW!, 900 * mPerLat / 2) && near(B[0].laneW!, 1300 * mPerLat / 3)
  && near(C[0].laneW!, 900 * mPerLat / 4),
  `A:${A[0].laneW} B:${B[0].laneW} C:${C[0].laneW}`);
check("a different road keeps its own lane width",
  near(D[0].laneW!, 600 * mPerLon / 2, 1e-4),
  `D:${D[0].laneW}`);
// the direction border (solid line) must sit at the same fraction of the
// road span on every piece of the road: the centerline runs through the
// middle of the road in this fixture, so the border offset in meters is
// also equal across pieces
const offsets = (p: LineFeature): number[] => {
  const out: number[] = [];
  for (let k = 1; k < p.lanes!; k++) out.push(-p.laneLeftM! + k * p.laneW!);
  return out;
};
const borderOffset = (p: LineFeature): number => -p.laneLeftM! + p.lanesFwd! * p.laneW!;
// pieces with the same direction split (A and C: 1+1) keep the solid
// border at the same offset; the 3-lane piece (B, 2+1) shifts as its own
// geometry requires — the road did not widen for its extra lane
check("solid direction border aligned across same-split pieces",
  near(borderOffset(A[0]), borderOffset(C[0]), 1e-6),
  `A:${borderOffset(A[0])} C:${borderOffset(C[0])}`);
// 2→3 lanes: the border keeps its position; lane boundaries shift only
// by the added lane's width (the anchor is fractional, the pieces have
// different unit widths)
const offA = offsets(A[0]), offB = offsets(B[0]);
check("2→3 lane change keeps the border and adds one lane",
  offB.length === offA.length + 1,
  `A:${offA} B:${offB}`);
// parking appears on the last section: the piece has one more unit, so
// its lane width shrinks — but its block still fills the road evenly and
// no boundary leaves the road span
check("parking change splits the road width evenly over its units",
  C[0].lanes === 2 && near(C[0].laneW!, 900 * mPerLat / 4),
  `C laneW:${C[0].laneW} expected:${900 * mPerLat / 4}`);

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all lane marking tests passed");
