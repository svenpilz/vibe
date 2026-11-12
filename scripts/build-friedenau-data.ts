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
import { CENTER, RADIUS_M, LAYER_H, lonLatToMeters, metersToLonLat, quantizeDeg } from "../src3d/geo";
import { decodePng } from "./png";
import type { BakedData, BakedWay, TerrainGrid } from "../src3d/schema";

const ROOT = new URL("..", import.meta.url).pathname;
const CACHE = join(ROOT, ".vibe/cache");
const PBF_URL = "https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf";
const PBF_PATH = join(CACHE, "berlin-latest.osm.pbf");
const OUT_PATH = join(ROOT, "public/data/friedenau-2km.json");
const UA = { "User-Agent": "vibe-heightfield-poc/1.0 (github.com/svenpilz/vibe; educational 3D map POC)" };

/** top-level way keys worth keeping for the 3D scene */
const WAY_KEYS = new Set([
  "highway", "area:highway", "railway", "building", "landuse", "leisure",
  "natural", "waterway", "amenity", "shop",
]);
/** per-way tag keys kept in the baked output */
const TAG_KEYS = new Set([
  "highway", "area:highway", "layer", "bridge", "tunnel", "width", "lanes",
  "surface", "oneway", "name", "building", "height", "building:levels",
  "roof:levels", "roof:shape", "min_height", "landuse", "leisure", "natural",
  "waterway", "amenity", "parking",
]);

const GRID_N = 160;
const GRID_SIZE_M = 4400;
const DEM_Z = 13;

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
    kept.push({ refs: way.refs, tags });
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

async function buildTerrain(): Promise<TerrainGrid> {
  const originX = -GRID_SIZE_M / 2;
  const originY = -GRID_SIZE_M / 2;
  const cell = GRID_SIZE_M / GRID_N;
  const heightsDm: number[] = [];
  for (let j = 0; j <= GRID_N; j++) {
    for (let i = 0; i <= GRID_N; i++) {
      const [lon, lat] = metersToLonLat(originX + i * cell, originY + j * cell);
      const h = await sampleDem(lon, lat);
      heightsDm.push(Math.round(h * 10));
    }
    if (j % 40 === 0) console.log(`terrain row ${j}/${GRID_N}`);
  }
  return { n: GRID_N, sizeM: GRID_SIZE_M, originX, originY, heightsDm };
}

function buildJson(data: OSMData, kept: KeptWay[], terrain: TerrainGrid): BakedData {
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
  let dropped = 0;
  for (const w of kept) {
    const r: number[] = [];
    for (const ref of w.refs) {
      const li = localRef(ref);
      if (li >= 0) r.push(li);
    }
    if (r.length < 2) {
      dropped++;
      continue;
    }
    const t: number[] = [];
    for (const [k, v] of Object.entries(w.tags)) {
      t.push(intern(keys, keyIdx, k), intern(values, valIdx, v));
    }
    ways.push({ r, t });
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
  };
}

async function main(): Promise<void> {
  await ensurePbf();
  const data = await parsePbf();
  const kept = extractWays(data);
  const terrain = await buildTerrain();
  const baked = buildJson(data, kept, terrain);
  mkdirSync(join(ROOT, "public/data"), { recursive: true });
  const json = JSON.stringify(baked);
  writeFileSync(OUT_PATH, json);
  // GitHub Pages serves the precompressed .gz with Content-Encoding when present
  writeFileSync(OUT_PATH + ".gz", gzipSync(json));
  const kb = (readFileSync(OUT_PATH).length / 1024).toFixed(0);
  console.log(`wrote ${OUT_PATH} (${kb} KiB)`);
}

await main();
