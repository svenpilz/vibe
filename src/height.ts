/**
 * Height policy for terrain displacement, combining the two DEM products:
 *
 *  - DGM (ground model): height of the bare ground. Used for layer-0 area
 *    fills (landuse, area:highway, parking, grass). Cells occluded from above
 *    by a higher-layer feature or a building are inpainted from visible ground.
 *  - DOM (surface model, includes buildings/bridges/vegetation): height of the
 *    topmost visible surface. Used for features that ARE structures:
 *    layer>0 areas (bridge decks), building roofs.
 *
 * Line/point features without their own area (kerbs, lane markings, lamps,
 * bollards, …) must stick to the area they belong to — e.g. a kerb on the
 * boundary of an area:highway reuses that polygon's vertices (exact same
 * height), and otherwise falls back to the topmost area containing the point.
 * A layer-0 road passing under a bridge therefore stays on the ground, and
 * its kerbs stay with it — they are not lifted to the bridge deck.
 */

import { DemField } from "./dem";

interface AreaEntry {
  outer: [number, number][]; // lon/lat ring
  layer: number;
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
}

export class HeightField {
  dem: DemField | null = null;
  dom: DemField | null = null;
  /** quantized vertex (1e-7 deg) -> ground/surface height in meters, from the
   *  area polygons registered; on conflict the higher layer wins */
  private vertexM = new Map<string, number>();
  private areas: AreaEntry[] = [];

  async loadDem(url: string): Promise<void> {
    try {
      this.dem = await DemField.load(url);
    } catch {
      this.dem = null;
    }
  }
  async loadDom(url: string): Promise<void> {
    try {
      this.dom = await DemField.load(url);
    } catch {
      this.dom = null;
    }
  }

  get ready(): boolean {
    return this.dem !== null || this.dom !== null;
  }

  /** bare-ground height in meters (DGM, occlusion-inpainted), null if unknown */
  groundM(lon: number, lat: number): number | null {
    return this.dem ? this.dem.sampleM(lon, lat) : null;
  }

  /** topmost visible surface height in meters (DOM, else DGM), null if unknown */
  surfaceM(lon: number, lat: number): number | null {
    const src = this.dom ?? this.dem;
    return src ? src.sampleM(lon, lat) : null;
  }

  /** height policy for an area feature: layer>0 (bridge deck) -> DOM surface,
   *  layer 0 -> DGM ground */
  fillM(layer: number): (lon: number, lat: number) => number {
    const dom = this.dom;
    if (layer > 0 && dom) return (lon, lat) => dom.sampleM(lon, lat) ?? 0;
    const dem = this.dem;
    return (lon, lat) => (dem ? dem.sampleM(lon, lat) ?? 0 : 0);
  }

  /** register an area polygon (lon/lat outer ring) so that line/point features
   *  can reuse its vertices and stick to it */
  registerArea(outer: [number, number][], layer: number): void {
    if (outer.length < 3) return;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lon, lat] of outer) {
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
    this.areas.push({ outer, layer, bbox: [minLon, minLat, maxLon, maxLat] });
    const f = this.fillM(layer);
    for (const [lon, lat] of outer) {
      const key = `${Math.round(lon * 1e7)}:${Math.round(lat * 1e7)}`;
      const z = f(lon, lat);
      const prev = this.vertexM.get(key);
      // on conflict (shared vertex of a ground road and a bridge), the
      // higher layer's height wins — it is the visible top from above
      if (prev === undefined || layer > this.vertexLayer.get(key)!) {
        this.vertexM.set(key, z);
        this.vertexLayer.set(key, layer);
      }
    }
  }
  private vertexLayer = new Map<string, number>();

  /** height for a line/point feature at lon/lat: reuse a registered area
   *  vertex when coincident, else the topmost containing area, else the DOM */
  stickM(lon: number, lat: number): number {
    const key = `${Math.round(lon * 1e7)}:${Math.round(lat * 1e7)}`;
    const hit = this.vertexM.get(key);
    if (hit !== undefined) return hit;
    let best: AreaEntry | null = null;
    for (const a of this.areas) {
      const [minLon, minLat, maxLon, maxLat] = a.bbox;
      if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
      if (!pointInRing(lon, lat, a.outer)) continue;
      if (!best || a.layer > best.layer) best = a;
    }
    if (best) return this.fillM(best.layer)(lon, lat);
    return this.surfaceM(lon, lat) ?? 0;
  }
}

function pointInRing(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
