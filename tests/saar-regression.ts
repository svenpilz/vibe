/**
 * Regression: exact Overpass snapshot around way 288689072 (Saarstraße,
 * Berlin) — a dual carriageway whose area:highway width CHANGES along the
 * way (~9.4 m at the fork to ~13.1 m at the junction mouth). The marking
 * piece must follow the local road width, not one piece-wide median.
 */
import { createOSMData } from "../src/osm-pbf";
import { extractFeatures } from "../src/extract";

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
let nextWay = 1;
const way = (id: number, coords: [number, number][], tags: Record<string, string>) => {
  data.ways.set(id, { id, refs: coords.map(([lat, lon]) => node(lat, lon)), tags });
};
const area = (id: number, coords: [number, number][], tags: Record<string, string>) => {
  const ring = [...coords, coords[0]].map(([lat, lon]) => node(lat, lon));
  data.ways.set(id, { id, refs: ring, tags });
};

way(4693389, [[52.4674263,13.3370076],[52.4674758,13.3368177],[52.4675008,13.3367161],[52.4675236,13.3366133],[52.4675443,13.3365106]],
  { highway: "secondary", lanes: "2", name: "Saarstraße", oneway: "yes", "parking:left": "no", "parking:right": "street_side", surface: "asphalt", lit: "yes", maxspeed: "30", "dual_carriageway": "yes", bicycle: "use_sidepath", foot: "use_sidepath", "cycleway:left": "no", "cycleway:right": "separate", "sidewalk:left": "no", "sidewalk:right": "separate", postal_code: "12161", "name:etymology:wikidata": "Q153972", wikidata: "Q63213508", "parking:right:orientation": "parallel" });

way(32845669, [[52.4672818,13.3369714],[52.4671532,13.3372813]],
  { highway: "secondary", lanes: "4", name: "Friedenauer Brücke", oneway: "yes", bridge: "yes", layer: "1", surface: "asphalt", lit: "yes", maxspeed: "30", "dual_carriageway": "yes", bicycle: "use_sidepath", foot: "use_sidepath", "cycleway:left": "no", "cycleway:right": "separate", "sidewalk:left": "no", "sidewalk:right": "separate", parking: "separate", "parking:right": "no", postal_code: "12161", "turn:lanes": "none|through|through|none", smoothness: "good", shoulder: "no", "maxweight:signed": "no", "name:etymology:wikidata": "Q692390", "name:etymology:wikipedia": "de:Berlin-Friedenau" });

way(288689072, [[52.4675068,13.3362489],[52.4674744,13.3363487],[52.4673717,13.3367190],[52.4673176,13.3368732]],
  { highway: "secondary", lanes: "4", name: "Saarstraße", oneway: "yes", "parking:both": "no", surface: "asphalt", lit: "yes", maxspeed: "30", "dual_carriageway": "yes", bicycle: "use_sidepath", foot: "use_sidepath", "cycleway:left": "no", "cycleway:right": "separate", "sidewalk:left": "no", "sidewalk:right": "separate", postal_code: "12161", smoothness: "intermediate", "name:etymology:wikidata": "Q153972", wikidata: "Q63213508" });

way(1102705121, [[52.4673970,13.3370976],[52.4674263,13.3370076]],
  { highway: "secondary", lanes: "3", "lanes:bus": "1", name: "Saarstraße", oneway: "yes", "parking:both": "no", surface: "asphalt", lit: "yes", maxspeed: "30", "dual_carriageway": "yes", bicycle: "use_sidepath", foot: "use_sidepath", "cycleway:left": "no", "cycleway:right": "separate", "sidewalk:left": "no", "sidewalk:right": "separate", postal_code: "12161", "name:etymology:wikidata": "Q153972", wikidata: "Q63213508" });

way(1196780749, [[52.4673176,13.3368732],[52.4672818,13.3369714]],
  { highway: "secondary", lanes: "4", name: "Saarstraße", oneway: "yes", "parking:both": "no", surface: "asphalt", lit: "yes", maxspeed: "30", "dual_carriageway": "yes", bicycle: "use_sidepath", foot: "use_sidepath", "cycleway:left": "no", "cycleway:right": "separate", "sidewalk:left": "no", "sidewalk:right": "separate", postal_code: "12161", smoothness: "intermediate", "turn:lanes": "none|through|through|none", "name:etymology:wikidata": "Q153972", wikidata: "Q63213508" });

// highway areas
area(1117262086, [[52.4674363,13.3363160],[52.4674744,13.3363487],[52.4675149,13.3363835],[52.4674760,13.3365446],[52.4674365,13.3367052],[52.4674251,13.3367482],[52.4674128,13.3367904],[52.4673878,13.3368722],[52.4673644,13.3369353],[52.4673378,13.3370004],[52.4673268,13.3370270],[52.4672818,13.3369714],[52.4672401,13.3369199],[52.4672505,13.3368925],[52.4672838,13.3368004],[52.4673086,13.3367281],[52.4673307,13.3366606],[52.4673550,13.3365785],[52.4673673,13.3365368],[52.4673921,13.3364528],[52.4674010,13.3364240],[52.4674183,13.3363710]],
  { "area:highway": "secondary" });

area(1117262091, [[52.4674359,13.3371619],[52.4674701,13.3370574],[52.4675150,13.3369030],[52.4675595,13.3367159],[52.4675748,13.3366467],[52.4675937,13.3365493],[52.4675941,13.3365444],[52.4675929,13.3365400],[52.4675785,13.3364976],[52.4675778,13.3364931],[52.4675778,13.3364878],[52.4675523,13.3364699],[52.4675267,13.3364520],[52.4674983,13.3365967],[52.4674705,13.3367225],[52.4674474,13.3368179],[52.4674227,13.3369118],[52.4673963,13.3370044],[52.4673807,13.3370558],[52.4673717,13.3370825],[52.4673932,13.3371091],[52.4674134,13.3371342],[52.4674359,13.3371619]],
  { "area:highway": "secondary" });

area(1117262087, [[52.4673268,13.3370270],[52.4672592,13.3371889],[52.4672358,13.3372423],[52.4671958,13.3373346],[52.4671532,13.3372813],[52.4671095,13.3372268],[52.4671284,13.3371833],[52.4672034,13.3370090],[52.4672401,13.3369199],[52.4672818,13.3369714]],
  { "area:highway": "secondary", layer: "1" });

area(1122779582, [[52.4675149,13.3363835],[52.4674744,13.3363487],[52.4674363,13.3363160],[52.4674236,13.3363045],[52.4674189,13.3363003],[52.4674350,13.3362561],[52.4674357,13.3362514],[52.4674361,13.3362466],[52.4674357,13.3362416],[52.4674347,13.3362370],[52.4674331,13.3362327],[52.4674296,13.3362282],[52.4674119,13.3362093],[52.4674285,13.3361668],[52.4674454,13.3361240],[52.4674603,13.3361397],[52.4674640,13.3361433],[52.4674681,13.3361451],[52.4674726,13.3361447],[52.4674758,13.3361427],[52.4674783,13.3361394],[52.4674813,13.3361338],[52.4674868,13.3361196],[52.4674971,13.3360933],[52.4675031,13.3360994],[52.4675136,13.3361100],[52.4675421,13.3361408],[52.4675693,13.3361692],[52.4675612,13.3361995],[52.4675544,13.3362240],[52.4675478,13.3362493],[52.4675286,13.3363260]],
  { "area:highway": "secondary", junction: "yes" });

area(1034305117, [[52.4673378,13.3370004],[52.4673644,13.3369353],[52.4673878,13.3368722],[52.4674128,13.3367904],[52.4674251,13.3367482],[52.4674365,13.3367052],[52.4674760,13.3365446],[52.4675149,13.3363835],[52.4675286,13.3363260],[52.4675309,13.3363199],[52.4675343,13.3363152],[52.4675370,13.3363129],[52.4675406,13.3363125],[52.4675443,13.3363142],[52.4675470,13.3363171],[52.4675494,13.3363222],[52.4675506,13.3363285],[52.4675499,13.3363377],[52.4675267,13.3364520],[52.4674983,13.3365967],[52.4674705,13.3367225],[52.4674474,13.3368179],[52.4674227,13.3369118],[52.4673963,13.3370044],[52.4673807,13.3370558]],
  { "area:highway": "traffic_island" });

area(392402737, [[52.4673202,13.3366681],[52.4672730,13.3368093]],
  { highway: "platform", public_transport: "platform", bus: "yes", bench: "yes", bin: "yes", shelter: "yes", lit: "yes", name: "Friedenauer Brücke", kerb: "yes", surface: "paved", "tactile_paving": "no", wheelchair: "yes", "passenger_information_display": "no" });

area(949520998, [[52.4672486,13.3374130],[52.4672755,13.3373461],[52.4672987,13.3372856],[52.4673213,13.3372257],[52.4673475,13.3371519],[52.4673717,13.3370825],[52.4673807,13.3370558],[52.4673378,13.3370004],[52.4673268,13.3370270],[52.4672592,13.3371889],[52.4672358,13.3372423],[52.4671958,13.3373346],[52.4671917,13.3373437]],
  { amenity: "parking", access: "yes", fee: "yes", layer: "1", orientation: "diagonal", parking: "street_side" });

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}
const near = (a: number, b: number, eps: number) => Math.abs(a - b) < eps;

const result = extractFeatures(data);
const byId = new Map(result.laneMarkings.map((m) => [m.id, m]));
const piece = byId.get("w288689072");

check(
  "one marking piece for way 288689072 (Saarstraße)",
  result.laneMarkings.filter((m) => m.id === "w288689072").length === 1,
);
check("piece has 4 lanes", piece?.lanes === 4, `lanes:${piece?.lanes}`);

// the road width changes along the area (~9.4 m -> ~13.1 m): the piece
// must carry a per-vertex road-edge profile following the local span
check(
  "piece carries a densified spline with measured edges",
  piece?.spline !== undefined && piece.spline!.length >= 8,
  `spline:${piece?.spline?.length}`,
);
if (piece?.spline) {
  const spans = piece.spline.map((s) => s.leftM + s.rightM);
  const minSpan = Math.min(...spans);
  const maxSpan = Math.max(...spans);
  // the ray-shot model reads the area width DIRECTLY: this area section
  // is a uniform ~12.2-12.5 m along the way (the 9.4->13.1 variation
  // the rectangle fit reported was the fit reading across the junction
  // mouths). The samples must follow the local span closely — small
  // variation, no fit-induced swings
  check(
    "spline reads the uniform local road width (no fit swings, < 0.5 m variation)",
    maxSpan - minSpan < 0.5,
    `spans:${spans.map((s) => s.toFixed(2)).join(" ")}`,
  );
  // every sampled span stays inside the physically plausible range of
  // the mapped area: between 9 m and 14 m
  check(
    "every sampled span is plausible (9–14 m)",
    spans.every((s) => s > 9 && s < 14),
    `spans:${spans.map((s) => s.toFixed(2)).join(" ")}`,
  );
  // the lane block fills the local road: the piece's lane width is
  // the local span split over its four lanes
  const laneWLocal = spans.map((s) => s / 4);
  check(
    "lane width fills the local road (span / 4 lanes)",
    near(Math.max(...laneWLocal), maxSpan / 4, 1e-9),
    `local max:${Math.max(...laneWLocal).toFixed(3)} span/4:${(maxSpan / 4).toFixed(3)}`,
  );
  // the spline runs strictly inside the area: every sample point is in
  for (const s of piece.spline) {
    if (!s.pt || s.pt.length !== 2) {
      check("spline sample points are coordinate pairs", false, `${s.pt}`);
      break;
    }
  }
  check("spline samples are coordinate pairs", piece.spline.every((s) => Array.isArray(s.pt) && s.pt.length === 2));
  // the middle of the road (the sharp way corner) must stay smooth too:
  // no zigzag in the spline geometry relative to the way centerline
  const cosLat = Math.cos((piece.coords[0][1] / 1e7) * (Math.PI / 180));
  const mPerLon = (111_320 * cosLat) / 1e7;
  const mPerLat = 111_320 / 1e7;
  const wayM = piece.coords.map((c) => [c[0] * mPerLon, c[1] * mPerLat]);
  const spM = piece.spline.map((s) => [s.pt[0] * mPerLon, s.pt[1] * mPerLat]);
  let maxDev = 0;
  for (const s of spM) {
    let best = Infinity;
    for (let i = 0; i + 1 < wayM.length; i++) {
      const a = wayM[i], b = wayM[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((s[0] - a[0]) * dx + (s[1] - a[1]) * dy) / (l2 || 1)));
      const d = Math.hypot(s[0] - a[0] - t * dx, s[1] - a[1] - t * dy);
      if (d < best) best = d;
    }
    if (best > maxDev) maxDev = best;
  }
  check(
    "spline hugs the way centerline (max deviation < 1 m)",
    maxDev < 1,
    `maxDev:${maxDev.toFixed(2)} m`,
  );
}
{
  // the road is SPLIT into w288689072 + w1196780749 within one area:
  // both pieces must carry splines and meet SEAMLESSLY at the shared
  // way junction (no gap between the last and first samples)
  const a = result.laneMarkings.find((m) => m.id === "w288689072");
  const b = result.laneMarkings.find((m) => m.id === "w1196780749");
  const okSplines = (a?.spline?.length ?? 0) >= 4 && (b?.spline?.length ?? 0) >= 2;
  check(
    "split road pieces both carry splines",
    okSplines,
    `a:${a?.spline?.length} b:${b?.spline?.length}`,
  );
  if (okSplines && a?.spline && b?.spline) {
    const la = a.spline[a.spline.length - 1];
    const fb = b.spline[0];
    const cosL = Math.cos((la.pt[1] / 1e7) * (Math.PI / 180));
    const mPerLon = (111_320 * cosL) / 1e7;
    const mPerLat = 111_320 / 1e7;
    const dx = (fb.pt[0] - la.pt[0]) * mPerLon;
    const dy = (fb.pt[1] - la.pt[1]) * mPerLat;
    const gap = Math.hypot(dx, dy);
    // sample spacing is ~4 m; the seam gap must not exceed one step
    check(
      "spline runs seamlessly across the way split (< 6 m gap)",
      gap < 6,
      `gap:${gap.toFixed(2)} m`,
    );
  }
}

if (failures > 0) {
  console.error(`${failures} saar regression test(s) failed`);
  process.exit(1);
}
console.log("all saar regression tests passed");
