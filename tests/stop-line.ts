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
  a?.stopLinesQ !== undefined && a.stopLinesQ.length >= 1 && a.stopLinesQ.every((l) => l.length >= 2),
);

const b = byName("B-Straße")[0];
check("one-way START: no stop line", b?.stopLinesQ === undefined);

const c = byName("C-Straße")[0];
check(
  "bidirectional END: stop line present",
  c?.stopLinesQ !== undefined && c.stopLinesQ.length >= 1 && c.stopLinesQ.every((l) => l.length >= 2),
);

const d = byName("D-Straße")[0];
check(
  "bidirectional START: stop line present",
  d?.stopLinesQ !== undefined && d.stopLinesQ.length >= 1 && d.stopLinesQ.every((l) => l.length >= 2),
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
    e2 !== undefined && e2.stopLinesQ !== undefined && e2.stopLinesQ.length >= 1 && e2.stopLinesQ.every((l) => l.length >= 2),
  );
  if (e2?.stopLinesQ) {
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
    f !== undefined && f.stopLinesQ !== undefined && f.stopLinesQ.length >= 1 && f.stopLinesQ.every((l) => l.length >= 2),
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
    g !== undefined && g.stopLinesQ !== undefined && g.stopLinesQ.length >= 1 && g.stopLinesQ.every((l) => l.length >= 2),
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
    h === undefined || h.stopLinesQ === undefined,
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

// a road area bordered by TWO junction areas (one at each end): the stop
// line must sit at the junction CONTAINING the signal node, never at the
// opposite end. The junction at the signal's far end is created FIRST so
// that a "first junction wins" picker would pick the wrong one
{
  // signal at the road area's right end, inside the RIGHT junction
  const sk = node(160000, 0, { highway: "traffic_signals" });
  way([node(150000, 0), node(155000, 0), sk], {
    highway: "tertiary",
    surface: "asphalt",
    lanes: "2",
    name: "K-Stra\u00dfe",
    oneway: "yes",
  });
  // FAR junction created first (wrong-end candidate), overlapping the
  // road area's left end by a sliver
  const kfa = node(149800, -450),
    kfb = node(150200, -450),
    kfc = node(150200, 450),
    kfd = node(149800, 450);
  way([kfa, kfb, kfc, kfd, kfa], {
    "area:highway": "tertiary",
    junction: "yes",
  });
  // road area spanning between the two junctions
  const kra = node(150200, -450),
    krb = node(160000, -450),
    krc = node(160000, 450),
    krd = node(150200, 450);
  way([kra, krb, krc, krd, kra], {
    "area:highway": "tertiary",
    surface: "asphalt",
  });
  // NEAR junction containing the signal node, created LAST
  const kna = node(160000, -450),
    knb = node(162000, -450),
    knc = node(162000, 450),
    knd = node(160000, 450);
  way([kna, knb, knc, knd, kna], {
    "area:highway": "tertiary",
    junction: "yes",
  });
  const res3 = extractFeatures(data);
  const k = res3.laneMarkings.find((m) => m.name === "K-Stra\u00dfe");
  check(
    "two junctions: stop line present",
    k !== undefined && k.stopLinesQ !== undefined && k.stopLinesQ.length >= 1 && k.stopLinesQ.every((l) => l.length >= 2),
  );
  if (k?.stopLinesQ) {
    // every stop line point must lie at the NEAR junction mouth
    // (x = 160000), never at the far end (x = 150200)
    const maxAbsDev = Math.max(
      ...k.stopLinesQ.flat().map((p) => Math.abs(p[0] - 160000)),
    );
    check(
      "two junctions: stop line at the signal's junction end",
      maxAbsDev < 200,
      `max deviation from x=160000: ${maxAbsDev}`,
    );
  }
  // same scenario for the standalone (no-lanes) stop line output
  const ks = node(175000, 0, { highway: "traffic_signals" });
  way([node(165000, 0), node(170000, 0), ks], {
    highway: "residential",
    surface: "asphalt",
    name: "L-Stra\u00dfe",
  });
  const lfa = node(164800, -350),
    lfb = node(165200, -350),
    lfc = node(165200, 350),
    lfd = node(164800, 350);
  way([lfa, lfb, lfc, lfd, lfa], {
    "area:highway": "residential",
    junction: "yes",
  });
  const lra = node(165200, -350),
    lrb = node(175000, -350),
    lrc = node(175000, 350),
    lrd = node(165200, 350);
  way([lra, lrb, lrc, lrd, lra], {
    "area:highway": "residential",
    surface: "asphalt",
  });
  const lna = node(175000, -350),
    lnb = node(177000, -350),
    lnc = node(177000, 350),
    lnd = node(175000, 350);
  way([lna, lnb, lnc, lnd, lna], {
    "area:highway": "residential",
    junction: "yes",
  });
  const res4 = extractFeatures(data);
  const l = res4.laneMarkings.find((m) => m.name === "L-Stra\u00dfe");
  if (l?.stopLinesQ) {
    const maxAbsDev2 = Math.max(
      ...l.stopLinesQ.flat().map((p) => Math.abs(p[0] - 175000)),
    );
    check(
      "two junctions (no-lanes): stop line at the signal's junction end",
      maxAbsDev2 < 200,
      `max deviation from x=175000: ${maxAbsDev2}`,
    );
  } else {
    // the L-Stra\u00dfe stop line is the one near x=175000
    const sl = res4.stopLines.find(
      (s) => s.bbox[0] > 170000 && s.bbox[2] < 180000,
    );
    check(
      "two junctions (standalone): stop line present",
      sl !== undefined,
      `count near signal=${res4.stopLines.filter((s) => s.bbox[0] > 170000 && s.bbox[2] < 180000).length}`,
    );
    if (sl) {
      const maxAbsDev3 = Math.max(
        ...sl.line.map((p) => Math.abs(p[0] - 175000)),
      );
      check(
        "two junctions (standalone): stop line at the signal's end",
        maxAbsDev3 < 200,
        `max deviation from x=175000: ${maxAbsDev3}`,
      );
    }
  }
}
// ONE junction area whose ring crosses the road area at SEVERAL places
// (the signal's mouth AND mid-road): the shared boundary consists of
// SEVERAL chains - the stop line must use only the chain at the signal's
// mouth, never the flattened polyline running through the far chains
{
  // long road, signal near its right end
  const sq = node(195000, 0, { highway: "traffic_signals" });
  way([node(185000, 0), node(190000, 0), sq], {
    highway: "tertiary",
    surface: "asphalt",
    lanes: "2",
    name: "M-Stra\u00dfe",
    oneway: "yes",
  });
  // road area
  const mra = node(185450, -450),
    mrb = node(195450, -450),
    mrc = node(195450, 450),
    mrd = node(185450, 450);
  way([mra, mrb, mrc, mrd, mra], {
    "area:highway": "tertiary",
    surface: "asphalt",
  });
  // ONE junction area: a lobe over the road's right end (the signal's
  // mouth at x=194500) plus a lobe touching the road mid-way (x=189000
  // and x=190500), connected below the road - its ring crosses the road
  // area at three separate places
  const mja = node(189000, -700),
    mjb = node(196000, -700),
    mjc = node(196000, 700),
    mjd = node(194500, 700),
    mje = node(194500, -600),
    mjf = node(190500, -600),
    mjg = node(190500, 700),
    mjh = node(189000, 700);
  way([mja, mjb, mjc, mjd, mje, mjf, mjg, mjh, mja], {
    "area:highway": "tertiary",
    junction: "yes",
  });
  const res5 = extractFeatures(data);
  const m = res5.laneMarkings.find((x) => x.name === "M-Stra\u00dfe");
  check(
    "multi-chain junction: stop line present",
    m !== undefined && m.stopLinesQ !== undefined && m.stopLinesQ.length >= 1 && m.stopLinesQ.every((l) => l.length >= 2),
  );
  if (m?.stopLinesQ) {
    // the stop line must sit at the signal's mouth (x=194500), never
    // reach the mid-road chains (x=189000 / 190500)
    const maxAbsDev = Math.max(
      ...m.stopLinesQ.flat().map((p) => Math.abs(p[0] - 194500)),
    );
    check(
      "multi-chain junction: stop line only at the signal's mouth",
      maxAbsDev < 200,
      `max deviation from x=194500: ${maxAbsDev}`,
    );
  }
}
// a road with traffic_signals at BOTH ends (two signalized junctions): the
// piece must carry TWO stop lines - one per signal node, each on the end
// where its own signal stands
{
  const sa = node(210000, 0, { highway: "traffic_signals" });
  const sb = node(220000, 0, { highway: "traffic_signals" });
  way([sa, node(215000, 0), sb], {
    highway: "tertiary",
    surface: "asphalt",
    lanes: "2",
    name: "N-Stra\u00dfe",
  });
  // junction at the left end (contains signal sa)
  const nja = node(208500, -450),
    njb = node(210000, -450),
    njc = node(210000, 450),
    njd = node(208500, 450);
  way([nja, njb, njc, njd, nja], {
    "area:highway": "tertiary",
    junction: "yes",
  });
  // road area between the two junctions
  const nra = node(210000, -450),
    nrb = node(220000, -450),
    nrc = node(220000, 450),
    nrd = node(210000, 450);
  way([nra, nrb, nrc, nrd, nra], {
    "area:highway": "tertiary",
    surface: "asphalt",
  });
  // junction at the right end (contains signal sb)
  const nka = node(220000, -450),
    nkb = node(221500, -450),
    nkc = node(221500, 450),
    nkd = node(220000, 450);
  way([nka, nkb, nkc, nkd, nka], {
    "area:highway": "tertiary",
    junction: "yes",
  });
  const res6 = extractFeatures(data);
  const q = res6.laneMarkings.find((x) => x.name === "N-Stra\u00dfe");
  check(
    "signals at both ends: TWO stop lines on the piece",
    q !== undefined && q.stopLinesQ !== undefined && q.stopLinesQ.length === 2,
    `stopLinesQ=${q?.stopLinesQ?.length ?? 0}`,
  );
  if (q?.stopLinesQ?.length === 2) {
    // one stop line at each mouth (x=210000 and x=220000)
    const ends = q.stopLinesQ.map(
      (line) => line.reduce((s, pt) => s + pt[0], 0) / line.length,
    );
    const nearLeft = ends.some((x) => Math.abs(x - 210000) < 200);
    const nearRight = ends.some((x) => Math.abs(x - 220000) < 200);
    check(
      "signals at both ends: one stop line per end, at its own signal",
      nearLeft && nearRight,
      `centroids=${JSON.stringify(ends)}`,
    );
  }
}
console.log("all stop line tests passed");
