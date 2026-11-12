/**
 * Builds the baked dataset for the heightfield POC:
 *
 *   1. downloads the Geofabrik Berlin .osm.pbf (cached in .vibe/cache),
 *   2. parses it with the repo's own PBF parser (src/osm-pbf.ts),
 *   3. extracts all ways within RADIUS_M around S Friedenau plus their nodes,
 *   4. fetches SRTM terrain tiles (AWS elevation-tiles-prod, terrarium)
 *      and samples a height grid over the area,
 *   5. writes a compact JSON to public/data/friedenau-2km.json.
 *
 * Run: npm run build:data
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { OSMPBFParser, createOSMData, type OSMData } from "../src/osm-pbf";
import { CENTER, RADIUS_M, LAYER_H, lonLatToMeters, metersToLonLat, quantizeDeg, lonLatToUtm33 } from "../src3d/geo";
import { decodePng } from "./png";
import { unzip } from "./zip";
import type { BakedData, BakedWay, TerrainGrid } from "../src3d/schema";

const ROOT = new URL("..", import.meta.url).pathname;
const CACHE = join(ROOT, ".vibe/cache");
const PBF_URL = "https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf";
const PBF_PATH = join(CACHE, "berlin-latest.osm.pbf");
const OUT_PATH = join(ROOT, "public/data/friedenau-2km.json");
const UA = { "User-Agent": "vibe-heightfield-poc/1.0 (github.com/svenpilz/vibe; educational 3D map POC)" };

/** top-level way keys worth keeping for the 3D scene */
const WAY_KEYS = new Set([
  "highway", "area:highway", "railway", "building", "building:part", "landuse",
  "leisure", "natural", "waterway", "amenity", "shop", "barrier",
]);
/** per-way tag keys kept in the baked output */
const TAG_KEYS = new Set([
  "highway", "area:highway", "layer", "bridge", "tunnel", "width", "lanes",
  "surface", "oneway", "name", "building", "building:part", "height", "building:levels",
  "roof:levels", "roof:shape", "roof:height", "min_height", "landuse",
  "leisure", "natural", "waterway", "amenity", "parking", "barrier", "kerb",
  "footway", "crossing", "lit", "maxspeed", "public_transport", "route",
  "type", "ref", "colour", "network", "operator", "railway", "usage",
]);
/** standalone tagged nodes kept as points (lamps, signals, trees, ...) */
const NODE_KEYS = new Set(["highway", "natural", "barrier", "amenity", "public_transport"]);
const NODE_VALUES = new Set(["street_lamp", "traffic_signals", "tree", "bollard", "bench", "waste_basket", "bus_stop", "bus_station", "stop_position", "platform"]);

const GRID_N = 880; // 5 m cells over 4.4 km; the source DGM1/DOM1 are 1 m
const GRID_SIZE_M = 4400;
const DEM_Z = 13;
/** DGM1/DOM1 tiles are 2x2 km in UTM33N on a 1 m lattice */
const DGM1_STEP = 1;
const DGM1_FEED = "https://gdi.berlin.de/data/dgm1/atom";
const DOM_FEED = "https://gdi.berlin.de/data/dom/atom";

async function ensurePbf(): Promise<void> {
  if (existsSync(PBF_PATH)) return;
  mkdirSync(CACHE, { recursive: true });
  console.log("downloading", PBF_URL);
  const r = await fetch(PBF_URL, { headers: UA });
  if (!r.ok) throw new Error(`download failed: ${r.status}`);
  writeFileSync(PBF_PATH, Buffer.from(await r.arrayBuffer()));
  console.log("downloaded", PBF_PATH);
}

async function parsePbf(): Promise<OSMData> {
  const data = createOSMData();
  const parser = new OSMPBFParser(data, undefined, (pct, stats) => {
    if (pct % 10 === 0) console.log(`parse ${pct}% ${stats}`);
  });
  await parser.parseBuffer(new Uint8Array(readFileSync(PBF_PATH)));
  console.log(`parsed: nodes=${data.nodeCoords.size} ways=${data.ways.size} rels=${data.relations.length}`);
  return data;
}

interface KeptWay {
  refs: number[];
  tags: Record<string, string>;
  /** per-ref OSM ele=* (m a.s.l.) for highway ways; -1 = no tag */
  ele?: number[];
}

interface KeptNode {
  id: number;
  tags: Record<string, string>;
}

function extractNodes(data: OSMData): KeptNode[] {
  const margin = 300;
  const kept: KeptNode[] = [];
  for (const [id, tags] of data.nodeTags) {
    const keys = Object.keys(tags);
    if (!keys.some((k) => NODE_KEYS.has(k))) continue;
    if (!keys.some((k) => NODE_VALUES.has(tags[k]))) continue;
    const c = data.nodeCoords.get(id);
    if (!c) continue;
    const [x, y] = lonLatToMeters(c.lon, c.lat);
    if (x * x + y * y > (RADIUS_M + margin) * (RADIUS_M + margin)) continue;
    const t: Record<string, string> = {};
    for (const k of keys) if (TAG_KEYS.has(k)) t[k] = tags[k];
    kept.push({ id, tags: t });
  }
  console.log(`kept ${kept.length} tagged nodes`);
  return kept;
}

interface KeptRelation {
  id: number;
  wayRefs: number[];
  tags: Record<string, string>;
}

/** Assemble type=route route=bus/trolleybus relations into ordered polylines. */
function extractRoutes(data: OSMData): KeptRelation[] {
  const margin = 300;
  const routes: KeptRelation[] = [];
  for (const rel of data.relations) {
    if (rel.tags["type"] !== "route") continue;
    if (!["bus", "trolleybus", "train", "light_rail"].includes(rel.tags["route"] ?? "")) continue;
    const wayRefs = rel.members.filter((m) => m.type === "way").map((m) => m.ref);
    if (wayRefs.length === 0) continue;
    let inside = false;
    for (const ref of wayRefs) {
      const w = data.ways.get(ref);
      if (!w) continue;
      for (const nodeRef of w.refs) {
        const c = data.nodeCoords.get(nodeRef);
        if (!c) continue;
        const [x, y] = lonLatToMeters(c.lon, c.lat);
        if (x * x + y * y <= (RADIUS_M + margin) * (RADIUS_M + margin)) {
          inside = true;
          break;
        }
      }
      if (inside) break;
    }
    if (!inside) continue;
    const tags: Record<string, string> = {};
    for (const k of ["route", "type", "ref", "colour", "network", "operator", "name"]) {
      if (rel.tags[k] && TAG_KEYS.has(k)) tags[k] = rel.tags[k];
    }
    routes.push({ id: rel.id, wayRefs, tags });
  }
  console.log(`kept ${routes.length} transit route relations`);
  return routes;
}

/** Order the member ways of a route into a connected polyline (node ids). */
function assembleRoute(data: OSMData, wayRefs: number[]): number[] {
  const remaining = wayRefs.filter((r) => data.ways.has(r));
  if (remaining.length === 0) return [];
  const nodeSet = new Map<number, number>();
  for (const r of remaining) for (const n of data.ways.get(r)!.refs) nodeSet.set(n, (nodeSet.get(n) ?? 0) + 1);
  const ends = new Set<number>();
  for (const [n, c] of nodeSet) if (c === 1) ends.add(n);
  let first = remaining[0];
  const firstRefs = data.ways.get(first)!.refs;
  if (ends.size >= 2) {
    const e0 = firstRefs[0];
    const e1 = firstRefs[firstRefs.length - 1];
    if (ends.has(e0) && !ends.has(e1)) {
      // keep orientation
    } else if (ends.has(e1) && !ends.has(e0)) {
      firstRefs.reverse();
    } else {
      // loop or ambiguous: keep as is
    }
  }
  const ordered: number[] = [...firstRefs];
  remaining.splice(remaining.indexOf(first), 1);
  while (remaining.length > 0) {
    const tail = ordered[ordered.length - 1];
    const head = ordered[0];
    let progressed = false;
    for (let i = 0; i < remaining.length; i++) {
      const refs = data.ways.get(remaining[i])!.refs;
      if (refs[0] === tail) {
        ordered.push(...refs.slice(1));
      } else if (refs[refs.length - 1] === tail) {
        ordered.push(...[...refs].reverse().slice(1));
      } else if (refs[refs.length - 1] === head) {
        ordered.unshift(...refs.slice(0, -1));
      } else if (refs[0] === head) {
        ordered.unshift(...[...refs].reverse().slice(0, -1));
      } else {
        continue;
      }
      remaining.splice(i, 1);
      progressed = true;
      break;
    }
    if (!progressed) break;
  }
  return ordered;
}

function extractWays(data: OSMData): KeptWay[] {
  const margin = 300;
  const kept: KeptWay[] = [];
  for (const way of data.ways.values()) {
    const keys = Object.keys(way.tags);
    if (!keys.some((k) => WAY_KEYS.has(k))) continue;
    let inside = false;
    for (const ref of way.refs) {
      const c = data.nodeCoords.get(ref);
      if (!c) continue;
      const [x, y] = lonLatToMeters(c.lon, c.lat);
      if (x * x + y * y <= (RADIUS_M + margin) * (RADIUS_M + margin)) {
        inside = true;
        break;
      }
    }
    if (!inside) continue;
    const tags: Record<string, string> = {};
    for (const k of keys) if (TAG_KEYS.has(k)) tags[k] = way.tags[k];
    const keptWay: KeptWay = { refs: way.refs, tags };
    // keep surveyed node heights (ele=*) on highway ways — per point, not per road
    if (tags["highway"]) {
      const ele = way.refs.map((ref) => {
        const nt = data.nodeTags.get(ref);
        const e = nt ? parseFloat(nt["ele"] ?? "") : NaN;
        return Number.isFinite(e) ? e : -1;
      });
      if (ele.some((e) => e >= 0)) keptWay.ele = ele;
    }
    kept.push(keptWay);
  }
  console.log(`kept ${kept.length} ways within ${RADIUS_M}m + margin`);
  return kept;
}

/** Web-Mercator slippy tile math: lon/lat -> fractional tile coords at zoom z. */
function lonLatToTile(lon: number, lat: number, z: number): { tx: number; ty: number; fx: number; fy: number } {
  const n = Math.pow(2, z);
  const tx = ((lon + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const ty = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  return { tx, ty, fx: tx - Math.floor(tx), fy: ty - Math.floor(ty) };
}

type DemTile = { width: number; height: number; h: Float32Array };
const demCache = new Map<string, Promise<DemTile>>();

async function fetchDemTile(tx: number, ty: number): Promise<DemTile> {
  const key = `${DEM_Z}/${tx}/${ty}`;
  let p = demCache.get(key);
  if (!p) {
    p = (async () => {
      const dir = join(CACHE, "dem");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${tx}_${ty}.png`);
      let buf: Buffer;
      if (existsSync(file)) {
        buf = readFileSync(file);
      } else {
        const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${DEM_Z}/${tx}/${ty}.png`;
        const r = await fetch(url, { headers: UA });
        if (!r.ok) throw new Error(`dem tile failed: ${r.status} ${url}`);
        buf = Buffer.from(await r.arrayBuffer());
        writeFileSync(file, buf);
      }
      const img = decodePng(new Uint8Array(buf));
      const h = new Float32Array(img.width * img.height);
      for (let i = 0; i < h.length; i++) {
        const r = img.data[i * 4];
        const g = img.data[i * 4 + 1];
        const b = img.data[i * 4 + 2];
        h[i] = r * 256 + g + b / 256 - 32768;
      }
      return { width: img.width, height: img.height, h };
    })();
    demCache.set(key, p);
  }
  return p;
}

async function sampleDem(lon: number, lat: number): Promise<number> {
  const t = lonLatToTile(lon, lat, DEM_Z);
  const tile = await fetchDemTile(Math.floor(t.tx), Math.floor(t.ty));
  const px = Math.max(0, Math.min(tile.width - 1, Math.floor(t.fx * tile.width)));
  const py = Math.max(0, Math.min(tile.height - 1, Math.floor(t.fy * tile.height)));
  return tile.h[py * tile.width + px];
}

/**
 * Terrain from Berlin's official bare-earth DGM1 (1 m LiDAR, DHHN2016,
 * UTM33N xyz tiles via the gdi.berlin.de atom feed), decimated to DGM1_STEP.
 * Falls back to SRTM terrarium tiles when the DGM1 download fails.
 */
async function buildTerrain(): Promise<{ dgm: TerrainGrid; dom?: TerrainGrid }> {
  const originX = -GRID_SIZE_M / 2;
  const originY = -GRID_SIZE_M / 2;
  const cell = GRID_SIZE_M / GRID_N;
  let dgm: TerrainGrid;
  try {
    dgm = await buildTerrainFromFeed(DGM1_FEED, "DGM1", "dgm1", originX, originY, cell);
  } catch (e) {
    console.log("DGM1 failed, falling back to SRTM:", (e as Error).message);
    const heightsDm: number[] = [];
    for (let j = 0; j <= GRID_N; j++) {
      for (let i = 0; i <= GRID_N; i++) {
        const [lon, lat] = metersToLonLat(originX + i * cell, originY + j * cell);
        heightsDm.push(Math.round((await sampleDem(lon, lat)) * 10));
      }
      if (j % 40 === 0) console.log(`terrain row ${j}/${GRID_N}`);
    }
    dgm = { n: GRID_N, sizeM: GRID_SIZE_M, originX, originY, heightsDm };
  }
  let dom: TerrainGrid | undefined;
  try {
    dom = await buildTerrainFromFeed(DOM_FEED, "DOM1", "dom", originX, originY, cell);
  } catch (e) {
    console.log("DOM1 failed (optional):", (e as Error).message);
  }
  return { dgm, dom };
}

async function buildTerrainFromFeed(feed: string, prefix: string, dirName: string, originX: number, originY: number, cell: number): Promise<TerrainGrid> {
  const [E0, N0] = lonLatToUtm33(CENTER.lon, CENTER.lat);
  const half = GRID_SIZE_M / 2 + 100;
  const tiles: Array<[number, number]> = [];
  for (let te = Math.floor((E0 - half) / 2000) * 2000; te <= E0 + half; te += 2000) {
    for (let tn = Math.floor((N0 - half) / 2000) * 2000; tn <= N0 + half; tn += 2000) {
      tiles.push([te, tn]);
    }
  }
  console.log(`fetching ${tiles.length} DGM1 tiles`);
  const latticeE0 = Math.min(...tiles.map(([te]) => te));
  const latticeN0 = Math.min(...tiles.map(([, tn]) => tn));
  const cols = Math.round((Math.max(...tiles.map(([te]) => te)) + 2000 - latticeE0) / DGM1_STEP) + 1;
  const rows = Math.round((Math.max(...tiles.map(([, tn]) => tn)) + 2000 - latticeN0) / DGM1_STEP) + 1;
  const lattice = new Float32Array(cols * rows).fill(NaN);
  let count = 0;
  const dir = join(CACHE, dirName);
  mkdirSync(dir, { recursive: true });
  for (const [te, tn] of tiles) {
    const file = join(dir, `${prefix}_${te / 1000}_${tn / 1000}.zip`);
    if (!existsSync(file)) {
      const url = `${feed}/${prefix}_${te / 1000}_${tn / 1000}.zip`;
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`${prefix} tile failed: ${r.status} ${url}`);
      writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    }
    const entries = unzip(new Uint8Array(readFileSync(file)));
    const xyz = entries[0]?.data.toString("utf8");
    if (!xyz) throw new Error(`empty ${prefix} tile`);
    console.log(`parsing tile ${te / 1000}_${tn / 1000} (${(xyz.length / 1e6).toFixed(0)} MB)`);
    for (const line of xyz.split("\n")) {
      if (!line) continue;
      const sp = line.indexOf(" ");
      const sp2 = line.indexOf(" ", sp + 1);
      if (sp < 0 || sp2 < 0) continue;
      const E = parseFloat(line.slice(0, sp));
      const N = parseFloat(line.slice(sp + 1, sp2));
      const h = parseFloat(line.slice(sp2 + 1));
      if (!Number.isFinite(E) || !Number.isFinite(N) || !Number.isFinite(h)) continue;
      lattice[Math.round((N - latticeN0) / DGM1_STEP) * cols + Math.round((E - latticeE0) / DGM1_STEP)] = h;
      count++;
    }
  }
  if (count < 1000) throw new Error(`too few ${prefix} points`);
  const sample = (E: number, N: number): number => {
    const fx = (E - latticeE0) / DGM1_STEP;
    const fy = (N - latticeN0) / DGM1_STEP;
    const x0 = Math.max(0, Math.min(cols - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(rows - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    const at = (xx: number, yy: number): number => {
      const v = lattice[yy * cols + xx];
      return Number.isNaN(v) ? lattice[y0 * cols + x0] : v;
    };
    const h00 = at(x0, y0), h10 = at(x0 + 1, y0), h01 = at(x0, y0 + 1), h11 = at(x0 + 1, y0 + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
  };
  const heightsDm: number[] = [];
  for (let j = 0; j <= GRID_N; j++) {
    for (let i = 0; i <= GRID_N; i++) {
      // sample at the true UTM33N position of this local-frame vertex — the
      // equirectangular local frame differs from UTM by ~0.2% (up to ~4 m at
      // 2 km), which would misalign the DEM with the OSM data
      const [lon, lat] = metersToLonLat(originX + i * cell, originY + j * cell);
      const [E, N] = lonLatToUtm33(lon, lat);
      heightsDm.push(Math.round(sample(E, N) * 10));
    }
    if (j % 40 === 0) console.log(`terrain row ${j}/${GRID_N}`);
  }
  return { n: GRID_N, sizeM: GRID_SIZE_M, originX, originY, heightsDm };
}

function buildJson(data: OSMData, kept: KeptWay[], keptNodes: KeptNode[], routes: KeptRelation[], terrain: TerrainGrid, terrainDom?: TerrainGrid): BakedData {
  const keys: string[] = [];
  const values: string[] = [];
  const keyIdx = new Map<string, number>();
  const valIdx = new Map<string, number>();
  const intern = (table: string[], map: Map<string, number>, s: string): number => {
    let i = map.get(s);
    if (i === undefined) {
      i = table.length;
      table.push(s);
      map.set(s, i);
    }
    return i;
  };

  const nodeLocal = new Map<number, number>();
  const nodes: number[] = [];
  const localRef = (id: number): number => {
    let li = nodeLocal.get(id);
    if (li === undefined) {
      const c = data.nodeCoords.get(id);
      if (!c) return -1;
      li = nodes.length / 2;
      nodes.push(quantizeDeg(c.lon), quantizeDeg(c.lat));
      nodeLocal.set(id, li);
      return li;
    }
    return li;
  };

  const ways: BakedWay[] = [];
  const points: BakedWay[] = [];
  const routeWays: BakedWay[] = [];
  let dropped = 0;
  for (const n of keptNodes) {
    const li = localRef(n.id);
    if (li < 0) continue;
    const t: number[] = [];
    for (const [k, v] of Object.entries(n.tags)) t.push(intern(keys, keyIdx, k), intern(values, valIdx, v));
    points.push({ r: [li], t });
  }
  for (const rt of routes) {
    const assembled = assembleRoute(data, rt.wayRefs);
    // split at nodes missing from the extract so no phantom jumps across the map
    let r: number[] = [];
    const flush = () => {
      if (r.length < 2) { r = []; return; }
      const t: number[] = [];
      for (const [k, v] of Object.entries(rt.tags)) t.push(intern(keys, keyIdx, k), intern(values, valIdx, v));
      routeWays.push({ r, t });
      r = [];
    };
    for (const nodeId of assembled) {
      const c = data.nodeCoords.get(nodeId);
      if (!c) { flush(); continue; }
      const [nx, ny] = lonLatToMeters(c.lon, c.lat);
      if (nx * nx + ny * ny > (RADIUS_M + 300) * (RADIUS_M + 300)) { flush(); continue; }
      const li = localRef(nodeId);
      if (li >= 0) r.push(li);
      else flush();
    }
    flush();
  }
  for (const w of kept) {
    const r: number[] = [];
    const ele: number[] = [];
    for (let k = 0; k < w.refs.length; k++) {
      const li = localRef(w.refs[k]);
      if (li >= 0) {
        r.push(li);
        if (w.ele) ele.push(Math.round(w.ele[k] * 10) / 10);
      }
    }
    if (r.length < 2) {
      dropped++;
      continue;
    }
    const t: number[] = [];
    for (const [k, v] of Object.entries(w.tags)) {
      t.push(intern(keys, keyIdx, k), intern(values, valIdx, v));
    }
    const way: BakedWay = { r, t };
    if (w.ele && ele.some((e) => e >= 0)) way.ele = ele;
    ways.push(way);
  }
  console.log(`nodes=${nodes.length / 2} ways=${ways.length} dropped=${dropped} keys=${keys.length} values=${values.length}`);

  return {
    centerLon: CENTER.lon,
    centerLat: CENTER.lat,
    radiusM: RADIUS_M,
    layerH: LAYER_H,
    terrain,
    keys,
    values,
    nodes,
    ways,
    points,
    routes: routeWays,
    terrainDom,
  };
}

async function main(): Promise<void> {
  await ensurePbf();
  const data = await parsePbf();
  const kept = extractWays(data);
  const nodes = extractNodes(data);
  const routes = extractRoutes(data);
  const { dgm, dom } = await buildTerrain();
  const baked = buildJson(data, kept, nodes, routes, dgm, dom);
  mkdirSync(join(ROOT, "public/data"), { recursive: true });
  const json = JSON.stringify(baked);
  writeFileSync(OUT_PATH, json);
  // GitHub Pages serves the precompressed .gz with Content-Encoding when present
  writeFileSync(OUT_PATH + ".gz", gzipSync(json));
  const kb = (readFileSync(OUT_PATH).length / 1024).toFixed(0);
  console.log(`wrote ${OUT_PATH} (${kb} KiB)`);
}

await main();
