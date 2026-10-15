/**
 * Extracts micromapping features from the Berlin PBF into data/map.jsonl
 * consumed by the frontend:
 *
 *   areas     : area:highway polygons (closed ways + multipolygon relations,
 *              with holes). Surface from the area itself; if absent, inherited
 *              from a highway centerline that intersects the area.
 *   centerlines: highway ways whose centerline runs inside an area (footway/
 *              pedestrian/service etc.), carrying surface/surface:colour/width.
 *   footways  : highway=footway/sidewalk lines with surface + width.
 *   crossings : footway=crossing ways with crossing:markings (zebra/dashes/...).
 *   kerbs     : barrier=kerb nodes with kerb=* details.
 */
import { OSMPBFParser, createOSMData, type OSMTags, type OSMWay } from "../src/osm-pbf";
import { mkdirSync, writeFileSync, writeSync, openSync } from "node:fs";

const PBF = process.env.PBF ?? "data/berlin-latest.osm.pbf";
const OUT = "data/map.jsonl";

interface AreaFeature {
  type: "area";
  id: string;
  highway: string;
  surface?: string;
  surfaceColour?: string;
  name?: string;
  wheelchair?: string;
  lit?: string;
  outer: number[][][];
  holes: number[][][];
  bbox: [number, number, number, number];
}
interface LineFeature {
  type: "centerline" | "footway" | "crossing";
  id: string;
  highway?: string;
  footway?: string;
  crossing?: string;
  crossingMarkings?: string;
  surface?: string;
  surfaceColour?: string;
  width?: number;
  lit?: string;
  name?: string;
  coords: number[][];
  bbox: [number, number, number, number];
}
interface KerbFeature {
  type: "kerb";
  id: string;
  kerb: string;
  tactilePaving?: string;
  lat: number;
  lon: number;
}

function q(coords: [number, number][]): number[][] {
  const out: number[][] = new Array(coords.length);
  for (let i = 0; i < coords.length; i++) {
    out[i] = [Math.round(coords[i][0] * 1e7), Math.round(coords[i][1] * 1e7)];
  }
  return out;
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

// quantized-space helpers (units of 1e-7 degrees)

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

function wayCoords(way: OSMWay): [number, number][] | null {
  const coords: [number, number][] = [];
  for (const ref of way.refs) {
    const c = data.nodeCoords.get(ref);
    if (!c) return null;
    coords.push([c.lon, c.lat]);
  }
  return coords;
}

function isClosed(way: OSMWay): boolean {
  return way.refs.length > 3 && way.refs[0] === way.refs[way.refs.length - 1];
}

const CENTERLINE_HIGHWAYS = new Set([
  "footway", "pedestrian", "service", "living_street", "residential", "unclassified",
  "cycleway", "path", "steps", "track", "road",
]);

console.log(`parsing ${PBF} ...`);
const data = createOSMData();
const t0 = Date.now();
const parser = new OSMPBFParser(data, (tags) => tags["barrier"] === "kerb" || tags["kerb"] !== undefined || tags["traffic_calming"] !== undefined);
parser.parseFile(PBF);
console.log(`parsed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---- classify ways ------------------------------------------------------
const areas: AreaFeature[] = [];
const centerlines: LineFeature[] = [];
const footways: LineFeature[] = [];
const crossings: LineFeature[] = [];

let wayCount = 0;
for (const way of data.ways.values()) {
  wayCount++;
  const tags = way.tags;
  const areaHighway = tags["area:highway"];
  const highway = tags["highway"];

  if (areaHighway && isClosed(way)) {
    const coords = wayCoords(way);
    if (!coords) continue;
    const qc = q(coords);
    areas.push({
      type: "area",
      id: `w${way.id}`,
      highway: areaHighway,
      surface: tags["surface"],
      surfaceColour: tags["surface:colour"] ?? tags["colour"],
      name: tags["name"],
      wheelchair: tags["wheelchair"],
      lit: tags["lit"],
      outer: [qc],
      holes: [],
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
        coords: qc,
        bbox: bboxOfQ(qc),
      });
    }
  }
}

// ---- multipolygon relations with area:highway ---------------------------
for (const rel of data.relations) {
  const tags = rel.tags;
  const areaHighway = tags["area:highway"];
  if (!areaHighway || tags["type"] !== "multipolygon") continue;

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
  areas.push({
    type: "area",
    id: `r${rel.id}`,
    highway: areaHighway,
    surface: tags["surface"],
    surfaceColour: tags["surface:colour"] ?? tags["colour"],
    name: tags["name"],
    wheelchair: tags["wheelchair"],
    lit: tags["lit"],
    outer: outerRings,
    holes: holeRings,
    bbox: bboxOfQ(all),
  });
}

console.log(`ways scanned: ${wayCount}`);
console.log(`areas: ${areas.length} (incl. ${areas.filter(a => a.id.startsWith("r")).length} multipolygons)`);
console.log(`centerlines: ${centerlines.length}`);
console.log(`footways: ${footways.length}`);
console.log(`crossings: ${crossings.length}`);

// ---- kerbs --------------------------------------------------------------
const kerbs: KerbFeature[] = [];
for (const [id, tags] of data.nodeTags) {
  if (tags["barrier"] === "kerb" || tags["kerb"] !== undefined) {
    const c = data.nodeCoords.get(id);
    if (!c) continue;
    kerbs.push({
      type: "kerb",
      id: `n${id}`,
      kerb: tags["kerb"] ?? tags["barrier"],
      tactilePaving: tags["tactile_paving"],
      lat: Math.round(c.lat * 1e7),
      lon: Math.round(c.lon * 1e7),
    });
  }
}
console.log(`kerbs: ${kerbs.length}`);

// free parse structures before building the area index
// @ts-ignore
data.ways = undefined as any;
// @ts-ignore
data.relations = undefined as any;
// @ts-ignore
data.nodeTags = undefined as any;
global.gc?.();

// ---- surface inheritance: area <- intersecting centerline ---------------
let inherited = 0;
const areaGrid = buildAreaIndex(areas);
for (const cl of centerlines) {
  if (!cl.surface) continue;
  const candidates = queryAreas(areaGrid, cl.bbox);
  for (const area of candidates) {
    if (area.surface) continue;
    if (!bboxOverlap(area.bbox, cl.bbox)) continue;
    const mid = cl.coords[Math.floor(cl.coords.length / 2)];
    if (pointInAreaQ(mid, area)) {
      area.surface = cl.surface;
      area.surfaceColour = area.surfaceColour ?? cl.surfaceColour;
      inherited++;
    }
  }
}
console.log(`surfaces inherited from centerlines: ${inherited}`);

// ---- write jsonl --------------------------------------------------------
type AnyFeature = AreaFeature | LineFeature | KerbFeature;
mkdirSync("data", { recursive: true });
const fd = openSync(OUT, "w");
let count = 0;
const pushLine = (f: AnyFeature) => {
  writeSync(fd, JSON.stringify(f) + "\n");
  count++;
};
for (const a of areas) pushLine(a);
for (const c of centerlines) pushLine(c);
for (const f of footways) pushLine(f);
for (const c of crossings) pushLine(c);
for (const k of kerbs) pushLine(k);
const { closeSync } = await import("node:fs");
closeSync(fd);
console.log(`wrote ${OUT}: ${count} features`);

// ---- simple grid index for areas -----------------------------------------
type AreaIndex = Map<string, AreaFeature[]>;
function buildAreaIndex(areas: AreaFeature[]): AreaIndex {
  const CELL = 50000; // 0.005 deg in 1e-7 units (~500m)
  const grid: AreaIndex = new Map();
  for (const a of areas) {
    const [minX, minY, maxX, maxY] = a.bbox;
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const y0 = Math.floor(minY / CELL), y1 = Math.floor(maxY / CELL);
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
function queryAreas(grid: AreaIndex, bbox: [number, number, number, number]): AreaFeature[] {
  const CELL = 50000; // 0.005 deg in 1e-7 units
  const [minX, minY, maxX, maxY] = bbox;
  const seen = new Set<AreaFeature>();
  const out: AreaFeature[] = [];
  const x0 = Math.floor(minX / CELL) - 1, x1 = Math.floor(maxX / CELL) + 1;
  const y0 = Math.floor(minY / CELL) - 1, y1 = Math.floor(maxY / CELL) + 1;
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
