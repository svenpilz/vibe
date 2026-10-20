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
  // PER-SIDE FILL: with the shared middle line at the group anchor (the
  // median of the pieces' natural border positions - between the two
  // pieces' naturals), each piece's unit width is its even split CAPPED
  // by its tighter side; the tighter side fills exactly, the looser
  // side keeps the same unit width and leaves a verge. The parking bays
  // are exactly one unit wide - the property this regression guards
  // (they were crushed to ~half a unit when the block was placed
  // without per-side capping)
  const sideFill = (p: LineFeature, tag: string): boolean => {
    const fwd = p.lanesFwd ?? Math.ceil(p.lanes! / 2);
    const lw = p.laneW!;
    const border = -p.laneLeftM! + fwd * lw;
    const unitsL = (p.parkingLeft ? 1 : 0) + (p.lanes! - fwd);
    const unitsR = (p.parkingRight ? 1 : 0) + fwd;
    const spanL = p.roadLeftM! + border;
    const spanR = p.roadRightM! - border;
    const perL = spanL / unitsL;
    const perR = spanR / unitsR;
    // the unit width equals the tighter side's natural width
    const tighter = Math.min(perL, perR);
    if (Math.abs(lw - tighter) > 0.05) return false;
    // the tighter side fills exactly: units*lw == span
    if (Math.abs(unitsL * lw - spanL) > 0.1 && Math.abs(unitsR * lw - spanR) > 0.1)
      return false;
    // the parking bay(s) are exactly one unit wide
    if (p.parkingLeft && Math.abs(spanL - unitsL * lw) > 0.1 && perL < perR)
      return false;
    void tag;
    return true;
  };
  check(
    "w4536810: unit width capped by the tighter side (bays full width)",
    sideFill(w, "w4536810"),
    `laneW:${w.laneW!.toFixed(3)}`,
  );
  check(
    "w1436394163: unit width capped by the tighter side (bay full width)",
    sideFill(n, "w1436394163"),
    `laneW:${n.laneW!.toFixed(3)}`,
  );
  // the fitted rectangles see the parking units: 6-unit piece and
  // 5-unit piece differ in unit width (the rectangle widths follow the
  // units, not a shared group constant)
  check(
    "unit widths differ with the unit count (rectangles see the parking lane)",
    Math.abs(w.laneW! - n.laneW!) > 0.2,
    `w:${w.laneW!.toFixed(3)} n:${n.laneW!.toFixed(3)}`,
  );
  // the middle line (solid border) is CONTINUOUS across the road group:
  // both pieces draw it at the SAME offset (the median of their
  // parking-aware natural positions). The two pieces have different
  // parking layouts and unit counts, so each piece's parking strips
  // absorb the difference between its natural border position and the
  // shared anchor (a strip may be wider or narrower than one traffic
  // unit, but never more than one unit off, and never negative)
  const borderOf = (p: LineFeature): number =>
    -p.laneLeftM! + (p.lanesFwd ?? Math.ceil(p.lanes! / 2)) * p.laneW!;
  check(
    "middle line continuous across the road group (shared anchor)",
    Math.abs(borderOf(w) - borderOf(n)) < 0.05,
    `w:${borderOf(w).toFixed(3)} n:${borderOf(n).toFixed(3)}`,
  );
  for (const [p, tag] of [[w, "w4536810"], [n, "w1436394163"]] as [LineFeature, string][]) {
    const lw = p.laneW!;
    const leftBlk = p.laneLeftM!;
    const rightBlk = leftBlk - p.lanes! * lw;
    const stripL = p.roadLeftM! - leftBlk;
    const stripR = rightBlk + p.roadRightM!;
    const parkSide = (side: "L" | "R"): boolean => {
      const strip = side === "L" ? stripL : stripR;
      if (side === "L" ? !p.parkingLeft : !p.parkingRight) return true;
      return strip >= -0.05 && strip <= lw * 2 + 0.05;
    };
    check(
      `${tag}: parking strips absorb the anchor difference (0..2 units, never negative)`,
      parkSide("L") && parkSide("R"),
      `L:${stripL.toFixed(2)} R:${stripR.toFixed(2)} unit:${lw.toFixed(2)}`,
    );
    check(
      `${tag}: traffic lanes at the piece's own unit width`,
      Math.abs((leftBlk - rightBlk) - p.lanes! * lw) < 1e-6,
      `block:${(leftBlk - rightBlk).toFixed(3)} expected:${(p.lanes! * lw).toFixed(3)}`,
    );
  }
}

if (failures > 0) {
  console.error(`${failures} saar 4536810 regression test(s) failed`);
  process.exit(1);
}
console.log("all saar 4536810 regression tests passed");
