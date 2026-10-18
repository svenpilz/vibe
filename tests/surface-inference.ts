/**
 * Surface inference rules for highway areas:
 * - footway areas never inherit by adjacency (a sidewalk is not made of
 *   the adjacent road's asphalt)
 * - footway=crossing lines never donate their surface
 * - several centerlines in one area: the majority (by inside length) wins
 * - adjacency inheritance only for areas with NO compatible centerline
 */
import { createOSMData } from "../src/osm-pbf";
import { extractFeatures } from "../src/extract";

let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const data = createOSMData();
let n = 1;
const nodeByCoord = new Map<string, number>();
const node = (lat: number, lon: number): number => {
  const k = `${lat},${lon}`;
  if (nodeByCoord.has(k)) return nodeByCoord.get(k)!;
  const id = n++;
  data.nodeCoords.set(id, Math.round(lon * 1e7), Math.round(lat * 1e7));
  nodeByCoord.set(k, id);
  return id;
};
let w = 1;
const way = (coords: [number, number][], tags: Record<string, string>, close = false) => {
  const all = close ? [...coords, coords[0]] : coords;
  data.ways.set(w, { id: w, refs: all.map(([a, b]) => node(a, b)), tags });
  w++;
};

// road area with asphalt
way([[52.47,13.34],[52.47,13.35],[52.471,13.35],[52.471,13.34]],
  { "area:highway": "residential", surface: "asphalt" }, true);
// footway area adjacent to road (shares vertices), NO centerline inside
way([[52.47,13.35],[52.47,13.36],[52.471,13.36],[52.471,13.35]],
  { "area:highway": "footway" }, true);
// footway area with TWO footway centerlines: long sett + short concrete
way([[52.47,13.36],[52.47,13.37],[52.471,13.37],[52.471,13.36]],
  { "area:highway": "footway" }, true);
way([[52.4701,13.3605],[52.4709,13.3605]], { highway: "footway", footway: "sidewalk", surface: "sett" });
way([[52.4704,13.362],[52.4706,13.362]], { highway: "footway", footway: "sidewalk", surface: "concrete" });
// footway area with only a crossing centerline inside
way([[52.47,13.37],[52.47,13.38],[52.471,13.38],[52.471,13.37]],
  { "area:highway": "footway" }, true);
way([[52.4702,13.3705],[52.4708,13.3705]], { highway: "footway", footway: "crossing", surface: "asphalt" });
// service area, no centerline, adjacent to the road
way([[52.471,13.35],[52.472,13.35],[52.472,13.34],[52.471,13.34]],
  { "area:highway": "service" }, true);
// service area WITH its own centerline
way([[52.471,13.36],[52.472,13.36],[52.472,13.37],[52.471,13.37]],
  { "area:highway": "service" }, true);
way([[52.4712,13.365],[52.4718,13.365]], { highway: "service", surface: "grass_paver" });

const r = extractFeatures(data);
const byId = (idx: number) => r.areas.find((a) => a.id === `w${idx}`);
check("road keeps its explicit asphalt", byId(1)?.surface === "asphalt");
check("footway area never inherits the adjacent road's surface",
  byId(2)?.surface === undefined, `surface=${byId(2)?.surface}`);
check("footway area takes the majority centerline surface",
  byId(3)?.surface === "sett", `surface=${byId(3)?.surface}`);
check("footway=crossing never donates its surface",
  byId(6)?.surface === undefined, `surface=${byId(6)?.surface}`);
check("service area without centerline inherits by adjacency",
  byId(8)?.surface === "asphalt", `surface=${byId(8)?.surface}`);
check("service area with its own centerline does not use adjacency",
  byId(9)?.surface === "grass_paver", `surface=${byId(9)?.surface}`);

if (failures > 0) { console.error(`${failures} test(s) failed`); process.exit(1); }
console.log("all surface inference tests passed");
