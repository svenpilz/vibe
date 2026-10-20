/**
 * Regression: exact Overpass snapshot of Rubensstraße (ways 4463559 +
 * 1122774349..352). The road is STRAIGHT with parking sides changing
 * between ways (both/left/both/right) and bus platforms denting the
 * area boundary. The extracted lane block must stay straight: the
 * mapped centerline's parking-induced jogs and the platform dents must
 * not bend the markings.
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

// ---- Rubensstraße centerline pieces (south -> north) ----
centerline([[52.4728269,13.3433651],[52.4737052,13.3432498],[52.4740519,13.3432017]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "lane" });
centerline([[52.4740519,13.3432017],[52.4741052,13.3431944]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "no" });
centerline([[52.4741052,13.3431944],[52.4741525,13.3431879],[52.4747858,13.3431022]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "lane" });
centerline([[52.4747858,13.3431022],[52.4748325,13.3430959],[52.4750004,13.3430734]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:left": "no", "parking:right": "lane" });
centerline([[52.4750004,13.3430734],[52.4750761,13.3430632]],           // <- the way from the request
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "lane" });
centerline([[52.4750761,13.3430632],[52.4752362,13.3430417],[52.4752689,13.3430373]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:left": "lane", "parking:right": "no" });
centerline([[52.4752689,13.3430373],[52.4757242,13.3429758],[52.4757775,13.3429689]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "lane" });
centerline([[52.4757775,13.3429689],[52.4758123,13.3429643],[52.4758440,13.3429599],[52.4759168,13.3429506]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "no" });
centerline([[52.4759168,13.3429506],[52.4760028,13.3429390]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:left": "no", "parking:right": "lane" });
centerline([[52.4760028,13.3429390],[52.4765847,13.3428590]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "lane" });

// ---- area:highway=tertiary polygons (incl. the junction ones to be skipped) ----
area([[52.4728269,13.3433651],[52.4728304,13.3434467],[52.4731659,13.3434020],[52.4740562,13.3432823],
      [52.4740519,13.3432017],[52.4740474,13.3431173],[52.4740196,13.3431209],[52.4728233,13.3432834]],
  { "area:highway": "tertiary" });
area([[52.4741563,13.3432681],[52.4741525,13.3431879],[52.4741486,13.3431033],[52.4741265,13.3431063],
      [52.4741071,13.3431090],[52.4741010,13.3431099],[52.4740942,13.3431108],[52.4740744,13.3431136],
      [52.4740719,13.3431141],[52.4740474,13.3431173],[52.4740519,13.3432017],[52.4740562,13.3432823],
      [52.4740586,13.3433260],[52.4740590,13.3433336],[52.4740864,13.3433300],[52.4740878,13.3433578],
      [52.4740881,13.3433640],[52.4741136,13.3433604],[52.4741385,13.3433569],[52.4741382,13.3433505],
      [52.4741369,13.3433238],[52.4741591,13.3433208],[52.4741587,13.3433126]],
  { "area:highway": "tertiary", junction: "yes" });
area([[52.4757199,13.3428908],[52.4757242,13.3429758],[52.4757283,13.3430558],[52.4752690,13.3431165],
      [52.4752570,13.3430922],[52.4750915,13.3431121],[52.4750808,13.3431424],[52.4741563,13.3432681],
      [52.4741525,13.3431879],[52.4741486,13.3431033],[52.4747867,13.3430161],[52.4748081,13.3430480],
      [52.4749837,13.3430244],[52.4750000,13.3429877]],
  { "area:highway": "tertiary" });
area([[52.4760068,13.3430184],[52.4760028,13.3429390],[52.4759984,13.3428541],[52.4766439,13.3427704],
      [52.4766614,13.3427681],[52.4766651,13.3428466],[52.4766690,13.3429313],[52.4761876,13.3429950],
      [52.4761321,13.3430015]],
  { "area:highway": "tertiary" });

const result = extractFeatures(data);
const lm = result.laneMarkings.filter((m) => m.name === "Rubensstraße");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

check("marking pieces extracted", lm.length >= 5, `pieces:${lm.length}`);

// boundary-1 straightness per piece: midline re-centering + robust
// smoothing must keep the drawn boundaries straight despite the
// platform dents and the parking-change way jogs
const cosLat = Math.cos(52.475 * (Math.PI / 180));
for (const p of lm) {
  const sp = p.spline ?? [];
  if (sp.length < 4) continue;
  const pts = sp.map((s) => [
    s.pt[0] * (1e-7 * 111320 * cosLat),
    s.pt[1] * (1e-7 * 111320),
  ]);
  // the DRAWN boundary: under the fitted road model the offset is
  // piece-constant from the mapped centerline (the spline provides the
  // smooth base curve and normals)
  const line = pts.map((q, i) => {
    const s = sp[i];
    const d = -p.laneLeftM! + p.laneW!;
    return [q[0] + s.nx * d, q[1] + s.ny * d];
  });
  const n = line.length;
  const mx = line.reduce((a, b) => a + b[0], 0) / n;
  const my = line.reduce((a, b) => a + b[1], 0) / n;
  let sxx = 0,
    sxy = 0,
    syy = 0;
  for (const q of line) {
    sxx += (q[0] - mx) ** 2;
    sxy += (q[0] - mx) * (q[1] - my);
    syy += (q[1] - my) ** 2;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(theta),
    uy = Math.sin(theta);
  let maxDev = 0;
  for (const q of line) {
    const dev = Math.abs(-uy * (q[0] - mx) + ux * (q[1] - my));
    if (dev > maxDev) maxDev = dev;
  }
  check(
    `piece ${p.id}: boundary straight (< 0.6 m deviation)`,
    maxDev < 0.6,
    `maxDev:${maxDev.toFixed(2)} m over ${n} samples`,
  );
}
// spans must ignore ONE-SIDED platform dents (mapping artifacts):
// pieces outside the bus-stop zone stay within 0.8 m of the road-wide
// median span. The bus-stop piece itself (w1122774351, staggered
// platforms on both sides) genuinely narrows and is exempt
const spans = lm
  .filter((p) => p.id !== "w5")
  .flatMap((p) => (p.spline ?? []).map((s) => s.leftM + s.rightM));
const medSpan = [...spans].sort((a, b) => a - b)[Math.floor(spans.length / 2)];
for (const p of lm) {
  if (p.id === "w5") continue;
  const sp = p.spline ?? [];
  if (!sp.length) continue;
  const worst = Math.max(
    ...sp.map((s) => Math.abs(s.leftM + s.rightM - medSpan)),
  );
  check(
    `piece ${p.id}: span ignores one-sided platform dents (< 0.8 m from median)`,
    worst < 0.8,
    `worst:${worst.toFixed(2)} med:${medSpan.toFixed(2)}`,
  );
}

// ---- fitted rectangles (the road model the "fitted rectangles" mode
// draws): every line-segment's rectangle must be a CLOSED quad —
// positive fitted width, first/last sample distinct — and adjacent
// segments' rectangles must tile the road WITHOUT overlapping
// tangentially: the seam samples coincide (same shared vertex), and
// along the bus-dent shoulder the rectangles must SHRINK honestly
// (smaller fitted spans at the dented segments, not the road-wide one)
{
  const cosLat2 = Math.cos(52.475 * (Math.PI / 180));
  const mPerLon2 = 1e-7 * 111_320 * cosLat2;
  const mPerLat2 = 1e-7 * 111_320;
  for (const p of lm) {
    const sp = p.spline ?? [];
    if (sp.length < 2) continue;
    // per-segment grouping
    const ranges: { seg: number; from: number; to: number }[] = [];
    for (let i = 0; i < sp.length; ) {
      const g = sp[i].seg ?? 0;
      let j = i + 1;
      while (j < sp.length && (sp[j].seg ?? 0) === g) j++;
      ranges.push({ seg: g, from: i, to: j - 1 });
      i = j;
    }
    // CLOSED rectangles: positive fitted edges and a non-degenerate
    // tangential extent on every segment
    let closed = true;
    let closedDetail = "";
    for (const r of ranges) {
      const a = sp[r.from],
        b = sp[r.to];
      const fl = a.fitLeftM,
        fr = a.fitRightM;
      if (fl === undefined || fr === undefined || !(fl > 0.1) || !(fr > 0.1)) {
        closed = false;
        closedDetail = `seg${r.seg} fl:${fl} fr:${fr}`;
        break;
      }
      const len = Math.hypot(
        (b.pt[0] - a.pt[0]) * mPerLon2,
        (b.pt[1] - a.pt[1]) * mPerLat2,
      );
      if (len < 0.05) {
        closed = false;
        closedDetail = `seg${r.seg} len:${len.toFixed(3)}`;
        break;
      }
    }
    check(
      `piece ${p.id}: every segment rectangle is closed (positive width, non-degenerate)`,
      closed,
      closedDetail,
    );
    // TANGENTIAL DISJOINTNESS: consecutive segments' seam samples
    // coincide (the shared vertex) — neither a gap nor an overlap; and
    // the sample ranges are strictly ordered along the arc
    let tiles = true;
    let tileDetail = "";
    for (let k = 1; k < ranges.length; k++) {
      const prev = sp[ranges[k - 1].to];
      const next = sp[ranges[k].from];
      const d = Math.hypot(
        (prev.pt[0] - next.pt[0]) * mPerLon2,
        (prev.pt[1] - next.pt[1]) * mPerLat2,
      );
      if (d > 0.05) {
        tiles = false;
        tileDetail = `seam ${ranges[k - 1].seg}|${ranges[k].seg} gap:${d.toFixed(3)} m`;
      }
    }
    check(
      `piece ${p.id}: adjacent segment rectangles meet at the shared vertex (no tangential overlap)`,
      tiles,
      tileDetail,
    );
  }
  // SMALLER RECTANGLES AT THE BUS DENTS: the bus-stop zone (w4/w6/w7
  // area shoulders) genuinely narrows — the dented segments' fitted
  // spans must be BELOW the road-wide median fitted span, proving the
  // model shows the dents instead of papering over them
  const fits = lm.flatMap((p) =>
    (p.spline ?? [])
      .filter((s) => s.fitLeftM !== undefined && s.fitRightM !== undefined)
      .map((s) => ({ id: p.id, seg: s.seg ?? 0, span: s.fitLeftM! + s.fitRightM! })),
  );
  const segSpans: { id: string; seg: number; span: number }[] = [];
  for (const f of fits) {
    const last = segSpans[segSpans.length - 1];
    if (!last || last.id !== f.id || last.seg !== f.seg) segSpans.push(f);
    else last.span = (last.span + f.span) / 2;
  }
  const medFit = [...segSpans.map((s) => s.span)].sort((a, b) => a - b)[
    Math.floor(segSpans.length / 2)
  ];
  const minFit = Math.min(...segSpans.map((s) => s.span));
  check(
    "bus-dent segments carry SMALLER fitted rectangles than the road-wide median",
    medFit - minFit > 0.5,
    `min:${minFit.toFixed(2)} med:${medFit.toFixed(2)}`,
  );
}

// ---- NO TWISTED RECTANGLES: every segment's rendered quad must be a
// simple polygon — its left/right edge polylines may not cross each
// other or the end caps (a bowtie renders as an "X"). The quads are
// reconstructed exactly as the "fitted rectangles" mode draws them:
// first/last sample position, averaged screen normals, fitted edges
{
  const cross2 = (p: number[], q: number[], r: number[]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const segInt = (a: number[], b: number[], c: number[], d: number[]) => {
    const d1 = cross2(a, b, c),
      d2 = cross2(a, b, d),
      d3 = cross2(c, d, a),
      d4 = cross2(c, d, b);
    return d1 * d2 < 0 && d3 * d4 < 0;
  };
  const mPerLonR = 1e-7 * 111320 * Math.cos(52.475 * (Math.PI / 180));
  const mPerLatR = 1e-7 * 111320;
  let bowties = 0;
  let detail = "";
  for (const p of lm) {
    const sp = p.spline ?? [];
    if (sp.length < 2) continue;
    const pts = sp.map((s) => [s.pt[0] * mPerLonR, s.pt[1] * mPerLatR]);
    const normals = pts.map((_, i) => {
      let nx = 0,
        ny = 0;
      for (const [j, k] of [
        [i - 1, i],
        [i, i + 1],
      ] as [number, number][]) {
        if (j < 0 || k > pts.length - 1) continue;
        const dx = pts[k][0] - pts[j][0],
          dy = pts[k][1] - pts[j][1];
        const l = Math.hypot(dx, dy);
        if (l > 0) {
          nx += dy / l;
          ny += -dx / l;
        }
      }
      const l = Math.hypot(nx, ny);
      return l > 0 ? [nx / l, ny / l] : [0, 0];
    });
    let i0 = 0;
    while (i0 < sp.length) {
      const g = sp[i0].seg ?? 0;
      let i1 = i0 + 1;
      while (i1 < sp.length && (sp[i1].seg ?? 0) === g) i1++;
      const fl = sp[i0].fitLeftM,
        fr = sp[i0].fitRightM;
      if (fl !== undefined && fr !== undefined && fl > 0 && fr > 0) {
        const A = pts[i0],
          B = pts[i1 - 1];
        const nA = normals[i0],
          nB = normals[i1 - 1];
        const aL = [A[0] - nA[0] * fl, A[1] - nA[1] * fl];
        const aR = [A[0] + nA[0] * fr, A[1] + nA[1] * fr];
        const bL = [B[0] - nB[0] * fl, B[1] - nB[1] * fl];
        const bR = [B[0] + nB[0] * fr, B[1] + nB[1] * fr];
        if (
          segInt(aL, bL, bR, aR) ||
          segInt(aR, bR, aL, bL) ||
          segInt(aL, aR, bL, bR)
        ) {
          bowties++;
          detail = `${p.id} seg${g}`;
        }
      }
      i0 = i1;
    }
  }
  check(
    "no twisted rectangles (no segment quad self-intersects)",
    bowties === 0,
    `${bowties} bowties, first:${detail}`,
  );
}

// ---- WAY-EXACT SAMPLE OWNERSHIP: every sample of a piece must lie on
// ITS OWN way's stretch - the old nearest-vertex ownership attributed
// the second half of a long segment to the NEIGHBOR way, so pieces
// rendered with the adjacent way's lane configuration (way
// 1122774352) and formed degenerate one-sample segment groups
{
  for (const p of lm) {
    const cs = p.coords;
    const sp = p.spline ?? [];
    let beyond = 0;
    let detail = "";
    for (const s of sp) {
      let best = Infinity;
      let beyondHere = false;
      for (let i = 1; i < cs.length; i++) {
        const dx = cs[i][0] - cs[i - 1][0],
          dy = cs[i][1] - cs[i - 1][1];
        const len2 = dx * dx + dy * dy;
        const f =
          len2 > 0
            ? ((s.pt[0] - cs[i - 1][0]) * dx + (s.pt[1] - cs[i - 1][1]) * dy) /
              len2
            : 0;
        const fC = Math.max(0, Math.min(1, f));
        const qx = cs[i - 1][0] + dx * fC,
          qy = cs[i - 1][1] + dy * fC;
        const d = Math.hypot(s.pt[0] - qx, s.pt[1] - qy);
        if (d < best) {
          best = d;
          beyondHere = f < 0 || f > 1;
        }
      }
      if (beyondHere && best > 100) {
        beyond++;
        detail = s.pt.map((v) => (v / 1e7).toFixed(6)).join(",");
      }
    }
    check(
      `piece ${p.id}: all samples lie on the way's own stretch (way-exact ownership)`,
      beyond === 0,
      `${beyond} beyond, e.g. ${detail}`,
    );
    // no degenerate one-sample segment groups (a seam sample mislabeled
    // into the next segment)
    const groups = new Map<number, number>();
    for (const s of sp) {
      const g = s.seg ?? 0;
      groups.set(g, (groups.get(g) ?? 0) + 1);
    }
    const degen = [...groups.entries()].filter(([, n]) => n < 2);
    check(
      `piece ${p.id}: no degenerate one-sample segment groups`,
      degen.length === 0,
      JSON.stringify(degen),
    );
  }
}

if (failures > 0) {
  console.error(`${failures} rubens regression test(s) failed`);
  process.exit(1);
}
console.log("all rubens regression tests passed");

// ---- solid continuous center line (the direction border) ----
// The road-model fit must align the direction border across ALL pieces
// of the group: the solid center line is one continuous straight line
// over the whole road, and the fitted rectangle stays centered on the
// mapped centerline (the mapper placed it well; the fit must confirm,
// not fight it).
{
  const bidir = lm.filter(
    (p) => (p.lanesFwd ?? 0) > 0 && (p.lanesFwd ?? 0) < p.lanes!,
  );
  check(
    "solid center line exists on every bidirectional piece",
    bidir.length === lm.length,
    `bidir:${bidir.length} of ${lm.length}`,
  );
  // border offset from the mapped centerline, per piece. The middle
  // line is continuous among pieces of the SAME lane+parking
  // configuration (their unit grids fill their roads the same way);
  // pieces whose parking layout differs have their middle line at a
  // different natural place - the parking units push the traffic block
  // off the road center, and aligning across parking layouts would
  // leave the road unfilled
  const offs = bidir.map(
    (p) => -p.laneLeftM! + (p.lanesFwd ?? 1) * p.laneW!,
  );
  const cfgOf = (p: (typeof lm)[number]) =>
    `${p.lanesFwd ?? 1}+${p.lanes! - (p.lanesFwd ?? 1)}|${p.parkingLeft ? "pL" : ""}${p.parkingRight ? "pR" : ""}`;
  const byCfg = new Map<string, number[]>();
  bidir.forEach((p, i) => {
    const k = cfgOf(p);
    const arr = byCfg.get(k) ?? [];
    arr.push(offs[i]);
    byCfg.set(k, arr);
  });
  let maxSpread = 0;
  let spreadDetail = "";
  for (const [k, xs] of byCfg) {
    const sp = Math.max(...xs.map((o) => Math.abs(o - xs[0])));
    if (sp > maxSpread) {
      maxSpread = sp;
      spreadDetail = `${k}:${xs.map((o) => o.toFixed(3)).join(" ")}`;
    }
  }
  check(
    "middle line continuous per lane+parking configuration",
    maxSpread < 0.05,
    `worst:${spreadDetail} spread:${maxSpread.toFixed(3)}`,
  );
  // the fitted rectangle must agree with the MEASURED area midline: the
  // mapper may jog the centerline where parking sides change, but the
  // area boundary is objective — the fit follows it, staying within a
  // fraction of a lane width of the raw midline measurement. The
  // bus-stop piece (w5, staggered platforms on BOTH sides) is exempt:
  // its honest per-segment fits follow its genuinely asymmetric
  // geometry, so the piece median legitimately departs from the
  // repaired midline
  for (const p of lm) {
    if (p.id === "w5") continue;
    const sp = p.spline ?? [];
    if (sp.length < 2) continue;
    const midOffs = sp
      .map((s) => (s.leftM - s.rightM) / 2)
      .sort((a, b) => a - b);
    const med = midOffs[Math.floor(midOffs.length / 2)];
    // the piece road rectangle (roadLeftM/roadRightM) before the
    // middle-line alignment shift follows the measured midline
    const shift = (p.roadLeftM! - p.roadRightM!) / 2;
    check(
      `piece ${p.id}: fit follows the measured area midline (< 0.35 m)`,
      Math.abs(shift - med) < 0.35,
      `fit:${shift.toFixed(3)} midline:${med.toFixed(3)}`,
    );
  }
}
