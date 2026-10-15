/**
 * Generates a small synthetic .osm.pbf covering a pretend Berlin intersection:
 * - a highway=pedestrian area (closed way)
 * - a multipolygon area:highway=footway relation (with inner hole)
 * - centerline highway=footway with surface=sett
 * - crossings with crossing=zebra / crossing:markings
 * - kerb nodes (kerb=raised/flush/lowered)
 * - footway way with width
 */
import { PbfWriter } from "pbf";
import { writeFileSync, mkdirSync } from "node:fs";

function lon(x: number) { return Math.round((13.40 + x * 0.0001) * 1e7); }
function lat(y: number) { return Math.round((52.52 + y * 0.0001) * 1e7); }

interface N { id: number; x: number; y: number; tags: Record<string, string> }
interface W { id: number; refs: number[]; tags: Record<string, string> }
interface R { id: number; members: { type: number; ref: number; role: string }[]; tags: Record<string, string> }

const nodes: N[] = [];
const ways: W[] = [];
const rels: R[] = [];

const addNode = (id: number, x: number, y: number, tags: Record<string, string> = {}) => nodes.push({ id, x, y, tags });
const addWay = (id: number, refs: number[], tags: Record<string, string>) => ways.push({ id, refs, tags });

// street area polygon (area:highway=pedestrian)
addNode(1, 0, 0); addNode(2, 60, 0); addNode(3, 60, 40); addNode(4, 0, 40);
// kerbs
addNode(5, 10, 0, { barrier: "kerb", kerb: "raised" });
addNode(6, 30, 0, { barrier: "kerb", kerb: "flush" });
addNode(7, 50, 0, { barrier: "kerb", kerb: "lowered", tactile_paving: "yes" });
// centerline through the area
addNode(8, 5, 20); addNode(9, 30, 22); addNode(10, 55, 18);
// sidewalk area multipolygon outer + inner hole
addNode(11, 100, 0); addNode(12, 160, 0); addNode(13, 160, 30); addNode(14, 100, 30);
addNode(15, 115, 8); addNode(16, 145, 8); addNode(17, 145, 20); addNode(18, 115, 20);
// footway centerline with width
addNode(19, 100, 35); addNode(20, 130, 38); addNode(21, 160, 32);
// crossing
addNode(22, 65, 15); addNode(23, 95, 17);
// kerbs at crossing ends
addNode(24, 65, 15, { barrier: "kerb", kerb: "lowered" });
addNode(25, 95, 17, { barrier: "kerb", kerb: "raised", tactile_paving: "yes" });

addWay(100, [1, 2, 3, 4, 1], { "area:highway": "pedestrian", area: "yes", surface: "paving_stones", name: "Am Testplatz" });
addWay(101, [8, 9, 10], { highway: "footway", surface: "sett", footway: "sidewalk", lit: "yes" });
addWay(110, [11, 12, 13, 14, 11], { "area:highway": "footway", area: "yes", surface: "asphalt" });
addWay(111, [15, 16, 17, 18, 15], { "area:highway": "footway", area: "yes", surface: "concrete" });
addWay(112, [19, 20, 21], { highway: "footway", footway: "sidewalk", width: "2.5", surface: "asphalt" });
addWay(113, [22, 23], { highway: "footway", footway: "crossing", crossing: "zebra", "crossing:markings": "zebra" });
addWay(114, [22, 23], { highway: "footway", footway: "crossing", crossing: "traffic_signals", "crossing:markings": "dashes", width: "3" });

rels.push({
  id: 200,
  members: [
    { type: 1, ref: 110, role: "outer" },
    { type: 1, ref: 111, role: "inner" },
  ],
  tags: { type: "multipolygon", "area:highway": "footway", surface: "asphalt", wheelchair: "yes" },
});

// ---------------- pbf writing ----------------
const st: string[] = [""];
const stIdx = new Map<string, number>();
function s(str: string): number {
  let i = stIdx.get(str);
  if (i === undefined) { i = st.length; st.push(str); stIdx.set(str, i); }
  return i;
}

function writeTags(w: PbfWriter, tags: Record<string, string>) {
  const keys = Object.keys(tags);
  w.writePackedVarint(2, keys.map(k => s(k)));
  w.writePackedVarint(3, keys.map(k => s(tags[k])));
}

function appendStringTable(w: PbfWriter) {
  w.writeMessage(1, (obj: null, stw: PbfWriter) => {
    for (const str of st) stw.writeBytesField(1, Buffer.from(str, "utf8"));
  }, null);
}

function appendBlob(out: Buffer[], type: string, payload: Uint8Array) {
  const bw = new PbfWriter();
  bw.writeBytesField(1, payload);
  const blob = bw.finish();

  const hw = new PbfWriter();
  hw.writeStringField(1, type);
  hw.writeVarintField(3, blob.length);
  const header = hw.finish();

  const lw = new PbfWriter();
  lw.writeVarint(header.length);
  out.push(Buffer.from(lw.finish()), Buffer.from(header), Buffer.from(blob));
}

const out: Buffer[] = [];

// OSMHeader
{
  const hw = new PbfWriter();
  hw.writeMessage(1, (obj: null, pw: PbfWriter) => {
    pw.writeStringField(1, "OsmSchema-V0.6");
  }, null);
  appendBlob(out, "OSMHeader", hw.finish());
}

// OSMData: one block, one group, granularity=100 nanodegrees
{
  const g = new PbfWriter();

  // dense nodes (field 2 of PrimitiveGroup)
  g.writeMessage(2, (obj: null, dw: PbfWriter) => {
    const ids: number[] = [], dlat: number[] = [], dlon: number[] = [], kv: number[] = [];
    let pid = 0, plat = 0, plon = 0;
    for (const n of nodes) {
      ids.push(n.id - pid); pid = n.id;
      const la = lat(n.y), lo = lon(n.x);
      dlat.push(la - plat); plat = la;
      dlon.push(lo - plon); plon = lo;
      for (const k of Object.keys(n.tags)) kv.push(s(k), s(n.tags[k]));
      kv.push(0);
    }
    dw.writePackedSVarint(1, ids);
    dw.writePackedSVarint(8, dlat);
    dw.writePackedSVarint(9, dlon);
    dw.writePackedVarint(10, kv);
  }, null);

  for (const way of ways) {
    g.writeMessage(3, (obj: null, ww: PbfWriter) => {
      ww.writeVarintField(1, way.id);
      writeTags(ww, way.tags);
      const refs: number[] = []; let pr = 0;
      for (const r of way.refs) { refs.push(r - pr); pr = r; }
      ww.writePackedSVarint(8, refs);
    }, null);
  }

  for (const rel of rels) {
    g.writeMessage(4, (obj: null, rw: PbfWriter) => {
      rw.writeVarintField(1, rel.id);
      writeTags(rw, rel.tags);
      rw.writePackedVarint(8, rel.members.map(m => s(m.role)));
      const refDeltas: number[] = [];
      let prev = 0;
      for (const m of rel.members) { refDeltas.push(m.ref - prev); prev = m.ref; }
      rw.writePackedSVarint(9, refDeltas);
      rw.writePackedVarint(10, rel.members.map(m => m.type));
    }, null);
  }

  const block = new PbfWriter();
  appendStringTable(block);
  block.writeVarintField(17, 100); // granularity
  block.writeTag(2, 2); // primitivegroup, wire type 2
  block.writeBytes(g.finish());

  appendBlob(out, "OSMData", block.finish());
}

mkdirSync("tests/fixtures", { recursive: true });
const pbf = Buffer.concat(out);
writeFileSync("tests/fixtures/synthetic.osm.pbf", pbf);
console.log("wrote tests/fixtures/synthetic.osm.pbf", pbf.length, "bytes,", nodes.length, "nodes,", ways.length, "ways,", rels.length, "rels");
