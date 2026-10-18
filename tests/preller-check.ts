/**
 * One-off validation against real Overpass data (Prellerweg ways 354907566 /
 * 1173562237 / 185008731, one-way dual carriageway, 5→4→2 lanes, the 5-lane
 * way placement=right_of:3 so its centerline sits off-center). One-way pieces
 * must lay their lane blocks from their OWN measured left edge, so the
 * boundaries at the 5→4 and 4→2 seams do not jump.
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
const centerline = (coords: [number, number][], tags: Record<string, string>) => {
  data.ways.set(nextWay, {
    id: nextWay,
    refs: coords.map(([lat, lon]) => node(lat, lon)),
    tags: { surface: "asphalt", ...tags },
  });
  nextWay++;
};
const area = (coords: [number, number][], tags: Record<string, string>) => {
  const ring = [...coords, coords[0]].map(([lat, lon]) => node(lat, lon));
  data.ways.set(nextWay, { id: nextWay, refs: ring, tags });
  nextWay++;
};

// 5-lane piece (west), placement=right_of:3 (off-center centerline)
centerline([[52.4591670,13.3495583],[52.4591560,13.3493319],[52.4591451,13.3491168],
            [52.4591424,13.3490637],[52.4591383,13.3490027],[52.4591309,13.3488945],
            [52.4591263,13.3488259]],
  { highway: "secondary", lanes: "5", name: "Prellerweg", oneway: "yes", "parking:both": "no" });
// 4-lane piece (middle)
centerline([[52.4591912,13.3500730],[52.4591670,13.3495583]],
  { highway: "secondary", lanes: "4", name: "Prellerweg", oneway: "yes", "parking:both": "no" });
// 2-lane piece with right parking (east, long curve)
centerline([[52.4588727,13.3547118],[52.4589160,13.3546482],[52.4589670,13.3545655],
            [52.4590134,13.3544826],[52.4590470,13.3544178],[52.4590797,13.3543452],
            [52.4591368,13.3541997],[52.4591640,13.3541201],[52.4591899,13.3540324],
            [52.4592185,13.3539257],[52.4592378,13.3538373],[52.4592545,13.3537481],
            [52.4592692,13.3536428],[52.4592792,13.3535573],[52.4592869,13.3534759],
            [52.4592964,13.3533367],[52.4593023,13.3532156],[52.4593070,13.3530369],
            [52.4593090,13.3528632],[52.4593078,13.3526875],[52.4593047,13.3525295],
            [52.4592997,13.3523974],[52.4592553,13.3514502],[52.4592147,13.3505696],
            [52.4591912,13.3500730]],
  { highway: "secondary", lanes: "2", name: "Prellerweg", oneway: "yes",
    "parking:left": "no", "parking:right": "lane" });
// the carriageway area
area([[52.4592099,13.3493228],[52.4592142,13.3494271],[52.4592206,13.3495512],
      [52.4592308,13.3497497],[52.4592482,13.3501419],[52.4592674,13.3505342],
      [52.4592917,13.3510534],[52.4593073,13.3513896],[52.4593097,13.3514416],
      [52.4593116,13.3514821],[52.4593375,13.3520427],[52.4593479,13.3522548],
      [52.4593567,13.3524674],[52.4593637,13.3527252],[52.4593634,13.3529510],
      [52.4593610,13.3530953],[52.4593527,13.3533091],[52.4593454,13.3534334],
      [52.4593399,13.3535011],[52.4593343,13.3535594],[52.4593265,13.3536282],
      [52.4593164,13.3537026],[52.4593018,13.3537969],[52.4592890,13.3538598],
      [52.4592789,13.3539097],[52.4592631,13.3539776],[52.4592490,13.3540311],
      [52.4592151,13.3541505],[52.4591879,13.3542312],[52.4591657,13.3542909],
      [52.4591482,13.3543370],[52.4591047,13.3544379],[52.4590746,13.3545020],
      [52.4590435,13.3545632],[52.4590217,13.3546026],[52.4589887,13.3546589],
      [52.4589507,13.3547178],[52.4589085,13.3547782],[52.4588727,13.3547118],
      [52.4588546,13.3546782],[52.4588747,13.3546498],[52.4588946,13.3546205],
      [52.4589390,13.3545498],[52.4589739,13.3544886],[52.4590180,13.3544040],
      [52.4590471,13.3543409],[52.4590755,13.3542764],[52.4590973,13.3542207],
      [52.4591189,13.3541631],[52.4591398,13.3541003],[52.4591596,13.3540355],
      [52.4591707,13.3539965],[52.4591963,13.3538948],[52.4592197,13.3537822],
      [52.4592324,13.3537113],[52.4592408,13.3536583],[52.4592468,13.3536094],
      [52.4592522,13.3535589],[52.4592576,13.3535075],[52.4592624,13.3534561],
      [52.4592676,13.3533830],[52.4592737,13.3532498],[52.4592791,13.3531331],
      [52.4592831,13.3528473],[52.4592813,13.3526458],[52.4592758,13.3524472],
      [52.4592457,13.3518097],[52.4591925,13.3506859],[52.4591855,13.3505380],
      [52.4591788,13.3504356],[52.4591730,13.3503619],[52.4591656,13.3502865],
      [52.4591387,13.3500406],[52.4591234,13.3498902],[52.4590977,13.3496669],
      [52.4590852,13.3495257],[52.4590754,13.3493456],[52.4591560,13.3493319]],
  { "area:highway": "secondary" });

const result = extractFeatures(data);
const lm = result.laneMarkings.filter((m) => m.name === "Prellerweg");
lm.sort((a, b) => a.coords[0][0] - b.coords[0][0]);
console.log(`${lm.length} Prellerweg pieces\n`);
console.log("way     lanes  laneW    leftM");
for (const p of lm) {
  console.log(`${p.id.padEnd(6)}  ${String(p.lanes).padEnd(5)}  ${p.laneW!.toFixed(3)}  ${p.laneLeftM!.toFixed(3)}`);
}
// continuity at the 5→4 seam: boundary offsets of adjacent pieces at the
// shared node must not jump — the 4-lane block (left edge at its own
// measured left edge) continues the outer boundaries of the 5-lane piece
if (lm.length >= 2) {
  const [p5, p4] = [lm.find((p) => p.lanes === 5), lm.find((p) => p.lanes === 4)];
  if (p5 && p4) {
    // left edge in meters from the (common) left road edge: both pieces'
    // centerlines share the same road; compare block widths
    console.log(`\n5-lane block: ${(5 * p5.laneW!).toFixed(2)}m over ${(p5.laneLeftM! + (p5.laneRightM! ?? 0)).toFixed(2)}m-ish`);
    console.log(`4-lane block: ${(4 * p4.laneW!).toFixed(2)}m`);
  }
}
