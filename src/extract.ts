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

/** area:highway types that are NOT roads for the ray-hit adjacency test:
 *  a boundary shared with a footway/sidewalk area is a plain road edge */
const FOOTWAY_AREA_TYPES = new Set([
  "footway",
  "sidewalk",
  "path",
  "cycleway",
  "steps",
]);

/** spatial index over an area's OUTER RING SEGMENTS: a quantized-
 *  coordinate grid (the same 50k cells as the area index) so a ray
 *  cast only tests the segments in the cells its ray passes through.
 *  Built ONCE per area (cached by the caller) — without it every cast
 *  scanned every ring segment of the area */
interface SegIndex {
  grid: Map<string, number[][][]>;
}
const SEG_CELL = 50000;
function buildAreaSegIndex(area: AreaFeature): SegIndex {
  const grid = new Map<string, number[][][]>();
  for (const ring of area.outer)
    for (let i = 1; i < ring.length; i++) {
      const seg: number[][] = [ring[i - 1], ring[i]];
      const x0 = Math.floor(Math.min(seg[0][0], seg[1][0]) / SEG_CELL),
        x1 = Math.floor(Math.max(seg[0][0], seg[1][0]) / SEG_CELL);
      const y0 = Math.floor(Math.min(seg[0][1], seg[1][1]) / SEG_CELL),
        y1 = Math.floor(Math.max(seg[0][1], seg[1][1]) / SEG_CELL);
      if (x1 - x0 > 40 || y1 - y0 > 40) continue;
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const k = `${x},${y}`;
          let arr = grid.get(k);
          if (!arr) grid.set(k, (arr = []));
          arr.push(seg);
        }
    }
  return { grid };
}
/** the segments of the area's rings that the ray origin->end passes
 *  through (cell walk) — deduplicated */
function rayCandidateSegs(
  area: AreaFeature,
  segIdx: SegIndex,
  origin: number[],
  end: number[],
): number[][][] {
  const out: number[][][] = [];
  const seen = new Set<number[][]>();
  const x0 = Math.floor(Math.min(origin[0], end[0]) / SEG_CELL),
    x1 = Math.floor(Math.max(origin[0], end[0]) / SEG_CELL);
  const y0 = Math.floor(Math.min(origin[1], end[1]) / SEG_CELL),
    y1 = Math.floor(Math.max(origin[1], end[1]) / SEG_CELL);
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const arr = segIdx.grid.get(`${x},${y}`);
      if (!arr) continue;
      for (const s of arr)
        if (!seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
    }
  return out;
}

/**
 * Road width by RAY SHOOTING: from a point on the centerline, cast one
 * ray along the positive and one along the negative normal; the width
 * at that point is the sum of both ray lengths. A hit only counts when
 * the hit boundary segment is MORE PARALLEL than orthogonal to the
 * centerline (a transverse boundary — the cap at a junction mouth —
 * says nothing about the width), and when the segment is not shared
 * with another area:highway of a road type (a rectangular cutout
 * connected to an adjacent area, typically a junction) unless a kerb
 * way runs along it — the kerb marks the true road edge. Invalid hits
 * make the whole cross-section invalid (null): the caller backtracks
 * along the centerline to find a valid one.
 */
function rayWidthInArea(
  origin: number[],
  tx: number,
  ty: number,
  area: AreaFeature,
  /** spatial index over the area's ring segments, built ONCE per area
   *  — the cast only tests segments in the cells the ray passes
   *  through instead of scanning every ring segment */
  segIdx: SegIndex,
  /** the area's ADJACENT road areas (same layer, shared edge),
   *  precomputed ONCE before the marking phase — the cutout test
   *  probes only these, never a per-hit area scan */
  adjacentRoadAreas: AreaFeature[],
  kerbMarked: (a: number[], b: number[]) => boolean,
  maxM: number,
): { left: number; right: number; valid: boolean } | null {
  if (!pointInAreaQ(origin, area)) return null;
  const mPerLon =
    (111_320 * Math.cos(((origin[1] / 1e7) * Math.PI) / 180)) / 1e7;
  const mPerLat = 111_320 / 1e7;
  const COS45 = Math.SQRT1_2;
  const cast = (dir: number): { d: number; ok: boolean } | null => {
    let end = [
      origin[0] + ((dir * -ty) / mPerLon) * maxM,
      origin[1] + ((dir * tx) / mPerLat) * maxM,
    ];
    // CLIP the ray to the area's bbox: no hit can lie beyond it, and
    // the cell walk then covers only the few cells between the origin
    // and the near boundary instead of the whole maxRay length
    {
      const [bx0, by0, bx1, by1] = area.bbox;
      const dx = end[0] - origin[0],
        dy = end[1] - origin[1];
      let tMax = Infinity;
      if (dx > 0) tMax = Math.min(tMax, (bx1 - origin[0]) / dx);
      else if (dx < 0) tMax = Math.min(tMax, (bx0 - origin[0]) / dx);
      if (dy > 0) tMax = Math.min(tMax, (by1 - origin[1]) / dy);
      else if (dy < 0) tMax = Math.min(tMax, (by0 - origin[1]) / dy);
      if (tMax < 1)
        end = [origin[0] + dx * tMax, origin[1] + dy * tMax];
    }
    let bestD = Infinity;
    let bestSeg: [number[], number[]] | null = null;
    for (const seg of rayCandidateSegs(area, segIdx, origin, end)) {
      const a = seg[0],
        b = seg[1];
      const ip = segIntersect(origin, end, a, b);
      if (!ip) continue;
      const d = Math.hypot(
        (ip[0] - origin[0]) * mPerLon,
        (ip[1] - origin[1]) * mPerLat,
      );
      if (d < bestD) {
        bestD = d;
        bestSeg = [a, b];
      }
    }
    if (!bestSeg || bestD <= 0.01) return null;
    const [a, b] = bestSeg;
    const sx = (b[0] - a[0]) * mPerLon,
      sy = (b[1] - a[1]) * mPerLat;
    const sl = Math.hypot(sx, sy);
    if (sl === 0) return null;
    // the hit segment must be more parallel than orthogonal to the road
    if (Math.abs((sx * tx + sy * ty) / sl) <= COS45) return { d: bestD, ok: false };
    // a hit segment shared with another area:highway of a road type is a
    // cutout towards that area (typically a junction) — valid only when
    // a kerb way marks the true road edge along it. The adjacency was
    // BUILT ONCE (same layer, genuinely shared edge — several probes
    // along the ring segment lie on the other area's boundary), so the
    // per-hit test only re-probes the hit segment against the area's
    // short neighbour list
    const probes = [0.2, 0.5, 0.8].map((t) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
    ]);
    const shared = adjacentRoadAreas.some(
      (oa) =>
        probes.filter((p) => pointOnAreaBoundaryQ(p, oa, 150)).length >= 2,
    );
    if (shared && !kerbMarked(a, b)) return { d: bestD, ok: false };
    return { d: bestD, ok: true };
  };
  const left = cast(1);
  if (left === null) return null;
  const right = cast(-1);
  if (right === null) return null;
  return {
    left: left.d,
    right: right.d,
    valid: left.ok && right.ok,
  };
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
    /** measured distance to the left/right area edge, meters — relative
     *  to the MIDDLE LINE (the sample sits on it): the half-width on
     *  each side */
    leftM: number;
    rightM: number;
    /** lateral offset of the middle line from the MAPPED centerline, in
     *  meters (positive = left of the way) — the spline points are the
     *  way points shifted by this along the sample normal */
    midM?: number;
    /** index of the chain line-segment the sample projects onto */
    seg?: number;
    /** arc-length position of the sample on the chain (internal) */
    tArc?: number;
    /** fitted edges of the segment's road-model rectangle, meters */
    fitLeftM?: number;
    fitRightM?: number;
    /** RAW measured edges before the outlier/dent repair — the honest
     *  geometry the rectangle fit consumes (dents show as smaller
     *  fitted rectangles); leftM/rightM stay the repaired values the
     *  markings layout uses */
    rawLeftM?: number;
    rawRightM?: number;
    /** the owning way was traversed REVERSED by the chain: the sample's
     *  values are in the WAY's frame, so the piece's sample array must be
     *  reversed to match the renderer's array-order normals */
    rev?: boolean;
  }
  interface MarkingSample {
    area: AreaFeature;
    leftM: number;
    rightM: number;
    /** densified spline centerline of the piece, sampled ~4 m, with per-sample
     *  measured road edges and the fitted edges of the per-segment road-model
     *  rectangles (fitLeftM/fitRightM) */
    spline?: SplineSampleInfo[];
  }
  // context the RAY HIT FILTER needs, built ONCE before the marking
  // phase: the ADJACENCY of the road-type highway areas (same layer,
  // genuinely shared edge — the cutout test probes only the area's
  // short neighbour list, never all areas per hit) and a spatial
  // index over the kerb way segments (a hit segment carrying a kerb
  // marks the true road edge even where another road area attaches)
  onProgress?.(72, "building road-area adjacency…");
  const allRoadAreas = areas.filter(
    (a) => !a.junction && !FOOTWAY_AREA_TYPES.has(a.highway),
  );
  // bbox grid over the road areas: candidate pairs come from the same
  // or neighbouring grid cells only
  const roadAreaGrid = buildAreaIndex(allRoadAreas);
  const adjacencyOf = new Map<AreaFeature, AreaFeature[]>();
  for (const a of allRoadAreas) adjacencyOf.set(a, []);
  for (const a of allRoadAreas) {
    // candidates: road areas whose bbox overlaps a's bbox (grid query)
    const cands = queryAreas(roadAreaGrid, a.bbox);
    for (const b of cands) {
      if (b === a) continue;
      if (b.layer !== a.layer) continue;
      if (adjacencyOf.get(b)!.includes(a)) continue; // pair done
      // genuinely SHARED EDGE: a ring segment of a whose interior
      // probes lie on b's boundary (and vice versa is implied by the
      // same shared geometry)
      let shared = false;
      outer: for (const ring of a.outer) {
        for (let i = 1; i < ring.length; i++) {
          const p1 = ring[i - 1],
            p2 = ring[i];
          // skip degenerate segments
          if (p1[0] === p2[0] && p1[1] === p2[1]) continue;
          const probes = [0.25, 0.5, 0.75].map((t) => [
            p1[0] + (p2[0] - p1[0]) * t,
            p1[1] + (p2[1] - p1[1]) * t,
          ]);
          if (
            probes.filter((p) => pointOnAreaBoundaryQ(p, b, 150)).length >= 2
          ) {
            shared = true;
            break outer;
          }
        }
      }
      if (shared) {
        adjacencyOf.get(a)!.push(b);
        adjacencyOf.get(b)!.push(a);
      }
    }
  }
  // spatial index over the kerb way segments (quantized-coordinate
  // grid; cells of the same 50k grid as the area index)
  const kerbSegGrid = new Map<string, { a: number[]; b: number[] }[]>();
  for (const kw of kerbWays)
    for (let i = 1; i < kw.coords.length; i++) {
      const seg = { a: kw.coords[i - 1], b: kw.coords[i] };
      const x0 = Math.floor(Math.min(seg.a[0], seg.b[0]) / AREA_CELL),
        x1 = Math.floor(Math.max(seg.a[0], seg.b[0]) / AREA_CELL);
      const y0 = Math.floor(Math.min(seg.a[1], seg.b[1]) / AREA_CELL),
        y1 = Math.floor(Math.max(seg.a[1], seg.b[1]) / AREA_CELL);
      if (x1 - x0 > 40 || y1 - y0 > 40) continue;
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const k = `${x},${y}`;
          let arr = kerbSegGrid.get(k);
          if (!arr) kerbSegGrid.set(k, (arr = []));
          arr.push(seg);
        }
    }
  // per-area ring-segment index cache: built ONCE per area on first
  // use, reused by every ray cast into that area
  const segIndexCache = new Map<AreaFeature, SegIndex>();
  const segIndexOf = (a: AreaFeature): SegIndex => {
    let idx = segIndexCache.get(a);
    if (!idx) segIndexCache.set(a, (idx = buildAreaSegIndex(a)));
    return idx;
  };
  const kerbAlongShared = (a: number[], b: number[]): boolean => {
    const x0 = Math.floor(Math.min(a[0], b[0]) / AREA_CELL),
      x1 = Math.floor(Math.max(a[0], b[0]) / AREA_CELL);
    const y0 = Math.floor(Math.min(a[1], b[1]) / AREA_CELL),
      y1 = Math.floor(Math.max(a[1], b[1]) / AREA_CELL);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const arr = kerbSegGrid.get(`${x},${y}`);
        if (!arr) continue;
        for (const k of arr) {
          if (
            Math.min(k.a[0], k.b[0]) <= Math.max(a[0], b[0]) + 1 &&
            Math.max(k.a[0], k.b[0]) >= Math.min(a[0], b[0]) - 1 &&
            Math.min(k.a[1], k.b[1]) <= Math.max(a[1], b[1]) + 1 &&
            Math.max(k.a[1], k.b[1]) >= Math.min(a[1], b[1]) - 1 &&
            distToSegQ2(a[0], a[1], k.a, k.b) < 100 * 100 &&
            distToSegQ2(b[0], b[1], k.a, k.b) < 100 * 100
          )
            return true;
        }
      }
    return false;
  };
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
      // ray-shoot the segment-midpoint cross-sections (the group
      // layout keys off these medians): same hit filter + adjacency
      // rule as the per-piece splines
      const measureAt = (
        sample: number[],
        nx: number,
        ny: number,
      ): [number, number] | null => {
        const mPerLon =
          (111_320 * Math.cos(((sample[1] / 1e7) * Math.PI) / 180)) / 1e7;
        const mPerLat = 111_320 / 1e7;
        const tl = Math.hypot(nx * mPerLon, ny * mPerLat);
        const m = rayWidthInArea(
          sample,
          -ny / tl,
          nx / tl,
          area,
          segIndexOf(area),
          adjacencyOf.get(area) ?? [],
          kerbAlongShared,
          maxRay,
        );
        return m ? [m.left, m.right] : null;
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
    // WAY-EXACT sample ownership: the owner of the segment containing
    // arc-length t is the owner of the segment's START vertex. Seam
    // vertices (shared between ways) are pre-assigned to the NEXT way
    // by the vertex dedup above, so the segment after a seam belongs to
    // the next way and the segment before it to the previous way's
    // start vertex — ownership switches exactly AT the seam vertices.
    // The previous nearest-VERTEX rule instead switched ownership at
    // each segment's midpoint: along a long final segment of a way, the
    // second half of the segment was attributed to the NEIGHBOR way, so
    // up to half a way's own stretch rendered with the adjacent way's
    // lane configuration (Rubensstrasse way 1122774352 drew the wrong
    // lane count). With the segment-start rule every sample belongs to
    // the way it actually lies on
    const cumV: number[] = [0];
    for (let i = 1; i < mv.length; i++)
      cumV.push(
        cumV[i - 1] +
          Math.hypot(mv[i][0] - mv[i - 1][0], mv[i][1] - mv[i - 1][1]),
      );
    // ownership by SEGMENT: the sample's own segment decides its owner
    // (the segment's start vertex). At a seam vertex both adjacent
    // segments create a boundary sample at the same position - the
    // ENDPOINT sample of segment i belongs to segment i's owner (the
    // way that ENDS at the seam, its last sample), the START sample of
    // segment i+1 to segment i+1's owner (the way that starts there).
    // The previous t-only rule could not tell the two apart and pulled
    // the next way's start sample into this way's piece (a degenerate
    // one-sample segment group at every seam)
    const ownerOfSeg = (seg: number): LineFeature =>
      verts[Math.min(seg, verts.length - 1)].cl;
    // chord-length parametrization and Catmull-Rom over the merged chain
    const cum: number[] = [0];
    for (let i = 1; i < mv.length; i++)
      cum.push(
        cum[i - 1] +
          Math.hypot(mv[i][0] - mv[i - 1][0], mv[i][1] - mv[i - 1][1]),
      );
    const total = cum[cum.length - 1];
    // chain line-segment index of an arc-length position: the chain is a
    // string of line-segments (vertices mv[i-1] -> mv[i] = segment i-1);
    // every sample records its segment so the road model can be fitted
    // PER LINE-SEGMENT (tangentially limited by the segment) instead of
    // one rectangle for the whole piece
    const segOf = (t: number): number => {
      // the segment containing t; at a segment boundary (t == cum[k])
      // the position is segment k-1's ENDPOINT - strict < keeps the
      // boundary sample with the segment it ends, never with the next
      // one (which would make a degenerate one-sample group)
      let k = 1;
      while (k < cum.length - 1 && cum[k] < t) k++;
      return k - 1;
    };
    // CHORDAL (knot-aware) Catmull-Rom via Barry–Goldman: the knots are
    // the VERTEX ARC LENGTHS (cum). The uniform-parameter Catmull-Rom
    // overshoots badly where consecutive chain segments differ in length
    // (a 36 m way segment followed by a 3.6 m one makes the curve LOOP —
    // points evaluate past the chord, even behind the segment start),
    // which showed up as twisted "X" rectangles: a segment's samples
    // nearly coincide while their normals point opposite. Dividing by
    // the true knot spacing keeps the curve inside a reasonable envelope
    // of its control points — no loops
    const ptAtRaw = (t: number): number[] => {
      let k = 1;
      while (k < cum.length - 1 && cum[k] < t) k++;
      const k1 = Math.max(0, k - 1),
        k2 = Math.min(cum.length - 1, k);
      const tk0 = cum[Math.max(0, k1 - 1)],
        tk1 = cum[k1],
        tk2 = cum[k2],
        tk3 = cum[Math.min(cum.length - 1, k2 + 1)];
      const pv = (idx: number): number[] =>
        idx < 0
          ? [
              2 * mv[0][0] - mv[1][0],
              2 * mv[0][1] - mv[1][1],
            ]
          : idx > mv.length - 1
            ? [
                2 * mv[mv.length - 1][0] - mv[mv.length - 2][0],
                2 * mv[mv.length - 1][1] - mv[mv.length - 2][1],
              ]
            : mv[idx];
      const p0 = pv(k1 - 1),
        p1 = pv(k1),
        p2 = pv(k2),
        p3 = pv(k2 + 1);
      const dt = Math.max(1e-9, tk2 - tk1);
      const tt = Math.min(Math.max(t, tk1), tk2);
      const lerp = (a: number[], b: number[], ta: number, tb: number, x: number): number[] =>
        tb - ta <= 0
          ? [...a]
          : [
              a[0] + ((b[0] - a[0]) * (x - ta)) / (tb - ta),
              a[1] + ((b[1] - a[1]) * (x - ta)) / (tb - ta),
            ];
      const A1 = lerp(p0, p1, tk0, tk1, tt);
      const A2 = lerp(p1, p2, tk1, tk2, tt);
      const A3 = lerp(p2, p3, tk2, tk3, tt);
      const B1 = lerp(A1, A2, tk0, tk2, tt);
      const B2 = lerp(A2, A3, tk1, tk3, tt);
      return lerp(B1, B2, tk1, tk2, tt);
    };
    // CORNER OVERSHOOT CLAMP: the chordal Catmull-Rom rounds corners but
    // OVERSHOOTS them - at a sharp corner between segments of very
    // different lengths the curve leaves the road by up to meters (a
    // 90-degree corner between a 30 m and a 60 m segment bulges ~2.4 m
    // outside). Lane markings are offset curves of the centerline, so
    // the base curve must stay ON the road: an evaluated point further
    // than OVERSHOOT_M meters off the chain polyline is projected back
    // onto it. The tolerance keeps the intended rounding (decimeters)
    // while eliminating the bulges that doubled markings near corners
    // and drew them past the road edge
    // mv and ptAtRaw are in METRIC working coordinates, so distances are
    // already meters - compare directly against the tolerance
    const OVERSHOOT_M = 0.4;
    const projectIfOffChain = (raw: number[]): number[] => {
      let best: number[] | null = null;
      let bestD2 = Infinity;
      for (let i = 1; i < mv.length; i++) {
        const ax = mv[i - 1][0],
          ay = mv[i - 1][1],
          bx = mv[i][0],
          by = mv[i][1];
        const dx = bx - ax,
          dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let f = len2 > 0 ? ((raw[0] - ax) * dx + (raw[1] - ay) * dy) / len2 : 0;
        f = Math.max(0, Math.min(1, f));
        const qx = ax + dx * f,
          qy = ay + dy * f;
        const d2 = (raw[0] - qx) ** 2 + (raw[1] - qy) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = [qx, qy];
        }
      }
      if (best && bestD2 > OVERSHOOT_M * OVERSHOOT_M) return best;
      return raw;
    };
    // closest point ON the chain polyline at arc-length t (the
    // position where the corresponding vertex-based segment is
    // evaluated): the chordal Catmull-Rom loops near knots of very
    // different segment lengths (a 98 m segment chained to a 39 m one)
    // and the overshoot clamp's projection jumps between loop folds —
    // instead, walk the polyline to t directly: the sample positions
    // advance monotonically at exactly the arc spacing
    const chainPtAt = (t: number): { p: number[]; d: number[] } => {
      const tt = Math.max(0, Math.min(cum[cum.length - 1], t));
      let k = 1;
      while (k < cum.length - 1 && cum[k] < tt) k++;
      const a = mv[k - 1],
        b = mv[k];
      const len = cum[k] - cum[k - 1];
      const f = len > 0 ? (tt - cum[k - 1]) / len : 0;
      const p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      const dl = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const d =
        dl > 0
          ? [(b[0] - a[0]) / dl, (b[1] - a[1]) / dl]
          : (() => {
              const pa = mv[Math.max(0, k - 2)];
              const l2 = Math.hypot(a[0] - pa[0], a[1] - pa[1]);
              return l2 > 0
                ? [(a[0] - pa[0]) / l2, (a[1] - pa[1]) / l2]
                : [1, 0];
            })();
      return { p, d };
    };
    const ptAt = chainPtAt;
    const [minX, minY, maxX, maxY] = area.bbox;
    const maxRay = Math.hypot(maxX - minX, maxY - minY) + 1000;
    // context the ray filter needs: the area's precomputed ADJACENT
    // road areas (cutout test) and whether a kerb way runs along a
    // segment — both built once before the marking phase
    const adjacentRoads = adjacencyOf.get(area) ?? [];
    const segIdx = segIndexOf(area);
    const kerbAlong = kerbAlongShared;
    /**
     * Ray-shoot one cross-section from the sample point, with the
     * BACKTRACKING rule: when a ray hit is invalid (transverse segment,
     // adjacent area:highway without a kerb), walk back along the chain
     // in steps of 1 m until a position measures validly, and report
     // THAT measurement (the width at the closest valid cross-section).
     // Returns the measured split relative to the CHAIN at position t.
     */
    const EPS_M = 0.3;
    const BACKTRACK_M = 30;
    const measureWithBacktrack = (
      t: number,
    ): { leftM: number; rightM: number } | null => {
      const inArea = (tt: number): boolean => {
        const { p } = ptAt(tt);
        const qx = p[0] / (1e-7 * 111_320 * cosLat);
        const qy = p[1] / (1e-7 * 111_320);
        return pointInAreaQ([qx, qy], area);
      };
      // fallback: when NO valid cross-section exists along the whole
      // backtrack window (a piece whose every boundary edge is shared
      // with adjacent road areas), use the WIDEST invalid measurement —
      // the invalid hits are still the best estimate, and the widest
      // reading rejects the spuriously narrow transverse-cap hits at
      // the piece ends (a cap crossing reads less than the road width)
      let fallback: { leftM: number; rightM: number } | null = null;
      for (let bt = 0; bt <= BACKTRACK_M; bt += 1) {
        for (const dt of bt === 0 ? [0] : [-bt, bt]) {
          const tt = Math.min(Math.max(t + dt, 0), total);
          if (bt > 0 && !inArea(tt)) continue;
          const { p, d } = ptAt(tt);
          const dl = Math.hypot(d[0], d[1]);
          if (dl === 0) continue;
          const tx = d[0] / dl,
            ty = d[1] / dl;
          const nx = -ty,
            ny = tx;
          const qx = p[0] / (1e-7 * 111_320 * cosLat);
          const qy = p[1] / (1e-7 * 111_320);
          const m = rayWidthInArea(
            [qx, qy],
            tx,
            ty,
            area,
            segIdx,
            adjacentRoads,
            kerbAlong,
            maxRay,
          );
          if (!m) continue;
          const meas = { leftM: m.left, rightM: m.right };
          if (m.valid) return meas;
          if (
            !fallback ||
            meas.leftM + meas.rightM > fallback.leftM + fallback.rightM
          )
            fallback = meas;
        }
      }
      return fallback;
    };
    // WIDTH TESTS ALWAYS AT THE WAY VERTICES (a vertex is where the
    // chain changes owner way — lane counts, parking and other
    // properties change there, so the sample must exist exactly there),
    // and BETWEEN them every 2 m on longer stretches (a segment shorter
    // than 2 m contributes only its endpoints)
    const SAMPLE_M = 2;
    const raw: (SplineSampleInfo & { cl: LineFeature })[] = [];
    // failed width tests (no measurable cross-section anywhere in the
    // backtrack window): filled afterwards by interpolation between the
    // nearest successful neighbours, so the 2 m cadence never breaks
    const failed: { t: number; seg: number }[] = [];
    const pushSample = (
      t: number,
      seg: number,
    ): void => {
      const t0 = cum[seg],
        t1 = cum[seg + 1];
      // the exact vertices are recorded, but the MEASUREMENT is nudged
      // EPS into the segment: a vertex on the area boundary is
      // ambiguous for the containment test
      const isStart = Math.abs(t - t0) < 1e-9;
      const isEnd = Math.abs(t - t1) < 1e-9;
      const eps = Math.min(EPS_M, (t1 - t0) / 4);
      const measureT = isStart
        ? t0 + eps
        : isEnd
          ? t1 - eps
          : t;
      // a sample POSITION outside the area (a chain segment leading
      // into a junction) is never taken: even a backtracked width
      // would extend the piece beyond its area section
      const posQ = [
        ptAt(t).p[0] / (1e-7 * 111_320 * cosLat),
        ptAt(t).p[1] / (1e-7 * 111_320),
      ];
      if (!pointInAreaTolQ2(posQ, area)) return;
      const m = measureWithBacktrack(measureT);
      if (!m) {
        failed.push({ t, seg });
        return;
      }
      const pv = ptAt(t).p;
      // the sample's OWN normal at t — the backtracked measurement only
      // contributes the distances; using the backtracked position's
      // normal at t twists the spline where the road curves
      const { d } = ptAt(t);
      const dl = Math.hypot(d[0], d[1]);
      if (dl === 0) return;
      raw.push({
        pt: [
          Math.round(pv[0] / (1e-7 * 111_320 * cosLat)),
          Math.round(pv[1] / (1e-7 * 111_320)),
        ],
        nx: -d[1] / dl,
        ny: d[0] / dl,
        leftM: m.leftM,
        rightM: m.rightM,
        seg,
        tArc: t,
        cl: ownerOfSeg(seg),
      });
    };
    for (let seg = 0; seg < cum.length - 1; seg++) {
      const t0 = cum[seg],
        t1 = cum[seg + 1];
      const len = t1 - t0;
      if (len <= 0) continue;
      // the vertices themselves are ALWAYS sampled; longer stretches
      // are subsampled between them every 2 m, in ARC ORDER
      pushSample(t0, seg);
      if (len > SAMPLE_M) {
        const n = Math.floor((len - 1e-9) / SAMPLE_M);
        for (let s = 1; s <= n; s++)
          pushSample(t0 + (len * s) / (n + 1), seg);
      }
      pushSample(t1, seg);
    }
    // fill failed samples by interpolating the measured edges between
    // the nearest successful neighbours along the arc (end runs extend
    // the nearest neighbour's values). Samples OUTSIDE the area (chain
    // segments leading into a junction) stay dropped — a piece never
    // extends beyond its area section. The inserted samples keep the
    // chain's arc order
    if (failed.length > 0 && raw.length >= 2) {
      const inAreaQ = (t: number): boolean => {
        const { p } = ptAt(t);
        return pointInAreaTolQ2(
          [
            p[0] / (1e-7 * 111_320 * cosLat),
            p[1] / (1e-7 * 111_320),
          ],
          area,
        );
      };
      for (const f of [...failed]) {
        if (!inAreaQ(f.t)) continue;
        let iLo = -1,
          iHi = -1;
        for (let i = 0; i < raw.length; i++) {
          if ((raw[i].tArc ?? 0) <= f.t) iLo = i;
          if ((raw[i].tArc ?? 0) >= f.t && iHi < 0) iHi = i;
        }
        let left: number, right: number;
        if (iLo >= 0 && iHi >= 0 && iLo !== iHi) {
          const w =
            (f.t - (raw[iLo].tArc ?? 0)) /
            ((raw[iHi].tArc ?? 0) - (raw[iLo].tArc ?? 0));
          left = raw[iLo].leftM + (raw[iHi].leftM - raw[iLo].leftM) * w;
          right = raw[iLo].rightM + (raw[iHi].rightM - raw[iLo].rightM) * w;
        } else if (iLo >= 0) {
          left = raw[iLo].leftM;
          right = raw[iLo].rightM;
        } else if (iHi >= 0) {
          left = raw[iHi].leftM;
          right = raw[iHi].rightM;
        } else continue;
        const { p, d } = ptAt(f.t);
        const dl = Math.hypot(d[0], d[1]);
        if (dl === 0) continue;
        raw.push({
          pt: [
            Math.round(p[0] / (1e-7 * 111_320 * cosLat)),
            Math.round(p[1] / (1e-7 * 111_320)),
          ],
          nx: -d[1] / dl,
          ny: d[0] / dl,
          leftM: left,
          rightM: right,
          seg: f.seg,
          tArc: f.t,
          cl: ownerOfSeg(f.seg),
        });
        raw.sort((a, b) => (a.tArc ?? 0) - (b.tArc ?? 0));
      }
    }

    // at a seam vertex the two adjacent segments sample the SAME
    // position; keep ONE copy so no zero-length chord enters the
    // spline (a duplicate pair turns per-sample noise into 180-degree
    // angles). The kept sample carries the FIRST segment's owner; the
    // per-piece ranges still meet exactly at the vertex
    const dedup: (SplineSampleInfo & { cl: LineFeature })[] = [];
    for (const s of raw) {
      const last = dedup[dedup.length - 1];
      if (
        last &&
        last.pt[0] === s.pt[0] &&
        last.pt[1] === s.pt[1]
      )
        continue;
      dedup.push(s);
    }
    // MINIMUM SPACING for interior sub-samples: a sub-sample closer
    // than 1 m to its predecessor carries no extra information, and
    // the sub-meter chords turn per-sample lateral noise into large
    // angles — drop it. Segment endpoints (the way vertices) are NEVER
    // dropped: they are the property-switch positions
    const isVertex = (
      arr: (SplineSampleInfo & { cl: LineFeature })[],
      i: number,
    ): boolean => {
      const s = arr[i];
      const seg = s.seg ?? 0;
      return (
        i === 0 ||
        i === arr.length - 1 ||
        (arr[i - 1].seg ?? 0) !== seg ||
        (i + 1 < arr.length && (arr[i + 1].seg ?? 0) !== seg)
      );
    };
    const dedupSrc = dedup.length >= 2 ? dedup : raw;
    const spaced: (SplineSampleInfo & { cl: LineFeature })[] = [];
    for (let i = 0; i < dedupSrc.length; i++) {
      const s = dedupSrc[i];
      const last = spaced[spaced.length - 1];
      if (
        !isVertex(dedupSrc, i) &&
        last &&
        Math.hypot(
          (s.pt[0] - last.pt[0]) * (1e-7 * 111_320 * cosLat),
          (s.pt[1] - last.pt[1]) * (1e-7 * 111_320),
        ) < 1
      ) {
        continue;
      }
      spaced.push(s);
    }
    const samples = spaced.length >= 2 ? spaced : dedupSrc;
    // DENT REPAIR before the middle-line re-basing: ONE-SIDED inward
    // spikes (a bus platform cutting INTO the road on one boundary)
    // are mapping artifacts of the boundary, not real narrowings — a
    // Hampel filter over an ~18 m arc window replaces an edge that
    // deviates more than 1.2 m from its window median while the OTHER
    // side is stable. Both sides denting together is a genuine
    // narrowing (facing platforms) and is kept; outward spikes are
    // replaced only at the chain ends (junction mouths widen for real)
    const arcOf2 = samples.map((s) =>
      Math.hypot(
        (s.pt[0] - samples[0].pt[0]) * (1e-7 * 111_320 * cosLat),
        (s.pt[1] - samples[0].pt[1]) * (1e-7 * 111_320),
      ),
    );
    const WIN2 = 18;
    const winIdx2 = (i: number): number[] => {
      const out2: number[] = [];
      for (let j = 0; j < arcOf2.length; j++)
        if (Math.abs(arcOf2[j] - arcOf2[i]) <= WIN2) out2.push(j);
      return out2.length > 0 ? out2 : [i];
    };
    const repairedSides = (() => {
      const L = samples.map((s) => s.leftM);
      const R = samples.map((s) => s.rightM);
      // the reference is a ROBUST LINEAR TREND of each side along the
      // arc (Theil-Sen over the window): a road may drift laterally
      // (slanted parallelogram) or narrow/widen genuinely (trapezoid) —
      // both follow the trend and never flag. Only abrupt ONE-SIDED
      // dents (a platform cutting into one boundary while the other
      // stays on its trend) repair
      const trendAt = (
        vals: number[],
        idx: number[],
        i: number,
      ): number => {
        const pts = idx.map((j) => [arcOf2[j], vals[j]]);
        if (pts.length < 3) return median2(idx.map((j) => vals[j]));
        const slopes: number[] = [];
        for (let a = 0; a < pts.length; a++)
          for (let b = a + 1; b < pts.length; b++) {
            const dx = pts[b][0] - pts[a][0];
            if (dx > 0.5) slopes.push((pts[b][1] - pts[a][1]) / dx);
          }
        const slope = slopes.length > 0 ? median2(slopes) : 0;
        const base = median2(
          pts.map((p) => p[1] - slope * p[0]),
        );
        return base + slope * arcOf2[i];
      };
      const repair = (vals: number[], other: number[]): number[] => {
        const out = [...vals];
        for (let i = 0; i < vals.length; i++) {
          const idx = winIdx2(i);
          const trend = trendAt(vals, idx, i);
          const trendOther = trendAt(other, idx, i);
          if (
            trend - vals[i] > 1.2 &&
            Math.abs(other[i] - trendOther) < 1.0
          ) {
            out[i] = trend;
          } else if (vals[i] - trend > 1.2) {
            if (
              arcOf2[i] - arcOf2[0] > WIN2 &&
              arcOf2[arcOf2.length - 1] - arcOf2[i] > WIN2
            )
              out[i] = trend;
          }
        }
        return out;
      };
      const smL = repair(L, R);
      const smR = repair(R, L);
      return samples.map((s, i) => ({
        ...s,
        leftM: smL[i],
        rightM: smR[i],
      }));
    })();
    // orient flips each sample's left/right split into the OWNING WAY's
    // own convention (the chain may traverse the way reversed) and
    // stamps it REVERSED; the per-piece slicing reverses the sample
    // ARRAY for reversed ways - the renderer derives its normals from
    // array order, so a piece whose array runs against its way's
    // direction would render the whole lane block MIRRORED
    // (parking:left on the right side, the solid border displaced)
    const orient = (
      s: SplineSampleInfo & { cl: LineFeature },
    ): SplineSampleInfo & { cl: LineFeature } =>
      revByOrig.get(s.cl)
        ? {
            ...s,
            rev: true,
            nx: -s.nx,
            ny: -s.ny,
            leftM: s.rightM,
            rightM: s.leftM,
            midM: -(s.midM ?? 0),
          }
        : { ...s, rev: false };
    // ---- the VIRTUAL MIDDLE LINE: half the width at each sample, in
    // meters relative to the mapped centerline (positive = LEFT). Its
    // lateral offsets form ONE interpolating spline per area:highway
    // — the solid centerline is continuous. The markings are offsets
    // of that middle spline, and the sample's own edges are re-based
    // onto it (leftM/rightM measure from the middle line)
    const midOff = repairedSides.map(
      (s) => (s.leftM - s.rightM) / 2,
    );
    // smooth the middle-line offsets: the spline BASE sits on the
    // middle line, so per-sample measurement noise would kink every
    // drawn boundary. Moving median over ~6 m (kills solitary
    // outliers) followed by a moving AVERAGE over ~16 m of arc
    // (subdues residual wobble) — genuine trends (slanted areas,
    // trapezoids) survive both
    const midMed = midOff.map((_, i) => {
      const xs: number[] = [];
      for (
        let j = i - 1;
        j <= i + 1 && j < repairedSides.length;
        j++
      )
        if (j >= 0) xs.push(midOff[j]);
      return median2(xs);
    });
    const midSm = midMed.map((_, i) => {
      let sum = 0,
        n = 0;
      for (
        let j = i - 4;
        j <= i + 4 && j < midMed.length;
        j++
      )
        if (j >= 0) {
          sum += midMed[j];
          n++;
        }
      return n > 0 ? sum / n : midMed[i];
    });
    // re-base the measured edges onto the middle line: relative to the
    // middle, the road half-width is the same on both sides — so the
    // two measured halves are averaged into one (halving the
    // per-sample measurement noise)
    const out = repairedSides.map((s, i) => {
      const half = (s.leftM + s.rightM) / 2;
      return {
        ...s,
        leftM: half,
        rightM: half,
        midM: midSm[i],
      };
    });
    // the SAMPLE POINTS move onto the middle line: the renderer offsets
    // this spline to draw the markings, so the base curve must BE the
    // middle line, not the mapped way
    const final = out.map((s) => {
      const m = s.midM!;
      const mx =
        (s.pt[0] * (1e-7 * 111_320 * cosLat) + s.nx * m) /
        (1e-7 * 111_320 * cosLat);
      const my =
        (s.pt[1] * (1e-7 * 111_320) + s.ny * m) / (1e-7 * 111_320);
      return {
        ...s,
        pt: [Math.round(mx), Math.round(my)] as number[],
      };
    });
    return final.map(orient);
  };

  const groupList = [...groups.values()];
  for (let gi = 0; gi < groupList.length; gi++) {
    const ways = groupList[gi];
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
      // CONTIGUOUS index range of the spline samples owned by this way —
      // STRICTLY its own range, no neighbour padding: adjacent ways
      // share the seam VERTEX sample (each segment owns its endpoints),
      // so the drawn boundaries meet there and the per-segment
      // rectangles tile the road without overlapping tangentially;
      // padded ranges would double-draw the neighbour's stretch and
      // produce degenerate one-sample rectangle groups at the seams
      let lo = -1,
        hi = -1;
      for (let i = 0; i < sp.length; i++) {
        if (sp[i].cl !== p.cl) continue;
        if (lo < 0) lo = i;
        hi = i;
      }
      if (lo < 0) continue;
      {
        // REVERSED ways: the samples' values are already in the WAY's
        // own frame (orient flipped them), but they are ordered along
        // the CHAIN - reverse the array so it runs along the way,
        // matching the frame the renderer's array-order normals assume
        // (otherwise the whole lane block renders MIRRORED:
        // parking:left on the right side)
        const slice = sp.slice(lo, hi + 1);
        const ordered = slice[0]?.rev ? slice.slice().reverse() : slice;
        p.spline = ordered.map((s) => ({
          pt: s.pt,
          nx: s.nx,
          ny: s.ny,
          leftM: s.leftM,
          rightM: s.rightM,
          midM: s.midM,
          seg: s.seg,
          rev: s.rev,
        }));
      }
    }
    const unitsOf = (p: MarkingSample & { cl: LineFeature }): number =>
      p.cl.lanes! +
      (p.cl.parkingLeft ? 1 : 0) +
      (p.cl.parkingRight ? 1 : 0);
    // FITTED edges of the piece: the MEDIAN of its samples' fitted
    // rectangle edges — the piece-level quantities the group layout keys
    // The piece's road edges IN THE MIDDLE-LINE FRAME: the spline samples
    // sit ON the virtual middle line (half the width), and their
    // leftM/rightM are the half-width to each side — the piece-level
    // quantities the layout keys off (anchors, clamps) are the medians
    // of those half-widths, falling back to the piece's measured medians
    const halfSpan = (
      p: MarkingSample & { cl: LineFeature },
      side: "l" | "r",
    ): number => {
      const xs = (p.spline ?? []).map((s) =>
        side === "l" ? s.leftM : s.rightM,
      );
      if (xs.length === 0)
        return side === "l" ? p.leftM : p.rightM;
      // DENT-ROBUST reading: the median of the piece's WIDEST window —
      // the moving median over a ~12 m arc window kills minority dents
      // (bus platforms cutting INTO the road), and taking the maximum
      // window median recovers the road's true extent where the piece
      // narrows genuinely towards one end (junction mouths, trapezoids)
      const med = (ys: number[]): number => {
        const s2 = [...ys].sort((a, b) => a - b);
        const m = s2.length >> 1;
        return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2;
      };
      let best = -Infinity;
      const W = 6;
      for (let i = 0; i < xs.length; i++) {
        const lo = Math.max(0, i - W),
          hi = Math.min(xs.length - 1, i + W);
        const m = med(xs.slice(lo, hi + 1));
        if (m > best) best = m;
      }
      return best;
    };
    const fitLeftM = (p: MarkingSample & { cl: LineFeature }): number =>
      halfSpan(p, "l");
    const fitRightM = (p: MarkingSample & { cl: LineFeature }): number =>
      halfSpan(p, "r");
    // unit width of the piece: its measured half-widths split evenly
    // over its width units (traffic lanes + parking)
    const laneWOf = (p: MarkingSample & { cl: LineFeature }): number =>
      (fitLeftM(p) + fitRightM(p)) / unitsOf(p);
    // the through-lane width when the parking strips absorb the remaining
    // road width instead of narrowing the traffic lanes: total minus one
    // parking unit per side, split over the traffic lanes
    const trafficLaneWOf = (p: MarkingSample & { cl: LineFeature }): number => {
      const park = (p.cl.parkingLeft ? 1 : 0) + (p.cl.parkingRight ? 1 : 0);
      const unitsW = laneWOf(p);
      return (fitLeftM(p) + fitRightM(p) - park * unitsW) / p.cl.lanes!;
    };
    // left traffic edge of a piece (its parking lane virtually removed),
    // relative to the middle line
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
    let anchorOf: (p: MarkingSample & { cl: LineFeature }) => number;
    // one-way roads: which side of the road the block is anchored on
    // ("left" | "right" | "center"), decided by where the road grows
    let anchorKind: "left" | "right" | "center" = "left";
    // PER-PIECE unit width: every piece's width units (traffic lanes +
    // parking) split ITS OWN measured road width evenly — the available
    // width is distributed evenly over ALL lanes (README 5), so the
    // grid fills the road on every piece. The through lanes stay
    // continuous through the shared middle-line anchor, not through a
    // shared width
    const laneWShared = trafficLaneWOf;
    if (anchorBorder) {
      // right-hand traffic: traffic in the way's (forward) direction
      // keeps RIGHT of the direction border, oncoming traffic LEFT.
      // The middle line (the spline base) is the natural zero; pieces
      // of the SAME direction split draw their solid border at the SAME
      // offset — the median of their PARKING-AWARE natural border
      // positions (each piece's right road edge minus its right parking
      // unit and fwd lane widths, all at the piece's OWN unit width).
      // Pieces with a DIFFERENT split have their middle line at a
      // different natural place; each split aligns among itself, and the
      // split change is where the middle line legitimately steps
      const splitOf = (p: MarkingSample & { cl: LineFeature }): string =>
        `${fwdOf(p.cl)}+${p.cl.lanes! - fwdOf(p.cl)}`;
      const anchorPosBySplit = new Map<string, number[]>();
      for (const p of borderPieces) {
        const park = p.cl.parkingRight ? laneWOf(p) : 0;
        const pos = fitRightM(p) - park - fwdOf(p.cl) * laneWOf(p);
        const key = splitOf(p);
        const arr = anchorPosBySplit.get(key);
        if (arr) arr.push(pos);
        else anchorPosBySplit.set(key, [pos]);
      }
      const anchorMBySplit = new Map<string, number>();
      for (const [key, xs] of anchorPosBySplit)
        anchorMBySplit.set(key, median(xs));
      anchorOf = (p) => anchorMBySplit.get(splitOf(p)) ?? 0;
    } else {
      // ONE-WAY LANE-COUNT CHANGES: track how the middle line moves
      // between the pieces. The middle line's lateral offset from the
      // mapped way (midM) and the half-width reconstruct each piece's
      // absolute road edges (left = mid + half, right = half - mid);
      // where the lane count rises, the side whose edge MOVED is the
      // side the road grew on. The middle line moving LEFT (road gets
      // bigger to the left, a rectangular trapezoid) adds the new lanes
      // LEFT — the block anchors on the RIGHT edge, so the right lanes
      // continue; moving right mirrors it. A middle line that does not
      // move (both edges shifted out, a non-rectangular trapezoid) adds
      // the lanes on BOTH sides — the block unfolds from the middle
      // line itself
      const edges = pieces.map((p) => {
        const mids = (p.spline ?? []).map((s) => s.midM ?? 0);
        const mid = mids.length > 0 ? median(mids) : (p.leftM - p.rightM) / 2;
        const half = (fitLeftM(p) + fitRightM(p)) / 2;
        return { l: mid + half, r: half - mid };
      });
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
        fitRightM(p) - (p.cl.parkingRight ? laneWOf(p) : 0);
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
      let laneW = laneWShared(p);
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
        // bidirectional, right-hand traffic: forward lanes keep RIGHT of
        // the direction border (the middle line, solid), backward lanes
        // LEFT. UNFOLD FROM THE MIDDLE LINE (README 5): the middle line
        // keeps the group's shared anchor offset, and each TAGGED side's
        // units fill EXACTLY the space between the middle line and that
        // side's fitted road edge - all lanes have EQUAL width, so a
        // parking bay is exactly one lane wide and the traffic lanes
        // take the rest of the side. The piece's unit width follows from
        // its two sides' unit counts and spans (they may differ, e.g. a
        // piece with parking on one side only, or a bus platform denting
        // one boundary); an UNTAGGED side has no units - its space stays
        // unpainted (no parking bay there). The renderer draws the
        // solid border at k = fwd, i.e. at -laneLeftM + fwd*laneW
        const anchor = anchorOf(p);
        const parkL = p.cl.parkingLeft ? 1 : 0;
        const parkR = p.cl.parkingRight ? 1 : 0;
        const unitsL = parkL + (p.cl.lanes! - fwd);
        const unitsR = parkR + fwd;
        const spanL = fitLeftM(p) + anchor;
        const spanR = fitRightM(p) - anchor;
        // the unit width starts as the piece's EVEN SPLIT (all units over
        // the full fitted span - the available width distributed evenly
        // over all lanes, README 5) and is then CAPPED per side: each
        // side must fit its own units between the middle line and its
        // road edge, so a side whose natural width is smaller (a
        // bus-platform dent, an asymmetric lane split around the shared
        // middle line) binds the unit width. The tighter side fills
        // exactly - its parking bay is exactly one unit wide, never
        // squeezed - and the looser side keeps the same unit width,
        // leaving its leftover unpainted (no parking tag there, or a
        // wider verge)
        const evenSplit =
          (fitLeftM(p) + fitRightM(p)) / (unitsL + unitsR);
        const perL = unitsL > 0 ? spanL / unitsL : Infinity;
        const perR = unitsR > 0 ? spanR / unitsR : Infinity;
        const unitW = Math.min(evenSplit, perL, perR);
        // re-space the traffic block at the piece's unit width: backward
        // lanes occupy [anchor - bwd*unitW, anchor], forward lanes
        // [anchor, anchor + fwd*unitW]; laneLeftM is the block's LEFT
        // edge in meters-left. The piece's lane width BECOMES unitW so
        // every drawn boundary (-laneLeftM + k*laneW) sits on the unit
        // grid: the solid border lands exactly on the anchor
        laneW = unitW;
        // laneLeftM (meters-LEFT) from the border equation: the renderer
        // draws the solid border at boundary k = BWD = lanes - fwd
        // (boundaries count from the block's LEFT edge; the forward
        // lanes keep RIGHT of the border), so
        // -laneLeftM + (lanes - fwd)*laneW = anchor
        laneLeftM = (p.cl.lanes! - fwd) * unitW - anchor;
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
      // clamp so markings never extend past the road edge: the piece's
      // half-spans from the middle line bound the block on each side
      const blockW = p.cl.lanes! * laneW;
      const parkLeft = bidirectional ? 0 : p.cl.parkingLeft ? laneW : 0;
      const parkRight = bidirectional ? 0 : p.cl.parkingRight ? laneW : 0;
      const minLeft = blockW + parkRight - fitRightM(p);
      const maxLeft = fitLeftM(p) - parkLeft;
      if (laneLeftM < minLeft) laneLeftM = minLeft;
      if (laneLeftM > maxLeft) laneLeftM = maxLeft;
      // the piece's CONTINUITY ANCHOR, in the renderer's offset convention
      // (meters from the mapped centerline, positive = RIGHT, like the
      // boundary offsets -leftM + k*laneW): the lateral offset that must
      // not change between pieces — the direction border on bidirectional
      // roads, the stable traffic edge (or centerline) on one-way roads.
      // The renderer scales the block into each sample's local span
      // AROUND this offset, so boundaries stay continuous across piece
      // seams (the anchor is group-shared) while the width follows the
      // local road
      const anchorOffsetM = bidirectional
        ? -laneLeftM + (p.cl.lanes! - fwd) * laneW
        : anchorKind === "left"
          ? -laneLeftM
          : anchorKind === "right"
            ? -laneLeftM + p.cl.lanes! * laneW
            : 0;
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
        laneAnchorKind: bidirectional ? "border" : anchorKind,
        laneAnchorM: anchorOffsetM,
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
