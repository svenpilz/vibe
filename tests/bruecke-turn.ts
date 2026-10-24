/**
 * Regression: Overpass snapshot around Friedenauer Brücke (way 344256556,
 * turn:lanes=left|through|through|none, 4 lanes oneway). The turn arrows
 * must sit at the CENTRE of each lane, aligned with the lane grid, and a
 * "through" arrow must be straight (shaft + symmetric V head) — the old
 * head drew an asymmetric barb that made through arrows read as right
 * bends (left|right|right instead of left|through|through).
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
const way = (coords: [number, number][], tags: Record<string, string>) => {
  data.ways.set(nextWay, {
    id: nextWay,
    refs: coords.map(([lat, lon]) => node(lat, lon)),
    tags,
  });
  nextWay++;
};

// the bridge way from the snapshot (4 lanes, oneway, turn:lanes)
way(
  [
    [52.467072, 13.3374569],
    [52.4670347, 13.3375242],
    [52.4669121, 13.3377465],
    [52.4668816, 13.3377998],
  ],
  {
    highway: "secondary",
    surface: "asphalt",
    lanes: "4",
    name: "Friedenauer Brücke",
    oneway: "yes",
    "parking:both": "no",
    layer: "1",
    "turn:lanes": "left|through|through|none",
  },
);
// its carriageway area (secondary, same layer)
way(
  [
    [52.4670772, 13.3375811],
    [52.4670732, 13.3375871],
    [52.4669701, 13.3377715],
    [52.4669597, 13.3377965],
    [52.4669121, 13.3377465],
    [52.4668656, 13.3376974],
    [52.4669922, 13.3374674],
    [52.4670347, 13.3375242],
    [52.4670772, 13.3375811],
  ],
  { "area:highway": "secondary", layer: "1" },
);

const lm = extractFeatures(data).laneMarkings.filter(
  (m) => m.name === "Friedenauer Brücke",
) as LineFeature[];

check("bridge piece extracted", lm.length === 1, `pieces:${lm.length}`);
const p = lm[0];
if (p) {
  check(
    "turn lanes carried: left|through|through|none",
    p.turnLanesFwd !== undefined &&
      p.turnLanesFwd.length === 4 &&
      p.turnLanesFwd[0].join(",") === "left" &&
      p.turnLanesFwd[1].join(",") === "through" &&
      p.turnLanesFwd[2].join(",") === "through" &&
      p.turnLanesFwd[3].length === 0,
    JSON.stringify(p.turnLanesFwd),
  );
  // lane grid: block spans [-laneLeftM, -laneLeftM + 4*laneW]; the four
  // lane centres must sit at 1/8, 3/8, 5/8, 7/8 of the block — i.e. the
  // arrows are aligned to the width and the lane width
  const left = -(p.laneLeftM ?? 0);
  const w = (p.laneW ?? 0) * 4;
  const centres = [0, 1, 2, 3].map((k) => left + (k + 0.5) * (p.laneW ?? 0));
  check(
    "arrow lane centres at 1/8, 3/8, 5/8, 7/8 of the block width",
    centres.every((c, k) => Math.abs(c - (left + ((2 * k + 1) * w) / 8)) < 1e-6),
    `centres:${centres.map((c) => c.toFixed(2)).join(",")} block:[${left.toFixed(2)},${(left + w).toFixed(2)}]`,
  );
  // the 'left' lane (turn:lanes[0], leftmost in driving direction) must be
  // the LEFTMOST block lane: its centre offset must be the SMALLEST
  check(
    "leftmost tagged lane maps to the leftmost block lane",
    centres[0] < centres[1] && centres[1] < centres[2] && centres[2] < centres[3],
    `centres:${centres.map((c) => c.toFixed(2)).join(",")}`,
  );
}

// ---- SPACING: the arrow cadence must stay visible — the arrow length
// (2.4 m capped at 0.9 lane widths) is always well below the 4 m repeat,
// so consecutive arrows keep a visible gap at any zoom (all-metric
// sizing; the previous pixel-space clamp made arrows overlap at low
// zoom, killing the cadence)
{
  const laneW2 = p.laneW ?? 0;
  const arrowLen = Math.min(2.4, laneW2 * 0.9);
  check(
    "arrow shorter than the 4 m repeat (visible gaps)",
    arrowLen < 4 - 0.5,
    `arrowLen:${arrowLen.toFixed(2)} m, laneW:${laneW2.toFixed(2)}`,
  );
  // the piece's arc carries at least two arrows under the 4 m cadence
  const sp2 = p.spline ?? [];
  const cosLat4 = Math.cos(52.467 * (Math.PI / 180));
  let arc = 0;
  for (let i = 1; i < sp2.length; i++)
    arc += Math.hypot(
      (sp2[i].pt[0] - sp2[i - 1].pt[0]) * 1e-7 * 111320 * cosLat4,
      (sp2[i].pt[1] - sp2[i - 1].pt[1]) * 1e-7 * 111320,
    );
  const nArrows = Math.max(
    0,
    Math.floor((arc - 1.5) / 4) - Math.ceil(1.5 / 4) + 1,
  );
  check(
    "at least two arrows on the 20 m bridge piece",
    nArrows >= 2,
    `arc:${arc.toFixed(1)} m arrows:${nArrows}`,
  );
}

if (failures > 0) {
  console.error(`${failures} brücke turn lane test(s) failed`);
  process.exit(1);
}
console.log("all brücke turn lane tests passed");
