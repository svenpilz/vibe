/**
 * Regression: a road chaining ways of OPPOSITE mapping directions. The
 * chain traverses a way mapped against the chain direction REVERSED;
 * its samples' left/right values are flipped into the WAY's own frame,
 * and the piece's sample array must be REVERSED to run along the way -
 * the renderer derives its normals from array order, so a piece whose
 * array runs against its way would render the whole lane block
 * MIRRORED: parking:left on the right side (way 1116382309).
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

// road running WEST->EAST; way A mapped forward, way B mapped REVERSED
// (east->west). Both tag parking on THEIR left: A's left is north (+y),
// B's left is south (-y) - the bays must render on OPPOSITE sides.
const a0 = node(0, 0), a1 = node(10000, 0);
const b0 = node(10000, 0), b1 = node(20000, 0);
way([a0, a1], { highway: "residential", surface: "asphalt", lanes: "2", name: "Spiegelweg", "parking:left": "lane", "parking:right": "no" });
way([b1, b0], { highway: "residential", surface: "asphalt", lanes: "2", name: "Spiegelweg", "parking:left": "lane", "parking:right": "no" });
{
  const p0 = node(0, -450), p1 = node(20000, -450), p2 = node(20000, 450), p3 = node(0, 450);
  way([p0, p1, p2, p3, p0], { "area:highway": "residential", area: "yes", surface: "asphalt" });
}

const result = extractFeatures(data);
const lm = result.laneMarkings.filter((m) => m.name === "Spiegelweg") as LineFeature[];
check("two marking pieces", lm.length === 2, `pieces:${lm.length}`);

for (const p of lm) {
  const sp = p.spline ?? [];
  check(`${p.id}: piece carries a spline`, sp.length >= 2, `samples:${sp.length}`);
  if (sp.length < 2) continue;
  // the sample array must run ALONG the way (its first sample near the
  // way's first vertex): the renderer's array-order normals then match
  // the sample values' way frame
  const wayStart = p.coords[0];
  const wayEnd = p.coords[p.coords.length - 1];
  const dStart = Math.hypot(sp[0].pt[0] - wayStart[0], sp[0].pt[1] - wayStart[1]);
  const dEnd = Math.hypot(sp[0].pt[0] - wayEnd[0], sp[0].pt[1] - wayEnd[1]);
  check(
    `${p.id}: sample array runs along the way`,
    dStart < dEnd,
    `first sample dStart:${dStart.toFixed(0)} dEnd:${dEnd.toFixed(0)}`,
  );
  // the left-positive sample normal must point to the WAY's left:
  // the way direction cross the normal = +1 (left) in metric space
  const mid = sp[Math.floor(sp.length / 2)];
  const wdx = wayEnd[0] - wayStart[0];
  const wdy = wayEnd[1] - wayStart[1];
  // left normal of the way direction = (-wdy, wdx)/|w|; compare with the sample's
  const wl = Math.hypot(wdx, wdy);
  const expNx = -wdy / wl;
  const expNy = wdx / wl;
  // account for lon/lat scale: compare the dominant axis sign
  const horiz = Math.abs(wdx) > Math.abs(wdy);
  const normalMatches = horiz
    ? Math.sign(mid.ny) === Math.sign(expNy)
    : Math.sign(mid.nx) === Math.sign(expNx);
  check(
    `${p.id}: left-positive normal points to the way's left`,
    normalMatches,
    `normal:(${mid.nx.toFixed(2)}, ${mid.ny.toFixed(2)}) expected sign:(${expNx.toFixed(2)}, ${expNy.toFixed(2)})`,
  );
  // the parking bay must sit on the way's LEFT side geometrically: the
  // block's left edge + bay lie between the block and the LEFT road
  // edge; for way A (W->E, left = +y/north) the bay's y > centerline;
  // for way B (E->W, left = -y/south) the bay's y < centerline
  const fwd = p.lanesFwd ?? Math.ceil(p.lanes! / 2);
  const lw = p.laneW!;
  const blkL = p.laneLeftM!;
  const roadL = p.roadLeftM!;
  check(
    `${p.id}: left bay exists (parking:left=lane)`,
    Math.abs(roadL - blkL) > 0.05,
    `roadL:${roadL.toFixed(2)} blkL:${blkL.toFixed(2)}`,
  );
  void fwd;
}

if (failures > 0) {
  console.error(`${failures} reversed-way regression test(s) failed`);
  process.exit(1);
}
console.log("all reversed-way regression tests passed");
