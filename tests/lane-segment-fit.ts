/**
 * Regression tests for the PER-LINE-SEGMENT road-model fit (README §5):
 * the chained centerline is a string of line-segments, and each segment
 * gets its own rectangle fitted to the highway area — tangentially
 * limited by the segment, maximizing covered area while minimizing
 * spill. Key case: a PARALLELOGRAM area over a straight road — both
 * long edges slanted along the road. A per-piece rectangle (one shift
 * for the whole way) cannot follow the slanted true center; the
 * per-segment fits must recover (a) the constant perpendicular extent
 * and (b) a lateral shift that grows linearly along the road.
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

const mPerLat = 111_320 / 1e7;

// PARALLELOGRAM: both long edges slanted by lat(x) = ±450 + x/100 —
// the true road center climbs linearly while the mapped centerline
// stays at lat 0. Perpendicular extent is constant; the required
// lateral shift grows by (10000/100) quantized lat units = ~1.11 m
// per segment. Caps stay far outside the way ends so no end truncation
// contaminates the fits.
const latB = (x: number): number => -450 + x / 100;
const latT = (x: number): number => 450 + x / 100;
{
  const x0 = -3000,
    x1 = 33000;
  const a = node(x0, latB(x0));
  way(
    [
      a,
      node(x1, latB(x1)),
      node(x1, latT(x1)),
      node(x0, latT(x0)),
      a,
    ],
    { "area:highway": "residential", area: "yes", surface: "asphalt" },
  );
  way([node(0, 0), node(10000, 0), node(20000, 0), node(30000, 0)], {
    highway: "residential",
    surface: "asphalt",
    lanes: "2",
    name: "Schiefe Straße",
  });
}

const result = extractFeatures(data);
const lm = result.laneMarkings.filter((m) => m.name === "Schiefe Straße");
check(
  "marking pieces extracted for the parallelogram road",
  lm.length === 1,
  `pieces:${lm.length}`,
);
const p = lm[0] as LineFeature | undefined;
check(
  "piece carries fitted per-sample rectangle edges",
  p?.spline !== undefined &&
    p.spline.some((s) => s.fitLeftM !== undefined && s.fitRightM !== undefined),
  `fitted:${p?.spline?.filter((s) => s.fitLeftM !== undefined).length}/${p?.spline?.length}`,
);

if (p?.spline) {
  const fitted = p.spline.filter(
    (s) => s.fitLeftM !== undefined && s.fitRightM !== undefined,
  );
  check(
    "every sample carries its segment's fitted edges",
    fitted.length === p.spline!.length,
    `fitted:${fitted.length} of ${p.spline!.length}`,
  );
  const want = 900 * mPerLat;
  const devW = Math.max(
    ...fitted.map((s) => Math.abs(s.fitLeftM! + s.fitRightM! - want)),
  );
  check(
    "fitted width is the constant perpendicular extent (9 m ± 0.35)",
    devW < 0.35,
    `devW:${devW.toFixed(3)} want:${want.toFixed(3)}`,
  );
  // the fitted rectangle must follow the slanted true center: the
  // lateral shift (fitLeftM - fitRightM)/2 grows linearly along the
  // road — the property a single per-piece rectangle cannot express
  const shift = fitted.map((s) => (s.fitLeftM! - s.fitRightM!) / 2);
  const n = shift.length;
  const first = shift.slice(0, Math.floor(n / 3));
  const last = shift.slice(Math.ceil((2 * n) / 3));
  const mean = (xs: number[]): number =>
    xs.reduce((a, b) => a + b, 0) / xs.length;
  const dShift = mean(last) - mean(first);
  // expected growth: (20000/100) quantized lat units ~ 2.22 m from the
  // first third's center to the last third's center
  check(
    "fitted shift follows the slanted true center (grows ~2.2 m along the road)",
    dShift > 1.4 && dShift < 3.0,
    `dShift:${dShift.toFixed(3)} first:${mean(first).toFixed(3)} last:${mean(last).toFixed(3)}`,
  );
  // monotone: the shift grows monotonically (small noise allowed)
  let mono = true;
  for (let i = 1; i < n; i++)
    if (shift[i] < shift[i - 1] - 0.25) mono = false;
  check(
    "fitted shift grows monotonically along the road",
    mono,
    `shift:${shift.map((x) => x.toFixed(2)).join(" ")}`,
  );
  // TANGENTIAL NON-OVERLAP: adjacent segments' sample ranges must be
  // disjoint except for the shared vertex sample — the per-segment
  // rectangles tile the road without overlapping tangentially. The
  // chain has 3 segments (4 vertices); a sample of segment k must never
  // appear again behind a sample of segment k+1 except at the seam
  const segs = [...new Set(p.spline.map((s) => s.seg))].sort(
    (a, b) => (a ?? 0) - (b ?? 0),
  );
  check(
    "samples cover every chain line-segment",
    segs.length === 3,
    `segments:${segs.join(",")}`,
  );
  let ordered = true;
  for (let i = 1; i < segs.length; i++) {
    const lastOf = p.spline.filter((s) => s.seg === segs[i - 1]);
    const firstOf = p.spline.filter((s) => s.seg === segs[i]);
    const lastPt = lastOf[lastOf.length - 1]?.pt;
    const firstPt = firstOf[0]?.pt;
    // the seam samples coincide (same shared vertex)
    if (!lastPt || !firstPt) {
      ordered = false;
      continue;
    }
    const seamGap = Math.hypot(
      (lastPt[0] - firstPt[0]) * 1e-7 * 111320 * Math.cos((52.52 * Math.PI) / 180),
      (lastPt[1] - firstPt[1]) * 1e-7 * 111320,
    );
    if (seamGap > 5) ordered = false;
  }
  check(
    "adjacent segment sample ranges meet at the shared vertex (no tangential gap/overlap)",
    ordered,
  );
  // every sample belongs to exactly one segment: the seg values are
  // contiguous along the spline (monotone non-decreasing)
  let monotoneSeg = true;
  for (let i = 1; i < p.spline.length; i++)
    if ((p.spline[i].seg ?? 0) < (p.spline[i - 1].seg ?? 0)) monotoneSeg = false;
  check("segment indices monotone along the spline", monotoneSeg);
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all lane segment fit tests passed");
