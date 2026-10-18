/**
 * Shared feature types (quantized to 1e-7 degree units).
 * Coordinates are [lonQ, latQ] with Q = 1e-7 degrees.
 */

export type Q = number; // quantized lon/lat unit

export interface AreaFeature {
  type: "area";
  id: string;
  highway: string;
  surface?: string;
  surfaceColour?: string;
  name?: string;
  wheelchair?: string;
  lit?: string;
  /** junction=yes / area:highway=junction */
  junction?: boolean;
  /** OSM layer=* tag (default 0) */
  layer: number;
  /** OSM level=* tag (undefined when absent) */
  level?: number;
  outer: Q[][][];
  holes: Q[][][];
  bbox: [number, number, number, number];
}

export interface LineFeature {
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
  /** OSM layer=* tag (default 0) */
  layer: number;
  /** OSM level=* tag (undefined when absent) */
  level?: number;
  /** ids of the highway areas the way corresponds to (markings clipped to them) */
  areaIds?: string[];
  /** lanes=* total lane count (centerlines only) */
  lanes?: number;
  /** lane_markings=no: lanes exist but are not painted */
  noLaneMarkings?: boolean;
  /** lane width in meters inferred from the highway area (centerlines only) */
  laneW?: number;
  /** distance in meters from centerline to the left area edge (centerlines only) */
  laneLeftM?: number;
  /** distance in meters from centerline to the right area edge (centerlines only) */
  laneRightM?: number;
  /** measured distance in meters from centerline to the LEFT road edge of the piece (markings only) */
  roadLeftM?: number;
  /** measured distance in meters from centerline to the RIGHT road edge of the piece (markings only) */
  roadRightM?: number;
  /** number of lanes forward (same direction of travel, centerlines only) */
  lanesFwd?: number;
  /** oneway=yes / -1 / roundabout: all lanes travel in one direction */
  oneway?: boolean;
  /** parking:lane:left/both consumes the outer left width unit */
  parkingLeft?: boolean;
  /** parking:lane:right/both consumes the outer right width unit */
  parkingRight?: boolean;
  coords: Q[][];
  bbox: [number, number, number, number];
}

export interface BuildingFeature {
  type: "building";
  id: string;
  /** building=* value ("yes" when tag present without a value) */
  building: string;
  /** residential (building=residential/house/apartments) or other */
  usage: "residential" | "other";
  name?: string;
  /** OSM layer=* tag (default 0) */
  layer: number;
  /** OSM level=* tag (undefined when absent) */
  level?: number;
  outer: Q[][][];
  bbox: [number, number, number, number];
}

export interface GrassFeature {
  type: "grass";
  id: string;
  /** landuse/natural/leisure key of the source (grass, scrub, garden) */
  kind: string;
  /** OSM layer=* tag (default 0) */
  layer: number;
  /** OSM level=* tag (undefined when absent) */
  level?: number;
  outer: Q[][][];
  holes: Q[][][];
  bbox: [number, number, number, number];
}

export interface ManholeFeature {
  type: "manhole";
  id: string;
  /** OSM layer=* tag (default 0) */
  layer: number;
  /** OSM level=* tag (undefined when absent) */
  level?: number;
  lat: Q;
  lon: Q;
}

export interface ParkingFeature {
  type: "parking";
  id: string;
  /** surface=* tag taken directly from the area */
  surface?: string;
  surfaceColour?: string;
  /** OSM layer=* tag (default 0) */
  layer: number;
  /** OSM level=* tag (undefined when absent) */
  level?: number;
  outer: Q[][][];
  holes: Q[][][];
  bbox: [number, number, number, number];
}

export interface StreetLampFeature {
  type: "streetlamp";
  id: string;
  /** OSM layer=* tag (default 0) */
  layer: number;
  /** OSM level=* tag (undefined when absent) */
  level?: number;
  lat: Q;
  lon: Q;
}

export interface LanduseFeature {
  type: "landuse";
  id: string;
  /** residential or commercial */
  kind: string;
  /** OSM layer=* tag (default 0) */
  layer: number;
  /** OSM level=* tag (undefined when absent) */
  level?: number;
  outer: Q[][][];
  holes: Q[][][];
  bbox: [number, number, number, number];
}

export interface BollardFeature {
  type: "bollard";
  id: string;
  /** OSM layer=* tag (default 0) */
  layer: number;
  /** OSM level=* tag (undefined when absent) */
  level?: number;
  lat: Q;
  lon: Q;
}

export interface FenceFeature {
  type: "fence";
  id: string;
  /** fence type (fence_type=* or barrier value) */
  fence?: string;
  /** OSM layer=* tag (default 0) */
  layer: number;
  /** OSM level=* tag (undefined when absent) */
  level?: number;
  coords: Q[][];
  bbox: [number, number, number, number];
}

export interface KerbFeature {
  type: "kerb";
  id: string;
  kerb: string;
  tactilePaving?: string;
  /** OSM layer=* tag (default 0) */
  layer: number;
  /** OSM level=* tag (undefined when absent) */
  level?: number;
  lat: Q;
  lon: Q;
}

export interface KerbWayFeature {
  type: "kerbway";
  id: string;
  kerb: string;
  tactilePaving?: string;
  /** kerb nodes on this way: vertex index + kerb type (local override, ~1 m radius) */
  overrides?: { idx: number; kerb: string }[];
  /** OSM layer=* tag (default 0) */
  layer: number;
  /** OSM level=* tag (undefined when absent) */
  level?: number;
  coords: Q[][];
  bbox: [number, number, number, number];
}

export type Feature = AreaFeature | BuildingFeature | GrassFeature | LineFeature | KerbFeature | KerbWayFeature | BollardFeature | FenceFeature | LanduseFeature | StreetLampFeature | ParkingFeature | ManholeFeature;

export interface Dataset {
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
}

export const SURFACE_COLORS: Record<string, string> = {
  asphalt: "#3d3d42",
  concrete: "#8d8d93",
  "concrete:plates": "#9a9aa0",
  sett: "#7a6a52",
  paving_stones: "#75685a",
  "paving_stones:lanes": "#75685a",
  cobblestone: "#6d6055",
  "cobblestone:flattened": "#6d6055",
  unhewn_cobblestone: "#5e5347",
  granite: "#83756a",
  gravel: "#a89c85",
  fine_gravel: "#b3a892",
  compacted: "#96917f",
  ground: "#7d745f",
  dirt: "#806f52",
  sand: "#cbb384",
  grass: "#5d7a44",
  grass_paver: "#688052",
  metal: "#9aa4ad",
  wood: "#8a6f4d",
  pebblestone: "#9b9284",
  woodchips: "#8a6f4d",
};

export function surfaceColor(surface?: string): string {
  if (!surface) return "#4a4a50";
  if (SURFACE_COLORS[surface]) return SURFACE_COLORS[surface];
  const base = surface.split(";")[0].split(":")[0];
  return SURFACE_COLORS[base] ?? "#4a4a50";
}

export function normalizeSurface(s?: string): string | undefined {
  if (!s) return undefined;
  return s.split(";")[0].split(":")[0];
}
