/**
 * Regression: Overpass snapshot around way 396518419 (Rubensstraße).
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

way(1127925182, [[52.4712704,13.3436625],[52.4711572,13.3436790]],
  { highway: "tertiary", lanes: "3", "lanes:backward": "1", "lanes:forward": "2", name: "Rubensstraße", "parking:both": "no", surface: "asphalt" });

way(396518419, [[52.4714684,13.3436275],[52.4712704,13.3436625]],
  { highway: "tertiary", lanes: "3", "lanes:backward": "1", "lanes:forward": "2", name: "Rubensstraße", "parking:left": "lane", "parking:right": "no", surface: "asphalt", "turn:lanes:forward": "left|through" });

way(396518422, [[52.4718169,13.3435494],[52.4714684,13.3436275]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "no", surface: "asphalt" });

area(1116382309, [[52.4712661,13.3435649],[52.4712704,13.3436625],[52.4712746,13.3437601],[52.4713217,13.3437547],[52.4715221,13.3436897],[52.4719235,13.3435756],[52.4722288,13.3434941],[52.4724263,13.3434508],[52.4724465,13.3434575],[52.4724152,13.3434191],[52.4723913,13.3433775],[52.4723815,13.3433841],[52.4722041,13.3434250],[52.4719156,13.3434753],[52.4712661,13.3435649]],
  { "area:highway": "tertiary" });

area(1116382310, [[52.4711867,13.3434366],[52.4711549,13.3434462],[52.4711199,13.3434550],[52.4711223,13.3434726],[52.4711230,13.3434802],[52.4711238,13.3434879],[52.4711239,13.3435026],[52.4711234,13.3435117],[52.4711221,13.3435211],[52.4711205,13.3435302],[52.4711169,13.3435440],[52.4711131,13.3435550],[52.4711075,13.3435663],[52.4711014,13.3435762],[52.4710929,13.3435859],[52.4710858,13.3435919],[52.4710793,13.3435954],[52.4710728,13.3435983],[52.4710263,13.3436057],[52.4710079,13.3436090],[52.4709888,13.3436125],[52.4709747,13.3436150],[52.4709788,13.3437050],[52.4709830,13.3437961],[52.4710063,13.3437936],[52.4710150,13.3437931],[52.4710237,13.3437945],[52.4710318,13.3437976],[52.4710398,13.3438027],[52.4710475,13.3438096],[52.4710568,13.3438205],[52.4710609,13.3438264],[52.4710635,13.3438303],[52.4710679,13.3438383],[52.4710691,13.3438425],[52.4710692,13.3438478],[52.4710638,13.3438829],[52.4711394,13.3438825],[52.4711948,13.3438822],[52.4711973,13.3438656],[52.4712083,13.3438700],[52.4712167,13.3438733],[52.4712192,13.3438574],[52.4712219,13.3438412],[52.4712253,13.3438289],[52.4712310,13.3438148],[52.4712371,13.3438052],[52.4712434,13.3437995],[52.4712507,13.3437941],[52.4712586,13.3437914],[52.4712584,13.3437840],[52.4712575,13.3437620],[52.4712746,13.3437601],[52.4712704,13.3436625],[52.4712661,13.3435649],[52.4712645,13.3435452],[52.4712637,13.3435362],[52.4712238,13.3435425],[52.4712191,13.3435424],[52.4712147,13.3435391],[52.4712100,13.3435347],[52.4712059,13.3435286],[52.4712019,13.3435193],[52.4711977,13.3435066],[52.4711951,13.3434946],[52.4711908,13.3434651],[52.4711867,13.3434366]],
  { "area:highway": "tertiary", junction: "yes" });

const result = extractFeatures(data);
const lm = result.laneMarkings.filter((m) => m.name === "Rubensstraße") as LineFeature[];
check("two marking pieces", lm.length === 2, `pieces:${lm.length}`);

const w = lm.find((p) => p.id === "w396518419");
const n = lm.find((p) => p.id === "w396518422");
check("pieces for both ways", w !== undefined && n !== undefined, `${w?.id},${n?.id}`);

if (w && n) {
  // layout dump
  for (const [p, tag] of [[w, "396518419"], [n, "396518422"]] as [LineFeature, string][]) {
    const fwd = p.lanesFwd ?? Math.ceil(p.lanes! / 2);
    const lw = p.laneW!;
    const blkL = p.laneLeftM!, blkR = blkL - p.lanes! * lw;
    const border = -blkL + fwd * lw;
    const bayL = p.parkingLeft ? p.roadLeftM! - blkL : null;
    console.log(`${tag}: lanes=${p.lanes} fwd=${fwd} unit=${lw.toFixed(3)} border@${border.toFixed(2)} road=[L${p.roadLeftM!.toFixed(2)},R${p.roadRightM!.toFixed(2)}] bayL=${bayL?.toFixed(2) ?? "-"}`);
  }
  // 396518419: 3 lanes 2 fwd + 1 bwd, parking:left. RIGHT-HAND TRAFFIC:
  // the 2 FORWARD lanes keep RIGHT of the solid border, the 1 backward
  // lane LEFT, and the parking bay sits at the block's left edge, at
  // the left road edge - exactly one unit wide
  const fwd = w.lanesFwd ?? 2;
  const bwd = w.lanes! - fwd;
  const lw = w.laneW!;
  const blkL = w.laneLeftM!, blkR = blkL - w.lanes! * lw;
  const border = -blkL + bwd * lw;
  check(
    "396518419: solid border between backward and forward lanes (k = bwd)",
    fwd !== bwd,
    `fwd:${fwd} bwd:${bwd}`,
  );
  check(
    "396518419: parking bay at the left road edge, exactly one unit wide",
    Math.abs(w.roadLeftM! - blkL - lw) < 0.05,
    `bay:${(w.roadLeftM! - blkL).toFixed(2)} unit:${lw.toFixed(2)}`,
  );
  check(
    "396518419: forward lanes fill the right side (border + 2 units = right edge)",
    Math.abs(w.roadRightM! - (border + fwd * lw)) < 0.05,
    `border:${border.toFixed(2)} fwdBlock:${(fwd * lw).toFixed(2)} roadR:${w.roadRightM!.toFixed(2)}`,
  );
  check(
    "396518419: unit grid fills its fitted road (4 units)",
    Math.abs(w.lanes! * lw + (w.parkingLeft ? lw : 0) - (w.roadLeftM! + w.roadRightM!)) < 0.3,
    `total:${(w.lanes! * lw + lw).toFixed(2)} road:${(w.roadLeftM! + w.roadRightM!).toFixed(2)}`,
  );
  // 396518422: 1+1, no parking - its own split's anchor: the natural
  // border (right edge minus 1 fwd lane) with its own unit width
  const nFwd = n.lanesFwd ?? 1;
  const nBwd = n.lanes! - nFwd;
  const nBorder = -n.laneLeftM! + nBwd * n.laneW!;
  const nNatural = n.roadRightM! - nFwd * n.laneW!;
  check(
    "396518422: middle line at its own natural position (1+1 split, own anchor)",
    Math.abs(nBorder - nNatural) < 0.05,
    `border:${nBorder.toFixed(2)} natural:${nNatural.toFixed(2)}`,
  );
}

if (failures > 0) {
  console.error(`${failures} rubens 396518419 regression test(s) failed`);
  process.exit(1);
}
console.log("all rubens 396518419 regression tests passed");
