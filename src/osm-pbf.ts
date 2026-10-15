import { PbfReader } from "pbf";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

export interface OSMTags {
  [key: string]: string;
}

export interface OSMNode {
  id: number;
  lon: number;
  lat: number;
  tags: OSMTags;
}

export interface OSMWay {
  id: number;
  refs: number[];
  tags: OSMTags;
}

export type OSMMemberType = "node" | "way" | "relation";

export interface OSMRelationMember {
  type: OSMMemberType;
  ref: number;
  role: string;
}

export interface OSMRelation {
  id: number;
  members: OSMRelationMember[];
  tags: OSMTags;
}

export interface OSMData {
  nodeCoords: NodeCoordStore;
  nodeTags: Map<number, OSMTags>;
  ways: Map<number, OSMWay>;
  relations: OSMRelation[];
}

export function createOSMData(): OSMData {
  return {
    nodeCoords: new NodeCoordStore(),
    nodeTags: new Map(),
    ways: new Map(),
    relations: [],
  };
}

/**
 * Open-addressing hash map from node id to lon/lat.
 * Coordinates are stored in Int32Arrays as 1e-7 degree units (~1.1 cm at
 * the equator) — nanodegrees would overflow int32 for lon/lat beyond ±2.1°.
 */
const COORD_INITIAL = 1 << 22;
const COORD_UNIT = 1e7;

export class NodeCoordStore {
  private cap: number;
  private mask: number;
  private keys: Float64Array;
  private lons: Int32Array;
  private lats: Int32Array;
  private used = 0;

  constructor(initial = COORD_INITIAL) {
    this.cap = initial;
    this.mask = initial - 1;
    this.keys = new Float64Array(initial).fill(NaN);
    this.lons = new Int32Array(initial);
    this.lats = new Int32Array(initial);
  }

  private hash(id: number): number {
    let h = id | 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h ^= h >>> 16;
    return h & this.mask;
  }

  set(id: number, lonUnits: number, latUnits: number): void {
    if ((this.used + 1) * 4 >= this.cap * 3) this.grow();
    let i = this.hash(id);
    while (true) {
      const k = this.keys[i];
      if (Number.isNaN(k)) {
        this.keys[i] = id;
        this.lons[i] = lonUnits;
        this.lats[i] = latUnits;
        this.used++;
        return;
      }
      if (k === id) {
        this.lons[i] = lonUnits;
        this.lats[i] = latUnits;
        return;
      }
      i = (i + 1) & this.mask;
    }
  }

  get(id: number): { lon: number; lat: number } | undefined {
    let i = this.hash(id);
    while (true) {
      const k = this.keys[i];
      if (Number.isNaN(k)) return undefined;
      if (k === id) return { lon: this.lons[i] / COORD_UNIT, lat: this.lats[i] / COORD_UNIT };
      i = (i + 1) & this.mask;
    }
  }

  has(id: number): boolean {
    return this.get(id) !== undefined;
  }

  get size(): number {
    return this.used;
  }

  private grow(): void {
    const oldKeys = this.keys;
    const oldLons = this.lons;
    const oldLats = this.lats;
    this.cap *= 2;
    this.mask = this.cap - 1;
    this.keys = new Float64Array(this.cap).fill(NaN);
    this.lons = new Int32Array(this.cap);
    this.lats = new Int32Array(this.cap);
    this.used = 0;
    for (let i = 0; i < oldKeys.length; i++) {
      const k = oldKeys[i];
      if (!Number.isNaN(k)) this.set(k, oldLons[i], oldLats[i]);
    }
  }
}

function coordUnits(base: number, step: number, raw: number): number {
  return Math.round((base + step * raw) * COORD_UNIT);
}

export type NodeTagFilter = (tags: OSMTags) => boolean;

export class OSMPBFParser {
  constructor(
    private data: OSMData,
    private nodeTagFilter?: NodeTagFilter
  ) {}

  parseFile(filePath: string): void {
    this.parseBuffer(readFileSync(filePath));
  }

  parseBuffer(buf: Uint8Array): void {
    let pos = 0;
    const len = buf.length;
    const t0 = Date.now();
    let lastReport = 0;

    while (pos < len) {
      const head = new PbfReader(buf.subarray(pos));
      const headerLen = head.readVarint();
      const headerBuf = buf.subarray(head.pos + pos, head.pos + pos + headerLen);
      pos = head.pos + pos + headerLen;

      const header = new PbfReader(headerBuf).readFields<{
        type?: string;
        datasize?: number;
      }>(
        (tag, res, p) => {
          if (tag === 1) res.type = p.readString();
          else if (tag === 3) res.datasize = p.readVarint();
          else p.skip(p.type);
        },
        {}
      );

      const blobBuf = buf.subarray(pos, pos + (header.datasize ?? 0));
      pos += header.datasize ?? 0;

      const blob = new PbfReader(blobBuf).readFields<{
        raw?: Uint8Array;
        zlibData?: Uint8Array;
      }>(
        (tag, res, p) => {
          if (tag === 1) res.raw = p.readBytes();
          else if (tag === 3) res.zlibData = p.readBytes();
          else p.skip(p.type);
        },
        {}
      );

      let data: Uint8Array | undefined;
      if (blob.raw) data = blob.raw;
      else if (blob.zlibData) data = inflateSync(blob.zlibData);
      if (!data) continue;

      if (header.type === "OSMData") {
        this.readPrimitiveBlock(data);
      }

      const now = Date.now();
      if (now - lastReport > 2000) {
        lastReport = now;
        process.stderr.write(
          `\r  pbf ${((pos / len) * 100).toFixed(0)}%  nodes:${this.data.nodeCoords.size}  ways:${this.data.ways.size}`
        );
      }
    }
    process.stderr.write(
      `\r  pbf done in ${(((Date.now() - t0) / 1000) | 0)}s  nodes:${this.data.nodeCoords.size}  ways:${this.data.ways.size}  rels:${this.data.relations.length}\n`
    );
  }

  private readPrimitiveBlock(data: Uint8Array): void {
    let stringTable: string[] = [];
    let granularity = 100;
    let latOffset = 0;
    let lonOffset = 0;
    const groups: Uint8Array[] = [];

    new PbfReader(data).readFields((tag, _res, p) => {
      switch (tag) {
        case 1:
          stringTable = p.readMessage((t, res: string[], pp) => {
            if (t === 1) res.push(pp.readString());
            else pp.skip(pp.type);
          }, [] as string[]);
          break;
        case 2:
          groups.push(p.readBytes());
          break;
        case 17:
          granularity = p.readVarint();
          break;
        case 19:
          latOffset = p.readVarint();
          break;
        case 20:
          lonOffset = p.readVarint();
          break;
        default:
          p.skip(p.type);
      }
    }, {});

    const nano = 1e-9;
    const lonBase = nano * lonOffset;
    const latBase = nano * latOffset;
    const lonStep = nano * granularity;
    const latStep = nano * granularity;

    for (const g of groups) {
      const group = new PbfReader(g);
      group.readFields((tag, _res, p) => {
        switch (tag) {
          case 1:
            this.readNodes(p, stringTable, lonBase, latBase, lonStep, latStep);
            break;
          case 2:
            this.readDenseNodes(p, stringTable, lonBase, latBase, lonStep, latStep);
            break;
          case 3:
            this.readWays(p, stringTable);
            break;
          case 4:
            this.readRelations(p, stringTable);
            break;
          default:
            p.skip(p.type);
        }
      }, {});
    }
  }

  private readNodes(
    p: PbfReader,
    st: string[],
    lonBase: number,
    latBase: number,
    lonStep: number,
    latStep: number
  ): void {
    const n = p.readMessage((tag, res: any, pp) => {
      if (tag === 1) res.id = pp.readVarint(true);
      else if (tag === 2) res.keys = pp.readPackedVarint();
      else if (tag === 3) res.vals = pp.readPackedVarint();
      else if (tag === 8) res.lat = pp.readSVarint();
      else if (tag === 9) res.lon = pp.readSVarint();
      else pp.skip(pp.type);
    }, {} as any);

    if (n.id === undefined || n.lat === undefined || n.lon === undefined) return;
    this.data.nodeCoords.set(
      n.id,
      coordUnits(lonBase, lonStep, n.lon),
      coordUnits(latBase, latStep, n.lat)
    );

    const keys: number[] = n.keys ?? [];
    const vals: number[] = n.vals ?? [];
    if (keys.length === 0) return;
    const tags: OSMTags = {};
    for (let i = 0; i < keys.length; i++) {
      const k = st[keys[i]];
      const v = st[vals[i]];
      if (k !== undefined && v !== undefined) tags[k] = v;
    }
    if (Object.keys(tags).length > 0 && (!this.nodeTagFilter || this.nodeTagFilter(tags))) {
      this.data.nodeTags.set(n.id, tags);
    }
  }

  private readDenseNodes(
    p: PbfReader,
    st: string[],
    lonBase: number,
    latBase: number,
    lonStep: number,
    latStep: number
  ): void {
    const dense = p.readMessage((tag, res: any, pp) => {
      if (tag === 1) res.ids = pp.readPackedSVarint();
      else if (tag === 8) res.lats = pp.readPackedSVarint();
      else if (tag === 9) res.lons = pp.readPackedSVarint();
      else if (tag === 10) res.keyvals = pp.readPackedVarint();
      else pp.skip(pp.type);
    }, {} as any);

    const ids: number[] = dense.ids ?? [];
    const lats: number[] = dense.lats ?? [];
    const lons: number[] = dense.lons ?? [];
    const keyvals: number[] = dense.keyvals ?? [];
    const hasKeyvals = keyvals.length > 0;

    let id = 0;
    let lat = 0;
    let lon = 0;
    let kv = 0;

    for (let i = 0; i < ids.length; i++) {
      id += ids[i];
      lat += lats[i];
      lon += lons[i];

      this.data.nodeCoords.set(
        id,
        coordUnits(lonBase, lonStep, lon),
        coordUnits(latBase, latStep, lat)
      );

      if (hasKeyvals) {
        const tags: OSMTags = {};
        while (kv < keyvals.length && keyvals[kv] !== 0) {
          const k = st[keyvals[kv]];
          const v = st[keyvals[kv + 1]];
          if (k !== undefined && v !== undefined) tags[k] = v;
          kv += 2;
        }
        kv++;
        if (Object.keys(tags).length > 0 && (!this.nodeTagFilter || this.nodeTagFilter(tags))) {
          this.data.nodeTags.set(id, tags);
        }
      }
    }
  }

  private readWays(p: PbfReader, st: string[]): void {
    const w = p.readMessage((tag, res: any, pp) => {
      if (tag === 1) res.id = pp.readVarint(true);
      else if (tag === 2) res.keys = pp.readPackedVarint();
      else if (tag === 3) res.vals = pp.readPackedVarint();
      else if (tag === 8) res.refs = pp.readPackedSVarint();
      else pp.skip(pp.type);
    }, {} as any);

    if (w.id === undefined) return;
    const keys: number[] = w.keys ?? [];
    const vals: number[] = w.vals ?? [];
    const tags: OSMTags = {};
    for (let i = 0; i < keys.length; i++) {
      const k = st[keys[i]];
      const v = st[vals[i]];
      if (k !== undefined && v !== undefined) tags[k] = v;
    }

    const refs: number[] = [];
    let ref = 0;
    for (const delta of w.refs ?? []) {
      ref += delta;
      refs.push(ref);
    }
    this.data.ways.set(w.id, { id: w.id, refs, tags });
  }

  private readRelations(p: PbfReader, st: string[]): void {
    const r = p.readMessage((tag, res: any, pp) => {
      if (tag === 1) res.id = pp.readVarint(true);
      else if (tag === 2) res.keys = pp.readPackedVarint();
      else if (tag === 3) res.vals = pp.readPackedVarint();
      else if (tag === 8) res.roles = pp.readPackedVarint();
      else if (tag === 9) res.refs = pp.readPackedSVarint();
      else if (tag === 10) res.types = pp.readPackedVarint();
      else pp.skip(pp.type);
    }, {} as any);

    if (r.id === undefined) return;
    const keys: number[] = r.keys ?? [];
    const vals: number[] = r.vals ?? [];
    const tags: OSMTags = {};
    for (let i = 0; i < keys.length; i++) {
      const k = st[keys[i]];
      const v = st[vals[i]];
      if (k !== undefined && v !== undefined) tags[k] = v;
    }

    const refs: number[] = r.refs ?? [];
    const types: number[] = r.types ?? [];
    const roles: number[] = r.roles ?? [];
    const members: OSMRelationMember[] = [];
    let ref = 0;
    for (let i = 0; i < refs.length; i++) {
      ref += refs[i];
      const role = st[roles[i]] ?? "";
      const type: OSMMemberType = types[i] === 0 ? "node" : types[i] === 1 ? "way" : "relation";
      members.push({ type, ref, role });
    }
    this.data.relations.push({ id: r.id, members, tags });
  }
}

export function nodeCoord(data: OSMData, id: number): { lon: number; lat: number } | undefined {
  return data.nodeCoords.get(id);
}
