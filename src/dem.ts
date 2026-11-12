/**
 * DEM (heightfield) support for terrain displacement of ground features.
 *
 * The bundled data ships a downsampled ATKIS DGM1 grid (Geoportal Berlin,
 * EPSG:25833 / DHHN2016) as a JSON header + little-endian Uint16 binary:
 *   height[m] = heightOffsetM + value * heightScaleM   (nodata = 65535)
 *
 * Ground features on the lowest OSM layer take their height from the DEM.
 * Cells covered by a higher-layer feature (bridge, building, ...) are
 * "occluded from above" and get their height interpolated (Laplacian
 * inpainting) from the surrounding visible ground cells.
 */

export interface DemHeader {
  crs: string;
  cellM: number;
  originE: number;
  originN: number;
  cols: number;
  rows: number;
  heightOffsetM: number;
  heightScaleM: number;
  nodata: number;
  minHM?: number;
  maxHM?: number;
  source?: string;
  area?: string;
}

/** WGS84 lon/lat (degrees) -> ETRS89 / UTM zone 33N (EPSG:25833) meters */
export function lonLatToUtm33(lon: number, lat: number): [number, number] {
  const a = 6378137.0,
    f = 1 / 298.257223563,
    k0 = 0.9996,
    e2 = f * (2 - f),
    ep2 = e2 / (1 - e2),
    rad = Math.PI / 180;
  const lam = lon * rad,
    phi = lat * rad,
    lam0 = (33 * 6 - 183) * rad;
  const s = Math.sin(phi);
  const N = a / Math.sqrt(1 - e2 * s * s);
  const T = Math.tan(phi) ** 2;
  const C = ep2 * Math.cos(phi) ** 2;
  const A = Math.cos(phi) * (lam - lam0);
  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * phi -
      (3 * e2 / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      (15 * e2 * e2 / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  const E =
    500000 +
    k0 *
      N *
      (A +
        (1 - T + C) * A ** 3 / 6 +
        (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
  const Nn =
    k0 *
    (M +
      N *
        Math.tan(phi) *
        (A * A / 2 +
          (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 +
          (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return [E, Nn];
}

export class DemField {
  private h: DemHeader;
  private raw: Uint16Array;
  /** decoded heights in meters; nodata cells stay NaN until inpainted */
  private z: Float32Array<ArrayBuffer>;
  private occluded: Uint8Array;

  private constructor(h: DemHeader, raw: Uint16Array) {
    this.h = h;
    this.raw = raw;
    this.z = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++)
      this.z[i] = raw[i] === h.nodata ? NaN : h.heightOffsetM + raw[i] * h.heightScaleM;
    this.occluded = new Uint8Array(raw.length);
  }

  static fromData(h: DemHeader, buf: ArrayBuffer): DemField {
    const raw = new Uint16Array(buf);
    if (raw.length !== h.cols * h.rows)
      throw new Error(`DEM grid size mismatch: ${raw.length} != ${h.cols * h.rows}`);
    return new DemField(h, raw);
  }

  static async load(jsonUrl: string): Promise<DemField> {
    const res = await fetch(jsonUrl);
    if (!res.ok) throw new Error(`DEM header ${jsonUrl}: HTTP ${res.status}`);
    const h = (await res.json()) as DemHeader;
    const bin = await fetch(jsonUrl.replace(/\.json$/, ".bin"));
    if (!bin.ok) throw new Error(`DEM grid ${jsonUrl}: HTTP ${bin.status}`);
    return DemField.fromData(h, await bin.arrayBuffer());
  }

  get cols(): number {
    return this.h.cols;
  }
  get rows(): number {
    return this.h.rows;
  }

  /** bilinear ground height in meters at lon/lat (after inpainting);
   *  null outside the DEM coverage. Memoized per quantized coordinate —
   *  scene rebuilds sample the same vertices over and over */
  private sampleCache = new Map<string, number | null>();
  private static SAMPLE_CACHE_MAX = 400000;

  /** is the DGM cell at lon/lat occluded from above (under a building or a
   *  higher-layer feature in 2D)? Those cells are inpainted by inpaint() */
  isOccluded(lon: number, lat: number): boolean {
    const [E, N] = lonLatToUtm33(lon, lat);
    const c = Math.floor((E - this.h.originE) / this.h.cellM);
    const r = Math.floor((N - this.h.originN) / this.h.cellM);
    if (c < 0 || r < 0 || c >= this.h.cols || r >= this.h.rows) return false;
    return this.occluded[r * this.h.cols + c] === 1;
  }

  sampleM(lon: number, lat: number): number | null {
    const key = `${Math.round(lon * 1e7)}:${Math.round(lat * 1e7)}`;
    const hit = this.sampleCache.get(key);
    if (hit !== undefined) return hit;
    const v = this.sampleMUncached(lon, lat);
    if (this.sampleCache.size >= DemField.SAMPLE_CACHE_MAX) this.sampleCache.clear();
    this.sampleCache.set(key, v);
    return v;
  }

  private sampleMUncached(lon: number, lat: number): number | null {
    const [E, N] = lonLatToUtm33(lon, lat);
    const fx = (E - this.h.originE) / this.h.cellM - 0.5;
    const fy = (N - this.h.originN) / this.h.cellM - 0.5;
    const c0 = Math.floor(fx),
      r0 = Math.floor(fy);
    if (c0 < 0 || r0 < 0 || c0 + 1 >= this.h.cols || r0 + 1 >= this.h.rows) return null;
    const tx = fx - c0,
      ty = fy - r0;
    let acc = 0,
      wsum = 0;
    for (const [dc, dr, w] of [
      [0, 0, (1 - tx) * (1 - ty)],
      [1, 0, tx * (1 - ty)],
      [0, 1, (1 - tx) * ty],
      [1, 1, tx * ty],
    ] as const) {
      const v = this.z[(r0 + dr) * this.h.cols + (c0 + dc)];
      if (Number.isNaN(v)) continue;
      acc += v * w;
      wsum += w;
    }
    return wsum > 0 ? acc / wsum : null;
  }

  /** mark grid cells covered by an occluder: a closed ring (polygon) or an
   *  open polyline buffered by widthM/2 (bridge deck). rings are [lon,lat]. */
  occludeRing(ring: [number, number][], widthM = 0): void {
    this.sampleCache.clear();
    const pts = ring.map(([lon, lat]) => lonLatToUtm33(lon, lat));
    const h = this.h;
    let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
    for (const [E, N] of pts) {
      e0 = Math.min(e0, E); n0 = Math.min(n0, N);
      e1 = Math.max(e1, E); n1 = Math.max(n1, N);
    }
    if (widthM > 0) {
      e0 -= widthM / 2; n0 -= widthM / 2; e1 += widthM / 2; n1 += widthM / 2;
    }
    const c0 = Math.max(0, Math.floor((e0 - h.originE) / h.cellM));
    const c1 = Math.min(h.cols - 1, Math.floor((e1 - h.originE) / h.cellM));
    const r0 = Math.max(0, Math.floor((n0 - h.originN) / h.cellM));
    const r1 = Math.min(h.rows - 1, Math.floor((n1 - h.originN) / h.cellM));
    const closed = widthM <= 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const E = h.originE + (c + 0.5) * h.cellM;
        const N = h.originN + (r + 0.5) * h.cellM;
        if (closed) {
          if (pointInRing(E, N, pts)) this.occluded[r * h.cols + c] = 1;
        } else {
          if (distToPolyline(E, N, pts) <= widthM / 2)
            this.occluded[r * h.cols + c] = 1;
        }
      }
    }
  }

  /** Laplacian inpainting of occluded cells from visible neighbors, so ground
   *  hidden under higher-layer features gets an interpolated height */
  inpaint(maxIter = 600): void {
    this.sampleCache.clear();
    const h = this.h;
    const occ: number[] = [];
    for (let i = 0; i < this.occluded.length; i++)
      if (this.occluded[i] && !Number.isNaN(this.z[i])) occ.push(i);
    if (occ.length === 0) return;
    let cur: Float32Array<ArrayBuffer> = this.z,
      next = new Float32Array(this.z);
    for (let it = 0; it < maxIter; it++) {
      let maxDelta = 0;
      for (const i of occ) {
        const c = i % h.cols,
          r = (i / h.cols) | 0;
        let s = 0,
          n = 0;
        if (c > 0 && !Number.isNaN(cur[i - 1])) { s += cur[i - 1]; n++; }
        if (c < h.cols - 1 && !Number.isNaN(cur[i + 1])) { s += cur[i + 1]; n++; }
        if (r > 0 && !Number.isNaN(cur[i - h.cols])) { s += cur[i - h.cols]; n++; }
        if (r < h.rows - 1 && !Number.isNaN(cur[i + h.cols])) { s += cur[i + h.cols]; n++; }
        const v = n > 0 ? s / n : cur[i];
        next[i] = v;
        const d = Math.abs(v - cur[i]);
        if (d > maxDelta) maxDelta = d;
      }
      const tmp = cur;
      cur = next;
      next = tmp;
      if (maxDelta < 0.002) break;
    }
    this.z = cur;
  }
}

function pointInRing(E: number, N: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (yi > N !== yj > N && E < ((xj - xi) * (N - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function distToPolyline(E: number, N: number, pts: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i],
      [x2, y2] = pts[i + 1];
    const dx = x2 - x1,
      dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((E - x1) * dx + (N - y1) * dy) / l2)) : 0;
    const d = Math.hypot(E - (x1 + t * dx), N - (y1 + t * dy));
    if (d < best) best = d;
  }
  return best;
}
