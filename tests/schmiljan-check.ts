/**
 * Regression: Schmiljanstraße snapshot around node 7260531572.
 * junction=y_junction is a GEOMETRY descriptor on the branching road
 * area, not a signalized intersection — it must not trigger stop lines.
 * The real highway=traffic_signals node (forward-facing, at the w2/w3
 * seam) keeps its stop line.
 */
import { createOSMData } from "../src/osm-pbf";
import { extractFeatures } from "../src/extract";
import type { LineFeature } from "../src/features";

let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

const data = createOSMData();
let n = 1;
const nodeByCoord = new Map<string, number>();
const node = (lat: number, lon: number, tags?: Record<string, string>): number => {
  const k = `${lat},${lon}`;
  let id = nodeByCoord.get(k);
  if (id === undefined) {
    id = n++;
    data.nodeCoords.set(id, Math.round(lon * 1e7), Math.round(lat * 1e7));
    nodeByCoord.set(k, id);
  }
  if (tags) data.nodeTags.set(id, tags);
  return id;
};
let w = 1;
const way = (coords: [number, number][], tags: Record<string, string>) => {
  data.ways.set(w, { id: w, refs: coords.map(([la, lo]) => node(la, lo)), tags });
  w++;
};

// the real signal node
node(52.4697184, 13.3312102, {
  highway: "traffic_signals",
  "traffic_signals:direction": "forward",
});
// the carriageways
way(
  [
    [52.4696985, 13.3314186],
    [52.4697225, 13.3313799],
    [52.4697418, 13.3313488],
    [52.4697602, 13.331319],
    [52.4698533, 13.3311695],
    [52.4699442, 13.3310225],
    [52.4699707, 13.3309179],
  ],
  {
    highway: "secondary",
    lanes: "2",
    oneway: "yes",
    surface: "asphalt",
    name: "Schmiljanstraße",
    "parking:both": "no",
  },
);
way(
  [
    [52.4699707, 13.3309179],
    [52.4699058, 13.330955],
    [52.4698086, 13.3310822],
    [52.4697184, 13.3312102],
  ],
  {
    highway: "secondary",
    lanes: "2",
    oneway: "yes",
    surface: "asphalt",
    name: "Schmiljanstraße",
    "parking:both": "no",
  },
);
way(
  [
    [52.4697184, 13.3312102],
    [52.4696889, 13.3312573],
    [52.4696436, 13.3313296],
  ],
  {
    highway: "secondary",
    lanes: "2",
    oneway: "yes",
    surface: "asphalt",
    name: "Schmiljanstraße",
    "parking:both": "no",
  },
);
// the y_junction branching road area (a GEOMETRY descriptor)
way(
  [
    [52.4698246, 13.3311193],
    [52.4698086, 13.3310822],
    [52.4697936, 13.3310475],
    [52.4698989, 13.3309088],
    [52.4699364, 13.3308499],
    [52.4699733, 13.3309136],
    [52.470011, 13.3309787],
    [52.4698732, 13.3312039],
    [52.4698533, 13.3311695],
    [52.4698343, 13.3311364],
    [52.469835, 13.3311304],
    [52.4698342, 13.3311249],
    [52.4698319, 13.3311212],
    [52.4698282, 13.3311197],
    [52.4698246, 13.3311193],
  ],
  { "area:highway": "secondary", junction: "y_junction" },
);
// the plain road areas
way(
  [
    [52.4698246, 13.3311193],
    [52.4697376, 13.3312429],
    [52.4697184, 13.3312102],
    [52.4696993, 13.3311785],
    [52.4697354, 13.3311252],
    [52.4697725, 13.3310728],
    [52.4697936, 13.3310475],
    [52.4698246, 13.3311193],
  ],
  { "area:highway": "secondary" },
);
way(
  [
    [52.4697795, 13.3313519],
    [52.4697602, 13.331319],
    [52.4697409, 13.3312863],
    [52.4698343, 13.3311364],
    [52.4698533, 13.3311695],
    [52.4698732, 13.3312039],
    [52.4697795, 13.3313519],
  ],
  { "area:highway": "secondary" },
);
// traffic island + kerb
way(
  [
    [52.4697409, 13.3312863],
    [52.4698343, 13.3311364],
    [52.469835, 13.3311304],
    [52.4698342, 13.3311249],
    [52.4698319, 13.3311212],
    [52.4698282, 13.3311197],
    [52.4698246, 13.3311193],
    [52.4697376, 13.3312429],
    [52.4697257, 13.3312605],
    [52.4697409, 13.3312863],
  ],
  { "area:highway": "traffic_island" },
);
way(
  [
    [52.4697409, 13.3312863],
    [52.4698343, 13.3311364],
    [52.469835, 13.3311304],
    [52.4698342, 13.3311249],
    [52.4698319, 13.3311212],
    [52.4698282, 13.3311197],
    [52.4698246, 13.3311193],
    [52.4697376, 13.3312429],
    [52.4697257, 13.3312605],
    [52.4697409, 13.3312863],
  ],
  { barrier: "kerb" },
);
// the signalized junction area south of the signal
way(
  [
    [52.4696932, 13.3313128],
    [52.4697257, 13.3312605],
    [52.4697376, 13.3312429],
    [52.4697184, 13.3312102],
    [52.4696993, 13.3311785],
    [52.469688, 13.3311967],
    [52.4696785, 13.3311813],
    [52.4696741, 13.3311743],
    [52.4696575, 13.3312031],
    [52.4696498, 13.3312149],
    [52.4696444, 13.3312192],
    [52.4696398, 13.3312202],
    [52.4696356, 13.3312198],
    [52.4696311, 13.3312183],
    [52.4696272, 13.3312158],
    [52.4696236, 13.3312108],
    [52.4696122, 13.3311914],
    [52.4695888, 13.3312316],
    [52.469568, 13.3312671],
    [52.4695707, 13.3312726],
    [52.4695779, 13.3312876],
    [52.4695812, 13.3312967],
    [52.4695824, 13.3313036],
    [52.4695825, 13.3313109],
    [52.4695818, 13.3313181],
    [52.4695799, 13.3313248],
    [52.4695592, 13.3313582],
    [52.4695637, 13.3313653],
    [52.4695733, 13.3313805],
    [52.4695901, 13.331415],
    [52.4696082, 13.3314475],
    [52.4696345, 13.3314054],
    [52.4696932, 13.3313128],
  ],
  { "area:highway": "secondary", junction: "yes" },
);

const result = extractFeatures(data);
const lm = result.laneMarkings.filter(
  (m) => m.name === "Schmiljanstraße",
) as LineFeature[];

// no piece except the one flowing INTO the signal carries a stop line
const withStop = lm.filter((p) => (p.stopLinesQ ?? []).length > 0);
check(
  "exactly one stop line: the piece flowing into the signal node",
  withStop.length === 1,
  `pieces with stop lines:${withStop.map((p) => p.id).join(",")}`,
);
// the y_junction area is NOT a junction: pieces inside it render lane
// markings (it is a plain branching carriageway)
const yAreaId = result.areas.find((a) =>
  a.outer.some((ring) => ring.some((pt) => pt[1] === Math.round(52.4698246 * 1e7) && pt[0] === Math.round(13.3311193 * 1e7))),
)?.id;
const piecesInY = lm.filter((p) => (p.areaIds ?? []).includes(yAreaId ?? ""));
check(
  "y_junction area renders as plain road (lane marking pieces)",
  piecesInY.length >= 1,
  `pieces in y_junction area:${piecesInY.length}`,
);

if (failures > 0) {
  console.error(`${failures} schmiljan regression test(s) failed`);
  process.exit(1);
}
console.log("all schmiljan regression tests passed");
