/**
 * Regression (real Overpass data, Menzelstraße/Rembrandtstraße junction):
 * the junction area (1117926329, area:highway=residential + junction=yes,
 * no surface) must inherit a surface from the centerlines passing through
 * it — majority by length inside the area. The asphalt ways through the
 * junction (Rembrandtstraße 1102703414, Menzelstraße 9933220,
 * Rembrandtstraße 1127924719) outweigh the sett run ending at the
 * junction edge, so the area gets asphalt.
 */
import { createOSMData } from "../src/osm-pbf";
import { extractFeatures } from "../src/extract";

let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const data = createOSMData();
let nextNode = 1;
const nodeByCoord = new Map<string, number>();
const node = (lat: number, lon: number): number => {
  const k = `${lat},${lon}`;
  const existing = nodeByCoord.get(k);
  if (existing !== undefined) return existing;
  const id = nextNode++;
  data.nodeCoords.set(id, Math.round(lon * 1e7), Math.round(lat * 1e7));
  nodeByCoord.set(k, id);
  return id;
};
let nextWay = 1;
const way = (coords: [number, number][], tags: Record<string, string>, close = false) => {
  data.ways.set(nextWay, {
    id: nextWay,
    refs: close
      ? [...coords, coords[0]].map(([lat, lon]) => node(lat, lon))
      : coords.map(([lat, lon]) => node(lat, lon)),
    tags,
  });
  nextWay++;
};

// Menzelstraße (asphalt), crossing the junction
way([[52.4681797,13.3399690],[52.4681470,13.3399739],[52.4681114,13.3399780],
     [52.4680878,13.3399807],[52.4680710,13.3399826]],
  { highway: "residential", surface: "asphalt", width: "7.5", name: "Menzelstraße",
    "parking:left": "lane", "parking:right": "no" });
// Rembrandtstraße sett run, ENDING at the junction boundary
way([[52.4672086,13.3384086],[52.4673019,13.3385560],[52.4680020,13.3394214],
     [52.4680872,13.3395696],[52.4681347,13.3396953],[52.4681703,13.3398189],
     [52.4681734,13.3398480]],
  { highway: "residential", surface: "sett", width: "6", name: "Rembrandtstraße",
    "parking:left": "no", "parking:right": "lane" });
// Rembrandtstraße asphalt run THROUGH the junction
way([[52.4681734,13.3398480],[52.4681797,13.3399690]],
  { highway: "residential", surface: "asphalt", width: "6", name: "Rembrandtstraße",
    "parking:both": "no" });
// Rembrandtstraße asphalt run, leaving the junction north-east
way([[52.4682383,13.3399708],[52.4681797,13.3399690]],
  { highway: "residential", surface: "asphalt", width: "7.5", name: "Rembrandtstraße",
    "parking:left": "lane", "parking:right": "no" });
// the junction area, no surface
way([[52.4681958,13.3398106],[52.4681703,13.3398189],[52.4681309,13.3398316],
     [52.4681301,13.3398395],[52.4681278,13.3398523],[52.4681248,13.3398650],
     [52.4681196,13.3398795],[52.4681139,13.3398923],[52.4681104,13.3398981],
     [52.4681080,13.3399021],[52.4681034,13.3399084],[52.4680980,13.3399135],
     [52.4680917,13.3399190],[52.4680847,13.3399227],[52.4680778,13.3399255],
     [52.4680686,13.3399270],[52.4680710,13.3399826],[52.4680734,13.3400383],
     [52.4680903,13.3400364],[52.4681139,13.3400338],[52.4681189,13.3400332],
     [52.4681666,13.3400279],[52.4681911,13.3400263],[52.4682213,13.3400266],
     [52.4682356,13.3400271],[52.4682383,13.3399708],[52.4682417,13.3399095],
     [52.4682333,13.3399045],[52.4682245,13.3398967],[52.4682166,13.3398806],
     [52.4682078,13.3398518]],
  { "area:highway": "residential", junction: "yes" }, true);

const r = extractFeatures(data);
const junction = r.areas.find((a) => a.junction);
check("junction area found", junction !== undefined);
check("junction area gets asphalt (majority by inside length)",
  junction?.surface === "asphalt", `surface=${junction?.surface}`);

console.log("areas:", r.areas.map((a) => `${a.id}:${a.highway}:${a.junction}:${a.surface}`).join(" "));
if (failures > 0) { console.error(`${failures} test(s) failed`); process.exit(1); }
console.log("all junction surface tests passed");
console.log("areas:", r.areas.map((a) => `${a.id}:${a.highway}:${a.junction}:${a.surface}`).join(" "));
