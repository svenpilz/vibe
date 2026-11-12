/**
 * Baked dataset schema + derived-value logic for the heightfield POC.
 * Pure module shared by the data pipeline, tests and the 3D app.
 *
 * "Real heights" come from three combined sources:
 *   1. terrain: SRTM DEM grid baked into the dataset (absolute elevation),
 *   2. buildings: OSM height=* / building:levels=* / roof:levels=*,
 *   3. roads: OSM layer=* (+ bridge=yes / tunnel=yes) stacked above terrain.
 */
import { LAYER_H } from "./geo";

export interface TerrainGrid {
  /** number of cells per side (vertices = n+1 per side) */
  n: number;
  /** world size in meters covered by the grid */
  sizeM: number;
  /** local-frame x of the grid's min corner */
  originX: number;
  /** local-frame y of the grid's min corner */
  originY: number;
  /** (n+1)^2 heights in decimeters (int), row-major from min corner (y asc) */
  heightsDm: number[];
}

export interface BakedData {
  centerLon: number;
  centerLat: number;
  radiusM: number;
  layerH: number;
  terrain: TerrainGrid;
  /** tag keys table */
  keys: string[];
  /** tag values table */
  values: string[];
  /** flat node coords: [lonQ, latQ, lonQ, latQ, ...] in 1e-7 degrees */
  nodes: number[];
  ways: BakedWay[];
}

export interface BakedWay {
  /** node indices into BakedData.nodes/2 */
  r: number[];
  /** flat tag pairs: [keyIdx, valueIdx, keyIdx, valueIdx, ...] */
  t: number[];
}

export function getTag(data: BakedData, way: BakedWay, key: string): string | undefined {
  const ki = data.keys.indexOf(key);
  if (ki < 0) return undefined;
  for (let i = 0; i < way.t.length; i += 2) {
    if (way.t[i] === ki) return data.values[way.t[i + 1]];
  }
  return undefined;
}

export function wayTags(data: BakedData, way: BakedWay): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < way.t.length; i += 2) {
    out[data.keys[way.t[i]]] = data.values[way.t[i + 1]];
  }
  return out;
}

/** Parse an OSM height-ish value ("12.5", "12 m", "12,5") to meters. */
export function parseHeightM(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const v = parseFloat(raw.replace(/,/g, ".").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Parse an OSM level count ("3", "2.5") to a float. */
export function parseLevels(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const v = parseFloat(raw.replace(/,/g, "."));
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

export const DEFAULT_BUILDING_H = 10;
export const M_PER_LEVEL = 3;
export const ROOF_H = 3;

/**
 * Real building height in meters: explicit height=* wins, then
 * building:levels (+ roof:levels) with the standard 3 m per level plus a
 * flat-roof allowance, else a default.
 */
export function buildingHeightM(tags: Record<string, string>): number {
  const h = parseHeightM(tags["height"]);
  if (h !== undefined) return h;
  const levels = parseLevels(tags["building:levels"]);
  if (levels !== undefined) {
    const roofLevels = parseLevels(tags["roof:levels"]) ?? 0;
    return levels * M_PER_LEVEL + roofLevels * M_PER_LEVEL + 2;
  }
  return DEFAULT_BUILDING_H;
}

/** Ground clearance of a building (min_height=*), 0 when absent. */
export function minHeightM(tags: Record<string, string>): number {
  return parseHeightM(tags["min_height"]) ?? 0;
}

/**
 * OSM layer of a way as int (default 0). bridge=yes without a layer implies
 * layer 1; tunnel=yes without a layer implies layer -1.
 */
export function osmLayer(tags: Record<string, string>): number {
  const raw = tags["layer"];
  let layer = raw !== undefined ? Math.round(parseFloat(raw)) : 0;
  if (!Number.isFinite(layer)) layer = 0;
  if (layer === 0) {
    if (tags["bridge"] === "yes" || tags["bridge"] === "viaduct") layer = 1;
    else if (tags["tunnel"] === "yes") layer = -1;
  }
  return layer;
}

/** Deck elevation above local terrain for a road way, in meters. */
export function layerElevationM(tags: Record<string, string>): number {
  return osmLayer(tags) * LAYER_H;
}

const ROAD_WIDTHS: Record<string, number> = {
  motorway: 13, trunk: 12, primary: 11, secondary: 10, tertiary: 9,
  unclassified: 8, residential: 7.5, living_street: 6, service: 5.5,
  motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 5.5,
  tertiary_link: 5.5, road: 7, track: 4, cycleway: 3, path: 2, footway: 2,
  pedestrian: 8, steps: 2, busway: 6, raceway: 8,
};

/** Road width in meters: explicit width=* wins, else class default. */
export function roadWidthM(tags: Record<string, string>): number {
  const w = parseHeightM(tags["width"]);
  if (w !== undefined && w >= 1 && w <= 40) return w;
  const hw = tags["highway"] ?? "road";
  const base = ROAD_WIDTHS[hw] ?? 6;
  const lanes = parseLevels(tags["lanes"]);
  if (lanes !== undefined && hw !== "footway" && hw !== "path" && hw !== "steps" && hw !== "pedestrian") {
    return Math.max(4, Math.min(20, lanes * 3.2));
  }
  return base;
}

const SURFACE_COLORS: Record<string, [number, number, number]> = {
  asphalt: [0.32, 0.32, 0.34],
  concrete: [0.62, 0.62, 0.6],
  paving_stones: [0.55, 0.53, 0.5],
  sett: [0.5, 0.48, 0.44],
  cobblestone: [0.45, 0.43, 0.4],
  grass: [0.35, 0.55, 0.3],
  gravel: [0.6, 0.56, 0.48],
  dirt: [0.55, 0.48, 0.38],
  sand: [0.76, 0.7, 0.5],
};

export function surfaceColor(tags: Record<string, string>): [number, number, number] {
  const s = tags["surface"];
  if (s && SURFACE_COLORS[s]) return SURFACE_COLORS[s];
  const hw = tags["highway"] ?? "";
  if (hw === "footway" || hw === "path" || hw === "steps" || hw === "pedestrian" || hw === "cycleway") {
    return s === "asphalt" ? SURFACE_COLORS.asphalt : [0.6, 0.58, 0.55];
  }
  if (hw === "motorway" || hw === "motorway_link") return [0.28, 0.29, 0.33];
  return SURFACE_COLORS.asphalt;
}

export function buildingColor(h: number): [number, number, number] {
  const t = Math.min(1, h / 60);
  return [0.72 - 0.25 * t, 0.62 - 0.2 * t, 0.55 - 0.15 * t];
}

/** Bilinear sample of the terrain grid at local-frame (x, y), meters a.s.l.
 *  heightsDm holds (n+1)^2 vertex heights, row-major, vertices at
 *  origin + i*cell. */
export function sampleTerrainM(g: TerrainGrid, x: number, y: number): number {
  const n = g.n;
  const cell = g.sizeM / n;
  const fx = Math.max(0, Math.min(n - 1e-9, (x - g.originX) / cell));
  const fy = Math.max(0, Math.min(n - 1e-9, (y - g.originY) / cell));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const h00 = g.heightsDm[y0 * (n + 1) + x0] * 0.1;
  const h10 = g.heightsDm[y0 * (n + 1) + x0 + 1] * 0.1;
  const h01 = g.heightsDm[(y0 + 1) * (n + 1) + x0] * 0.1;
  const h11 = g.heightsDm[(y0 + 1) * (n + 1) + x0 + 1] * 0.1;
  return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
}
