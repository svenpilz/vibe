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
  /** ring keys of areas "connected" to a higher-layer structure: directly
   *  (shared vertex with a high line or a layer>0/bridge area) or ONE hop
   *  further (shared vertex with such an area) — not transitive beyond that */
  private connectedRings = new Set<string>();

  private ringKey(ring: [number, number][]): string {
    const f = ring[0], l = ring[ring.length - 1];
    return `${vkey(f[0], f[1])}|${vkey(l[0], l[1])}|${ring.length}`;
  }

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

  /** after all areas and high lines are registered: compute which areas are
   *  "connected" to a higher-layer structure — directly (shared vertex with a
   *  high line or a layer>0/bridge area) or, FOR ROAD AREAS ONLY (ramps), one
   *  hop further via a shared vertex with such an area; NOT transitive beyond
   *  that. Connected areas take the DOM surface, and their stored height fn +
   *  vertex heights are recomputed on the DOM so lane markings/kerbs stick to
   *  the same surface the fill renders on */
  finalizeConnections(): void {
    const n = this.areas.length;
    const direct = new Array<boolean>(n).fill(false);
    for (let i = 0; i < n; i++) {
      const a = this.areas[i];
      if (effLayer(a.layer, a.bridge) > 0) { direct[i] = true; continue; }
      for (const [lon, lat] of a.outer)
        if ((this.vertexMaxLayer.get(vkey(lon, lat)) ?? 0) > 0) { direct[i] = true; break; }
    }
    // one hop: ROAD areas ADJACENT to a direct area (e.g. a ramp touching a
    // bridge deck) — other polygon classes are not propagated. "Adjacent"
    // means the rings share a vertex exactly OR their boundaries come within
    // ADJ_TOL_M meters (connected roads share adjacent vertices even when the
    // mapped nodes do not coincide exactly)
    const adjacent = new Array<boolean>(n).fill(false);
    for (let i = 0; i < n; i++) {
      if (!direct[i]) continue;
      const a = this.areas[i];
      for (let j = 0; j < n; j++) {
        if (direct[j] || adjacent[j] || !this.areas[j].road) continue;
        const b = this.areas[j];
        // bbox prefilter (expanded by the tolerance)
        const tolDeg = ADJ_TOL_M / 110540;
        if (
          b.bbox[0] > a.bbox[2] + tolDeg || a.bbox[0] > b.bbox[2] + tolDeg ||
          b.bbox[1] > a.bbox[3] + tolDeg || a.bbox[1] > b.bbox[3] + tolDeg
        )
          continue;
        if (ringsAdjacentM(a.outer, b.outer, ADJ_TOL_M)) adjacent[j] = true;
      }
    }
    for (let i = 0; i < n; i++) {
      const a = this.areas[i];
      const eff = effLayer(a.layer, a.bridge);
      if (eff > 0) continue; // structures already render on the DOM
      if (!direct[i] && !adjacent[i]) continue;
      this.connectedRings.add(this.ringKey(a.outer));
      // recompute the stored fn on the DOM surface so sticking features ride
      // the same (plane-fitted) surface as the rendered fill
      const f = a.road ? planeFitM([a.outer], this.surfaceFn()) : this.surfaceFn();
      a.fn = f;
      for (const [lon, lat] of a.outer) {
        const key = vkey(lon, lat);
        const prev = this.vertexM.get(key);
        if (prev === undefined || eff > this.vertexLayer.get(key)!) {
          this.vertexM.set(key, f(lon, lat));
          this.vertexLayer.set(key, eff);
        }
      }
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
      if (connected) {
        // one-hop adjacency (computed by finalizeConnections) + direct
        // shared-vertex rule (fallback for unregistered rings / high lines)
        if (rings.length > 0 && this.connectedRings.has(this.ringKey(rings[0]))) hit = true;
        if (!hit)
          for (const ring of rings)
            for (const [lon, lat] of ring)
              if ((this.vertexMaxLayer.get(vkey(lon, lat)) ?? 0) > 0) { hit = true; break; }
      }
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

/** tolerance for "connected roads share adjacent vertices": boundaries closer
 *  than this (in meters) count as touching even without identical nodes */
const ADJ_TOL_M = 2;

/** do two rings share a vertex exactly or come within tolM meters of each
 *  other (vertex-to-segment distance, symmetric)? */
function ringsAdjacentM(
  a: [number, number][],
  b: [number, number][],
  tolM: number,
): boolean {
  const aKeys = new Set(a.map(([x, y]) => vkey(x, y)));
  for (const [x, y] of b) if (aKeys.has(vkey(x, y))) return true;
  // geometric fallback: meters-per-degree at the rings' mean latitude
  let latSum = 0;
  for (const [, y] of a) latSum += y;
  for (const [, y] of b) latSum += y;
  const lat0 = latSum / (a.length + b.length);
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180), my = 110540;
  const near = (ring: [number, number][], pt: [number, number]): boolean => {
    const px = (pt[0] - ring[0][0]) * mx, py = (pt[1] - ring[0][1]) * my;
    // cheap reject: point far outside the ring bbox (in meters)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of ring) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const tolDegX = tolM / mx, tolDegY = tolM / my;
    if (
      pt[0] < minX - tolDegX || pt[0] > maxX + tolDegX ||
      pt[1] < minY - tolDegY || pt[1] > maxY + tolDegY
    )
      return false;
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      const axm = (ax - ring[0][0]) * mx, aym = (ay - ring[0][1]) * my;
      const bxm = (bx - ring[0][0]) * mx, bym = (by - ring[0][1]) * my;
      const dx = bxm - axm, dy = bym - aym;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((px - axm) * dx + (py - aym) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = axm + t * dx, cy = aym + t * dy;
      if (Math.hypot(px - cx, py - cy) <= tolM) return true;
    }
    return false;
  };
  for (const p of b) if (near(a, p)) return true;
  for (const p of a) if (near(b, p)) return true;
  return false;
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
