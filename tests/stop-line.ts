/**
 * Stop lines at highway=traffic_signals nodes (README §5):
 * - one-way road with the signal at its END: stop line spans the full width
 * - one-way road with the signal at its START: no stop line (flows away)
 * - bidirectional road, signal at END: only the forward (into-junction)
 *   lanes get the stop line
 * - bidirectional road, signal at START: only the backward lanes
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

// one-way road, signal at its END node
const s1 = node(10000, 0, { highway: "traffic_signals" });
way([node(0, 0), node(5000, 0), s1], {
  highway: "tertiary",
  surface: "asphalt",
  lanes: "2",
  name: "A-Straße",
  oneway: "yes",
});
way(rect(-450, 10500, 450), { "area:highway": "tertiary", surface: "asphalt" });

// one-way road, signal at its START node: no stop line
const s2 = node(20000, 0, { highway: "traffic_signals" });
way([s2, node(25000, 0), node(30000, 0)], {
  highway: "tertiary",
  surface: "asphalt",
  lanes: "2",
  name: "B-Straße",
  oneway: "yes",
});
way(rect(19550, 30450, 450), {
  "area:highway": "tertiary",
  surface: "asphalt",
});

// bidirectional road, signal at its END: only forward lanes stop
const s3 = node(45000, 0, { highway: "traffic_signals" });
way([node(35000, 0), node(40000, 0), s3], {
  highway: "tertiary",
  surface: "asphalt",
  lanes: "2",
  name: "C-Straße",
});
way(rect(34550, 45500, 450), {
  "area:highway": "tertiary",
  surface: "asphalt",
});

// bidirectional road, signal at its START: only backward lanes stop
const s4 = node(55000, 0, { highway: "traffic_signals" });
way([s4, node(60000, 0), node(65000, 0)], {
  highway: "tertiary",
  surface: "asphalt",
  lanes: "2",
  name: "D-Straße",
});
way(rect(54550, 65450, 450), {
  "area:highway": "tertiary",
  surface: "asphalt",
});

const r = extractFeatures(data);
const lm = r.laneMarkings;
const byName = (name: string) => lm.filter((m) => m.name === name);

const a = byName("A-Straße")[0];
check("one-way END: stop line present", a?.stopLineAtQ !== undefined);
const aSpan = Math.abs(a!.stopLineFromM! - a!.stopLineToM!);
check(
  "one-way END: spans the full width",
  Math.abs(aSpan - a!.laneW! * a!.lanes!) < 0.1,
  `span=${aSpan} vs block=${a!.laneW! * a!.lanes!}`,
);

const b = byName("B-Straße")[0];
check("one-way START: no stop line", b?.stopLineAtQ === undefined);

const c = byName("C-Straße")[0];
check("bidirectional END: stop line present", c?.stopLineAtQ !== undefined);
const cSpan = Math.abs(c!.stopLineFromM! - c!.stopLineToM!);
check(
  "bidirectional END: covers only the forward lanes",
  Math.abs(cSpan - c!.laneW!) < 0.5,
  `span=${cSpan} vs one lane=${c!.laneW}`,
);

const d = byName("D-Straße")[0];
check("bidirectional START: stop line present", d?.stopLineAtQ !== undefined);
const dSpan = Math.abs(d!.stopLineFromM! - d!.stopLineToM!);
check(
  "bidirectional START: covers only the backward lanes",
  Math.abs(dSpan - d!.laneW!) < 0.5,
  `span=${dSpan} vs one lane=${d!.laneW}`,
);

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}

// signal inside a junction area: the stop line must land at the piece
// vertex where the way ENTERS the road area (the junction's mouth), not
// at the node (which the junction would clip away)
{
  const sj = node(80000, 0, { highway: "traffic_signals" });
  way([node(70000, 0), node(74000, 0), node(76000, 0), sj], {
    highway: "tertiary",
    surface: "asphalt",
    lanes: "2",
    name: "E-Straße",
    oneway: "yes",
  });
  const ja = node(79000, -600),
    jb = node(81000, -600),
    jc = node(81000, 600),
    jd = node(79000, 600);
  way([ja, jb, jc, jd, ja], { "area:highway": "tertiary", junction: "yes" });
  const ra = node(69550, -450),
    rb = node(76200, -450),
    rc = node(76200, 450),
    rd = node(69550, 450);
  way([ra, rb, rc, rd, ra], { "area:highway": "tertiary", surface: "asphalt" });
  const e2 = extractFeatures(data).laneMarkings.find(
    (m) => m.name === "E-Straße",
  );
  check(
    "signal inside junction: stop line present on the entering piece",
    e2 !== undefined && e2.stopLineAtQ !== undefined,
  );
  if (e2?.stopLineAtQ) {
    // coords are raw units in this harness: the mouth vertex is at 76000,
    // the signal node at 80000 - the stop line must sit at the mouth
    check(
      "signal inside junction: stop line at the junction mouth, not the node",
      e2.stopLineAtQ[0] === 76000,
      `atQ lon=${e2.stopLineAtQ[0]}`,
    );
  }
}

console.log("all stop line tests passed");
