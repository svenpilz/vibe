/**
 * Surface inheritance from adjacent highway areas (README §3):
 * like parking, an area:highway=service without surface=* takes the
 * surface of the largest adjacent highway area; explicit surfaces are
 * untouched and non-adjacent areas stay unset.
 */
import { createOSMData } from "../src/osm-pbf";
import { extractFeatures } from "../src/extract";
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
const way = (refs: number[], tags: Record<string, string>) => {
  data.ways.set(w, { id: w, refs, tags });
  w++;
};
// asphalt road area
const road = [[52.47,13.34],[52.47,13.35],[52.471,13.35],[52.471,13.34]].map(([a,b]) => node(a,b));
way([...road, road[0]], { "area:highway": "residential", surface: "asphalt" });
// adjacent service area (shares two vertices), no surface
const svc = [[52.47,13.35],[52.47,13.36],[52.471,13.36],[52.471,13.35]].map(([a,b]) => node(a,b));
way([...svc, svc[0]], { "area:highway": "service" });
// service area with explicit surface: untouched
const svc2 = [[52.47,13.36],[52.47,13.37],[52.471,13.37],[52.471,13.36]].map(([a,b]) => node(a,b));
way([...svc2, svc2[0]], { "area:highway": "service", surface: "concrete" });
// non-adjacent service area (no shared vertex), no surface: stays unset
const svc3 = [[52.48,13.36],[52.48,13.37],[52.481,13.37],[52.481,13.36]].map(([a,b]) => node(a,b));
way([...svc3, svc3[0]], { "area:highway": "service" });
const r = extractFeatures(data);
const byId = (idx: number) => r.areas.find((a) => a.id === `w${idx}`);
const a2 = byId(2), a3 = byId(3), a4 = byId(4);
console.log("adjacent svc inherits asphalt:", a2?.surface === "asphalt", a2?.surface);
console.log("explicit svc untouched:", a3?.surface === "concrete", a3?.surface);
console.log("non-adjacent svc stays unset:", a4?.surface === undefined, a4?.surface);
