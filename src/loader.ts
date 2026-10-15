import type { Dataset, Feature } from "./features";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

export async function loadDataset(onProgress?: (msg: string) => void): Promise<Dataset> {
  onProgress?.("fetching map data…");
  let text: string;
  const gzUrl = new URL("data/map.jsonl.gz", document.baseURI);
  const rawUrl = new URL("data/map.jsonl", document.baseURI);
  try {
    const res = await fetch(gzUrl);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    if (res.headers.get("content-encoding") === "gzip") {
      onProgress?.("reading…");
      text = await readAll(res.body);
    } else {
      onProgress?.("decompressing…");
      text = await readAll(res.body.pipeThrough(new DecompressionStream("gzip")));
    }
  } catch {
    const res = await fetch(rawUrl);
    if (!res.ok) throw new Error(`failed to load map data: ${res.status}`);
    onProgress?.("reading…");
    text = await res.text();
  }
  onProgress?.("parsing…");
  const ds: Dataset = { areas: [], centerlines: [], footways: [], crossings: [], kerbs: [] };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const f = JSON.parse(l) as Feature;
    switch (f.type) {
      case "area": ds.areas.push(f); break;
      case "centerline": ds.centerlines.push(f); break;
      case "footway": ds.footways.push(f); break;
      case "crossing": ds.crossings.push(f); break;
      case "kerb": ds.kerbs.push(f); break;
    }
  }
  onProgress?.("");
  return ds;
}

export interface Indexed<T extends { bbox: [number, number, number, number] }> {
  grid: Map<number, T[]>;
  cell: number;
}

const CELL = 100000;

function keyOf(x: number, y: number): number {
  return x * 100000 + y;
}

export function buildIndex<T extends { bbox: [number, number, number, number] }>(items: T[]): Indexed<T> {
  const grid = new Map<number, T[]>();
  for (const it of items) {
    const [minX, minY, maxX, maxY] = it.bbox;
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const y0 = Math.floor(minY / CELL), y1 = Math.floor(maxY / CELL);
    if (x1 - x0 > 40 || y1 - y0 > 40) continue;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = keyOf(x, y);
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(it);
      }
    }
  }
  return { grid, cell: CELL };
}

export function queryIndex<T extends { bbox: [number, number, number, number] }>(
  idx: Indexed<T>,
  bbox: [number, number, number, number]
): T[] {
  const [minX, minY, maxX, maxY] = bbox;
  const x0 = Math.floor(minX / idx.cell), x1 = Math.floor(maxX / idx.cell);
  const y0 = Math.floor(minY / idx.cell), y1 = Math.floor(maxY / idx.cell);
  const seen = new Set<T>();
  const out: T[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const arr = idx.grid.get(keyOf(x, y));
      if (!arr) continue;
      for (const it of arr) {
        if (!seen.has(it)) { seen.add(it); out.push(it); }
      }
    }
  }
  return out;
}
