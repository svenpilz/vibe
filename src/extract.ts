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
import type { Q, AreaFeature, BuildingFeature, LineFeature, KerbFeature, KerbWayFeature } from "./features";

export interface ExtractResult {
  areas: AreaFeature[];
  buildings: BuildingFeature[];
  centerlines: LineFeature[];
  footways: LineFeature[];
  crossings: LineFeature[];
  kerbs: KerbFeature[];
  kerbWays: KerbWayFeature[];
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

function bboxOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
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
]);

export function extractFeatures(
  data: OSMData,
  onProgress?: (pct: number, msg: string) => void
): ExtractResult {
  const areas: AreaFeature[] = [];
  const buildings: BuildingFeature[] = [];
  const centerlines: LineFeature[] = [];
  const footways: LineFeature[] = [];
  const crossings: LineFeature[] = [];
  const kerbWays: KerbWayFeature[] = [];
  const kerbs: KerbFeature[] = [];

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

    if (tags["building"] !== undefined && isClosed(way)) {
      const coords = wayCoords(way);
      if (coords) {
        const qc = q(coords);
        buildings.push({
          type: "building",
          id: `w${way.id}`,
          building: tags["building"] || "yes",
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
        layer: parseLayer(tags["layer"]),
      level: parseLevel(tags["level"]),
        outer: [qc],
        holes: [],
        bbox: bboxOfQ(qc),
      });
      continue;
    }

    const isKerbWay = tags["barrier"] === "kerb" || tags["kerb"] !== undefined;
    if (isKerbWay) {
      const coords = wayCoords(way);
      if (!coords) continue;
      const qc = q(coords);
      kerbWays.push({
        type: "kerbway",
        id: `w${way.id}`,
        kerb: tags["kerb"] ?? tags["barrier"],
        tactilePaving: tags["tactile_paving"],
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
                 && (tags["surface"] !== undefined || widthNum !== undefined)) {
        const qc = q(coords);
        centerlines.push({
          type: "centerline",
          id: `w${way.id}`,
          highway,
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
      }
    }
  }

  onProgress?.(30, "assembling multipolygons…");
  for (const rel of data.relations) {
    const tags = rel.tags;
    const areaHighway = tags["area:highway"];
    const buildingTag = tags["building"];
    if ((!areaHighway && !buildingTag) || tags["type"] !== "multipolygon") continue;

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
    if (!areaHighway) {
      buildings.push({
        type: "building",
        id: `r${rel.id}`,
        building: buildingTag || "yes",
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

  // surface inheritance: area <- intersecting centerline of the same highway
  // type. Without the type check, sidewalk centerlines (footway,
  // surface=paving_stones) that cross road-area polygons donate their surface
  // to the road, painting residential/secondary areas as paving stone.
  onProgress?.(70, "inheriting surfaces from centerlines…");
  const areaGrid = buildAreaIndex(areas);
  let inherited = 0;
  for (const cl of centerlines) {
    if (!cl.surface) continue;
    const candidates = queryAreas(areaGrid, cl.bbox);
    for (const area of candidates) {
      if (area.surface) continue;
      if (!highwayTypesCompatible(cl.highway, area.highway)) continue;
      if (!bboxOverlap(area.bbox, cl.bbox)) continue;
      const mid = cl.coords[Math.floor(cl.coords.length / 2)];
      if (pointInAreaQ(mid, area)) {
        area.surface = cl.surface;
        area.surfaceColour = area.surfaceColour ?? cl.surfaceColour;
        inherited++;
      }
    }
  }
  void inherited;

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

  // collect all layer values
  const layerSet = new Set<number>();
  for (const a of areas) layerSet.add(a.layer);
  for (const b of buildings) layerSet.add(b.layer);
  for (const c of centerlines) layerSet.add(c.layer);
  for (const f of footways) layerSet.add(f.layer);
  for (const c of crossings) layerSet.add(c.layer);
  for (const k of kerbWays) layerSet.add(k.layer);
  for (const k of kerbs) layerSet.add(k.layer);
  const layers = [...layerSet].sort((a, b) => a - b);

  // collect all level values (only features with an explicit level=*)
  const levelSet = new Set<number>();
  for (const arr of [areas, buildings, centerlines, footways, crossings, kerbWays, kerbs]) {
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

  onProgress?.(100, `done (${areas.length} areas, ${centerlines.length} centerlines (-${droppedCenterlines} covered), ${crossings.length} crossings, ${kerbs.length + kerbWays.length} kerbs)`);

  return {
    areas,
    buildings,
    centerlines,
    footways,
    crossings,
    kerbs,
    kerbWays,
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
