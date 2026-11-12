/**
 * Shared geodesy for the heightfield POC. Pure module: used by the data
 * pipeline (Node), the tests and the 3D app alike.
 *
 * Local frame: equirectangular projection around CENTER, x = east (m),
 * y = north (m), origin at CENTER. At 2 km scale the error is < 0.1 %.
 */

/** S-Bahnhof Friedenau, Berlin. */
export const CENTER = { lon: 13.341, lat: 52.4784 };

/** Experiment radius in meters. */
export const RADIUS_M = 2000;

/** Vertical distance per OSM layer step (bridge deck above the road below). */
export const LAYER_H = 5;

export const EARTH_R = 6371000;

export function metersPerDegLat(lat: number): number {
  const r = (lat * Math.PI) / 180;
  return 111132.92 - 559.82 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r);
}

export function metersPerDegLon(lat: number): number {
  return 111412.84 * Math.cos((lat * Math.PI) / 180) - 93.5 * Math.cos(3 * (lat * Math.PI) / 180);
}

/** lon/lat (degrees) -> local meters [x east, y north] relative to CENTER. */
export function lonLatToMeters(lon: number, lat: number): [number, number] {
  const x = (lon - CENTER.lon) * metersPerDegLon(CENTER.lat);
  const y = (lat - CENTER.lat) * metersPerDegLat(CENTER.lat);
  return [x, y];
}

/** local meters -> lon/lat (degrees). Inverse of lonLatToMeters. */
export function metersToLonLat(x: number, y: number): [number, number] {
  const lon = CENTER.lon + x / metersPerDegLon(CENTER.lat);
  const lat = CENTER.lat + y / metersPerDegLat(CENTER.lat);
  return [lon, lat];
}

/** Quantize degrees to 1e-7 degree units (int32-safe, ~1.1 cm). */
export function quantizeDeg(deg: number): number {
  return Math.round(deg * 1e7);
}

export function dequantizeDeg(q: number): number {
  return q / 1e7;
}

/** Great-circle-ish distance in meters between two lon/lat points (local frame). */
export function distanceM(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
