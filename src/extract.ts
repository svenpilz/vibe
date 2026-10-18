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
import type { Q, AreaFeature, BuildingFeature, GrassFeature, LineFeature, KerbFeature, KerbWayFeature, BollardFeature, FenceFeature, LanduseFeature, StreetLampFeature, ParkingFeature, ManholeFeature } from "./features";

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
  /** all layer values present in the data, sorted ascending */
  layers: number[];
  /** all level values present in the data, sorted ascending */
  levels: number[];
  /** bbox of all extracted features: [minLonQ, minLatQ, maxLonQ, maxLatQ] */
  bounds: [number, number, number, number];
}

function bboxOfQ(coords: number[][]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** distance along direction d from pt until leaving the area, or null if never */
function rayExitInArea(pt: number[], d: number[], area: AreaFeature, maxRay: number): number | null {
  let best: number | null = null;
  const test = (t: number): void => {
    const p = [pt[0] + d[0] * t, pt[1] + d[1] * t];
    if (!pointInAreaQ(p, area)) {
      if (best === null || t < best) best = t;
    }
  };
  // coarse scan then refine; the step adapts to the ray length so small
  // areas (diagonal below the previous fixed step) are still scanned
  const steps = 40;
  const step = Math.max(1, maxRay / steps);
  let prevInside = true;
  for (let t = step; t <= maxRay; t += step) {
    const p = [pt[0] + d[0] * t, pt[1] + d[1] * t];
    const inside = pointInAreaQ(p, area);
    if (prevInside && !inside) {
      // binary refine between t-step and t
      let lo = t - step, hi = t;
      for (let k = 0; k < 24; k++) {
        const midT = (lo + hi) / 2;
        const pm = [pt[0] + d[0] * midT, pt[1] + d[1] * midT];
        if (pointInAreaQ(pm, area)) lo = midT; else hi = midT;
      }
      best = (lo + hi) / 2;
      break;
    }
    prevInside = inside;
  }
  void test;
  return best;
}

function pointInRingQ(pt: number[], ring: number[][]): boolean {
  let inside = false;
  const x = pt[0], y = pt[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInAreaQ(pt: number[], area: AreaFeature): boolean {
  let inOuter = false;
  for (const ring of area.outer) {
    if (pointInRingQ(pt, ring)) { inOuter = true; break; }
  }
  if (!inOuter) return false;
  for (const hole of area.holes) {
    if (pointInRingQ(pt, hole)) return false;
  }
  return true;
}

/** squared distance from pt to segment a-b in quantized units */
function distToSegQ2(px: number, py: number, a: number[], b: number[]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - a[0]) * dx + (py - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx, y = a[1] + t * dy;
  return (px - x) ** 2 + (py - y) ** 2;
}

/**
 * Containment with tolerance: true when the point is inside the area or
 * within tolQ of its boundary. Ways mapped along an area's edge share
 * nodes with the area ring; their vertices lie exactly on the boundary,
 * where the strict test is ambiguous.
 */
function pointOnAreaBoundaryQ(pt: number[], area: AreaFeature, tolQ: number): boolean {
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

function centerlineInAreaTolQ(cl: LineFeature, area: AreaFeature, tolQ: number): boolean {
  let inside = 0;
  let onBoundary = 0;
  for (const pt of cl.coords) {
    // boundary first: a vertex exactly on the ring must never count as
    // inside (the strict test is ambiguous there) — also for the adjacent
    // area, which shares this boundary
    if (pointOnAreaBoundaryQ(pt, area, tolQ)) { onBoundary++; continue; }
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
  b: [number, number, number, number]
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
  if (b === "residential" || b === "house" || b === "apartments" || b === "detached"
    || b === "terrace" || b === "semi" || b === "semidetached_house" || b === "bungalow") return "residential";
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
function highwayTypesCompatible(clHighway: string | undefined, areaHighway: string): boolean {
  if (!clHighway) return false;
  if (clHighway === areaHighway) return true;
  if (clHighway === "footway" && areaHighway === "sidewalk") return true;
  if (clHighway === "sidewalk" && areaHighway === "footway") return true;
  return false;
}

const CENTERLINE_HIGHWAYS = new Set([
  "footway", "pedestrian", "service", "living_street", "residential", "unclassified",
  "cycleway", "path", "steps", "track", "road",
  "motorway", "trunk", "primary", "secondary", "tertiary",
  "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
]);

export function extractFeatures(
  data: OSMData,
  onProgress?: (pct: number, msg: string) => void
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
  const parkingLanesOnCarriageway: { id: string; layer: number; outer: Q[][][]; holes: Q[][][]; bbox: [number, number, number, number] }[] = [];
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

    const landuseKind = tags["landuse"] === "residential" ? "residential"
      : tags["landuse"] === "commercial" || tags["landuse"] === "retail" ? "commercial"
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
        surface: tags["surface"] ?? (areaHighway === "traffic_island" ? "sett" : undefined),
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

    const greenKind = tags["landuse"] === "grass" ? "grass"
      : tags["natural"] === "scrub" ? "scrub"
      : tags["leisure"] === "garden" ? "garden"
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
      const isCrossing = footway === "crossing" || tags["crossing"] !== undefined;
      const widthNum = tags["width"] ? parseFloat(tags["width"]) : undefined;

      if (isCrossing) {
        const qc = q(coords);
        crossings.push({
          type: "crossing",
          id: `w${way.id}`,
          highway,
          footway,
          crossing: tags["crossing"],
          crossingMarkings: tags["crossing:markings"] ?? (tags["crossing"] === "zebra" ? "zebra" : undefined),
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
      } else if (CENTERLINE_HIGHWAYS.has(highway) && !isClosed(way)
                 && (tags["surface"] !== undefined || widthNum !== undefined
                     || parseLanes(tags["lanes"]) !== undefined)) {
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
          parkingLeft: parkingOnCarriageway("left", tags) || parkingOnCarriageway("both", tags),
          parkingRight: parkingOnCarriageway("right", tags) || parkingOnCarriageway("both", tags),
          oneway: tags["oneway"] === "yes" || tags["oneway"] === "-1" || tags["junction"] === "roundabout" || tags["junction"] === "circular",
          lanesFwd: parseLanes(tags["lanes:forward"])
            ?? (parseLanes(tags["lanes:backward"]) !== undefined
                ? (parseLanes(tags["lanes"]) ?? 2 * parseLanes(tags["lanes:backward"])!) - parseLanes(tags["lanes:backward"])!
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
        if (m.type !== "way" || (m.role !== "outer" && m.role !== "inner" && m.role !== "")) continue;
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

    const grassTag = tags["landuse"] === "grass" || tags["natural"] === "scrub" || tags["leisure"] === "garden";
    const greenKind = tags["landuse"] === "grass" ? "grass"
      : tags["natural"] === "scrub" ? "scrub"
      : tags["leisure"] === "garden" ? "garden"
      : "grass";
    if ((!areaHighway && !buildingTag && !grassTag) || tags["type"] !== "multipolygon") continue;

    const outerRings: number[][][] = [];
    const holeRings: number[][][] = [];

    for (const m of rel.members) {
      if (m.type !== "way" || (m.role !== "outer" && m.role !== "inner" && m.role !== "")) continue;
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
      surface: tags["surface"] ?? (areaHighway === "traffic_island" ? "sett" : undefined),
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
      nodeWayLayer.set(ref, prev === undefined || prev === wl ? wl : Number.NaN);
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
        if (inherited !== undefined && Number.isFinite(inherited)) layer = inherited;
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
        const a = cl.coords[i - 1], b = cl.coords[i];
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pointInAreaQ(m, area)) { areasWithCenterline.add(area); break; }
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
        const a = cl.coords[i - 1], b = cl.coords[i];
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pointInAreaQ(m, area)) lenIn += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      if (lenIn <= 0) continue;
      let byArea = surfaceByArea.get(area);
      if (!byArea) { byArea = new Map(); surfaceByArea.set(area, byArea); }
      byArea.set(cl.surface!, (byArea.get(cl.surface!) ?? 0) + lenIn);
    }
  }
  for (const [area, bySurface] of surfaceByArea) {
    let topS = "", topL = -1;
    for (const [sf, l] of bySurface) if (l > topL) { topL = l; topS = sf; }
    if (topS) area.surface = topS;
  }

  // lane marking extraction: like crossings, lane-bearing centerlines may be
  // covered by their highway area (and then dropped below); extract the
  // marking data first into its own array.
  const laneMarkings: LineFeature[] = [];
  const laneCandidates: LineFeature[] = [];
  for (const cl of centerlines) {
    if (cl.lanes !== undefined && cl.lanes >= 2 && !cl.noLaneMarkings) laneCandidates.push(cl);
  }
  // on-carriageway parking strips (amenity=parking + parking=lane): the
  // nearest lane-bearing centerline on the same layer gains a parking
  // lane on the side the strip occupies — cross product of the
  // centerline direction at the nearest segment with the vector to the
  // strip's centroid; positive = left of the way
  {
    for (const st of parkingLanesOnCarriageway) {
      let sx = 0, sy = 0, cnt = 0;
      for (const ring of st.outer) for (const pt of ring) { sx += pt[0]; sy += pt[1]; cnt++; }
      if (cnt === 0) continue;
      const mid: [number, number] = [sx / cnt, sy / cnt];
      let best: LineFeature | null = null;
      let bestD = Infinity;
      let bestSeg = 1;
      for (const cl of laneCandidates) {
        if (cl.layer !== st.layer) continue;
        if (!bboxOverlap(cl.bbox, st.bbox)) continue;
        for (let i = 1; i < cl.coords.length; i++) {
          const a = cl.coords[i - 1], b = cl.coords[i];
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const len2 = dx * dx + dy * dy;
          if (len2 === 0) continue;
          let t = ((mid[0] - a[0]) * dx + (mid[1] - a[1]) * dy) / len2;
          t = Math.max(0, Math.min(1, t));
          const px = a[0] + t * dx, py = a[1] + t * dy;
          const d = (mid[0] - px) ** 2 + (mid[1] - py) ** 2;
          if (d < bestD) { bestD = d; best = cl; bestSeg = i; }
        }
      }
      if (!best) continue;
      const a = best.coords[bestSeg - 1], b = best.coords[bestSeg];
      const cross = (b[0] - a[0]) * (mid[1] - a[1]) - (b[1] - a[1]) * (mid[0] - a[0]);
      if (cross > 0) best.parkingLeft = true;
      else if (cross < 0) best.parkingRight = true;
    }
  }
  const areaGridL = buildAreaIndex(areas);
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
  interface MarkingSample {
    area: AreaFeature;
    leftM: number;
    rightM: number;
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
        const a = cl.coords[si - 1], b = cl.coords[si];
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pointInAreaTolQ2(m, area)) someInside = true;
      }
      if (!someInside) continue;
      matching.push(area);
    }
    if (matching.length > 1) {
      const sameLayer = matching.filter((a) => a.layer === cl.layer);
      if (sameLayer.length > 0) matching.length = 0, matching.push(...sameLayer);
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
        const a = cl.coords[si - 1], b = cl.coords[si];
        if (a[0] === b[0] && a[1] === b[1]) continue;
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pointInAreaQ(m, area)) insideSegs.push(si);
        else if (pointInAreaTolQ2(m, area)) tolSegs.push(si);
      }
      const segs = insideSegs.length > 0 ? insideSegs : tolSegs;
      if (segs.length === 0) continue;
      const sampled = segs.length <= 12
        ? segs
        : [...Array(12).keys()].map((k) => segs[Math.min(segs.length - 1, Math.round((k * (segs.length - 1)) / 11))]);
      const lefts: number[] = [];
      const rights: number[] = [];
      for (const bi of sampled) {
        const dxs = cl.coords[bi][0] - cl.coords[bi - 1][0];
        const dys = cl.coords[bi][1] - cl.coords[bi - 1][1];
        const segLen = Math.hypot(dxs, dys);
        // sample: the segment midpoint, or — when it lies on the boundary —
        // a point of the segment strictly inside this area
        let sample: number[] | null = null;
        const a0 = cl.coords[bi - 1], a1 = cl.coords[bi];
        for (let t = 0.5; t >= 0.05; t -= 0.05) {
          for (const u of [t, 1 - t]) {
            const p = [a0[0] + (a1[0] - a0[0]) * u, a0[1] + (a1[1] - a0[1]) * u];
            if (pointInAreaQ(p, area)) { sample = p; break; }
          }
          if (sample) break;
        }
        if (!sample) continue;
        const nx = -dys / segLen, ny = dxs / segLen;
        const [minX, minY, maxX, maxY] = area.bbox;
        const maxRay = Math.hypot(maxX - minX, maxY - minY) + 1000;
        const left = rayExitInArea(sample, [nx, ny], area, maxRay);
        const right = rayExitInArea(sample, [-nx, -ny], area, maxRay);
        if (left === null || right === null) continue;
        // convert each ray to meters: lon units scale with cos(latitude),
        // lat units are constant; the ray travels in mixed units
        const mPerLon = (111_320 * Math.cos((sample[1] / 1e7) * Math.PI / 180)) / 1e7;
        const mPerLat = 111_320 / 1e7;
        const rayM = (t: number, dx2: number, dy2: number): number =>
          Math.hypot(dx2 * t * mPerLon, dy2 * t * mPerLat);
        lefts.push(rayM(left, nx, ny));
        rights.push(rayM(right, -nx, -ny));
      }
      if (lefts.length === 0) continue;
      const median = (xs: number[]): number => {
        const s2 = [...xs].sort((a, b) => a - b);
        const m = s2.length >> 1;
        return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2;
      };
      let arr = samplesOf.get(cl);
      if (!arr) { arr = []; samplesOf.set(cl, arr); }
      arr.push({ area, leftM: median(lefts), rightM: median(rights) });
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
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a: number, b: number): void => {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  };
  // all way ends by coordinate (named and unnamed alike)
  const byEnd = new Map<string, { i: number; atStart: boolean }[]>();
  const endKey = (p: Q[]): string => `${p[0]},${p[1]}`;
  laneCandidates.forEach((cl, i) => {
    const first = cl.coords[0], last = cl.coords[cl.coords.length - 1];
    for (const [end, atStart] of [[first, true], [last, false]] as [Q[], boolean][]) {
      const k = endKey(end);
      const arr = byEnd.get(k);
      const e = { i, atStart };
      if (arr) arr.push(e); else byEnd.set(k, [e]);
    }
  });
  // unit direction pointing OUT of the way at the given end
  const endDir = (cl: LineFeature, atStart: boolean): [number, number] => {
    const a = atStart ? cl.coords[1] : cl.coords[cl.coords.length - 2];
    const b = atStart ? cl.coords[0] : cl.coords[cl.coords.length - 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
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
      let bestB = -1, bestDot = -2, secondDot = -2;
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
          secondDot = bestDot; bestDot = dot; bestB = b;
        } else if (dot > secondDot) secondDot = dot;
      }
      if (bestB < 0) continue;
      // ambiguous fork: another candidate is nearly as collinear
      if (secondDot > bestDot - 0.15) continue;
      // mutuality: the partner must also pick this end as its best
      const dB = endDir(laneCandidates[ends[bestB].i], ends[bestB].atStart);
      let mutBest = -1, mutDot = -2;
      for (let c = 0; c < ends.length; c++) {
        if (c === bestB) continue;
        if (find(ends[bestB].i) === find(ends[c].i)) continue;
        const C = laneCandidates[ends[c].i];
        if (laneCandidates[ends[bestB].i].layer !== C.layer) continue;
        if (laneCandidates[ends[bestB].i].oneway !== C.oneway) continue;
        if (laneCandidates[ends[bestB].i].highway !== C.highway) continue;
        const dC = endDir(C, ends[c].atStart);
        const dot = dB[0] * dC[0] + dB[1] * dC[1];
        if (dot <= -0.7 && dot > mutDot) { mutDot = dot; mutBest = c; }
      }
      if (mutBest === a) union(ends[a].i, ends[bestB].i);
    }
  }
  const groups = new Map<number, LineFeature[]>();
  laneCandidates.forEach((cl, i) => {
    const r = find(i);
    const arr = groups.get(r);
    if (arr) arr.push(cl); else groups.set(r, [cl]);
  });
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const fwdOf = (cl: LineFeature): number =>
    cl.lanesFwd ?? (cl.oneway ? cl.lanes! : Math.ceil(cl.lanes! / 2));
  for (const ways of groups.values()) {
    // one marking piece per (way, area section) of the road
    const pieces: (MarkingSample & { cl: LineFeature })[] = [];
    for (const w of ways) for (const s of samplesOf.get(w) ?? []) pieces.push({ cl: w, ...s });
    if (pieces.length === 0) continue;
    // PER-PIECE lane width: each piece splits its OWN measured width
    // evenly among its units (traffic + parking lanes), so the layout
    // follows the local road width and every piece fills its road exactly
    // (a 12 m piece with 4 units gets 3 m lanes, the neighbouring 12 m
    // piece with 3 units gets 4 m lanes)
    const laneWOf = (p: MarkingSample & { cl: LineFeature }): number =>
      (p.leftM + p.rightM) /
      (p.cl.lanes! + (p.cl.parkingLeft ? 1 : 0) + (p.cl.parkingRight ? 1 : 0));
    // left traffic edge of a piece (its parking lane virtually removed)
    const trafficLeftM = (p: MarkingSample & { cl: LineFeature }): number =>
      p.leftM - (p.cl.parkingLeft ? laneWOf(p) : 0);
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
    let laneWShared: (p: MarkingSample & { cl: LineFeature }) => number = laneWOf;
    if (anchorBorder) {
      const anchorM = median(borderPieces.map((p) =>
        trafficLeftM(p) - fwdOf(p.cl) * laneWOf(p)));
      anchorOf = () => anchorM;
    } else {
      anchorOf = (p) => trafficLeftM(p);
      const w = Math.min(...pieces.map(laneWOf));
      laneWShared = () => w;
    }
    for (const p of pieces) {
      const fwd = fwdOf(p.cl);
      const laneW = laneWShared(p);
      // anchored on the direction border: adding forward lanes extends
      // the layout to the left, adding backward lanes to the right — the
      // border fraction keeps existing boundaries aligned across pieces
      // place the border at the anchor offset, then lay the forward lanes
      // to its left and the rest to its right. A purely one-way road has
      // no border: each piece lays its block from its OWN measured left
      // edge — the centerline placement can differ between the ways of a
      // dual carriageway (placement=*), and the measured edges follow the
      // actual road outline, which is continuous where the ways meet. The
      // clamp below keeps the block inside the road
      const hasBorder = fwd > 0 && fwd < p.cl.lanes!;
      const lw = laneWShared(p);
      let laneLeftM = hasBorder
        ? anchorOf(p) + fwd * lw
        : anchorOf(p);
      // clamp into this piece's (cluster-shared) measured span so markings
      // never extend past the road edge even where the centerline wanders
      // off-center
      const blockW = p.cl.lanes! * laneW;
      const minLeft = blockW - p.rightM;
      const maxLeft = p.leftM;
      if (laneLeftM < minLeft) laneLeftM = minLeft;
      if (laneLeftM > maxLeft) laneLeftM = maxLeft;
      laneMarkings.push({
        ...p.cl,
        // the marking lives on the area's layer (bird's-eye stacking, selector
        // filtering); fall back to the centerline's layer when equal
        layer: p.area.layer,
        laneW,
        laneLeftM,
        laneRightM: laneLeftM + p.cl.lanes! * laneW,
        lanesFwd: fwd,
        areaIds: [p.area.id],
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
      if (pointInAreaQ(mid, area)) { covered = true; break; }
    }
    if (!covered) keptCenterlines.push(cl);
  }
  const droppedCenterlines = centerlines.length - keptCenterlines.length;
  // replace contents in place (no spread — avoids stack overflow on large arrays)
  centerlines.length = 0;
  for (let i = 0; i < keptCenterlines.length; i++) centerlines[i] = keptCenterlines[i];
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
    const mid = [(cr.coords[ci][0] + cr.coords[ci - 1][0]) / 2,
                 (cr.coords[ci][1] + cr.coords[ci - 1][1]) / 2];
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
    feats: { surface?: string; surfaceColour?: string; outer: Q[][][]; bbox: [number, number, number, number] }[],
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
                if (p1[0] === p2[0] && p1[1] === p2[1]) { touches = true; break outer; }
              }
            }
          }
        }
        if (!touches) continue;
        const a = (area.bbox[2] - area.bbox[0]) * (area.bbox[3] - area.bbox[1]);
        if (a > bestArea) { bestArea = a; best = area; }
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
  inheritFromAdjacent(areas.filter((a) => a.highway === "service" && !areasWithCenterline.has(a)));

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
  for (const arr of [areas, buildings, grass, centerlines, footways, crossings, kerbWays, kerbs, bollards, fences, landuse, streetLamps, parking, manholes]) {
    for (const f of arr) if (f.level !== undefined) levelSet.add(f.level);
  }
  const levels = [...levelSet].sort((a, b) => a - b);

  // compute overall bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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

  onProgress?.(100, `done (${areas.length} areas, ${centerlines.length} centerlines (-${droppedCenterlines} covered), ${crossings.length} crossings, ${kerbs.length + kerbWays.length} kerbs)`);

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
    const x0 = Math.floor(minX / AREA_CELL), x1 = Math.floor(maxX / AREA_CELL);
    const y0 = Math.floor(minY / AREA_CELL), y1 = Math.floor(maxY / AREA_CELL);
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
  bbox: [number, number, number, number]
): AreaFeature[] {
  const [minX, minY, maxX, maxY] = bbox;
  const seen = new Set<AreaFeature>();
  const out: AreaFeature[] = [];
  const x0 = Math.floor(minX / AREA_CELL) - 1, x1 = Math.floor(maxX / AREA_CELL) + 1;
  const y0 = Math.floor(minY / AREA_CELL) - 1, y1 = Math.floor(maxY / AREA_CELL) + 1;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const arr = grid.get(`${x},${y}`);
      if (!arr) continue;
      for (const a of arr) {
        if (!seen.has(a)) { seen.add(a); out.push(a); }
      }
    }
  }
  return out;
}
