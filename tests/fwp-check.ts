/**
 * Regression: exact Overpass snapshot around way 4575475
 * (Friedrich-Wilhelm-Platz, Berlin) — a 3-lane one-way tertiary crossing
 * a small area:highway=tertiary section, with junction areas at both
 * ends. The way's chain segments leading into the junctions lie
 * OUTSIDE the area and touch it only at the shared seam vertices; each
 * owns exactly ONE sample. The marking piece must stop and start at
 * the area (no samples beyond it), and the fitted-rectangle mode must
 * not render those degenerate one-sample groups — a collapsed quad
 * draws as a transverse stroke across the road, visually closing the
 * lane strip into a box.
 */
import { createOSMData } from "../src/osm-pbf";
import { extractFeatures } from "../src/extract";
import type { LineFeature, AreaFeature } from "../src/features";

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

way(4575475, [[52.4711733,13.3284741],[52.4711841,13.3285074],[52.4712103,13.3285881],[52.4712715,13.3287931],[52.4712872,13.3288440],[52.4713005,13.3288873],[52.4713378,13.3290085]],
  { highway: "tertiary", lanes: "3", oneway: "yes", surface: "asphalt", name: "Friedrich-Wilhelm-Platz", "parking:both": "no" });

way(706803037, [[52.4712216,13.3288939],[52.4712282,13.3288889],[52.4712872,13.3288440],[52.4713292,13.3288119]],
  { highway: "footway", footway: "crossing", crossing: "traffic_signals" });

area(896269600, [[52.4713500,13.3287586],[52.4713203,13.3287816],[52.4713140,13.3287591],[52.4712567,13.3285707],[52.4712512,13.3285471],[52.4712413,13.3284881],[52.4712408,13.3284811],[52.4712413,13.3284740],[52.4712427,13.3284692],[52.4712454,13.3284658],[52.4712492,13.3284643],[52.4712525,13.3284652],[52.4712559,13.3284703],[52.4712593,13.3284782],[52.4712627,13.3284875],[52.4712670,13.3285016]],
  { "area:highway": "traffic_island", landuse: "grass" });

area(1116607262, [[52.4715879,13.3287506],[52.4716084,13.3288368],[52.4716277,13.3289176],[52.4716129,13.3289244],[52.4715902,13.3289356],[52.4715664,13.3289473],[52.4715604,13.3289503],[52.4715538,13.3289536],[52.4715341,13.3289633],[52.4715305,13.3289668],[52.4715278,13.3289717],[52.4715256,13.3289793],[52.4715255,13.3289873],[52.4715270,13.3289950],[52.4715303,13.3290072],[52.4715329,13.3290123],[52.4715357,13.3290156],[52.4715422,13.3290177],[52.4715572,13.3290204],[52.4715632,13.3290207],[52.4715690,13.3290201],[52.4715720,13.3290190],[52.4715761,13.3290174],[52.4715825,13.3290138],[52.4716047,13.3290015],[52.4716271,13.3289891],[52.4716433,13.3290599],[52.4716588,13.3291272],[52.4716355,13.3291403],[52.4716170,13.3291508],[52.4716059,13.3291573],[52.4715981,13.3291618],[52.4714854,13.3292286],[52.4713429,13.3293091],[52.4713345,13.3293140],[52.4713293,13.3293167],[52.4713061,13.3293297],[52.4712856,13.3293402],[52.4712691,13.3293478],[52.4712508,13.3292845],[52.4712328,13.3292205],[52.4712496,13.3292144],[52.4712695,13.3292047],[52.4712936,13.3291929],[52.4712991,13.3291903],[52.4713058,13.3291870],[52.4713141,13.3291851],[52.4713171,13.3291794],[52.4713173,13.3291719],[52.4713057,13.3291290],[52.4713018,13.3291225],[52.4712973,13.3291209],[52.4712897,13.3291283],[52.4712825,13.3291335],[52.4712776,13.3291371],[52.4712541,13.3291557],[52.4712364,13.3291696],[52.4712067,13.3291099],[52.4711791,13.3290517],[52.4711956,13.3290308],[52.4712108,13.3290034],[52.4712180,13.3289809],[52.4712225,13.3289570],[52.4712233,13.3289453],[52.4712240,13.3289345],[52.4712237,13.3289231],[52.4712234,13.3289117],[52.4712216,13.3288939],[52.4712170,13.3288632],[52.4712226,13.3288589],[52.4712318,13.3288521],[52.4712273,13.3288285],[52.4712715,13.3287931],[52.4713140,13.3287591],[52.4713203,13.3287816],[52.4713292,13.3288119],[52.4713378,13.3288412],[52.4713422,13.3288559],[52.4713466,13.3288709],[52.4713528,13.3288892],[52.4713556,13.3288944],[52.4713590,13.3288973],[52.4713647,13.3288989],[52.4713687,13.3288985],[52.4713734,13.3288952],[52.4713779,13.3288910],[52.4713812,13.3288852],[52.4713828,13.3288782],[52.4713835,13.3288712],[52.4713828,13.3288634],[52.4713786,13.3288460],[52.4713737,13.3288313],[52.4713687,13.3288160],[52.4713596,13.3287888],[52.4713500,13.3287586],[52.4713870,13.3287316],[52.4714397,13.3286929],[52.4714520,13.3286839],[52.4714610,13.3286773],[52.4714646,13.3286919],[52.4714684,13.3287060],[52.4714733,13.3287179],[52.4714785,13.3287281],[52.4714843,13.3287360],[52.4714920,13.3287430],[52.4715000,13.3287473],[52.4715084,13.3287490],[52.4715148,13.3287489],[52.4715196,13.3287472],[52.4715452,13.3287328],[52.4715635,13.3287231],[52.4715666,13.3287359],[52.4715721,13.3287583]],
  { "area:highway": "secondary", junction: "yes" });

area(1116607286, [[52.4714397,13.3286929],[52.4714243,13.3286483],[52.4713581,13.3284554],[52.4713106,13.3284794],[52.4712670,13.3285016],[52.4713500,13.3287586],[52.4713870,13.3287316]],
  { "area:highway": "tertiary" });

area(1128025400, [[52.4713140,13.3287591],[52.4712715,13.3287931],[52.4712273,13.3288285],[52.4711787,13.3286601],[52.4711680,13.3286304],[52.4712103,13.3285881],[52.4712512,13.3285471],[52.4712567,13.3285707]],
  { "area:highway": "tertiary" });

area(1128025399, [[52.4710221,13.3285272],[52.4710219,13.3284658],[52.4710216,13.3283938],[52.4710381,13.3283934],[52.4710623,13.3283931],[52.4710876,13.3283927],[52.4710898,13.3283922],[52.4710918,13.3283903],[52.4710937,13.3283870],[52.4710956,13.3283834],[52.4710969,13.3283783],[52.4710974,13.3283723],[52.4710970,13.3283672],[52.4710958,13.3283626],[52.4710935,13.3283583],[52.4710908,13.3283552],[52.4710873,13.3283527],[52.4710623,13.3283521],[52.4710380,13.3283516],[52.4710370,13.3282837],[52.4710361,13.3282184],[52.4710359,13.3282025],[52.4710357,13.3281891],[52.4710625,13.3281891],[52.4710841,13.3281894],[52.4711228,13.3281869],[52.4711420,13.3281789],[52.4711597,13.3281665],[52.4711846,13.3281371],[52.4712066,13.3281044],[52.4712491,13.3280386],[52.4712542,13.3280453],[52.4712591,13.3280519],[52.4712860,13.3280839],[52.4713082,13.3281103],[52.4712968,13.3281274],[52.4712913,13.3281367],[52.4712863,13.3281450],[52.4712695,13.3281734],[52.4712543,13.3281989],[52.4712497,13.3282064],[52.4712454,13.3282139],[52.4712451,13.3282256],[52.4712468,13.3282366],[52.4712502,13.3282463],[52.4712555,13.3282537],[52.4712615,13.3282581],[52.4712687,13.3282589],[52.4712757,13.3282574],[52.4712821,13.3282519],[52.4712860,13.3282443],[52.4712906,13.3282355],[52.4713043,13.3282091],[52.4713196,13.3281793],[52.4713244,13.3281701],[52.4713289,13.3281614],[52.4713602,13.3281870],[52.4713758,13.3281997],[52.4713822,13.3282049],[52.4713721,13.3282308],[52.4713588,13.3282650],[52.4713531,13.3282925],[52.4713493,13.3283111],[52.4713482,13.3283252],[52.4713462,13.3283525],[52.4713463,13.3283837],[52.4713486,13.3284146],[52.4713524,13.3284369],[52.4713581,13.3284554],[52.4713106,13.3284794],[52.4712670,13.3285016],[52.4712627,13.3284875],[52.4712593,13.3284782],[52.4712559,13.3284703],[52.4712525,13.3284652],[52.4712492,13.3284643],[52.4712454,13.3284658],[52.4712427,13.3284692],[52.4712413,13.3284740],[52.4712408,13.3284811],[52.4712413,13.3284881],[52.4712512,13.3285471],[52.4712103,13.3285881],[52.4711680,13.3286304],[52.4711566,13.3286047],[52.4711414,13.3285806],[52.4711286,13.3285626],[52.4711186,13.3285789],[52.4711154,13.3285837],[52.4710990,13.3285739],[52.4710850,13.3285703],[52.4710621,13.3285703],[52.4710393,13.3285703],[52.4710392,13.3285525],[52.4710390,13.3285271]],
  { "area:highway": "tertiary", junction: "yes" });

const result = extractFeatures(data);

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

const pieces = result.laneMarkings.filter((m) => m.id === "w4575475");
check(
  "one marking piece for way 4575475",
  pieces.length === 1,
  `pieces:${pieces.length}`,
);
const p = pieces[0] as LineFeature | undefined;
check(
  "piece carries a spline",
  p?.spline !== undefined && p.spline!.length >= 2,
  `spline:${p?.spline?.length}`,
);

if (p?.spline && p.spline.length >= 2) {
  const sp = p.spline;
  // the piece must STOP and START at the area: its first and last
  // samples sit at the shared seam vertices F (52.4712103,13.3285881)
  // and B (52.4712715,13.3287931) — the chain segments beyond them lie
  // outside the area (junction mouths) and must contribute nothing
  // the samples sit ON THE MIDDLE LINE (offset from the mapped way by
  // midM, the road's true center), so the endpoints are the seam
  // vertices shifted sideways — a metric tolerance covers the shift
  const near = (pt: number[], lat: number, lon: number): boolean => {
    const mPerLat = 111_320 / 1e7;
    const mPerLon = (111_320 * Math.cos((lat * Math.PI) / 180)) / 1e7;
    return (
      Math.abs((pt[1] / 1e7 - lat) * 1e7 * mPerLat) < 0.5 &&
      Math.abs((pt[0] / 1e7 - lon) * 1e7 * mPerLon) < 0.5
    );
  };
  check(
    "piece starts at the area's south seam vertex",
    near(sp[0].pt, 52.4712103, 13.3285881),
    `first:${(sp[0].pt[1] / 1e7).toFixed(7)},${(sp[0].pt[0] / 1e7).toFixed(7)}`,
  );
  check(
    "piece ends at the area's north seam vertex",
    near(sp[sp.length - 1].pt, 52.4712715, 13.3287931),
    `last:${(sp[sp.length - 1].pt[1] / 1e7).toFixed(7)},${(sp[sp.length - 1].pt[0] / 1e7).toFixed(7)}`,
  );
  // every sample lies between the seam vertices (nothing beyond the area)
  const f = sp[0].pt,
    b = sp[sp.length - 1].pt;
  const between = sp.every((s) => {
    const t =
      ((s.pt[0] - f[0]) * (b[0] - f[0]) + (s.pt[1] - f[1]) * (b[1] - f[1])) /
      ((b[0] - f[0]) ** 2 + (b[1] - f[1]) ** 2);
    return t >= -0.02 && t <= 1.02;
  });
  check(
    "no sample beyond the area section (all between the seam vertices)",
    between,
  );
  // the DEGENERATE groups (chain segments outside the area owning one
  // sample each) must not render: the renderer skips single-sample
  // groups, so the drawn rectangles are exactly the groups with >= 2
  // samples
  const groups: number[][] = [];
  for (let i = 0; i < sp.length; ) {
    const g = sp[i].seg ?? 0;
    const grp: number[] = [];
    while (i < sp.length && (sp[i].seg ?? 0) === g) grp.push(i++);
    groups.push(grp);
  }
  const drawn = groups.filter((g) => g.length >= 2);
  check(
    "only non-degenerate segment groups render as rectangles",
    drawn.length >= 1 && groups.length - drawn.length <= 2,
    `groups:${groups.map((g) => g.length).join("|")}`,
  );
  // every sample measures positive half-widths on both sides of the
  // middle line
  let ok = true;
  let detail = "";
  for (const s of sp) {
    if (!(s.leftM > 0.1) || !(s.rightM > 0.1)) {
      ok = false;
      detail = `left:${s.leftM} right:${s.rightM}`;
      break;
    }
  }
  check("every sample measures positive half-widths", ok, detail);
}

if (failures > 0) {
  console.error(`${failures} fwp regression test(s) failed`);
  process.exit(1);
}
console.log("all fwp regression tests passed");
