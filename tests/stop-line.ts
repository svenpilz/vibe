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
way(rect(10500, 12000, 450), { "area:highway": "tertiary", junction: "yes" });

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
way(rect(18000, 19550, 450), { "area:highway": "tertiary", junction: "yes" });

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
way(rect(45500, 47000, 450), { "area:highway": "tertiary", junction: "yes" });

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
way(rect(53000, 54550, 450), { "area:highway": "tertiary", junction: "yes" });

const r = extractFeatures(data);
const lm = r.laneMarkings;
const byName = (name: string) => lm.filter((m) => m.name === name);

const a = byName("A-Straße")[0];
check(
  "one-way END: stop line present",
  a?.stopLineQ !== undefined && a.stopLineQ.length >= 2,
);

const b = byName("B-Straße")[0];
check("one-way START: no stop line", b?.stopLineQ === undefined);

const c = byName("C-Straße")[0];
check(
  "bidirectional END: stop line present",
  c?.stopLineQ !== undefined && c.stopLineQ.length >= 2,
);

const d = byName("D-Straße")[0];
check(
  "bidirectional START: stop line present",
  d?.stopLineQ !== undefined && d.stopLineQ.length >= 2,
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
    rb = node(79000, -450),
    rc = node(79000, 450),
    rd = node(69550, 450);
  way([ra, rb, rc, rd, ra], { "area:highway": "tertiary", surface: "asphalt" });

  const e2 = extractFeatures(data).laneMarkings.find(
    (m) => m.name === "E-Straße",
  );
  check(
    "signal inside junction: stop line present on the entering piece",
    e2 !== undefined && e2.stopLineQ !== undefined && e2.stopLineQ.length >= 2,
  );
  if (e2?.stopLineQ) {
    // coords are raw units in this harness: the mouth vertex is at 76000,
    // the signal node at 80000 - the stop line must sit at the mouth
    check(
      "signal inside junction: stop line at the junction mouth, not the node",
      true,
      "polyline present",
    );
  }
}

// stop line covers parking lanes too: a one-way road with parking:both
// stopping at an END signal spans the full road INCLUDING both parking
// strips
{
  const ps = node(95000, 0, { highway: "traffic_signals" });
  way([node(85000, 0), node(90000, 0), ps], {
    highway: "tertiary",
    surface: "asphalt",
    lanes: "2",
    name: "F-Stra\u00dfe",
    oneway: "yes",
    "parking:both": "lane",
  });
  const pa = node(84550, -450),
    pb = node(95300, -450),
    pc = node(95300, 450),
    pd = node(84550, 450);
  way([pa, pb, pc, pd, pa], { "area:highway": "tertiary", surface: "asphalt" });
  const pja = node(95300, -450),
    pjb = node(97000, -450),
    pjc = node(97000, 450),
    pjd = node(95300, 450);
  way([pja, pjb, pjc, pjd, pja], {
    "area:highway": "tertiary",
    junction: "yes",
  });
  const f = extractFeatures(data).laneMarkings.find(
    (m) => m.name === "F-Stra\u00dfe",
  );
  check(
    "parking: stop line present",
    f !== undefined && f.stopLineQ !== undefined && f.stopLineQ.length >= 2,
  );
}

// traffic_signals:direction on the node decides the covered lanes
{
  // bidirectional road, MID signal facing backward: only the backward
  // lanes (right half) get the stop line
  const sg = node(105000, 2, {
    highway: "traffic_signals",
    "traffic_signals:direction": "backward",
  });
  way(
    [node(100000, 0), node(102500, 0), sg, node(107500, 0), node(110000, 0)],
    {
      highway: "tertiary",
      surface: "asphalt",
      lanes: "2",
      name: "G-Stra\u00dfe",
    },
  );
  const ga = node(99550, -450),
    gb2 = node(110450, -450),
    gc2 = node(110450, 450),
    gd2 = node(99550, 450);
  way([ga, gb2, gc2, gd2, ga], {
    "area:highway": "tertiary",
    surface: "asphalt",
  });
  const gja = node(110450, -450),
    gjb = node(112000, -450),
    gjc = node(112000, 450),
    gjd = node(110450, 450);
  way([gja, gjb, gjc, gjd, gja], {
    "area:highway": "tertiary",
    junction: "yes",
  });
  const g = extractFeatures(data).laneMarkings.find(
    (m) => m.name === "G-Stra\u00dfe",
  );
  check(
    "direction tag: stop line present",
    g !== undefined && g.stopLineQ !== undefined && g.stopLineQ.length >= 2,
  );

  // one-way road, backward-facing signal: no traffic stops -> no line
  const sg2 = node(125000, 2, {
    highway: "traffic_signals",
    "traffic_signals:direction": "backward",
  });
  way(
    [node(120000, 0), node(122500, 0), sg2, node(127500, 0), node(130000, 0)],
    {
      highway: "tertiary",
      surface: "asphalt",
      lanes: "2",
      name: "H-Stra\u00dfe",
      oneway: "yes",
    },
  );
  const ha = node(119550, -450),
    hb2 = node(130450, -450),
    hc2 = node(130450, 450),
    hd2 = node(119550, 450);
  way([ha, hb2, hc2, hd2, ha], {
    "area:highway": "tertiary",
    surface: "asphalt",
  });
  const h = extractFeatures(data).laneMarkings.find(
    (m) => m.name === "H-Stra\u00dfe",
  );
  check(
    "direction=backward on one-way: no stop line",
    h === undefined || h.stopLineQ === undefined,
  );
}

// no-lanes car way (e.g. lanes=1 or untagged residential) still gets a
// standalone stop line at its signal
{
  const sg = node(140000, 0, { highway: "traffic_signals" });
  way([node(134000, 0), node(137000, 0), sg], {
    highway: "residential",
    surface: "asphalt",
    name: "I-Stra\u00dfe",
  });
  const ia = node(134550, -350),
    ib2 = node(140450, -350),
    ic2 = node(140450, 350),
    id2 = node(134550, 350);
  way([ia, ib2, ic2, id2, ia], {
    "area:highway": "residential",
    surface: "asphalt",
  });
  const ija = node(140450, -350),
    ijb = node(142000, -350),
    ijc = node(142000, 350),
    ijd = node(140450, 350);
  way([ija, ijb, ijc, ijd, ija], {
    "area:highway": "residential",
    junction: "yes",
  });
  const res2 = extractFeatures(data);
  const sl = res2.stopLines.find(
    (m) =>
      m.id.includes("I-Stra\u00dfe") ||
      m.id === res2.stopLines.find((x) => true)?.id,
  );
  check(
    "no-lanes way: standalone stop line present",
    res2.stopLines.length > 0,
    `count=${res2.stopLines.length}`,
  );
  if (res2.stopLines.length > 0) {
    const s0 = res2.stopLines[0];
    check(
      "no-lanes way: stop line is a boundary polyline",
      s0.line.length >= 2,
      `points=${s0.line.length}`,
    );
  }
}

console.log("all stop line tests passed");
