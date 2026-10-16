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
