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
  /** man_made=bridge: the area is a bridge deck even without layer>0 */
  bridge: boolean;
  /** road/bridge deck area: height is plane-fitted (locally flat) */
  road: boolean;
  /** the area's height function (plane-fitted for road areas) */
  fn: (lon: number, lat: number) => number;
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
}

/** Least-squares plane z = a + b*x + c*y (x/y in meters) fitted to the base
 *  height sampled at the ring vertices and on a coarse interior grid.
 *  Roads/bridges are locally flat in reality — this removes DEM noise and
 *  polygon/DEM mismatch bumps while keeping the overall up/down slope.
 *  Falls back to a constant (mean height) when the samples are degenerate */
function planeFitM(
  rings: [number, number][][],
  base: (lon: number, lat: number) => number,
): (lon: number, lat: number) => number {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const pts: [number, number][] = [];
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      pts.push([lon, lat]);
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!Number.isFinite(minLon)) return base;
  const lon0 = (minLon + maxLon) / 2, lat0 = (minLat + maxLat) / 2;
  // meters per degree at the polygon center
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180), my = 110540;
  // coarse interior grid (only points inside the outer ring)
  const outer = rings[0];
  const NX = 5, NY = 5;
  for (let i = 0; i <= NX; i++)
    for (let j = 0; j <= NY; j++) {
      const lon = minLon + ((maxLon - minLon) * i) / NX;
      const lat = minLat + ((maxLat - minLat) * j) / NY;
      if (pointInRing(lon, lat, outer)) pts.push([lon, lat]);
    }
  let sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
  const n = pts.length;
  for (const [lon, lat] of pts) {
    const x = (lon - lon0) * mx, y = (lat - lat0) * my, z = base(lon, lat);
    sx += x; sy += y; sz += z;
    sxx += x * x; sxy += x * y; syy += y * y;
    sxz += x * z; syz += y * z;
  }
  // normal equations for z = a + b*x + c*y
  const A = [
    [n, sx, sy, sz],
    [sx, sxx, sxy, sxz],
    [sy, sxy, syy, syz],
  ];
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  let a: number, b: number, c: number;
  if (!Number.isFinite(D) || Math.abs(D) < 1e-9) {
    a = sz / Math.max(1, n); b = 0; c = 0; // degenerate: flat at mean height
  } else {
    const rep = (col: number) => {
      const m = A.map((r) => [...r]);
      for (let i = 0; i < 3; i++) m[i][col] = m[i][3];
      return det(m);
    };
    a = rep(0) / D; b = rep(1) / D; c = rep(2) / D;
  }
  return (lon, lat) => a + b * (lon - lon0) * mx + c * (lat - lat0) * my;
}

/** effective structure level: a man_made=bridge deck counts as at least layer 1 */
function effLayer(layer: number, bridge: boolean): number {
  return bridge ? Math.max(layer, 1) : layer;
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

  /** height policy by layer only: layer>0 -> DOM surface, layer 0 -> DGM */
  fillM(layer: number): (lon: number, lat: number) => number {
    if (layer > 0) return this.surfaceFn();
    return this.groundFn();
  }

  /** register an area polygon (lon/lat outer ring) so that line/point features
   *  can reuse its vertices and stick to it */
  registerArea(outer: [number, number][], layer: number, bridge = false, road = false): void {
    if (outer.length < 3) return;
    const eff = effLayer(layer, bridge);
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lon, lat] of outer) {
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      const key = vkey(lon, lat);
      const prevMax = this.vertexMaxLayer.get(key) ?? 0;
      if (eff > prevMax) this.vertexMaxLayer.set(key, eff);
    }
    // road/bridge deck areas are plane-fitted: locally flat, but can slope
    const f = road ? planeFitM([outer], this.fillM(eff)) : this.fillM(eff);
    this.areas.push({ outer, layer, bridge, road, fn: f, bbox: [minLon, minLat, maxLon, maxLat] });
    for (const [lon, lat] of outer) {
      const key = vkey(lon, lat);
      const z = f(lon, lat);
      const prev = this.vertexM.get(key);
      // on conflict (shared vertex of a ground road and a bridge), the
      // higher layer's height wins — it is the visible top from above
      if (prev === undefined || eff > this.vertexLayer.get(key)!) {
        this.vertexM.set(key, z);
        this.vertexLayer.set(key, eff);
      }
    }
  }
  private vertexLayer = new Map<string, number>();
  /** quantized vertex -> highest layer of any feature touching it */
  private vertexMaxLayer = new Map<string, number>();

  /** mark the vertices of a higher-layer line (e.g. a bridge way): polygons
   *  connected to them take the DOM surface height to stay continuous */
  markHighLine(coords: [number, number][], layer: number, bridge = false): void {
    const eff = effLayer(layer, bridge);
    for (const [lon, lat] of coords) {
      const key = vkey(lon, lat);
      const prevMax = this.vertexMaxLayer.get(key) ?? 0;
      if (eff > prevMax) this.vertexMaxLayer.set(key, eff);
    }
  }

  /** height policy for an area feature: layer>0 (bridge deck) takes the DOM
   *  surface; a layer-0 polygon that shares a vertex with a higher-layer
   *  feature is connected to it and also takes the DOM (stays continuous with
   *  the deck); everything else stays on the DGM ground. With
   *  connected=false the vertex-sharing rule is skipped (landuse always
   *  stays on the ground, even where it touches a bridge). With flatten=true
   *  the chosen surface is plane-fitted over the polygon (roads/bridges are
   *  locally flat but may slope as a whole) */
  fillMFor(rings: [number, number][][], layer: number, bridge = false, connected = true, flatten = false): (lon: number, lat: number) => number {
    let base: (lon: number, lat: number) => number;
    if (effLayer(layer, bridge) > 0) base = this.surfaceFn();
    else {
      let hit = false;
      if (connected)
        for (const ring of rings)
          for (const [lon, lat] of ring)
            if ((this.vertexMaxLayer.get(vkey(lon, lat)) ?? 0) > 0) { hit = true; break; }
      base = hit ? this.surfaceFn() : this.groundFn();
    }
    // roads/bridges: plane-fit the surface — locally flat, keeps the slope
    return flatten ? planeFitM(rings, base) : base;
  }

  private surfaceFn(): (lon: number, lat: number) => number {
    const dom = this.dom, dem = this.dem;
    return (lon, lat) => (dom ? dom.sampleM(lon, lat) ?? (dem ? dem.sampleM(lon, lat) ?? 0 : 0) : dem ? dem.sampleM(lon, lat) ?? 0 : 0);
  }
  private groundFn(): (lon: number, lat: number) => number {
    const dem = this.dem;
    return (lon, lat) => (dem ? dem.sampleM(lon, lat) ?? 0 : 0);
  }

  /** height for a line/point feature at lon/lat on layer `layer`:
   *  1. reuse a registered area vertex when coincident (shared OSM node),
   *  2. else the containing area on the SAME OR LOWER layer — a bridge deck
   *     polygon is the ground level for same-layer features inside it, while
   *     lower-layer features inside it (road passing under the bridge in 2D)
   *     stay on the ground,
   *  3. else DOM surface for layer>0, DGM ground for layer 0 */
  stickM(lon: number, lat: number, layer = 0): number {
    const key = vkey(lon, lat);
    const hit = this.vertexM.get(key);
    if (hit !== undefined) return hit;
    let best: AreaEntry | null = null,
      bestEff = -1;
    for (const a of this.areas) {
      const [minLon, minLat, maxLon, maxLat] = a.bbox;
      if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
      if (!pointInRing(lon, lat, a.outer)) continue;
      const e = effLayer(a.layer, a.bridge);
      if (e <= layer && e > bestEff) {
        best = a;
        bestEff = e;
      }
    }
    if (best) return best.fn(lon, lat);
    return layer > 0 ? this.surfaceM(lon, lat) ?? 0 : this.groundM(lon, lat) ?? 0;
  }
}

function vkey(lon: number, lat: number): string {
  return `${Math.round(lon * 1e7)}:${Math.round(lat * 1e7)}`;
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
