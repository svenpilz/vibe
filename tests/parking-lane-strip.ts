/**
 * amenity=parking + parking=lane polygons lying on a road's carriageway
 * (inside the same highway area, e.g. way 1442125974 on the
 * Rheinstraße/Hauptstraße carriageway): they are a parking LANE of the
 * road, not a separate parking ground — the nearest lane-bearing
 * centerline gains parkingLeft/parkingRight on the strip's side.
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
    refs: coords.map(([lat, lon]) => node(lat, lon)).concat(close ? [coords[0]].map(([lat, lon]) => node(lat, lon)) : []),
    tags,
  });
  nextWay++;
};

// vertical road, 2 lanes, no parking tags
way([[52.4716,13.3355],[52.4726,13.3355]],
  { highway: "tertiary", lanes: "2", surface: "asphalt", name: "Testweg" });
// road area around it (±450 lat units ≈ ±5 m)
way([[52.47155,13.33544],[52.47265,13.33544],[52.47265,13.33556],[52.47155,13.33556]],
  { "area:highway": "tertiary", surface: "asphalt" }, true);
// parking strip on the LEFT of the way (west; way runs north with west on its left)
way([[52.4720,13.33544],[52.4723,13.33544],[52.4723,13.33550],[52.4720,13.33550]],
  { amenity: "parking", parking: "lane", orientation: "parallel", surface: "asphalt" }, true);
// separate parking GROUND next to the road (parking=street_side): stays a feature
way([[52.4720,13.33560],[52.4723,13.33560],[52.4723,13.33570],[52.4720,13.33570]],
  { amenity: "parking", surface: "asphalt" }, true);

const r = extractFeatures(data);
const cl = r.centerlines.find((c) => c.name === "Testweg")
  ?? r.laneMarkings.find((c) => c.name === "Testweg")!;
const lm = r.laneMarkings.find((m) => m.name === "Testweg");
check("strip not a separate parking feature",
  r.parking.length === 1 && r.parking[0].id !== "w1",
  `parking count ${r.parking.length}, ids ${r.parking.map((p) => p.id).join(",")}`);
check("strip marks the centerline's left side",
  cl.parkingLeft === true,
  `L:${cl.parkingLeft} R:${cl.parkingRight}`);
check("lane marking piece carries the parking lane",
  lm !== undefined && lm.parkingLeft === true && lm.lanes === 2,
  `L:${lm?.parkingLeft} lanes:${lm?.lanes}`);

if (failures > 0) { console.error(`${failures} test(s) failed`); process.exit(1); }
console.log("all parking lane strip tests passed");
