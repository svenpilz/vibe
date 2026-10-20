/**
 * Regression: exact Overpass snapshot around way 4536810 (Saarstraße,
 * Berlin) — a bidirectional 4-lane (2+2) secondary with parking:both=lane
 * (6 width units over a ~14.9 m area) chaining into way 1436394163
 * (4 lanes 2+2, parking:left only — 5 units over ~15.1 m). Per README §5
 * the available width is distributed evenly over ALL lanes per piece:
 *  - each piece's unit grid FILLS its own fitted road width (the old
 *    group-median lane width filled neither piece),
 *  - the fitted rectangles show the parking units (6 vs 5 units wide),
 *  - the middle line stays continuous: pieces of the same direction
 *    split share one border anchor, aligning differently sized
 *    rectangles.
 */
import { createOSMData } from "../src/osm-pbf";
import { extractFeatures } from "../src/extract";
import type { LineFeature } from "../src/features";

const data = createOSMData();
let nextNode = 1;
const nodeByCoord = new Map<string, number>();
const node = (lat: number, lon: number): number => {
  const k = `${lat},${lon}`;
  const existing = nodeByCoord.get(k);
  if (existing !== undefined) return existing;
  const id = nextNode++;
  data.nodeCoords.set(id, Math.round(lon * 1e7), Math.round(lat * 1e7));
  nodeByCoord.set(k, id);
  return id;
};
const way = (id: number, coords: [number, number][], tags: Record<string, string>) => {
  data.ways.set(id, { id, refs: coords.map(([lat, lon]) => node(lat, lon)), tags });
};
const area = (id: number, coords: [number, number][], tags: Record<string, string>) => {
  const ring = [...coords, coords[0]].map(([lat, lon]) => node(lat, lon));
  data.ways.set(id, { id, refs: ring, tags });
};

way(4536810, [[52.4685774,13.3335503],[52.4684453,13.3338905],[52.4682234,13.3344617],[52.4681996,13.3345229],[52.4681925,13.3345413]],
  { highway: "secondary", lanes: "4", "lanes:backward": "2", "lanes:forward": "2", name: "Saarstraße", "parking:both": "lane", surface: "asphalt" });

area(1116377493, [[52.4687229,13.3332180],[52.4687528,13.3332623],[52.4687811,13.3333043],[52.4687568,13.3333530],[52.4687235,13.3334244],[52.4686854,13.3335148],[52.4686181,13.3334455],[52.4685700,13.3333959],[52.4686147,13.3332785],[52.4686599,13.3331537],[52.4686844,13.3331758],[52.4687088,13.3331979],[52.4687086,13.3332053],[52.4687094,13.3332112],[52.4687112,13.3332156],[52.4687139,13.3332195],[52.4687194,13.3332201],[52.4687229,13.3332180]],
  { "area:highway": "secondary", junction: "y_junction" });

area(1116377496, [[52.4681527,13.3344734],[52.4681996,13.3345229],[52.4682455,13.3345714],[52.4682477,13.3345684],[52.4682782,13.3345561],[52.4682891,13.3345279],[52.4685104,13.3339595],[52.4686854,13.3335148],[52.4686181,13.3334455],[52.4685700,13.3333959],[52.4685293,13.3335009],[52.4681527,13.3344734]],
  { "area:highway": "secondary" });

area(1116377497, [[52.4681240,13.3347557],[52.4681469,13.3347741],[52.4681714,13.3347938],[52.4681799,13.3347657],[52.4682175,13.3346496],[52.4682455,13.3345714],[52.4681996,13.3345229],[52.4681527,13.3344734],[52.4680659,13.3346960],[52.4680883,13.3347201],[52.4681115,13.3347450],[52.4681139,13.3347422],[52.4681164,13.3347411],[52.4681193,13.3347414],[52.4681217,13.3347439],[52.4681235,13.3347476],[52.4681242,13.3347518],[52.4681240,13.3347557]],
  { "area:highway": "secondary", junction: "y_junction" });

way(1436394163, [[52.4686213,13.3334372],[52.4686181,13.3334455],[52.4685774,13.3335503]],
  { highway: "secondary", lanes: "4", "lanes:backward": "2", "lanes:forward": "2", name: "Saarstraße", "parking:left": "lane", "parking:right": "no", surface: "asphalt" });

const result = extractFeatures(data);
const lm = result.laneMarkings.filter((m) => m.name === "Saarstraße");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

const w = lm.find((m) => m.id === "w4536810") as LineFeature | undefined;
const n = lm.find((m) => m.id === "w1436394163") as LineFeature | undefined;
check(
  "marking pieces for both ways",
  w !== undefined && n !== undefined,
  `w:${w?.id} n:${n?.id}`,
);
if (w && n) {
  const units = (p: LineFeature): number =>
    p.lanes! + (p.parkingLeft ? 1 : 0) + (p.parkingRight ? 1 : 0);
  // the piece's unit width splits its OWN fitted width: the traffic
  // block + parking strips fill the fitted road exactly
  const fillOf = (p: LineFeature): boolean => {
    const u = units(p);
    const lw = p.laneW!;
    const blk = p.lanes! * lw;
    const parkL = p.parkingLeft ? lw : 0;
    const parkR = p.parkingRight ? lw : 0;
    const total = blk + parkL + parkR;
    const road = p.roadLeftM! + p.roadRightM!;
    return Math.abs(total - road) < 0.05 * road;
  };
  check(
    "w4536810: unit grid fills its fitted width (incl. parking lanes)",
    fillOf(w),
    `units:${units(w)} total:${(w.lanes! * w.laneW! + (w.parkingLeft ? w.laneW! : 0) + (w.parkingRight ? w.laneW! : 0)).toFixed(2)} road:${(w.roadLeftM! + w.roadRightM!).toFixed(2)}`,
  );
  check(
    "w1436394163: unit grid fills its fitted width (incl. parking lane)",
    fillOf(n),
    `units:${units(n)} total:${(n.lanes! * n.laneW! + (n.parkingLeft ? n.laneW! : 0) + (n.parkingRight ? n.laneW! : 0)).toFixed(2)} road:${(n.roadLeftM! + n.roadRightM!).toFixed(2)}`,
  );
  // the fitted rectangles see the parking units: 6-unit piece and
  // 5-unit piece differ in unit width (the rectangle widths follow the
  // units, not a shared group constant)
  check(
    "unit widths differ with the unit count (rectangles see the parking lane)",
    Math.abs(w.laneW! - n.laneW!) > 0.2,
    `w:${w.laneW!.toFixed(3)} n:${n.laneW!.toFixed(3)}`,
  );
  // the middle line (solid border) stays at the same offset on both
  // pieces — same direction split (2+2), aligned differently sized
  // rectangles
  const borderOf = (p: LineFeature): number =>
    -p.laneLeftM! + (p.lanesFwd ?? Math.ceil(p.lanes! / 2)) * p.laneW!;
  check(
    "middle line aligned across the differently sized rectangles (same 2+2 split)",
    Math.abs(borderOf(w) - borderOf(n)) < 0.05,
    `w:${borderOf(w).toFixed(3)} n:${borderOf(n).toFixed(3)}`,
  );
}

if (failures > 0) {
  console.error(`${failures} saar 4536810 regression test(s) failed`);
  process.exit(1);
}
console.log("all saar 4536810 regression tests passed");
