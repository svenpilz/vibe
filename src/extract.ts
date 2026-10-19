/**
 * Extracts micromapping features from parsed OSM data into the feature
 * arrays consumed by the renderer. Runs in the browser (web worker) or Node.
 *
 *   areas      : area:highway polygons (closed ways + multipolygon relations,
 *                with holes). Surface from the area itself; if absent,
 *                inherited from a highway centerline that intersects it.
 *                Traffic islands default to sett.
 *   centerlines: highway ways with surface=* / width=* (surface detail).
 *                Suppressed when a corresponding area (same highway type,
 *                same layer) already covers them.
 *   footways   : highway=footway / footway=sidewalk lines (surface, width).
 *   crossings  : footway=crossing (crossing=*, crossing:markings=*, width).
 *   kerbs      : barrier=kerb nodes AND ways with kerb=* details.
 *
 * All features carry their OSM layer=* value; the result exposes the list of
 * layer values present so the UI can offer layer selection.
 */
import type { OSMData, OSMTags, OSMWay } from "./osm-pbf";
import type {
  Q,
  StopLineFeature,
  AreaFeature,
  BuildingFeature,
  GrassFeature,
  LineFeature,
  KerbFeature,
  KerbWayFeature,
  BollardFeature,
  FenceFeature,
  LanduseFeature,
  StreetLampFeature,
  ParkingFeature,
  ManholeFeature,
} from "./features";

export interface ExtractResult {
  areas: AreaFeature[];
  buildings: BuildingFeature[];
  grass: GrassFeature[];
  centerlines: LineFeature[];
  footways: LineFeature[];
  crossings: LineFeature[];
  kerbs: KerbFeature[];
  kerbWays: KerbWayFeature[];
  bollards: BollardFeature[];
  fences: FenceFeature[];
  landuse: LanduseFeature[];
  streetLamps: StreetLampFeature[];
  parking: ParkingFeature[];
  manholes: ManholeFeature[];
  laneMarkings: LineFeature[];
  stopLines: StopLineFeature[];
  /** all layer values present in the data, sorted ascending */
  layers: number[];
  /** all level values present in the data, sorted ascending */
  levels: number[];
  /** bbox of all extracted features: [minLonQ, minLatQ, maxLonQ, maxLatQ] */
  bounds: [number, number, number, number];
}

function bboxOfQ(coords: number[][]): [number, number, number, number] {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** distance along direction d from pt until leaving the area, or null if never */
function pointInRingQ(pt: number[], ring: number[][]): boolean {
  let inside = false;
  const x = pt[0],
    y = pt[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1];
    const xj = ring[j][0],
      yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInAreaQ(pt: number[], area: AreaFeature): boolean {
  let inOuter = false;
  for (const ring of area.outer) {
    if (pointInRingQ(pt, ring)) {
      inOuter = true;
      break;
    }
  }
  if (!inOuter) return false;
  for (const hole of area.holes) {
    if (pointInRingQ(pt, hole)) return false;
  }
  return true;
}

/**
 * Robust lateral cross-section: walk outward from the sample along BOTH
 * normals until the first exit from the area (coarse metric steps, then
 * binary refinement). Returns [leftM, rightM], the distances in meters to
 * the area boundary on each side of the sample. Unlike a plain ray cast,
 * the bounded metric step cannot jump over narrow boundary features, and
 * starting at the sample itself detects a sample sitting outside the area.
 */
function lateralIntervalInArea(
  pt: number[],
  nx: number,
  ny: number,
  mPerLon: number,
  mPerLat: number,
  area: AreaFeature,
  maxM: number,
): [number, number] | null {
  if (!pointInAreaQ(pt, area)) return null;
  const inside = (m: number): boolean =>
    pointInAreaQ(
      [pt[0] + (nx * m) / mPerLon, pt[1] + (ny * m) / mPerLat],
      area,
    );
  const edge = (dir: number): number => {
    const STEP = 2;
    let prev = 0;
    for (let m = STEP; m <= maxM; m += STEP) {
      if (!inside(dir * m)) {
        let lo = prev,
          hi = m;
        for (let k = 0; k < 20; k++) {
          const mid = (lo + hi) / 2;
          if (inside(dir * mid)) lo = mid;
          else hi = mid;
        }
        return dir * ((lo + hi) / 2);
      }
      prev = m;
    }
    return dir * maxM;
  };
  const left = edge(1);
  const right = edge(-1);
  return [left, -right];
}

/**
 * Fit the extruded road model to the measured cross-sections of one
 * (way, area) piece. The model is a rectangle of `units` evenly sized
 * strips (traffic lanes + parking units), centered on the mapped
 * centerline and shifted `s` meters to its left. At sample i the block
 * covers the lateral interval [s - U*w/2, s + U*w/2] (meters-left
 * convention); the road occupies [-rightM_i, leftM_i]. The fit maximizes
 * covered length minus the length spilling outside the highway area,
 * summed over the samples: the largest rectangle that actually fits the
 * geometry, tolerating minority dents (bus platforms, cutouts) that
 * would shrink an exact fit.
 */
function fitRoadRectangle(
  samples: { leftM: number; rightM: number }[],
  units: number,
): { w: number; s: number } {
  const ivs: [number, number][] = samples.map((s) => [-s.rightM, s.leftM]);
  const overlap = (i: number, lo: number, hi: number): number =>
    Math.max(0, Math.min(hi, ivs[i][1]) - Math.max(lo, ivs[i][0]));
  // the optimal block sits flush against cross-section edges: the
  // coverage function is piecewise linear in s with breakpoints exactly
  // where a block edge meets an interval edge — evaluating those
  // candidates is exact, no ternary assumptions. When the block is
  // NARROWER than the road along the whole piece (fewer units than the
  // area has room for — e.g. a 2-lane way crossing a wide area), a whole
  // PLATEAU of shifts achieves full coverage and the objective alone is
  // underdetermined: among equally-optimal shifts, the one closest to
  // the measured area midline wins — the rectangle centers itself in
  // the road instead of clinging to an arbitrary plateau edge
  const midPref = (() => {
    const offs = samples.map((x) => (x.leftM - x.rightM) / 2).sort((a, b) => a - b);
    return offs[Math.floor(offs.length / 2)];
  })();
  // TRIMMED objective: the plain sum lets a minority of samples
  // dominate — junction-mouth widenings pull the rectangle sideways and
  // inflate its width, platform dents shrink it. Dropping the top and
  // bottom per-sample coverages makes the MAJORITY cross-section decide,
  // which is the robust reading of an inconsistent OSM area
  const trim = Math.max(0, Math.floor(ivs.length * 0.15));
  const scoreOf = (per: number[]): number => {
    const s = [...per].sort((a, b) => a - b);
    let sum = 0;
    for (let i = trim; i < s.length - trim; i++) sum += s[i];
    return sum;
  };
  const bestShift = (w: number): { s: number; v: number } => {
    const h = (units * w) / 2;
    const cands: number[] = [0];
    for (const [lo, hi] of ivs) {
      cands.push(lo + h, hi - h, (lo + hi) / 2);
    }
    let best = { s: 0, v: -Infinity };
    for (const s of cands) {
      const per = ivs.map((_, i) => overlap(i, s - h, s + h));
      const v = 2 * scoreOf(per) - units * w * (ivs.length - 2 * trim);
      if (v > best.v + 1e-6) best = { s, v };
      else if (v > best.v - 1e-6 && Math.abs(s - midPref) < Math.abs(best.s - midPref))
        best = { s, v: Math.max(best.v, v) };
    }
    return best;
  };
  const cand = [
    ...new Set(samples.map((x) => (x.leftM + x.rightM) / units)),
  ].sort((a, b) => a - b);
  const wLo = Math.max(0.5, cand[0] * 0.5);
  const wHi = cand[cand.length - 1] * 1.5;
  let best = { ...bestShift(cand[0]), w: cand[0] };
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const w = wLo + ((wHi - wLo) * i) / N;
    const r = bestShift(w);
    if (r.v > best.v) best = { ...r, w };
  }
  for (const w of cand) {
    const r = bestShift(w);
    if (r.v > best.v) best = { ...r, w };
  }
  return { w: best.w, s: best.s };
}

/** squared distance from pt to segment a-b in quantized units */
function distToSegQ2(px: number, py: number, a: number[], b: number[]): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - a[0]) * dx + (py - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx,
    y = a[1] + t * dy;
  return (px - x) ** 2 + (py - y) ** 2;
}

/**
 * Containment with tolerance: true when the point is inside the area or
 * within tolQ of its boundary. Ways mapped along an area's edge share
 * nodes with the area ring; their vertices lie exactly on the boundary,
 * where the strict test is ambiguous.
 */
function segIntersect(
  p1: number[],
  p2: number[],
  p3: number[],
  p4: number[],
): number[] | null {
  const d1x = p2[0] - p1[0],
    d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0],
    d2y = p4[1] - p3[1];
  const denom = d1x * d2y - d1y * d2x;
  if (denom === 0) return null;
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [p1[0] + t * d1x, p1[1] + t * d1y];
}

/**
 * The shared boundary between the entering road area and the junction
 * area, as SEPARATE polylines (chains) - one per place where the two
 * polygons meet: the parts of the JUNCTION ring that lie inside (or on)
 * the road polygon, with ring edges cut at the road boundary where they
 * enter/leave. Handles partially overlapping polygons (a wider junction
 * meeting a narrower road: the boundary follows the road's edge inside
 * the junction). Callers drawing a stop line MUST pick the chain that
 * contains the traffic_signals node itself - never the flattened set,
 * which would run through the far end of the road too.
 */
function sharedBoundaryQ(
  road: AreaFeature,
  junction: AreaFeature,
  tolQ: number,
): number[][][] {
  const out: number[][][] = [];
  for (const jRing of junction.outer) {
    const inside = jRing.map(
      (pt) => pointOnAreaBoundaryQ(pt, road, tolQ) || pointInAreaQ(pt, road),
    );
    let chain: number[][] = [];
    const flush = () => {
      if (chain.length >= 2) out.push(chain);
      chain = [];
    };
    for (let i = 0; i < jRing.length; i++) {
      const j = (i + 1) % jRing.length;
      const a = jRing[i],
        b = jRing[j];
      if (inside[i] && inside[j]) {
        if (chain.length === 0) chain.push(a);
        chain.push(b);
        continue;
      }
      // edge crosses the road boundary: cut at every road-ring
      // intersection, keep the sub-segments whose midpoint is in the road
      const cuts: { t: number; pt: number[] }[] = [];
      for (const rRing of road.outer) {
        for (let k = 1; k < rRing.length; k++) {
          const ip = segIntersect(a, b, rRing[k - 1], rRing[k]);
          if (ip) {
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const t =
              len === 0 ? 0 : Math.hypot(ip[0] - a[0], ip[1] - a[1]) / len;
            cuts.push({ t, pt: ip });
          }
        }
      }
      cuts.sort((c1, c2) => c1.t - c2.t);
      const pts = [a, ...cuts.map((c) => c.pt), b];
      for (let q = 1; q < pts.length; q++) {
        const mid = [
          (pts[q - 1][0] + pts[q][0]) / 2,
          (pts[q - 1][1] + pts[q][1]) / 2,
        ];
        const midInside =
          pointInAreaQ(mid, road) || pointOnAreaBoundaryQ(mid, road, tolQ);
        if (midInside) {
          if (chain.length === 0) chain.push(pts[q - 1]);
          chain.push(pts[q]);
        } else {
          flush();
        }
      }
    }
    flush();
  }
  return out;
}

function pointOnAreaBoundaryQ(
  pt: number[],
  area: AreaFeature,
  tolQ: number,
): boolean {
  const tol2 = tolQ * tolQ;
  const onRing = (ring: number[][]): boolean => {
    for (let i = 1; i < ring.length; i++) {
      if (distToSegQ2(pt[0], pt[1], ring[i - 1], ring[i]) <= tol2) return true;
    }
    return false;
  };
  for (const ring of area.outer) {
    if (onRing(ring)) return true;
  }
  return false;
}

/**
 * Whether a centerline corresponds to an area: either some vertex lies
 * strictly inside, or at least two vertices lie on the boundary (the way
 * runs along the area's edge). A single boundary vertex with nothing
 * inside is a corner clip, not correspondence — and a boundary vertex is
 * not "inside" for the adjacent area either.
 */
function pointInAreaTolQ2(pt: number[], area: AreaFeature): boolean {
  return pointInAreaQ(pt, area) || pointOnAreaBoundaryQ(pt, area, 10);
}

function centerlineInAreaTolQ(
  cl: LineFeature,
  area: AreaFeature,
  tolQ: number,
): boolean {
  let inside = 0;
  let onBoundary = 0;
  for (const pt of cl.coords) {
    // boundary first: a vertex exactly on the ring must never count as
    // inside (the strict test is ambiguous there) — also for the adjacent
    // area, which shares this boundary
    if (pointOnAreaBoundaryQ(pt, area, tolQ)) {
      onBoundary++;
      continue;
    }
    if (pointInAreaQ(pt, area)) inside++;
    // a vertex strictly outside disqualifies the donor: the way must lie
    // ENTIRELY inside — a long road merely ENDING on the area boundary
    // (its last vertices shared with the polygon) must not donate its
    // surface to the junction it runs into
    else return false;
  }
  return inside > 0 || onBoundary >= 2;
}

function bboxOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Whether an on-carriageway parking lane consumes road width. Two tagging
 * schemes: the old parking:lane:left/right/both (any value except no/none)
 * and the newer parking:left/right/both, where only the value "lane" marks
 * parking on the carriageway (street_side/on_kerb/shoulder are off-road).
 */
function hasParkingLane(kind: string | undefined): boolean {
  if (kind === undefined) return false;
  const k = kind.split(";")[0];
  return k !== "no" && k !== "none";
}

function parkingOnCarriageway(side: string, tags: OSMTags): boolean {
  // old scheme: parking:lane:left/right/both
  if (hasParkingLane(tags[`parking:lane:${side}`])) return true;
  // new scheme: parking:left/right/both = lane means on the carriageway
  const p = tags[`parking:${side}`];
  return p === "lane";
}

/** residential building classes (light orange fill); everything else is "other" */
function buildingUsage(tags: OSMTags): "residential" | "other" {
  const b = tags["building"];
  if (
    b === "residential" ||
    b === "house" ||
    b === "apartments" ||
    b === "detached" ||
    b === "terrace" ||
    b === "semi" ||
    b === "semidetached_house" ||
    b === "bungalow"
  )
    return "residential";
  return "other";
}

function parseLanes(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n <= 16 ? n : undefined;
}

function parseLevel(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseLayer(v: string | undefined): number {
  if (v === undefined) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(-16, Math.min(16, n)) : 0;
}

/**
 * A centerline may only donate its surface to an area of the same highway
 * type. Exception: highway=footway centerlines also cover sidewalk areas,
 * which are the same physical feature mapped with a different type tag.
 */
function highwayTypesCompatible(
  clHighway: string | undefined,
  areaHighway: string,
): boolean {
  if (!clHighway) return false;
  if (clHighway === areaHighway) return true;
  if (clHighway === "footway" && areaHighway === "sidewalk") return true;
  if (clHighway === "sidewalk" && areaHighway === "footway") return true;
  return false;
}

const CENTERLINE_HIGHWAYS = new Set([
  "footway",
  "pedestrian",
  "service",
  "living_street",
  "residential",
  "unclassified",
  "cycleway",
  "path",
  "steps",
  "track",
  "road",
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
]);

export function extractFeatures(
  data: OSMData,
  onProgress?: (pct: number, msg: string) => void,
): ExtractResult {
  const areas: AreaFeature[] = [];
  const buildings: BuildingFeature[] = [];
  const grass: GrassFeature[] = [];
  const centerlines: LineFeature[] = [];
  const footways: LineFeature[] = [];
  const crossings: LineFeature[] = [];
  const kerbWays: KerbWayFeature[] = [];
  const kerbs: KerbFeature[] = [];
  const bollards: BollardFeature[] = [];
  const fences: FenceFeature[] = [];
  const landuse: LanduseFeature[] = [];
  const streetLamps: StreetLampFeature[] = [];
  const parking: ParkingFeature[] = [];
  // amenity=parking + parking=lane polygons on a road's carriageway:
  // a parking lane of that road, not a separate parking ground
  const parkingLanesOnCarriageway: {
    id: string;
    layer: number;
    outer: Q[][][];
    holes: Q[][][];
    bbox: [number, number, number, number];
  }[] = [];
  const manholes: ManholeFeature[] = [];

  const wayCoords = (way: OSMWay): [number, number][] | null => {
    const coords: [number, number][] = [];
    for (const ref of way.refs) {
      const c = data.nodeCoords.get(ref);
      if (!c) return null;
      coords.push([c.lon, c.lat]);
    }
    return coords;
  };

  const q = (coords: [number, number][]): number[][] => {
    const out: number[][] = new Array(coords.length);
    for (let i = 0; i < coords.length; i++) {
      out[i] = [Math.round(coords[i][0] * 1e7), Math.round(coords[i][1] * 1e7)];
    }
    return out;
  };

  const isClosed = (way: OSMWay): boolean =>
    way.refs.length > 3 && way.refs[0] === way.refs[way.refs.length - 1];

  onProgress?.(0, "classifying ways…");
  for (const way of data.ways.values()) {
    const tags = way.tags;
    const areaHighway = tags["area:highway"];
    const highway = tags["highway"];

    if (tags["amenity"] === "parking" && isClosed(way)) {
      const coords = wayCoords(way);
      // parking=lane ON the carriageway, drawn inside the same highway
      // area (e.g. way 1442125974 on the Rheinstraße/Hauptstraße
      // carriageway): a parking LANE of the road, not a separate parking
      // ground — recorded for the lane marking pass below
      if (tags["parking"] === "lane") {
        const qc2 = q(coords!);
        parkingLanesOnCarriageway.push({
          id: `w${way.id}`,
          layer: parseLayer(tags["layer"]),
          outer: [qc2],
          holes: [],
          bbox: bboxOfQ(qc2),
        });
        continue;
      }
      if (coords) {
        const qc = q(coords);
        parking.push({
          type: "parking",
          id: `w${way.id}`,
          surface: tags["surface"],
          surfaceColour: tags["surface:colour"],
          layer: parseLayer(tags["layer"]),
          level: parseLevel(tags["level"]),
          outer: [qc],
          holes: [],
          bbox: bboxOfQ(qc),
        });
      }
      continue;
    }

    const landuseKind =
      tags["landuse"] === "residential"
        ? "residential"
        : tags["landuse"] === "commercial" || tags["landuse"] === "retail"
          ? "commercial"
          : undefined;
    if (landuseKind && isClosed(way)) {
      const coords = wayCoords(way);
      if (coords) {
        const qc = q(coords);
        landuse.push({
          type: "landuse",
          id: `w${way.id}`,
          kind: landuseKind,
          layer: parseLayer(tags["layer"]),
          level: parseLevel(tags["level"]),
          outer: [qc],
          holes: [],
          bbox: bboxOfQ(qc),
        });
      }
      continue;
    }

    if (tags["building"] !== undefined && isClosed(way)) {
      const coords = wayCoords(way);
      if (coords) {
        const qc = q(coords);
        buildings.push({
          type: "building",
          id: `w${way.id}`,
          building: tags["building"] || "yes",
          usage: buildingUsage(tags),
          name: tags["name"],
          layer: parseLayer(tags["layer"]),
          level: parseLevel(tags["level"]),
          outer: [qc],
          bbox: bboxOfQ(qc),
        });
      }
      if (!areaHighway) continue;
    }

    if (areaHighway && isClosed(way)) {
      const coords = wayCoords(way);
      if (!coords) continue;
      const qc = q(coords);
      areas.push({
        type: "area",
        id: `w${way.id}`,
        highway: areaHighway,
        surface:
          tags["surface"] ??
          (areaHighway === "traffic_island" ? "sett" : undefined),
        surfaceColour: tags["surface:colour"] ?? tags["colour"],
        name: tags["name"],
        wheelchair: tags["wheelchair"],
        lit: tags["lit"],
        junction: areaHighway === "junction" || tags["junction"] !== undefined,
        layer: parseLayer(tags["layer"]),
        level: parseLevel(tags["level"]),
        outer: [qc],
        holes: [],
        bbox: bboxOfQ(qc),
      });
      continue;
    }

    const greenKind =
      tags["landuse"] === "grass"
        ? "grass"
        : tags["natural"] === "scrub"
          ? "scrub"
          : tags["leisure"] === "garden"
            ? "garden"
            : undefined;
    if (greenKind && isClosed(way)) {
      const coords = wayCoords(way);
      if (coords) {
        const qc = q(coords);
        grass.push({
          type: "grass",
          id: `w${way.id}`,
          kind: greenKind,
          layer: parseLayer(tags["layer"]),
          level: parseLevel(tags["level"]),
          outer: [qc],
          holes: [],
          bbox: bboxOfQ(qc),
        });
      }
      continue;
    }

    if (tags["barrier"] === "fence") {
      const coords = wayCoords(way);
      if (coords) {
        const qc = q(coords);
        fences.push({
          type: "fence",
          id: `w${way.id}`,
          fence: tags["fence_type"],
          layer: parseLayer(tags["layer"]),
          level: parseLevel(tags["level"]),
          coords: qc,
          bbox: bboxOfQ(qc),
        });
      }
      continue;
    }

    const isKerbWay = tags["barrier"] === "kerb" || tags["kerb"] !== undefined;
    if (isKerbWay) {
      const coords = wayCoords(way);
      if (!coords) continue;
      const qc = q(coords);
      // kerb nodes on this way locally override the kerb type
      const overrides: { idx: number; kerb: string }[] = [];
      for (let ri = 0; ri < way.refs.length; ri++) {
        const nt = data.nodeTags.get(way.refs[ri]);
        if (nt && (nt["kerb"] !== undefined || nt["barrier"] === "kerb")) {
          overrides.push({ idx: ri, kerb: nt["kerb"] ?? nt["barrier"] });
        }
      }
      kerbWays.push({
        type: "kerbway",
        id: `w${way.id}`,
        kerb: tags["kerb"] ?? tags["barrier"],
        tactilePaving: tags["tactile_paving"],
        overrides: overrides.length > 0 ? overrides : undefined,
        layer: parseLayer(tags["layer"]),
        level: parseLevel(tags["level"]),
        coords: qc,
        bbox: bboxOfQ(qc),
      });
      continue;
    }

    if (highway) {
      const coords = wayCoords(way);
      if (!coords) continue;
      const footway = tags["footway"];
      const isCrossing =
        footway === "crossing" || tags["crossing"] !== undefined;
      const widthNum = tags["width"] ? parseFloat(tags["width"]) : undefined;

      if (isCrossing) {
        const qc = q(coords);
        crossings.push({
          type: "crossing",
          id: `w${way.id}`,
          highway,
          footway,
          crossing: tags["crossing"],
          crossingMarkings:
            tags["crossing:markings"] ??
            (tags["crossing"] === "zebra" ? "zebra" : undefined),
          surface: tags["surface"],
          surfaceColour: tags["surface:colour"],
          width: Number.isFinite(widthNum as number) ? widthNum : undefined,
          lit: tags["lit"],
          name: tags["name"],
          layer: parseLayer(tags["layer"]),
          level: parseLevel(tags["level"]),
          coords: qc,
          bbox: bboxOfQ(qc),
        });
      } else if (highway === "footway" || footway === "sidewalk") {
        const qc = q(coords);
        footways.push({
          type: "footway",
          id: `w${way.id}`,
          highway,
          footway,
          surface: tags["surface"],
          surfaceColour: tags["surface:colour"],
          width: Number.isFinite(widthNum as number) ? widthNum : undefined,
          lit: tags["lit"],
          name: tags["name"],
          layer: parseLayer(tags["layer"]),
          level: parseLevel(tags["level"]),
          coords: qc,
          bbox: bboxOfQ(qc),
        });
      } else if (
        CENTERLINE_HIGHWAYS.has(highway) &&
        !isClosed(way) &&
        (tags["surface"] !== undefined ||
          widthNum !== undefined ||
          parseLanes(tags["lanes"]) !== undefined)
      ) {
        const qc = q(coords);
        centerlines.push({
          type: "centerline",
          id: `w${way.id}`,
          highway,
          surface: tags["surface"],
          surfaceColour: tags["surface:colour"],
          width: Number.isFinite(widthNum as number) ? widthNum : undefined,
          lanes: parseLanes(tags["lanes"]),
          // lane_markings=no: the road has lanes but no painted markings
          noLaneMarkings: tags["lane_markings"] === "no",
          parkingLeft:
            parkingOnCarriageway("left", tags) ||
            parkingOnCarriageway("both", tags),
          parkingRight:
            parkingOnCarriageway("right", tags) ||
            parkingOnCarriageway("both", tags),
          oneway:
            tags["oneway"] === "yes" ||
            tags["oneway"] === "-1" ||
            tags["junction"] === "roundabout" ||
            tags["junction"] === "circular",
          lanesFwd:
            parseLanes(tags["lanes:forward"]) ??
            (parseLanes(tags["lanes:backward"]) !== undefined
              ? (parseLanes(tags["lanes"]) ??
                  2 * parseLanes(tags["lanes:backward"])!) -
                parseLanes(tags["lanes:backward"])!
              : undefined),
          lit: tags["lit"],
          name: tags["name"],
          layer: parseLayer(tags["layer"]),
          level: parseLevel(tags["level"]),
          coords: qc,
          bbox: bboxOfQ(qc),
        });
      }
    }
  }

  onProgress?.(30, "assembling multipolygons…");
  for (const rel of data.relations) {
    const tags = rel.tags;
    const areaHighway = tags["area:highway"];
    const buildingTag = tags["building"];
    if (tags["amenity"] === "parking" && tags["type"] === "multipolygon") {
      const parkingTags = tags;
      const outerRingsP: number[][][] = [];
      const holeRingsP: number[][][] = [];
      for (const m of rel.members) {
        if (
          m.type !== "way" ||
          (m.role !== "outer" && m.role !== "inner" && m.role !== "")
        )
          continue;
        const way = data.ways.get(m.ref);
        if (!way || !isClosed(way)) continue;
        const coords = wayCoords(way);
        if (!coords) continue;
        const qc = q(coords);
        if (m.role === "inner") holeRingsP.push(qc);
        else outerRingsP.push(qc);
      }
      if (outerRingsP.length > 0) {
        const allP: number[][] = [];
        for (const r of outerRingsP) allP.push(...r);
        for (const r of holeRingsP) allP.push(...r);
        parking.push({
          type: "parking",
          id: `r${rel.id}`,
          surface: parkingTags["surface"],
          surfaceColour: parkingTags["surface:colour"],
          layer: parseLayer(parkingTags["layer"]),
          level: parseLevel(parkingTags["level"]),
          outer: outerRingsP,
          holes: holeRingsP,
          bbox: bboxOfQ(allP),
        });
        continue;
      }
    }

    const grassTag =
      tags["landuse"] === "grass" ||
      tags["natural"] === "scrub" ||
      tags["leisure"] === "garden";
    const greenKind =
      tags["landuse"] === "grass"
        ? "grass"
        : tags["natural"] === "scrub"
          ? "scrub"
          : tags["leisure"] === "garden"
            ? "garden"
            : "grass";
    if (
      (!areaHighway && !buildingTag && !grassTag) ||
      tags["type"] !== "multipolygon"
    )
      continue;

    const outerRings: number[][][] = [];
    const holeRings: number[][][] = [];

    for (const m of rel.members) {
      if (
        m.type !== "way" ||
        (m.role !== "outer" && m.role !== "inner" && m.role !== "")
      )
        continue;
      const way = data.ways.get(m.ref);
      if (!way || !isClosed(way)) continue;
      const coords = wayCoords(way);
      if (!coords) continue;
      const qc = q(coords);
      if (m.role === "inner") holeRings.push(qc);
      else outerRings.push(qc);
    }
    if (outerRings.length === 0) continue;

    const all: number[][] = [];
    for (const r of outerRings) all.push(...r);
    for (const r of holeRings) all.push(...r);
    if (!areaHighway && grassTag) {
      grass.push({
        type: "grass",
        id: `r${rel.id}`,
        kind: greenKind,
        layer: parseLayer(tags["layer"]),
        level: parseLevel(tags["level"]),
        outer: outerRings,
        holes: holeRings,
        bbox: bboxOfQ(all),
      });
      continue;
    }
    if (!areaHighway) {
      buildings.push({
        type: "building",
        id: `r${rel.id}`,
        building: buildingTag || "yes",
        usage: buildingUsage(tags),
        name: tags["name"],
        layer: parseLayer(tags["layer"]),
        level: parseLevel(tags["level"]),
        outer: outerRings,
        bbox: bboxOfQ(all),
      });
      continue;
    }
    areas.push({
      type: "area",
      id: `r${rel.id}`,
      highway: areaHighway,
      surface:
        tags["surface"] ??
        (areaHighway === "traffic_island" ? "sett" : undefined),
      surfaceColour: tags["surface:colour"] ?? tags["colour"],
      name: tags["name"],
      wheelchair: tags["wheelchair"],
      lit: tags["lit"],
      junction: areaHighway === "junction" || tags["junction"] !== undefined,
      layer: parseLayer(tags["layer"]),
      level: parseLevel(tags["level"]),
      outer: outerRings,
      holes: holeRings,
      bbox: bboxOfQ(all),
    });
  }

  onProgress?.(50, "collecting kerbs…");

  // node -> ways membership (needed to inherit layers for unlayered points).
  // A node's candidate layer is the layer of its parent way(s); NaN marks a
  // conflict (parent ways on different layers).
  const nodeWayLayer = new Map<number, number>();
  for (const way of data.ways.values()) {
    const wl = parseLayer(way.tags["layer"]);
    for (const ref of way.refs) {
      const prev = nodeWayLayer.get(ref);
      nodeWayLayer.set(
        ref,
        prev === undefined || prev === wl ? wl : Number.NaN,
      );
    }
  }

  for (const [id, tags] of data.nodeTags) {
    if (tags["man_made"] === "manhole") {
      const c = data.nodeCoords.get(id);
      if (!c) continue;
      manholes.push({
        type: "manhole",
        id: `n${id}`,
        layer: parseLayer(tags["layer"]),
        level: parseLevel(tags["level"]),
        lat: Math.round(c.lat * 1e7),
        lon: Math.round(c.lon * 1e7),
      });
      continue;
    }
    if (tags["highway"] === "street_lamp") {
      const c = data.nodeCoords.get(id);
      if (!c) continue;
      streetLamps.push({
        type: "streetlamp",
        id: `n${id}`,
        layer: parseLayer(tags["layer"]),
        level: parseLevel(tags["level"]),
        lat: Math.round(c.lat * 1e7),
        lon: Math.round(c.lon * 1e7),
      });
      continue;
    }
    if (tags["barrier"] === "bollard") {
      const c = data.nodeCoords.get(id);
      if (!c) continue;
      bollards.push({
        type: "bollard",
        id: `n${id}`,
        layer: parseLayer(tags["layer"]),
        level: parseLevel(tags["level"]),
        lat: Math.round(c.lat * 1e7),
        lon: Math.round(c.lon * 1e7),
      });
      continue;
    }
    if (tags["barrier"] === "kerb" || tags["kerb"] !== undefined) {
      const c = data.nodeCoords.get(id);
      if (!c) continue;
      let layer = parseLayer(tags["layer"]);
      if (tags["layer"] === undefined) {
        const inherited = nodeWayLayer.get(id);
        if (inherited !== undefined && Number.isFinite(inherited))
          layer = inherited;
      }
      kerbs.push({
        type: "kerb",
        id: `n${id}`,
        kerb: tags["kerb"] ?? tags["barrier"],
        tactilePaving: tags["tactile_paving"],
        layer,
        level: parseLevel(tags["level"]),
        lat: Math.round(c.lat * 1e7),
        lon: Math.round(c.lon * 1e7),
      });
    }
  }

  // surface inheritance: area <- centerline of the same highway type that
  // lies entirely within the area. Checking every vertex (not just the
  // midpoint) prevents ways that merely clip a polygon corner from donating
  // their surface to an area they mostly run outside of.
  onProgress?.(70, "inheriting surfaces from centerlines and footways…");
  const areaGrid = buildAreaIndex(areas);
  let inherited = 0;
  // footway ways carry surface tags too but are extracted into their own
  // bucket: they must also donate surfaces to matching areas (e.g. a
  // footway=sidewalk/traffic_island line inside an area:highway=footway
  // polygon, as with mapped traffic islands)
  // surface inference for highway areas without surface=*: ONE majority
  // vote. Every compatible centerline/footway with surface=* contributes
  // the length of its parts lying strictly inside the area (segment
  // midpoints); the surface with the greatest total inside length wins.
  // This replaces the earlier entirely-inside containment rule, which a
  // short spur could win against long sidewalks running along the
  // boundary.
  // highway areas still without surface (e.g. a junction area no centerline
  // runs ENTIRELY through): take the majority surface of the centerlines
  // passing through it (segment midpoint strictly inside, compatible
  // highway type, same layer) — weighted by the length inside the area, so
  // a long Rembrandtstraße sett run beats a short clipping driveway.
  // Footway areas get the same treatment from footway/sidewalk lines; a
  // footway=crossing never donates its surface (crossings lie in the road
  // they cross and would smear asphalt over the footway area)
  const surfaceByArea = new Map<AreaFeature, Map<string, number>>();
  // areas that have at least one compatible centerline/footway passing
  // through (strictly inside): surface inference from them is possible,
  // and adjacency inference is then forbidden
  const areasWithCenterline = new Set<AreaFeature>();
  const surfaceDonors: LineFeature[] = [];
  for (const cl of centerlines) if (cl.surface) surfaceDonors.push(cl);
  for (const fw of footways) if (fw.surface) surfaceDonors.push(fw);

  // ANY compatible way passing strictly through marks the area as having a
  // centerline — even one without surface=*, which blocks the adjacency
  // fallback below (surface inference by adjacency only happens when there
  // is no centerline at all)
  const passingLines: LineFeature[] = [...centerlines, ...footways];
  for (const cl of passingLines) {
    const candidates = queryAreas(areaGrid, cl.bbox);
    for (const area of candidates) {
      if (areasWithCenterline.has(area)) continue;
      if (!highwayTypesCompatible(cl.highway, area.highway)) continue;
      if (!bboxOverlap(area.bbox, cl.bbox)) continue;
      for (let i = 1; i < cl.coords.length; i++) {
        const a = cl.coords[i - 1],
          b = cl.coords[i];
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pointInAreaQ(m, area)) {
          areasWithCenterline.add(area);
          break;
        }
      }
    }
  }
  for (const cl of surfaceDonors) {
    const candidates = queryAreas(areaGrid, cl.bbox);
    for (const area of candidates) {
      if (area.surface) continue;
      if (!highwayTypesCompatible(cl.highway, area.highway)) continue;
      if (!bboxOverlap(area.bbox, cl.bbox)) continue;
      // length of the way inside the area: a segment counts when its
      // midpoint lies STRICTLY inside — a way merely running along the
      // area boundary must not donate
      let lenIn = 0;
      for (let i = 1; i < cl.coords.length; i++) {
        const a = cl.coords[i - 1],
          b = cl.coords[i];
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pointInAreaQ(m, area))
          lenIn += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      if (lenIn <= 0) continue;
      let byArea = surfaceByArea.get(area);
      if (!byArea) {
        byArea = new Map();
        surfaceByArea.set(area, byArea);
      }
      byArea.set(cl.surface!, (byArea.get(cl.surface!) ?? 0) + lenIn);
    }
  }
  for (const [area, bySurface] of surfaceByArea) {
    let topS = "",
      topL = -1;
    for (const [sf, l] of bySurface)
      if (l > topL) {
        topL = l;
        topS = sf;
      }
    if (topS) area.surface = topS;
  }

  // lane marking extraction: like crossings, lane-bearing centerlines may be
  // covered by their highway area (and then dropped below); extract the
  // marking data first into its own array.
  const laneMarkings: LineFeature[] = [];
  const stopLines: StopLineFeature[] = [];
  const laneCandidates: LineFeature[] = [];
  for (const cl of centerlines) {
    if (cl.lanes !== undefined && cl.lanes >= 2 && !cl.noLaneMarkings)
      laneCandidates.push(cl);
  }
  // on-carriageway parking strips (amenity=parking + parking=lane): the
  // nearest lane-bearing centerline on the same layer gains a parking
  // lane on the side the strip occupies — cross product of the
  // centerline direction at the nearest segment with the vector to the
  // strip's centroid; positive = left of the way
  {
    for (const st of parkingLanesOnCarriageway) {
      let sx = 0,
        sy = 0,
        cnt = 0;
      for (const ring of st.outer)
        for (const pt of ring) {
          sx += pt[0];
          sy += pt[1];
          cnt++;
        }
      if (cnt === 0) continue;
      const mid: [number, number] = [sx / cnt, sy / cnt];
      let best: LineFeature | null = null;
      let bestD = Infinity;
      let bestSeg = 1;
      for (const cl of laneCandidates) {
        if (cl.layer !== st.layer) continue;
        if (!bboxOverlap(cl.bbox, st.bbox)) continue;
        for (let i = 1; i < cl.coords.length; i++) {
          const a = cl.coords[i - 1],
            b = cl.coords[i];
          const dx = b[0] - a[0],
            dy = b[1] - a[1];
          const len2 = dx * dx + dy * dy;
          if (len2 === 0) continue;
          let t = ((mid[0] - a[0]) * dx + (mid[1] - a[1]) * dy) / len2;
          t = Math.max(0, Math.min(1, t));
          const px = a[0] + t * dx,
            py = a[1] + t * dy;
          const d = (mid[0] - px) ** 2 + (mid[1] - py) ** 2;
          if (d < bestD) {
            bestD = d;
            best = cl;
            bestSeg = i;
          }
        }
      }
      if (!best) continue;
      const a = best.coords[bestSeg - 1],
        b = best.coords[bestSeg];
      const cross =
        (b[0] - a[0]) * (mid[1] - a[1]) - (b[1] - a[1]) * (mid[0] - a[0]);
      if (cross > 0) best.parkingLeft = true;
      else if (cross < 0) best.parkingRight = true;
    }
  }
  const areaGridL = buildAreaIndex(areas);
  // ---------------------------------------------------------------------
  // STOP LINES: a lane-bearing way carrying a highway=traffic_signals node
  // gets a stop line at that node - traffic signals stand at the stop
  // line. Which lanes the stop line covers depends on where the node sits
  // on the way: at the END, traffic flowing forward (the way direction)
  // runs into the signalized crossing; at the START, traffic flows away
  // (one-way roads get no stop line there - it belongs to the opposite
  // carriageway); mid-way on a bidirectional road, both directions stop.
  // lane candidates AND car-only ways without lanes=* (lanes defaults to
  // 2, one per direction; a lanes=1 residential road still gets a stop
  // line for its single direction). Footway/crossing ways never carry car
  // stop lines - stop lines are for cars
  const stopWays: LineFeature[] = [...laneCandidates];
  for (const cl of centerlines) {
    if (stopWays.includes(cl)) continue;
    if (
      cl.highway === "footway" ||
      cl.footway === "sidewalk" ||
      cl.footway === "crossing"
    )
      continue;
    if (
      cl.highway === "cycleway" ||
      cl.highway === "path" ||
      cl.highway === "steps" ||
      cl.highway === "pedestrian" ||
      cl.highway === "track"
    )
      continue;
    stopWays.push(cl);
  }
  const stopLineAt = new Map<
    LineFeature,
    {
      idx: number;
      side: "start" | "mid" | "end";
      sigDir: "forward" | "backward" | "both" | undefined;
      sigIdx: number;
    }[]
  >();
  for (const cl of stopWays) {
    const way = data.ways.get(parseInt(cl.id.slice(1), 10));
    if (!way) continue;
    const n = cl.coords.length;
    for (let ri = 0; ri < way.refs.length; ri++) {
      const nt = data.nodeTags.get(way.refs[ri]);
      if (!nt || nt["highway"] !== "traffic_signals") continue;
      // END is checked first: a 2-node way's last node is both near the
      // start and at the end - it is the END (traffic runs into the
      // signal there), never the start
      const side: "start" | "mid" | "end" =
        ri >= n - 2 ? "end" : ri <= 1 ? "start" : "mid";
      // traffic_signals:direction on the node tells which direction the
      // signal FACES (forward = along the way, backward = against it);
      // without it, signals apply to the direction(s) implied by the
      // node's position on the way
      const sigDir: "forward" | "backward" | "both" | undefined =
        nt["traffic_signals:direction"] === "forward"
          ? "forward"
          : nt["traffic_signals:direction"] === "backward"
            ? "backward"
            : nt["traffic_signals:direction"] === "both"
              ? "both"
              : undefined;
      let arr = stopLineAt.get(cl);
      if (!arr) {
        arr = [];
        stopLineAt.set(cl, arr);
      }
      arr.push({ idx: ri, side, sigDir, sigIdx: ri });
    }
  }
  // resolve each signal to its stop position: walk from the signal node
  // along the way towards the stopping traffic (backwards for an END
  // signal, forwards for a START signal) to the first vertex that lies
  // inside/on one of the way's OWN road areas (non-junction areas the way
  // corresponds to). Signals stand AT the stop line, so the mouth of the
  // entering road section is a couple of vertices away; bounding the walk
  // to a few segments prevents reaching across a junction onto an
  // unrelated far piece. Keyed by the AREA that received the stop line -
  // the piece of that area carries it
  const areasOfWay = new Map<LineFeature, AreaFeature[]>();
  const slAreaGrid = buildAreaIndex(areas);
  for (const cl of stopWays) {
    const found: AreaFeature[] = [];
    for (const area of queryAreas(slAreaGrid, cl.bbox)) {
      if (area.junction) continue;
      if (!highwayTypesCompatible(cl.highway, area.highway)) continue;
      if (!bboxOverlap(area.bbox, cl.bbox)) continue;
      for (let i = 1; i < cl.coords.length; i++) {
        const a = cl.coords[i - 1],
          b = cl.coords[i];
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pointInAreaQ(m, area)) {
          found.push(area);
          break;
        }
      }
    }
    areasOfWay.set(cl, found);
  }
  const stopLineResolved = new Map<
    LineFeature,
    {
      idx: number;
      side: "start" | "mid" | "end";
      sigDir: "forward" | "backward" | "both" | undefined;
      sigIdx: number;
      area: AreaFeature;
    }[]
  >();
  for (const [cl, sigs] of stopLineAt) {
    const myAreas = areasOfWay.get(cl) ?? [];
    for (const sl of sigs) {
      const step = sl.side === "end" ? -1 : 1;
      let steps = 0;
      for (
        let i = sl.idx;
        i >= 0 && i < cl.coords.length && steps <= 3;
        i += step
      ) {
        const nq = cl.coords[i];
        const hit = myAreas.find(
          (a) => pointInAreaQ(nq, a) || pointOnAreaBoundaryQ(nq, a, 10),
        );
        if (hit) {
          let arr = stopLineResolved.get(cl);
          if (!arr) {
            arr = [];
            stopLineResolved.set(cl, arr);
          }
          arr.push({
            idx: i,
            side: sl.side,
            sigDir: sl.sigDir,
            sigIdx: sl.sigIdx,
            area: hit,
          });
          break;
        }
        steps++;
      }
    }
  }
  // stop line geometry: the STOP LINE follows the shared boundary
  // between the entering road area and the adjacent junction area - the
  // polyline where the two polygons meet, which is generally NOT
  // orthogonal to the road. For ways WITHOUT drawn lane markings (no
  // lanes=*, lane_markings=no) the boundary is the whole stop line; for
  // bidirectional lane-bearing ways it is laterally clipped to the
  // stopping direction's half (forward = right half, backward = left)
  const junctionAreaList = areas.filter((a) => a.junction);
  // pick THE junction area the stop line belongs to: the one CONTAINING
  // the traffic_signals node wins (a road area can border several
  // junction areas, e.g. one at each end - the wrong pick would draw
  // the stop line at the far end); among junctions sharing a boundary
  // with the road area, the nearest to the signal node wins
  const findJunction = (
    road: AreaFeature,
    sigQ: number[] | undefined,
  ): AreaFeature | null => {
    let best: AreaFeature | null = null;
    let bestD = Infinity;
    for (const ja of junctionAreaList) {
      if (!bboxOverlap(ja.bbox, road.bbox)) continue;
      const chains = sharedBoundaryQ(road, ja, 10);
      if (chains.length === 0) continue;
      if (!sigQ) return ja;
      let d = Infinity;
      for (const chain of chains)
        for (const pt of chain) {
          const dd = (pt[0] - sigQ[0]) ** 2 + (pt[1] - sigQ[1]) ** 2;
          if (dd < d) d = dd;
        }
      if (d < bestD) {
        bestD = d;
        best = ja;
      }
    }
    return best;
  };
  // the boundary chain that carries the stop line: among a junction's
  // shared chains, the one nearest the traffic_signals node. Never the
  // flattened boundary - a junction touching the road area at both ends
  // would put the stop line on the wrong end
  // like stopLineChain, but the chain must lie within maxD2 (squared) of
  // the signal node - a signal far from every shared chain does not sit
  // at this intersection and gets no stop line from it
  const stopLineChainNear = (
    road: AreaFeature,
    junction: AreaFeature,
    sigQ: number[],
    maxD2: number,
  ): number[][] | null => {
    const chains = sharedBoundaryQ(road, junction, 10);
    let best: number[][] | null = null;
    let bestD = Infinity;
    for (const chain of chains) {
      // a cut exactly at a ring vertex can yield a degenerate chain whose
      // points all coincide - it draws nothing and must never win the
      // pick over a real chain at the same place
      let distinct = 0;
      for (const pt of chain) {
        if (pt[0] !== chain[0][0] || pt[1] !== chain[0][1]) distinct++;
      }
      if (distinct === 0) continue;
      let d = Infinity;
      for (const pt of chain) {
        const dd = (pt[0] - sigQ[0]) ** 2 + (pt[1] - sigQ[1]) ** 2;
        if (dd < d) d = dd;
      }
      if (d < bestD) {
        bestD = d;
        best = chain;
      }
    }
    if (best === null || bestD > maxD2) return null;
    return best;
  };
  for (const [cl, sigs] of stopLineResolved) {
    if (laneCandidates.includes(cl)) continue;
    for (const sl of sigs) {
      const ja = findJunction(sl.area, cl.coords[sl.sigIdx]);
      if (!ja) continue;
      const line = stopLineChainNear(
        sl.area,
        ja,
        cl.coords[sl.sigIdx],
        100000000,
      );
      if (!line || line.length < 2) continue;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const pt of line) {
        if (pt[0] < minX) minX = pt[0];
        if (pt[0] > maxX) maxX = pt[0];
        if (pt[1] < minY) minY = pt[1];
        if (pt[1] > maxY) maxY = pt[1];
      }
      stopLines.push({
        type: "stopline",
        id: cl.id,
        layer: cl.layer,
        level: cl.level,
        line: line as Q[][],
        bbox: [minX, minY, maxX, maxY],
      });
    }
  }
  // ---------------------------------------------------------------------
  // CONTINUOUS LANE MARKINGS
  // ---------------------------------------------------------------------
  // One road is often mapped as SEVERAL centerline ways (split where lanes
  // or parking change) running through SEVERAL highway areas (a road polygon
  // split into sections) — but it is still ONE road, and its painted
  // markings do not jump: existing lane boundaries continue, lane changes
  // only add or remove lanes on the outer side(s), and parking changes only
  // move the dashed parking boundary. All marking pieces of one road
  // therefore share
  //   * one lane width (median of the road's measured unit widths) and
  //   * one anchor: the position of the direction border (the solid line
  //     between forward and backward lanes), or — on one-way roads — the
  //     left edge of the leftmost lane.
  // A piece's left traffic edge follows from the anchor and its own forward
  // lane count, so boundaries keep their offsets across pieces: a 2→3 lane
  // change keeps the two existing lanes and adds one on the outside, and a
  // parking lane appearing or disappearing shifts no lane boundary at all.
  interface SplineSampleInfo {
    /** quantized position on the spline */
    pt: number[];
    /** unit normal (left-positive) at the sample */
    nx: number;
    ny: number;
    /** measured distance to the left/right area edge, meters */
    leftM: number;
    rightM: number;
  }
  interface MarkingSample {
    area: AreaFeature;
    leftM: number;
    rightM: number;
    /** fitted unit width (m) of the extruded road-model rectangle, when a spline fit succeeded */
    fitW?: number;
    /** fitted lateral shift (m, positive = left) of the rectangle center vs the mapped centerline */
    fitShift?: number;
    /** densified spline centerline of the piece, sampled ~4 m, with per-sample measured road edges */
    spline?: SplineSampleInfo[];
  }
  const samplesOf = new Map<LineFeature, MarkingSample[]>();
  for (const cl of laneCandidates) {
    const candidates = queryAreas(areaGridL, cl.bbox);
    // a centerline may correspond to MULTIPLE areas (a road polygon split
    // into sections): collect all corresponding areas; same-layer areas
    // win, falling back to the highest-layer containing area when the
    // centerline is untagged while its area carries layer=*
    const matching: AreaFeature[] = [];
    for (const area of candidates) {
      if (area.junction) continue;
      // only areas of the same highway type: a centerline that clips an
      // unrelated, differently-typed area (e.g. a tertiary road passing
      // through a small secondary loop) must not infer its width from it
      if (!highwayTypesCompatible(cl.highway, area.highway)) continue;
      if (!bboxOverlap(area.bbox, cl.bbox)) continue;
      // correspondence: a segment midpoint inside the area
      let someInside = false;
      for (let si = 1; si < cl.coords.length && !someInside; si++) {
        const a = cl.coords[si - 1],
          b = cl.coords[si];
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pointInAreaTolQ2(m, area)) someInside = true;
      }
      if (!someInside) continue;
      matching.push(area);
    }
    if (matching.length > 1) {
      const sameLayer = matching.filter((a) => a.layer === cl.layer);
      if (sameLayer.length > 0)
        ((matching.length = 0), matching.push(...sameLayer));
    }
    for (const area of matching) {
      // sample MULTIPLE segments per area (median of the ray-cast edges),
      // so a long curving way follows its local road width instead of one
      // smoothed measurement at its longest segment; at most 12 samples,
      // evenly spaced among the segments whose midpoint lies inside the
      // area. The middle segment of a bent way can be a short corner-cut
      // whose direction matches the road axis nowhere — segments strictly
      // inside are preferred over ones only touching the boundary (a
      // segment spanning two area sections has its midpoint on the shared
      // edge, where rays toward the other section would measure zero width)
      const insideSegs: number[] = [];
      const tolSegs: number[] = [];
      for (let si = 1; si < cl.coords.length; si++) {
        const a = cl.coords[si - 1],
          b = cl.coords[si];
        if (a[0] === b[0] && a[1] === b[1]) continue;
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pointInAreaQ(m, area)) insideSegs.push(si);
        else if (pointInAreaTolQ2(m, area)) tolSegs.push(si);
      }
      const segs = insideSegs.length > 0 ? insideSegs : tolSegs;
      if (segs.length === 0) continue;
      const lefts: number[] = [];
      const rights: number[] = [];
      const [minX, minY, maxX, maxY] = area.bbox;
      const maxRay = Math.hypot(maxX - minX, maxY - minY) + 1000;
      // nx/ny is a UNIT NORMAL IN METRIC SPACE; the quantized ray
      // direction (nx/mPerLon, ny/mPerLat) has metric length 1, so the
      // ray parameter t IS the distance in meters
      const measureAt = (
        sample: number[],
        nx: number,
        ny: number,
      ): [number, number] | null => {
        const mPerLon =
          (111_320 * Math.cos(((sample[1] / 1e7) * Math.PI) / 180)) / 1e7;
        const mPerLat = 111_320 / 1e7;
        return lateralIntervalInArea(
          sample,
          nx,
          ny,
          mPerLon,
          mPerLat,
          area,
          maxRay,
        );
      };
      const median = (xs: number[]): number => {
        const s2 = [...xs].sort((a, b) => a - b);
        const m = s2.length >> 1;
        return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2;
      };
      // piece-wide median from segment-midpoint samples (the group
      // layout below still keys off these medians)
      for (const bi of segs) {
        const dxs = cl.coords[bi][0] - cl.coords[bi - 1][0];
        const dys = cl.coords[bi][1] - cl.coords[bi - 1][1];
        const segLen = Math.hypot(dxs, dys);
        if (segLen === 0) continue;
        let sample: number[] | null = null;
        const a0 = cl.coords[bi - 1],
          a1 = cl.coords[bi];
        for (let t = 0.5; t >= 0.05; t -= 0.05) {
          for (const u of [t, 1 - t]) {
            const p = [
              a0[0] + (a1[0] - a0[0]) * u,
              a0[1] + (a1[1] - a0[1]) * u,
            ];
            if (pointInAreaQ(p, area)) {
              sample = p;
              break;
            }
          }
          if (sample) break;
        }
        if (!sample) continue;
        const mPerLonS =
          (111_320 *
            Math.cos(((sample[1] / 1e7) * Math.PI) / 180)) /
          1e7;
        const mPerLatS = 111_320 / 1e7;
        const tx = (dxs / segLen) * mPerLonS,
          ty = (dys / segLen) * mPerLatS;
        const tl = Math.hypot(tx, ty);
        const measured = measureAt(sample, -ty / tl, tx / tl);
        if (!measured) continue;
        lefts.push(measured[0]);
        rights.push(measured[1]);
      }
      if (lefts.length === 0) continue;
      let arr = samplesOf.get(cl);
      if (!arr) {
        arr = [];
        samplesOf.set(cl, arr);
      }
      arr.push({
        area,
        leftM: median(lefts),
        rightM: median(rights),
      });
    }
  }
  // group the lane-bearing ways into roads: centerlines that touch
  // end-to-end and continue in the same direction, with the SAME highway
  // type, layer and oneway status. A road changing name mid-block still
  // joins; a different highway type never joins (the Rheinstraße→
  // Hauptstraße fork — wait, that one keeps the type; the type rule
  // catches e.g. residential→service transitions). Same-type forks are
  // assumed to sit at junctions/y-junctions, where the ambiguity check
  // (several collinear candidates) breaks the group. Junction areas do
  // not break the group: geometry alone decides.
  const parent = laneCandidates.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };
  // all way ends by coordinate (named and unnamed alike)
  const byEnd = new Map<string, { i: number; atStart: boolean }[]>();
  const endKey = (p: Q[]): string => `${p[0]},${p[1]}`;
  laneCandidates.forEach((cl, i) => {
    const first = cl.coords[0],
      last = cl.coords[cl.coords.length - 1];
    for (const [end, atStart] of [
      [first, true],
      [last, false],
    ] as [Q[], boolean][]) {
      const k = endKey(end);
      const arr = byEnd.get(k);
      const e = { i, atStart };
      if (arr) arr.push(e);
      else byEnd.set(k, [e]);
    }
  });
  // unit direction pointing OUT of the way at the given end
  const endDir = (cl: LineFeature, atStart: boolean): [number, number] => {
    const a = atStart ? cl.coords[1] : cl.coords[cl.coords.length - 2];
    const b = atStart ? cl.coords[0] : cl.coords[cl.coords.length - 1];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    return l > 0 ? [dx / l, dy / l] : [0, 0];
  };
  for (const ends of byEnd.values()) {
    if (ends.length < 2) continue;
    // join two way ends when they are each other's UNIQUE collinear
    // continuation: mutual best match, clearly ahead of any competitor
    // (a fork gives the incoming way two collinear branches — ambiguous,
    // so nothing joins and both fork legs start their own group)
    for (let a = 0; a < ends.length; a++) {
      const dA = endDir(laneCandidates[ends[a].i], ends[a].atStart);
      if (dA[0] === 0 && dA[1] === 0) continue;
      let bestB = -1,
        bestDot = -2,
        secondDot = -2;
      for (let b = 0; b < ends.length; b++) {
        if (b === a) continue;
        const B = laneCandidates[ends[b].i];
        if (find(ends[a].i) === find(ends[b].i)) continue;
        const A = laneCandidates[ends[a].i];
        if (A.layer !== B.layer || A.oneway !== B.oneway) continue;
        // a collinear continuation of a DIFFERENT highway type is a
        // different road (the Rheinstraße→Hauptstraße fork changes
        // tertiary type? no — it keeps the type; but a service driveway
        // continuing a residential road is different): never join.
        // Same-type collinear continuations join even under a different
        // name — a road changing name mid-block is still one street
        // area; same-type forks are assumed to sit at junctions, where
        // the ambiguity check breaks the group anyway
        if (A.highway !== B.highway) continue;
        const dB = endDir(B, ends[b].atStart);
        const dot = dA[0] * dB[0] + dA[1] * dB[1];
        if (dot <= -0.7 && dot > bestDot) {
          secondDot = bestDot;
          bestDot = dot;
          bestB = b;
        } else if (dot > secondDot) secondDot = dot;
      }
      if (bestB < 0) continue;
      // ambiguous fork: another candidate is nearly as collinear
      if (secondDot > bestDot - 0.15) continue;
      // mutuality: the partner must also pick this end as its best
      const dB = endDir(laneCandidates[ends[bestB].i], ends[bestB].atStart);
      let mutBest = -1,
        mutDot = -2;
      for (let c = 0; c < ends.length; c++) {
        if (c === bestB) continue;
        if (find(ends[bestB].i) === find(ends[c].i)) continue;
        const C = laneCandidates[ends[c].i];
        if (laneCandidates[ends[bestB].i].layer !== C.layer) continue;
        if (laneCandidates[ends[bestB].i].oneway !== C.oneway) continue;
        if (laneCandidates[ends[bestB].i].highway !== C.highway) continue;
        const dC = endDir(C, ends[c].atStart);
        const dot = dB[0] * dC[0] + dB[1] * dC[1];
        if (dot <= -0.7 && dot > mutDot) {
          mutDot = dot;
          mutBest = c;
        }
      }
      if (mutBest === a) union(ends[a].i, ends[bestB].i);
    }
  }
  const groups = new Map<number, LineFeature[]>();
  laneCandidates.forEach((cl, i) => {
    const r = find(i);
    const arr = groups.get(r);
    if (arr) arr.push(cl);
    else groups.set(r, [cl]);
  });
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const fwdOf = (cl: LineFeature): number =>
    cl.lanesFwd ?? (cl.oneway ? cl.lanes! : Math.ceil(cl.lanes! / 2));
  // Build one spline per (road group, area): the ways of a group form a
  // POLYLINE through the area (often several joined ways - a road split
  // mid-block), and the spline must cover ALL of them with no seams.
  // Each sample records the way it lies on, so lane counts, parking and
  // other properties come from the corresponding way.
  const median2 = (xs: number[]): number => {
    const s2 = [...xs].sort((a, b) => a - b);
    const m = s2.length >> 1;
    return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2;
  };
  const chainSplines = (
    ways: LineFeature[],
    area: AreaFeature,
  ): (SplineSampleInfo & { cl: LineFeature })[] => {
    // chain the ways into one ordered polyline (they touch end-to-end)
    const byEnd = new Map<string, LineFeature[]>();
    const key = (p: number[]): string => `${p[0]},${p[1]}`;
    for (const w of ways) {
      for (const e of [w.coords[0], w.coords[w.coords.length - 1]]) {
        const arr = byEnd.get(key(e));
        if (arr) arr.push(w);
        else byEnd.set(key(e), [w]);
      }
    }
    // seed: the first way with a FREE end (a chain end), then walk
    // BOTH directions from it, flipping directions as needed; each way
    // keeps its identity so per-way properties survive
    // reversed copies carry their ORIGINAL way object so ownership
    // comparisons survive the direction flip
    const reversed = (w: LineFeature): LineFeature =>
      ({
        ...w,
        coords: [...w.coords].reverse(),
        __orig: w,
      } as LineFeature);
    let seed: LineFeature | undefined;
    let seedFlipped = false;
    for (const w of ways) {
      if ((byEnd.get(key(w.coords[0])) ?? []).length === 1) {
        seed = w;
        seedFlipped = false;
        break;
      }
      if (
        (byEnd.get(key(w.coords[w.coords.length - 1])) ?? []).length === 1
      ) {
        seed = w;
        seedFlipped = true;
        break;
      }
    }
    if (!seed) seed = ways[0];
    const usedOrig = new Set<LineFeature>([seed]);
    const chain: LineFeature[] = [seedFlipped ? reversed(seed) : seed];
    // whether each chain entry runs REVERSED vs its own way direction:
    // chain[i] may be a reversed() copy ("__orig" set) or the way itself
    const isRev = (w: LineFeature): boolean =>
      (w as unknown as { __orig?: LineFeature }).__orig !== undefined;
    const chainRev: boolean[] = [seedFlipped && isRev(chain[0])];
    // extend forward from the chain end
    while (true) {
      const last = chain[chain.length - 1];
      const lastEnd = last.coords[last.coords.length - 1];
      const next = (byEnd.get(key(lastEnd)) ?? []).find(
        (c) => !usedOrig.has(c),
      );
      if (!next) break;
      usedOrig.add(next);
      const fwd = key(next.coords[0]) === key(lastEnd);
      chain.push(fwd ? next : reversed(next));
      chainRev.push(!fwd);
    }
    // extend backward from the chain start
    while (true) {
      const first = chain[0];
      const firstEnd = first.coords[0];
      const prev = (byEnd.get(key(firstEnd)) ?? []).find(
        (c) => !usedOrig.has(c),
      );
      if (!prev) break;
      usedOrig.add(prev);
      const fwd = key(prev.coords[prev.coords.length - 1]) === key(firstEnd);
      chain.unshift(fwd ? prev : reversed(prev));
      chainRev.unshift(!fwd);
    }
    const used = new Set<LineFeature>();
    // merged vertex list with way ownership (dedup shared seam
    // vertices); ownership always refers to the ORIGINAL way object
    const origOfChain = (w: LineFeature): LineFeature =>
      (w as unknown as { __orig?: LineFeature }).__orig ?? w;
    // owner way -> reversed in the chain? samples for a REVERSED way are
    // later flipped back to the way's own left/right convention
    const revByOrig = new Map<LineFeature, boolean>();
    chain.forEach((w, i) => revByOrig.set(origOfChain(w), chainRev[i]));
    const verts: { p: number[]; cl: LineFeature }[] = [];
    for (const w of chain) {
      const owner = origOfChain(w);
      for (const c of w.coords) {
        const lastV = verts[verts.length - 1];
        if (
          chain.length > 1 &&
          lastV &&
          lastV.cl !== owner &&
          lastV.p[0] === c[0] &&
          lastV.p[1] === c[1]
        ) {
          lastV.cl = owner; // seam vertex belongs to the NEXT way
          continue;
        }
        if (lastV && lastV.p[0] === c[0] && lastV.p[1] === c[1] && lastV.cl === owner)
          continue;
        verts.push({ p: c, cl: owner });
      }
    }
    if (verts.length < 2) return [];
    // metric working coordinates
    const cosLat = Math.cos((verts[0].p[1] / 1e7) * (Math.PI / 180));
    const MX = (lonQ: number): number => lonQ * 1e-7 * 111_320 * cosLat;
    const MY = (latQ: number): number => latQ * 1e-7 * 111_320;
    const mv = verts.map((v) => [MX(v.p[0]), MY(v.p[1])]);
    // vertex -> sample ownership: interpolate along the chain
    const ownerAt = (t: number): LineFeature => {
      // arc-length t along the merged metric polyline
      let acc = 0;
      for (let i = 1; i < mv.length; i++) {
        const segLen = Math.hypot(
          mv[i][0] - mv[i - 1][0],
          mv[i][1] - mv[i - 1][1],
        );
        if (t <= acc + segLen || i === mv.length - 1) {
          const f = segLen > 0 ? (t - acc) / segLen : 0;
          const px = mv[i - 1][0] + (mv[i][0] - mv[i - 1][0]) * f;
          const py = mv[i - 1][1] + (mv[i][1] - mv[i - 1][1]) * f;
          // nearest vertex decides the owner (way boundaries are vertices)
          const dPrev = Math.hypot(px - mv[i - 1][0], py - mv[i - 1][1]);
          const dNext = Math.hypot(px - mv[i][0], py - mv[i][1]);
          return dPrev <= dNext ? verts[i - 1].cl : verts[i].cl;
        }
        acc += segLen;
      }
      return verts[verts.length - 1].cl;
    };
    // chord-length parametrization and Catmull-Rom over the merged chain
    const cum: number[] = [0];
    for (let i = 1; i < mv.length; i++)
      cum.push(
        cum[i - 1] +
          Math.hypot(mv[i][0] - mv[i - 1][0], mv[i][1] - mv[i - 1][1]),
      );
    const total = cum[cum.length - 1];
    const ptAt = (t: number): { p: number[]; d: number[] } => {
      let k = 1;
      while (k < cum.length - 1 && cum[k] < t) k++;
      const t0 = cum[k - 1],
        t1 = cum[k];
      const f = t1 - t0 > 0 ? (t - t0) / (t1 - t0) : 0;
      const P = (idx: number): number[] =>
        idx < 0
          ? [2 * mv[0][0] - mv[1][0], 2 * mv[0][1] - mv[1][1]]
          : idx > mv.length - 1
            ? [
                2 * mv[mv.length - 1][0] - mv[mv.length - 2][0],
                2 * mv[mv.length - 1][1] - mv[mv.length - 2][1],
              ]
            : mv[idx];
      const p0 = P(k - 2),
        p1 = P(k - 1),
        p2 = P(k),
        p3 = P(k + 1);
      const f2 = f * f,
        f3 = f2 * f;
      const px =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * f +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * f2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * f3);
      const py =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * f +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * f2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * f3);
      const dx =
        0.5 *
        (-p0[0] +
          p2[0] +
          2 * (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * f +
          3 * (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * f2);
      const dy =
        0.5 *
        (-p0[1] +
          p2[1] +
          2 * (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * f +
          3 * (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * f2);
      return { p: [px, py], d: [dx, dy] };
    };
    const [minX, minY, maxX, maxY] = area.bbox;
    const maxRay = Math.hypot(maxX - minX, maxY - minY) + 1000;
    const measureAt = (
      sample: number[],
      nx: number,
      ny: number,
    ): [number, number] | null => {
      const mPerLon = (111_320 * cosLat) / 1e7;
      const mPerLat = 111_320 / 1e7;
      return lateralIntervalInArea(
        sample,
        nx,
        ny,
        mPerLon,
        mPerLat,
        area,
        maxRay,
      );
    };
    const EPS_M = 0.3;
    const nSamples = Math.min(120, Math.max(8, Math.round(total / 4)));
    const raw: (SplineSampleInfo & { cl: LineFeature })[] = [];
    for (let s = 0; s <= nSamples; s++) {
      const t = (total * s) / nSamples;
      const { p, d } = ptAt(t);
      const dl = Math.hypot(d[0], d[1]);
      if (dl === 0) continue;
      const nx = -d[1] / dl,
        ny = d[0] / dl;
      const qx = p[0] / (1e-7 * 111_320 * cosLat);
      const qy = p[1] / (1e-7 * 111_320);
      const ux = d[0] / dl,
        uy = d[1] / dl;
      const mid = ptAt(total / 2).p;
      const towards =
        (mid[0] - p[0]) * ux + (mid[1] - p[1]) * uy >= 0 ? 1 : -1;
      const nudged = [
        qx + (ux * EPS_M * towards) / (1e-7 * 111_320 * cosLat),
        qy + (uy * EPS_M * towards) / (1e-7 * 111_320),
      ];
      if (!pointInAreaQ(nudged, area)) continue;
      const m2 = measureAt(nudged, nx, ny);
      if (!m2) continue;
      raw.push({
        pt: [Math.round(nudged[0]), Math.round(nudged[1])],
        nx,
        ny,
        leftM: m2[0],
        rightM: m2[1],
        cl: ownerAt(t),
      });
    }
    // samples of a way the chain traverses REVERSED carry the chain's
    // normal and left/right split; flip them back so every consumer sees
    // the sample in the OWNING WAY's own orientation (left/right must
    // match the way's tags: parking:left etc.)
    const orient = (
      s: SplineSampleInfo & { cl: LineFeature },
    ): SplineSampleInfo & { cl: LineFeature } =>
      revByOrig.get(s.cl)
        ? {
            ...s,
            nx: -s.nx,
            ny: -s.ny,
            leftM: s.rightM,
            rightM: s.leftM,
          }
        : s;
    if (raw.length < 3) return raw.map(orient);
    // ---- pass 2: re-center on the geometric midline ----
    // The mapped centerline can be SHIFTED by the mapper (jogging the way
    // where parking sides change, honoring placement). The AREA boundary
    // is objective: the midline between the two measured edges is a
    // property of the road, not of the mapping. Re-measure from it so
    // the split (leftM/rightM) stops wobbling with the way.
    // Robust smoothing per side (moving median): boundary DENTS (bus
    // platforms, cutouts) are minority outliers and vanish, while real
    // widenings (span changes with lane counts) survive.
    const midPts: { p: number[] }[] = raw.map((s) => {
      // boundary hit points in metric coords: p +- normal * dist
      const nxq = s.nx, nyq = s.ny; // metric unit normal
      const lx = s.pt[0] * (1e-7 * 111_320 * cosLat) - nxq * s.leftM;
      const ly = s.pt[1] * (1e-7 * 111_320) - nyq * s.leftM;
      const rx = s.pt[0] * (1e-7 * 111_320 * cosLat) + nxq * s.rightM;
      const ry = s.pt[1] * (1e-7 * 111_320) + nyq * s.rightM;
      return { p: [(lx + rx) / 2, (ly + ry) / 2] };
    });
    // smooth the midline with a moving average over the arc
    const midSmoothed = midPts.map((m, i) => {
      if (!m) return null;
      const W = 2;
      let sx = 0, sy = 0, n = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(midPts.length - 1, i + W); j++) {
        const mj = midPts[j];
        if (mj) { sx += mj.p[0]; sy += mj.p[1]; n++; }
      }
      return n > 0 ? [sx / n, sy / n] : m.p;
    });
    // re-measure from the smoothed midline: radial pairs via the LOCAL
    // midline tangent (circle-fit-free: midline points are ~4 m apart,
    // the chord direction is a good local tangent)
    const raw2: (SplineSampleInfo & { cl: LineFeature })[] = [];
    for (let i = 0; i < raw.length; i++) {
      const m = midSmoothed[i];
      if (!m) { raw2.push(raw[i]); continue; }
      // local tangent from neighbours on the smoothed midline
      const prev = midSmoothed[Math.max(0, i - 1)];
      const next = midSmoothed[Math.min(midSmoothed.length - 1, i + 1)];
      if (!prev || !next) { raw2.push(raw[i]); continue; }
      const tx = next[0] - prev[0], ty = next[1] - prev[1];
      const tl = Math.hypot(tx, ty);
      if (tl === 0) { raw2.push(raw[i]); continue; }
      const nx = -ty / tl, ny = tx / tl; // metric unit normal at the midline
      // measure from the sample's own point (pt keeps the drawn curve):
      // leftM/rightM must stay relative to pt, or downstream consumers
      // (the rectangle fit) read them against the wrong reference
      const m2 = measureAt(raw[i].pt, nx, ny);
      if (!m2) { raw2.push(raw[i]); continue; }
      raw2.push({
        ...raw[i],
        nx,
        ny,
        leftM: m2[0],
        rightM: m2[1],
      });
    }
    // Hampel-style robust smoothing per side (window ~9 samples = ~36 m):
    // a sample whose edge deviates more than 1.2 m from its window
    // median is replaced by that median. INWARD spikes (platforms,
    // bollard cutouts, kerb dents - the edge cuts INTO the road) are
    // always replaced; OUTWARD deviations are kept only at the very ends
    // of the chain (junction mouths widen outward for real). Genuine
    // widenings (lane-count changes) span whole windows and their
    // window medians follow them, so they survive
    const smoothSide = (vals: number[], other: number[]): number[] => {
      const W = 6;
      const out = [...vals];
      for (let i = 0; i < vals.length; i++) {
        const win: number[] = [];
        for (
          let j = Math.max(0, i - W);
          j <= Math.min(vals.length - 1, i + W);
          j++
        )
          win.push(vals[j]);
        const med = median2(win);
        if (med - vals[i] > 1.2 && Math.abs(other[i] - median2(
          (() => {
            const w2: number[] = [];
            for (
              let j = Math.max(0, i - W);
              j <= Math.min(other.length - 1, i + W);
              j++
            )
              w2.push(other[j]);
            return w2;
          })(),
        )) < 1.0) {
          // ONE-SIDED inward dent with the other side stable: a mapping
          // artifact (platform, cutout on one boundary) — the true road
          // edge is farther out. When BOTH sides dent together the road
          // genuinely narrows (facing platforms) and the dent is kept
          out[i] = med;
        } else if (vals[i] - med > 1.2) {
          // outward spike: keep only at the chain ends (mouth widening)
          if (i > W && i < vals.length - 1 - W) out[i] = med;
        }
      }
      return out;
    };
    const L = raw2.map((s) => s.leftM);
    const R = raw2.map((s) => s.rightM);
    const smL = smoothSide(L, R);
    const smR = smoothSide(R, L);
    const smoothed = raw2.map((s, i) => ({
      ...s,
      leftM: smL[i],
      rightM: smR[i],
    }));
    // keep the ORIGINAL sample positions (the drawn curve) but with the
    // re-centered, smoothed edges
    const final = smoothed;
    // per-side outlier repair (boundary tips / junction mouths truncate
    // one side); interior outliers interpolate, end runs truncate
    const medL = median2(final.map((s) => s.leftM));
    const medR = median2(final.map((s) => s.rightM));
    const bad = final.map(
      (s) =>
        Math.abs(s.leftM - medL) > 0.25 * medL ||
        Math.abs(s.rightM - medR) > 0.25 * medR,
    );
    if (!bad.some((b) => b)) return final.map(orient);
    let lo = 0;
    while (lo < bad.length && bad[lo]) lo++;
    let hi = bad.length;
    while (hi > lo && bad[hi - 1]) hi--;
    const kept = final.slice(lo, hi);
    if (kept.length < 3) return final.map(orient);
    const lefts: (number | null)[] = kept.map((s, i) =>
      bad[lo + i] ? null : s.leftM,
    );
    const rights: (number | null)[] = kept.map((s, i) =>
      bad[lo + i] ? null : s.rightM,
    );
    const fill = (xs: (number | null)[]): void => {
      let lastGood = -1;
      for (let i = 0; i < xs.length; i++) {
        if (xs[i] !== null) {
          lastGood = i;
          continue;
        }
        let nextGood = -1;
        for (let j = i + 1; j < xs.length; j++)
          if (xs[j] !== null) {
            nextGood = j;
            break;
          }
        if (lastGood >= 0 && nextGood >= 0)
          xs[i] =
            (xs[lastGood] as number) +
            (((xs[nextGood] as number) - (xs[lastGood] as number)) *
              (i - lastGood)) /
              (nextGood - lastGood);
        else if (lastGood >= 0) xs[i] = xs[lastGood];
        else if (nextGood >= 0) xs[i] = xs[nextGood];
      }
    };
    fill(lefts);
    fill(rights);
    return kept.map((s, i) =>
      orient({
        ...s,
        leftM: lefts[i] as number,
        rightM: rights[i] as number,
      }),
    );
  };

  for (const ways of groups.values()) {
    // one marking piece per (way, area section) of the road
    const pieces: (MarkingSample & { cl: LineFeature })[] = [];
    for (const w of ways)
      for (const s of samplesOf.get(w) ?? []) pieces.push({ cl: w, ...s });
    if (pieces.length === 0) continue;
    // ONE spline per (group, area) covering ALL the group's ways in
    // that area - a road split mid-block gets a seamless spline; each
    // piece keeps the sub-range of samples lying on ITS way
    const splineByArea = new Map<AreaFeature, (SplineSampleInfo & { cl: LineFeature })[]>();
    for (const p of pieces) {
      if (splineByArea.has(p.area)) continue;
      const groupWays = ways.filter((w) =>
        (samplesOf.get(w) ?? []).some((s) => s.area === p.area),
      );
      if (groupWays.length === 0) continue;
      splineByArea.set(p.area, chainSplines(groupWays, p.area));
    }
    for (const p of pieces) {
      const sp = splineByArea.get(p.area);
      if (!sp) continue;
      // CONTIGUOUS index range of the spline samples owned by this way;
      // the samples of the neighboring ways (same area) pad the range by
      // one sample on each side so the drawn boundary MEETS the neighbor
      // piece's — without the padding, a one-sample gap (~4 m) would open
      // at every way seam inside one area
      let lo = -1,
        hi = -1;
      for (let i = 0; i < sp.length; i++) {
        if (sp[i].cl !== p.cl) continue;
        if (lo < 0) lo = i;
        hi = i;
      }
      if (lo < 0) continue;
      const pad = (i: number): boolean =>
        i >= 0 && i < sp.length && sp[i].cl !== p.cl;
      const from = pad(lo - 1) ? lo - 1 : lo;
      const to = pad(hi + 1) ? hi + 1 : hi;
      p.spline = sp.slice(from, to + 1).map((s) => ({
        pt: s.pt,
        nx: s.nx,
        ny: s.ny,
        leftM: s.leftM,
        rightM: s.rightM,
      }));
    }
    // FIT THE ROAD MODEL per piece: an extruded rectangle with the
    // piece's units (traffic lanes + parking strips), evenly sized,
    // centered on the mapped centerline and shifted sideways to maximize
    // covered highway area minus spill outside it. The fitted rectangle
    // REPLACES the piece's measured span: the layout no longer follows
    // boundary dents (bus platforms, cutouts) — one straight extrusion
    // per piece is the robust shape the OSM area actually describes,
    // and the lateral shift aligns the mapped centerline with the road's
    // true center where the mapper jogged it
    for (const p of pieces) {
      const units =
        p.cl.lanes! +
        (p.cl.parkingLeft ? 1 : 0) +
        (p.cl.parkingRight ? 1 : 0);
      const sp = p.spline;
      if (!sp || sp.length < 2) continue;
      const { w, s: shift } = fitRoadRectangle(sp, units);
      if (!(w > 0) || !isFinite(w) || !isFinite(shift)) continue;
      p.fitW = w;
      p.fitShift = shift;
    }
    // FITTED edges of the piece's road-model rectangle, in the mapped-
    // centerline meters-left convention (shift + h / h - shift); pieces
    // without a fit keep their measured edges
    const fitLeftM = (p: MarkingSample & { cl: LineFeature }): number =>
      p.fitW !== undefined
        ? p.fitShift! + (unitsOf(p) * p.fitW) / 2
        : p.leftM;
    const fitRightM = (p: MarkingSample & { cl: LineFeature }): number =>
      p.fitW !== undefined
        ? (unitsOf(p) * p.fitW) / 2 - p.fitShift!
        : p.rightM;
    const unitsOf = (p: MarkingSample & { cl: LineFeature }): number =>
      p.cl.lanes! +
      (p.cl.parkingLeft ? 1 : 0) +
      (p.cl.parkingRight ? 1 : 0);
    // fitted unit width of the piece's road-model rectangle (falling
    // back to the even split of its measured width when no spline fit
    // succeeded); the layout is the FIT, not the boundary measurement
    const laneWOf = (p: MarkingSample & { cl: LineFeature }): number =>
      p.fitW ?? (p.leftM + p.rightM) / unitsOf(p);
    // the through-lane width when the parking strips absorb the remaining
    // road width instead of narrowing the traffic lanes: total minus one
    // parking unit per side, split over the traffic lanes
    const trafficLaneWOf = (p: MarkingSample & { cl: LineFeature }): number => {
      const park = (p.cl.parkingLeft ? 1 : 0) + (p.cl.parkingRight ? 1 : 0);
      const unitsW = laneWOf(p);
      return (fitLeftM(p) + fitRightM(p) - park * unitsW) / p.cl.lanes!;
    };
    // left traffic edge of a piece (its parking lane virtually removed)
    const trafficLeftM = (p: MarkingSample & { cl: LineFeature }): number =>
      fitLeftM(p) - (p.cl.parkingLeft ? laneWOf(p) : 0);
    // continuity anchor in METERS: the position of the direction border
    // (solid line between forward and backward lanes), or — on purely
    // one-way roads — the left edge of the leftmost lane. The solid border
    // is the visually dominant line: keeping it at the same offset across
    // pieces (median of the pieces' natural positions) is what makes the
    // markings read as continuous; lane widths themselves are per piece
    const borderPieces = pieces.filter((p) => {
      const f = fwdOf(p.cl);
      return f > 0 && f < p.cl.lanes!;
    });
    const anchorBorder = borderPieces.length > 0;
    // bidirectional roads: one shared border anchor (median of the
    // pieces' natural border positions). One-way roads have no border:
    // every piece anchors on its OWN measured left road edge — pure
    // geometry, following the actual road outline, which is continuous
    // where the ways meet (placement=* tags are ignored). The lane width
    // is shared across the whole road group as the MINIMUM of the pieces'
    // even-split widths, so the through lanes fit the narrowest piece
    // (where parking eats into the width): the divider runs at the same
    // distance from the road edge on every piece, all units stay visible,
    // and wider pieces leave their extra width unpainted
    let anchorOf: (p: MarkingSample & { cl: LineFeature }) => number;
    // one-way roads: which side of the road the block is anchored on
    // ("left" | "right" | "center"), decided by where the road grows
    let anchorKind: "left" | "right" | "center" = "left";
    let laneWShared: (p: MarkingSample & { cl: LineFeature }) => number =
      laneWOf;
    if (anchorBorder) {
      // right-hand traffic: traffic in the way's (forward) direction
      // keeps RIGHT of the direction border, oncoming traffic LEFT. The
      // border sits fwd lanes from the RIGHT ROAD edge - not the traffic
      // edge, so parking strips on the right do not shift the border;
      // pieces whose right parking differs still align
      const anchorM = median(
        borderPieces.map((p) => {
          const park = p.cl.parkingRight ? laneWOf(p) : 0;
          return fitRightM(p) - park - fwdOf(p.cl) * laneWOf(p);
        }),
      );
      anchorOf = () => anchorM;
      // ONE through-lane width across the whole group: the minimum of
      // the pieces' traffic-lane widths (each piece's road width minus
      // its parking units, split over its lanes). Every lane boundary
      // then sits at border + k*laneW - identical on all pieces, so the
      // markings are fully continuous even where parking changes; the
      // parking strips absorb each piece's remaining width
      {
        const w = Math.min(...pieces.map(trafficLaneWOf));
        laneWShared = () => w;
      }
    } else {
      // which side does the road GROW on along the group? Compare the
      // pieces' measured edges: when the lane count rises from one piece
      // to the next, the extra units sit on the side whose measured edge
      // moved further out. Lanes added on the RIGHT (left edge roughly
      // constant) anchor on the LEFT edge, so the left lanes continue;
      // lanes added on the LEFT anchor on the RIGHT edge, so the right
      // lanes continue; lanes added on BOTH sides (centerline stays)
      // anchor on the centerline itself, continuous outwards from it
      // the growth-side analysis needs the MEASURED road edges: each
      // piece's FIT spans only its own units (a 2-lane piece's rectangle
      // is narrower than a 5-lane piece's), so comparing fitted edges
      // would misread the unit-count change as road growth. The measured
      // edges span the full area at each piece — the objective geometry
      const edges = pieces.map((p) => ({ l: trafficLeftM(p), r: p.rightM }));
      // max edge movement between any two pieces
      let dl = 0,
        dr = 0;
      for (const a of edges)
        for (const b of edges) {
          if (a.l - b.l > dl) dl = a.l - b.l;
          if (b.l - a.l > dl) dl = b.l - a.l;
          if (a.r - b.r > dr) dr = a.r - b.r;
          if (b.r - a.r > dr) dr = b.r - a.r;
        }
      // a piece's traffic block is laid FROM the anchor edge; the anchor
      // edge is the one that did NOT move (the continuous side)
      const rightTrafficM = (p: MarkingSample & { cl: LineFeature }): number =>
        p.rightM - (p.cl.parkingRight ? laneWOf(p) : 0);
      // the LEFT edge moved much more than the right -> the road grew LEFT
      // (added lanes sit on the left); symmetric for the right
      const anchorLeftCase = dl > dr + 0.75;
      const anchorRightCase = dr > dl + 0.75;
      if (anchorLeftCase) {
        // the right edge stayed: lanes were added on the LEFT, the block
        // extends leftwards from the right traffic edge
        anchorKind = "right";
        anchorOf = (p) => rightTrafficM(p);
      } else if (anchorRightCase) {
        // the left edge stayed: lanes were added on the RIGHT, the block
        // extends rightwards from the left traffic edge
        anchorKind = "left";
        anchorOf = (p) => trafficLeftM(p);
      } else {
        // both sides expanded: anchor on the centerline
        anchorKind = "center";
        anchorOf = () => 0;
      }
      // ONE through-lane width across the whole group: the minimum of
      // the pieces' traffic-lane widths (each piece's road width minus
      // its parking units, split over its lanes). The lanes fit the
      // narrowest piece; wider pieces leave their extra width to the
      // parking strips / unpainted. Boundaries sit at k*laneW from the
      // growth-side anchor, continuous across the whole group
      {
        const w = Math.min(...pieces.map(trafficLaneWOf));
        laneWShared = () => w;
      }
    }
    // junction adjacency + lane clipping for the stop line boundary
    const junctionAreasStop = areas.filter((a) => a.junction);
    const findJunctionForStopLine = (
      road: AreaFeature,
      sigQ: number[] | undefined,
    ): AreaFeature | null => {
      let best: AreaFeature | null = null;
      let bestD = Infinity;
      for (const ja of junctionAreasStop) {
        if (!bboxOverlap(ja.bbox, road.bbox)) continue;
        const chains = sharedBoundaryQ(road, ja, 10);
        if (chains.length === 0) continue;
        if (!sigQ) return ja;
        let d = Infinity;
        for (const chain of chains)
          for (const pt of chain) {
            const dd = (pt[0] - sigQ[0]) ** 2 + (pt[1] - sigQ[1]) ** 2;
            if (dd < d) d = dd;
          }
        if (d < bestD) {
          bestD = d;
          best = ja;
        }
      }
      return best;
    };
    /**
     * Clip the shared-boundary polyline to the stopping half of the road:
     * project each boundary point onto the way's normal at its nearest
     * way vertex; keep the points whose lateral offset falls in the
     * requested half (right = forward lanes, left = backward lanes of a
     * bidirectional block). Without a half, the full boundary passes.
     */
    const clipBoundaryToLanes = (
      boundary: number[][],
      cl: LineFeature,
      laneLeftM: number,
      laneW: number,
      half: "left" | "right" | undefined,
    ): number[][] => {
      if (!half) return boundary;
      // lateral midline of the block in meters-left convention:
      // block spans laneLeftM (left edge) .. laneLeftM - lanes*laneW
      const blockRight = laneLeftM - cl.lanes! * laneW;
      const mid = (laneLeftM + blockRight) / 2;
      // lateral meters-left of a point: project onto the normal of the
      // nearest way segment (positive = left of the way)
      const leftMOf = (pt: number[]): number => {
        let bi = 0,
          bd = Infinity;
        for (let i = 0; i < cl.coords.length; i++) {
          const d =
            (pt[0] - cl.coords[i][0]) ** 2 + (pt[1] - cl.coords[i][1]) ** 2;
          if (d < bd) {
            bd = d;
            bi = i;
          }
        }
        const a = cl.coords[Math.max(0, bi - 1)];
        const b = cl.coords[Math.min(cl.coords.length - 1, bi + 1)];
        const dx = b[0] - a[0],
          dy = b[1] - a[1];
        const l = Math.hypot(dx, dy);
        if (l === 0) return 0;
        const nx = -dy / l,
          ny = dx / l;
        const vx = pt[0] - cl.coords[bi][0],
          vy = pt[1] - cl.coords[bi][1];
        const latQ = vx * nx + vy * ny;
        const mPerLon =
          (111_320 * Math.cos(((pt[1] / 1e7) * Math.PI) / 180)) / 1e7;
        const mPerLat = 111_320 / 1e7;
        return Math.hypot(nx * mPerLon, ny * mPerLat) * latQ;
      };
      const inHalf = (pt: number[]): boolean => {
        const lm = leftMOf(pt);
        return half === "right" ? lm <= mid : lm >= mid;
      };
      // walk the polyline: keep in-half points and SPLIT edges that cross
      // the midline at the crossing point, so the half boundary is closed
      const out: number[][] = [];
      for (let i = 0; i < boundary.length; i++) {
        const pt = boundary[i];
        if (inHalf(pt)) {
          out.push(pt);
        }
        // edge to the next point: if it crosses the midline, add the
        // intersection
        if (i + 1 < boundary.length) {
          const nx2 = boundary[i + 1];
          const s0 = leftMOf(pt) - mid,
            s1 = leftMOf(nx2) - mid;
          if (s0 > 0 !== s1 > 0 && s0 !== 0 && s1 !== 0) {
            const t = s0 / (s0 - s1);
            out.push([
              Math.round(pt[0] + (nx2[0] - pt[0]) * t),
              Math.round(pt[1] + (nx2[1] - pt[1]) * t),
            ]);
          }
        }
      }
      return out;
    };
    for (const p of pieces) {
      const fwd = fwdOf(p.cl);
      const laneW = laneWShared(p);
      // the stop line belongs to the piece whose area section contains
      // the signal node (within ~3 m tolerance)
      // the signal node itself often sits inside the JUNCTION area, which
      // never produces marking pieces and would clip the line away. Walk
      // from the signal node along the way towards the traffic that stops
      // (an END signal: walk backwards; a START signal: forwards) until a
      // vertex of THIS piece's area is reached - the stop line goes there,
      // at the mouth of the junction on the entering carriageway
      // signals resolved to this piece's area section carry their stop
      // lines here - ONE PER SIGNAL NODE (a road between two signalized
      // junctions carries two); other areas' stop lines belong to their
      // own pieces
      const pieceSignals = (stopLineResolved.get(p.cl) ?? []).filter(
        (sl) => sl.area === p.area,
      );
      let laneLeftM: number;
      let bidirectional = false;
      if (fwd > 0 && fwd < p.cl.lanes!) {
        // bidirectional, right-hand traffic: the anchor is the direction
        // border (fwd lanes from the right traffic edge); forward lanes
        // occupy the right half (from the border to the right edge),
        // backward lanes the left half. laneLeftM is the block's LEFT
        // edge = border + fwd*laneW (meters-LEFT-positive: the border is
        // anchorM meters right of the centerline, so its left-positive
        // value is -anchorM). The border keeps its shared offset; the
        // clamp below treats the piece WITHOUT the parking reservation
        laneLeftM = -anchorOf(p) + fwd * laneW;
        bidirectional = true;
      } else if (anchorKind === "left") {
        // lanes added on the right: the LEFT edge is continuous, the
        // block extends rightwards from it
        laneLeftM = anchorOf(p);
      } else if (anchorKind === "right") {
        // lanes added on the left: the RIGHT edge is continuous, the
        // block extends leftwards from the right traffic edge
        laneLeftM = anchorOf(p) - p.cl.lanes! * laneW;
      } else {
        // both sides expanded: the centerline stays, lanes run
        // continuously outwards from it
        laneLeftM = anchorOf(p) - (p.cl.lanes! * laneW) / 2;
      }
      // clamp so markings never extend past the road edge. BIDIRECTIONAL
      // pieces clamp into their FITTED rectangle — the border continuity
      // is the fit's product and the rectangle is where the road is.
      // ONE-WAY pieces clamp into their MEASURED span instead: there the
      // outermost lane carries the continuity (anchored on the measured
      // road edge), and a narrow fitted rectangle (fewer units than the
      // area holds, e.g. a 2-lane way across a wide mouth) must not
      // cut the anchored outer lane off the road
      const blockW = p.cl.lanes! * laneW;
      const parkLeft = bidirectional ? 0 : p.cl.parkingLeft ? laneW : 0;
      const parkRight = bidirectional ? 0 : p.cl.parkingRight ? laneW : 0;
      const minLeft = bidirectional
        ? blockW + parkRight - fitRightM(p)
        : blockW + parkRight - p.rightM;
      const maxLeft = bidirectional
        ? fitLeftM(p) - parkLeft
        : p.leftM - parkLeft;
      if (laneLeftM < minLeft) laneLeftM = minLeft;
      if (laneLeftM > maxLeft) laneLeftM = maxLeft;
      // stop line geometry, ONE PER SIGNAL NODE on this piece: start at
      // the signal node, find the intersection (junction area) at it, and
      // take the shared-boundary chain that CONTAINS the node - the
      // intersection alone shapes the stop line, laterally clipped to
      // the lanes flowing into that signal (forward = right half of the
      // block, backward = left half; one-way: the full boundary)
      const stopLinesQ: Q[][][] = [];
      for (const sl of pieceSignals) {
        // which direction does the signal FACE? traffic_signals:direction
        // on the node wins (forward = along the way, backward = against);
        // a one-way way flows in its own direction only, so a
        // backward-facing signal on it is ignored
        let effectiveSide: "start" | "mid" | "end" | undefined = sl.side;
        if (sl.sigDir) {
        if (sl.sigDir === "forward") effectiveSide = "end";
        else if (sl.sigDir === "backward") {
          // a backward-facing signal stops the backward lanes; on a
          // one-way road nothing flows backward -> no stop line
          effectiveSide = bidirectional ? "start" : undefined;
        }
        // "both" keeps the node-position side (mid stays full width)
      }
        // a one-way road at its START flows AWAY from the signal: the
        // stop line belongs to the opposite carriageway, not here
        if (!bidirectional && effectiveSide === "start") {
          effectiveSide = undefined;
        }
        if (!effectiveSide) continue;
        const sigQ = p.cl.coords[sl.sigIdx];
        // the intersection AT the signal node: the junction area containing
        // the node itself; among junctions sharing a boundary with this
        // piece's area, the one whose shared chain is nearest to the node
        const ja = findJunctionForStopLine(p.area, sigQ);
        if (!ja) continue;
        // only the chain containing the signal node - a junction touching
        // the road area at several places must never contribute a far
        // chain; if no chain lies within ~100 m of the node, the signal
        // does not sit at this intersection at all
        const boundary = stopLineChainNear(p.area, ja, sigQ, 100000000);
        if (!boundary || boundary.length < 2) continue;
        const clipHalf = bidirectional && effectiveSide !== "mid";
        const fwdSide = effectiveSide === "end";
        const clipped = clipBoundaryToLanes(
          boundary,
          p.cl,
          laneLeftM,
          laneW,
          clipHalf ? (fwdSide ? "right" : "left") : undefined,
        ) as Q[][];
        if (clipped.length >= 2) stopLinesQ.push(clipped);
      }
      laneMarkings.push({
        ...p.cl,
        // the marking lives on the area's layer (bird's-eye stacking, selector
        // filtering); fall back to the centerline's layer when equal
        layer: p.area.layer,
        laneW,
        laneLeftM,
        laneRightM: laneLeftM + p.cl.lanes! * laneW,
        roadLeftM: fitLeftM(p),
        roadRightM: fitRightM(p),
        spline: p.spline,
        lanesFwd: fwd,
        areaIds: [p.area.id],
        stopLinesQ: stopLinesQ.length > 0 ? stopLinesQ : undefined,
      });
    }
  }
  // drop centerlines that are already represented by a corresponding area
  // (same highway type, same layer): the area fill replaces the line.
  onProgress?.(85, "filtering centerlines covered by areas…");
  const areaGrid2 = buildAreaIndex(areas);
  const keptCenterlines: LineFeature[] = [];
  for (const cl of centerlines) {
    const mid = cl.coords[Math.floor(cl.coords.length / 2)];
    let covered = false;
    const candidates = queryAreas(areaGrid2, cl.bbox);
    for (const area of candidates) {
      if (area.layer !== cl.layer) continue;
      if (!highwayTypesCompatible(cl.highway, area.highway)) continue;
      if (!bboxOverlap(area.bbox, cl.bbox)) continue;
      if (pointInAreaQ(mid, area)) {
        covered = true;
        break;
      }
    }
    if (!covered) keptCenterlines.push(cl);
  }
  const droppedCenterlines = centerlines.length - keptCenterlines.length;
  // replace contents in place (no spread — avoids stack overflow on large arrays)
  centerlines.length = 0;
  for (let i = 0; i < keptCenterlines.length; i++)
    centerlines[i] = keptCenterlines[i];
  void droppedCenterlines;

  // assign each crossing to the highway area it lies in: the crossing band
  // and its markings are clipped to that area at draw time, so they follow
  // the (possibly curved) street boundary and never overlap sidewalks,
  // kerbs or other adjacent objects.
  onProgress?.(88, "assigning crossings to highway areas…");
  const areaGrid3 = buildAreaIndex(areas);
  for (const cr of crossings) {
    const candidates = queryAreas(areaGrid3, cr.bbox);
    // midpoint of the middle segment (a vertex can sit exactly on an area
    // boundary, where point-in-polygon is ambiguous)
    const ci = Math.floor(cr.coords.length / 2);
    const mid = [
      (cr.coords[ci][0] + cr.coords[ci - 1][0]) / 2,
      (cr.coords[ci][1] + cr.coords[ci - 1][1]) / 2,
    ];
    // a crossing may lie in MULTIPLE areas (a road polygon split into
    // sections): clip against all of them; prefer same-layer areas, fall
    // back to the highest-layer containing area (crossings are often
    // untagged while their area carries layer=*); the crossing adopts that
    // area's layer so bird's-eye stacking paints it with its area instead
    // of being occluded by it
    const matching: AreaFeature[] = [];
    for (const area of candidates) {
      if (!bboxOverlap(area.bbox, cr.bbox)) continue;
      if (!pointInAreaTolQ2(mid, area)) continue;
      matching.push(area);
    }
    if (matching.length > 0) {
      const sameLayer = matching.filter((a) => a.layer === cr.layer);
      const pick = sameLayer.length > 0 ? sameLayer : matching;
      let top = pick[0];
      for (const a of pick) if (a.layer > top.layer) top = a;
      cr.areaIds = pick.map((a) => a.id);
      cr.layer = top.layer;
    }
  }

  // a feature without surface takes the surface of the LARGEST adjacent
  // highway area (by bbox area of the touching/overlapping polygon);
  // adjacent means the rings share at least one vertex
  const areaGridP = buildAreaIndex(areas);
  const inheritFromAdjacent = (
    feats: {
      surface?: string;
      surfaceColour?: string;
      outer: Q[][][];
      bbox: [number, number, number, number];
    }[],
  ): void => {
    for (const f of feats) {
      if (f.surface) continue;
      const candidates = queryAreas(areaGridP, f.bbox);
      let best: AreaFeature | null = null;
      let bestArea = -1;
      for (const area of candidates) {
        if (!area.surface) continue;
        if (!bboxOverlap(area.bbox, f.bbox)) continue;
        // adjacent: rings touch or overlap; a shared point is enough
        let touches = false;
        outer: for (const fRing of f.outer) {
          for (const aRing of area.outer) {
            for (const p1 of fRing) {
              for (const p2 of aRing) {
                if (p1[0] === p2[0] && p1[1] === p2[1]) {
                  touches = true;
                  break outer;
                }
              }
            }
          }
        }
        if (!touches) continue;
        const a = (area.bbox[2] - area.bbox[0]) * (area.bbox[3] - area.bbox[1]);
        if (a > bestArea) {
          bestArea = a;
          best = area;
        }
      }
      if (best) {
        f.surface = best.surface;
        f.surfaceColour = f.surfaceColour ?? best.surfaceColour;
      }
    }
  };
  // parking without surface: assume the surface of the largest adjacent
  // highway area
  inheritFromAdjacent(parking);
  // service highway areas without surface: the same rule — a parking lot or
  // driveway mapped as area:highway=service takes the surface of the road
  // area it is adjacent to (the centerline donation below only fires for a
  // centerline running entirely INSIDE the area, which service areas
  // rarely have)
  // service highway areas without surface: the same rule — a parking lot or
  // driveway mapped as area:highway=service takes the surface of the road
  // area it is adjacent to. Only for areas with NO compatible centerline
  // passing through (a centerline inside defines the surface, and its
  // absence is what makes the adjacency fallback meaningful). Footway
  // areas never inherit by adjacency: a sidewalk next to a road is not
  // made of the road's asphalt
  inheritFromAdjacent(
    areas.filter((a) => a.highway === "service" && !areasWithCenterline.has(a)),
  );

  // collect all layer values
  const layerSet = new Set<number>();
  for (const a of areas) layerSet.add(a.layer);
  for (const b of buildings) layerSet.add(b.layer);
  for (const g of grass) layerSet.add(g.layer);
  for (const c of centerlines) layerSet.add(c.layer);
  for (const f of footways) layerSet.add(f.layer);
  for (const c of crossings) layerSet.add(c.layer);
  for (const k of kerbWays) layerSet.add(k.layer);
  for (const b of bollards) layerSet.add(b.layer);
  for (const f of fences) layerSet.add(f.layer);
  for (const l of landuse) layerSet.add(l.layer);
  for (const sl of streetLamps) layerSet.add(sl.layer);
  for (const pk of parking) layerSet.add(pk.layer);
  for (const mh of manholes) layerSet.add(mh.layer);
  for (const k of kerbs) layerSet.add(k.layer);
  const layers = [...layerSet].sort((a, b) => a - b);

  // collect all level values (only features with an explicit level=*)
  const levelSet = new Set<number>();
  for (const arr of [
    areas,
    buildings,
    grass,
    centerlines,
    footways,
    crossings,
    kerbWays,
    kerbs,
    bollards,
    fences,
    landuse,
    streetLamps,
    parking,
    manholes,
  ]) {
    for (const f of arr) if (f.level !== undefined) levelSet.add(f.level);
  }
  const levels = [...levelSet].sort((a, b) => a - b);

  // compute overall bounds
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const expand = (b: [number, number, number, number]) => {
    if (b[0] < minX) minX = b[0];
    if (b[1] < minY) minY = b[1];
    if (b[2] > maxX) maxX = b[2];
    if (b[3] > maxY) maxY = b[3];
  };
  for (const a of areas) expand(a.bbox);
  for (const b of buildings) expand(b.bbox);
  for (const g of grass) expand(g.bbox);
  for (const c of centerlines) expand(c.bbox);
  for (const f of footways) expand(f.bbox);
  for (const c of crossings) expand(c.bbox);
  for (const k of kerbs) {
    if (k.lon < minX) minX = k.lon;
    if (k.lat < minY) minY = k.lat;
    if (k.lon > maxX) maxX = k.lon;
    if (k.lat > maxY) maxY = k.lat;
  }
  for (const k of kerbWays) expand(k.bbox);
  for (const f of fences) expand(f.bbox);
  for (const l of landuse) expand(l.bbox);
  for (const pk of parking) expand(pk.bbox);
  for (const mh of manholes) {
    if (mh.lon < minX) minX = mh.lon;
    if (mh.lat < minY) minY = mh.lat;
    if (mh.lon > maxX) maxX = mh.lon;
    if (mh.lat > maxY) maxY = mh.lat;
  }
  for (const sl of streetLamps) {
    if (sl.lon < minX) minX = sl.lon;
    if (sl.lat < minY) minY = sl.lat;
    if (sl.lon > maxX) maxX = sl.lon;
    if (sl.lat > maxY) maxY = sl.lat;
  }
  for (const b of bollards) {
    if (b.lon < minX) minX = b.lon;
    if (b.lat < minY) minY = b.lat;
    if (b.lon > maxX) maxX = b.lon;
    if (b.lat > maxY) maxY = b.lat;
  }

  onProgress?.(
    100,
    `done (${areas.length} areas, ${centerlines.length} centerlines (-${droppedCenterlines} covered), ${crossings.length} crossings, ${kerbs.length + kerbWays.length} kerbs)`,
  );

  return {
    areas,
    buildings,
    grass,
    centerlines,
    footways,
    crossings,
    kerbs,
    kerbWays,
    bollards,
    fences,
    landuse,
    streetLamps,
    parking,
    manholes,
    laneMarkings,
    stopLines,
    layers,
    levels,
    bounds: [minX, minY, maxX, maxY],
  };
}

// ---- grid index over areas (1e-7 units, ~500m cells) ----

const AREA_CELL = 50000;

function buildAreaIndex(areas: AreaFeature[]): Map<string, AreaFeature[]> {
  const grid = new Map<string, AreaFeature[]>();
  for (const a of areas) {
    const [minX, minY, maxX, maxY] = a.bbox;
    const x0 = Math.floor(minX / AREA_CELL),
      x1 = Math.floor(maxX / AREA_CELL);
    const y0 = Math.floor(minY / AREA_CELL),
      y1 = Math.floor(maxY / AREA_CELL);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`;
        let arr = grid.get(key);
        if (!arr) grid.set(key, (arr = []));
        arr.push(a);
      }
    }
  }
  return grid;
}

function queryAreas(
  grid: Map<string, AreaFeature[]>,
  bbox: [number, number, number, number],
): AreaFeature[] {
  const [minX, minY, maxX, maxY] = bbox;
  const seen = new Set<AreaFeature>();
  const out: AreaFeature[] = [];
  const x0 = Math.floor(minX / AREA_CELL) - 1,
    x1 = Math.floor(maxX / AREA_CELL) + 1;
  const y0 = Math.floor(minY / AREA_CELL) - 1,
    y1 = Math.floor(maxY / AREA_CELL) + 1;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const arr = grid.get(`${x},${y}`);
      if (!arr) continue;
      for (const a of arr) {
        if (!seen.has(a)) {
          seen.add(a);
          out.push(a);
        }
      }
    }
  }
  return out;
}
