/**
 * Regression tests for the RAY-SHOT road width model (README §5): the
 * width comes from ray casting in both normal directions from the
 * mapped centerline, hit-filtered (the hit segment must be more
 * parallel than orthogonal to the road) and backtracked in 1 m steps
 * on invalid hits. Key case: a PARALLELOGRAM area over a straight
 * road — both long edges slanted along the road. The measured width
 * is the constant perpendicular extent (9 m), and the VIRTUAL MIDDLE
 * LINE (half the width) follows the slanted true center: its lateral
 * offset from the mapped way grows linearly along the road — the
 * property a piece-wide model cannot express.
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
// lateral middle-line shift grows by ~1.11 m per 10000 quantized lon
// units (100 lat units). Caps stay far outside the way ends so no end
// truncation contaminates the measurements.
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
  "piece carries the middle-line spline",
  p?.spline !== undefined && p.spline!.length >= 2,
  `spline:${p?.spline?.length}`,
);

if (p?.spline) {
  const sp = p.spline;
  const want = 900 * mPerLat;
  const devW = Math.max(
    ...sp.map((s) => Math.abs(s.leftM + s.rightM - want)),
  );
  check(
    "ray-shot width is the constant perpendicular extent (9 m ± 0.35)",
    devW < 0.35,
    `devW:${devW.toFixed(3)} want:${want.toFixed(3)}`,
  );
  // the middle line must follow the slanted true center: the lateral
  // offset from the mapped way (midM, positive = left) shrinks
  // linearly along the road — the area's center climbs to the LEFT
  const mid = sp.map((s) => s.midM ?? 0);
  const n = mid.length;
  const first = mid.slice(0, Math.floor(n / 3));
  const last = mid.slice(Math.ceil((2 * n) / 3));
  const mean = (xs: number[]): number =>
    xs.reduce((a, b) => a + b, 0) / xs.length;
  const dMid = mean(last) - mean(first);
  // expected growth: (20000/100) quantized lat units ~ 2.22 m from the
  // first third's center to the last third's center
  check(
    "middle line follows the slanted true center (moves ~2.2 m along the road)",
    dMid > 1.4 && dMid < 3.0,
    `dMid:${dMid.toFixed(3)} first:${mean(first).toFixed(3)} last:${mean(last).toFixed(3)}`,
  );
  // monotone: the middle-line offset moves monotonically (small noise
  // allowed)
  let mono = true;
  for (let i = 1; i < n; i++)
    if (mid[i] < mid[i - 1] - 0.25) mono = false;
  check(
    "middle-line offset moves monotonically along the road",
    mono,
    `mid:${mid.map((x) => x.toFixed(2)).join(" ")}`,
  );
  // the spline points lie ON the middle line: each sample's lateral
  // distance from the mapped way must equal its midM (the base curve
  // of every drawn marking offset)
  let onMid = true;
  let onDetail = "";
  for (const s of sp) {
    // project the sample point onto the nearest way vertex pair and
    // measure the lateral offset
    let bi = 0,
      bd = Infinity;
    for (let i = 0; i < p.coords.length; i++) {
      const d = (s.pt[0] - p.coords[i][0]) ** 2 + (s.pt[1] - p.coords[i][1]) ** 2;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const a = p.coords[Math.max(0, bi - 1)];
    const b = p.coords[Math.min(p.coords.length - 1, bi + 1)];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    if (l === 0) continue;
    const nx = -dy / l,
      ny = dx / l;
    const vx = s.pt[0] - p.coords[bi][0],
      vy = s.pt[1] - p.coords[bi][1];
    const latQ = vx * nx + vy * ny;
    const mPerLon =
      (111_320 * Math.cos(((s.pt[1] / 1e7) * Math.PI) / 180)) / 1e7;
    const latM = Math.hypot(nx * mPerLon, ny * mPerLat) * latQ;
    if (Math.abs(latM - (s.midM ?? 0)) > 0.25) {
      onMid = false;
      onDetail = `latM:${latM.toFixed(3)} midM:${s.midM?.toFixed(3)}`;
      break;
    }
  }
  check("spline samples sit on the middle line", onMid, onDetail);
  // the chain line-segments are all covered: samples carry segment
  // indices monotone along the spline
  let monotoneSeg = true;
  for (let i = 1; i < sp.length; i++)
    if ((sp[i].seg ?? 0) < (sp[i - 1].seg ?? 0)) monotoneSeg = false;
  check("segment indices monotone along the spline", monotoneSeg);
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all lane segment fit tests passed");
