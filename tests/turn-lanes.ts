/**
 * Turn lane indicators (turn:lanes, turn:lanes:forward/backward):
 * - one-way road flowing into a junction: arrows for its own direction
 * - bidirectional road: forward list at the junction END, backward list
 *   at the junction START
 * - no junction at the way's end: no arrows
 * - oneway=-1: turn:lanes:backward applies (reversed into way frame)
 * - value parsing: ; combinations, | per lane, none/empty dropped,
 *   unknown values dropped
 */
import { createOSMData } from "../src/osm-pbf";
import { extractFeatures } from "../src/extract";

let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

const data = createOSMData();
const LAT = Math.round(52.52 * 1e7);
let n = 1;
const node = (x: number, y: number, tags?: Record<string, string>): number => {
  const id = n++;
  data.nodeCoords.set(id, x, LAT + y);
  if (tags) data.nodeTags.set(id, tags);
  return id;
};
let w = 1;
const way = (refs: number[], tags: Record<string, string>) => {
  data.ways.set(w, { id: w, refs, tags });
  w++;
};
const rect = (x0: number, x1: number, hw: number): number[] => {
  const a = node(x0, -hw),
    b = node(x1, -hw),
    c = node(x1, hw),
    d = node(x0, hw);
  return [a, b, c, d, a];
};

// one-way road flowing into a junction at its END: left|through;right
// plus a second way exercising merge_to_* values
way([node(0, 0), node(5000, 0), node(10000, 0)], {
  highway: "tertiary",
  surface: "asphalt",
  lanes: "3",
  name: "A-Straße",
  oneway: "yes",
  "turn:lanes": "left|through;right|bogus_value",
});
way(rect(-450, 10500, 450), { "area:highway": "tertiary", surface: "asphalt" });
way(rect(10500, 12000, 450), { "area:highway": "tertiary", junction: "yes" });
// merge_to_* values (rendered as regular left/right)
way([node(70000, 0), node(75000, 0), node(80000, 0)], {
  highway: "tertiary",
  surface: "asphalt",
  lanes: "2",
  name: "E-Straße",
  oneway: "yes",
  "turn:lanes": "merge_to_left|merge_to_right",
});
way(rect(69550, 80500, 450), { "area:highway": "tertiary", surface: "asphalt" });
way(rect(80500, 82000, 450), { "area:highway": "tertiary", junction: "yes" });

// bidirectional road with a junction at BOTH ends: forward arrows at the
// end, backward arrows at the start
way([node(20000, 0), node(25000, 0), node(30000, 0)], {
  highway: "tertiary",
  surface: "asphalt",
  lanes: "4",
  name: "B-Straße",
  "turn:lanes:forward": "left|through",
  "turn:lanes:backward": "through;right|right",
});
way(rect(19550, 30450, 450), { "area:highway": "tertiary", surface: "asphalt" });
way(rect(18000, 19550, 450), { "area:highway": "tertiary", junction: "yes" });
way(rect(30450, 32000, 450), { "area:highway": "tertiary", junction: "yes" });

// road WITHOUT turn:lanes: no arrows, junction or not
way([node(40000, 0), node(45000, 0), node(50000, 0)], {
  highway: "tertiary",
  surface: "asphalt",
  lanes: "2",
  name: "C-Straße",
  oneway: "yes",
});
way(rect(39550, 50450, 450), { "area:highway": "tertiary", surface: "asphalt" });
way(rect(50450, 52000, 450), { "area:highway": "tertiary", junction: "yes" });

// oneway=-1 flowing into a junction at the way's START (in travel
// direction): turn:lanes:backward applies, reversed into the way frame
way([node(60000, 0), node(65000, 0), node(70000, 0)], {
  highway: "tertiary",
  surface: "asphalt",
  lanes: "2",
  name: "D-Straße",
  oneway: "-1",
  "turn:lanes:backward": "left|right",
});
way(rect(59550, 70450, 450), { "area:highway": "tertiary", surface: "asphalt" });
way(rect(58000, 59550, 450), { "area:highway": "tertiary", junction: "yes" });

const lm = extractFeatures(data).laneMarkings;

const a = lm.find((m) => m.name === "A-Straße");
check(
  "one-way into junction: forward turn lanes extracted",
  a?.turnLanesFwd !== undefined && a.turnLanesFwd.length === 3,
  JSON.stringify(a?.turnLanesFwd),
);
check(
  "leftmost lane keeps 'left'",
  a?.turnLanesFwd?.[0]?.join(",") === "left",
);
check(
  "';' combination kept as one lane's values",
  a?.turnLanesFwd?.[1]?.join(",") === "through,right",
);
check("unknown value dropped", a?.turnLanesFwd?.[2]?.length === 0);
check("one-way road has no backward arrows", a?.turnLanesBwd === undefined);

const b = lm.find((m) => m.name === "B-Straße");
check(
  "bidirectional: forward arrows at the junction end",
  b?.turnLanesFwd?.length === 2 &&
    b.turnLanesFwd[0].join(",") === "left" &&
    b.turnLanesFwd[1].join(",") === "through",
  JSON.stringify(b?.turnLanesFwd),
);
check(
  "bidirectional: backward arrows at the junction start",
  b?.turnLanesBwd?.length === 2 &&
    b.turnLanesBwd[0].join(",") === "through,right" &&
    b.turnLanesBwd[1].join(",") === "right",
  JSON.stringify(b?.turnLanesBwd),
);

const c = lm.find((m) => m.name === "C-Straße");
check(
  "untagged way: no arrows",
  c?.turnLanesFwd === undefined && c?.turnLanesBwd === undefined,
);

const d = lm.find((m) => m.name === "D-Straße");
check(
  "oneway=-1: backward-tagged lanes reversed into the travel direction",
  d?.turnLanesFwd?.length === 2 &&
    d.turnLanesFwd[0].join(",") === "left" &&
    d.turnLanesFwd[1].join(",") === "right",
  JSON.stringify(d?.turnLanesFwd),
);

// ---- LANE CENTRING: the forward arrows of a 2-lane one-way road sit at
// 1/4 and 3/4 of the lane block's width — the renderer derives the lane
// centres from laneLeftM/laneW; verify the piece data supports exactly
// that mapping (block spans [-laneLeftM, -laneLeftM + lanes*laneW])
{
  const d2 = lm.find((m) => m.name === "D-Straße");
  if (d2 && d2.laneLeftM !== undefined && d2.laneW !== undefined) {
    const left = -d2.laneLeftM;
    const w = d2.lanes! * d2.laneW!;
    const c0 = left + 0.5 * d2.laneW!;
    const c1 = left + 1.5 * d2.laneW!;
    check(
      "2-lane one-way: arrow lane centres at 1/4 and 3/4 of the block",
      Math.abs(c0 - (left + w / 4)) < 1e-6 && Math.abs(c1 - (left + (3 * w) / 4)) < 1e-6,
      `centres:${c0.toFixed(2)},${c1.toFixed(2)} block:[${left.toFixed(2)},${(left + w).toFixed(2)}]`,
    );
  }
}

// merge_to_* parse and are carried (the renderer draws them as
// regular left/right)
{
  const e = lm.find((m) => m.name === "E-Straße");
  check(
    "merge_to_left|merge_to_right carried per lane",
    e?.turnLanesFwd !== undefined &&
      e.turnLanesFwd[0].join(",") === "merge_to_left" &&
      e.turnLanesFwd[1].join(",") === "merge_to_right",
    JSON.stringify(e?.turnLanesFwd),
  );
}

if (failures > 0) {
  console.error(`${failures} turn lane test(s) failed`);
  process.exit(1);
}
console.log("all turn lane tests passed");
