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
// a DIFFERENT road (other name) touching the first one end-to-end: must not
// join the group and must keep its own measured lane width
const n4 = node(30000, 0), n5 = node(40000, 0);
const wayD = way([n4, n5], { highway: "residential", surface: "asphalt", lanes: "2", name: "Andere Straße" });
way(rect(30000, 40000, 300), { "area:highway": "residential", area: "yes", surface: "asphalt" });

const result = extractFeatures(data);
const lm = result.laneMarkings;
const byWay = (id: number): LineFeature[] => lm.filter((m) => m.id === `w${id}`);

const A = byWay(wayA), B = byWay(wayB), C = byWay(wayC), D = byWay(wayD);
check("one marking piece per way/area section",
  A.length === 1 && B.length === 1 && C.length === 1 && D.length === 1,
  `A:${A.length} B:${B.length} C:${C.length} D:${D.length}`);

// unit widths measured per piece: 900/2, 1300/3, 900/4, 600/2 (lat units ~ cm;
// ratios are what matter). The road group shares the MEDIAN of the first
// three (the fourth is a different road).
const mPerLat = 111_320 / 1e7;
const expected = 1300 * mPerLat / 3;
check("all pieces of the road share the median lane width",
  near(A[0].laneW!, expected) && near(B[0].laneW!, expected) && near(C[0].laneW!, expected),
  `A:${A[0].laneW} B:${B[0].laneW} C:${C[0].laneW} expected:${expected}`);
check("a different road keeps its own lane width",
  near(D[0].laneW!, 600 * mPerLat / 2),
  `D:${D[0].laneW}`);

// offset of a lane boundary k from the centerline (left positive, main.ts):
// -laneLeftM + k * laneW
const offsets = (p: LineFeature): number[] => {
  const out: number[] = [];
  for (let k = 1; k < p.lanes!; k++) out.push(-p.laneLeftM! + k * p.laneW!);
  return out;
};
const borderOffset = (p: LineFeature): number => -p.laneLeftM! + p.lanesFwd! * p.laneW!;
check("solid direction border at the same offset on every piece",
  near(borderOffset(A[0]), borderOffset(B[0])) && near(borderOffset(A[0]), borderOffset(C[0])),
  `A:${borderOffset(A[0])} B:${borderOffset(B[0])} C:${borderOffset(C[0])}`);

// 2→3 lanes: the two existing boundaries continue, one lane is ADDED on the
// outer (left) side — the border offset appears in both boundary sets
const offA = offsets(A[0]), offB = offsets(B[0]);
check("2→3 lane change only adds an outer boundary",
  offB.length === offA.length + 1
  && offB.some((o) => offA.some((o2) => near(o, o2))) === true
  && offA.every((o) => offB.some((o2) => near(o, o2))),
  `A:${offA} B:${offB}`);

// parking appears on the last section: lane boundaries must not move
check("parking change moves no lane boundary",
  C[0].lanes === 2 && near(C[0].laneLeftM!, A[0].laneLeftM!)
  && near(C[0].laneW!, A[0].laneW!),
  `C left:${C[0].laneLeftM} A left:${A[0].laneLeftM}`);

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all lane marking tests passed");
