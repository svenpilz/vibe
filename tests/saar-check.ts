/**
 * One-off validation against real Overpass data around way 288689072
 * (Saarstraße, Berlin — a dual carriageway with a junction and a fork).
 * Not part of npm test.
 */
import { createOSMData } from "../src/osm-pbf";
import { extractFeatures } from "../src/extract";

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
const centerline = (coords: [number, number][], tags: Record<string, string>) => {
  data.ways.set(nextWay, {
    id: nextWay,
    refs: coords.map(([lat, lon]) => node(lat, lon)),
    tags: { surface: "asphalt", ...tags },
  });
  nextWay++;
};
const area = (coords: [number, number][], tags: Record<string, string>) => {
  const ring = [...coords, coords[0]].map(([lat, lon]) => node(lat, lon));
  data.ways.set(nextWay, { id: nextWay, refs: ring, tags });
  nextWay++;
};

// ---- Saarstraße centerline pieces ----
// north of the junction: 2 lanes (at/inside the junction area)
centerline([[52.4675421,13.3361408],[52.4675327,13.3361689],[52.4675068,13.3362489]],
  { highway: "secondary", lanes: "2", name: "Saarstraße", oneway: "yes", "parking:both": "no" });
// through the non-junction area: 4 lanes
centerline([[52.4675068,13.3362489],[52.4674744,13.3363487],[52.4673717,13.3367190],[52.4673176,13.3368732]],
  { highway: "secondary", lanes: "4", name: "Saarstraße", oneway: "yes", "parking:both": "no" });
// south end, approaching the fork: 4 lanes with turn:lanes
centerline([[52.4673176,13.3368732],[52.4672818,13.3369714]],
  { highway: "secondary", lanes: "4", name: "Saarstraße", oneway: "yes", "parking:both": "no", "turn:lanes": "none|through|through|none" });

// ---- area:highway=secondary polygons ----
// the junction area at the north end (junction=yes -> skipped for sampling)
area([[52.4675149,13.3363835],[52.4674744,13.3363487],[52.4674363,13.3363160],[52.4674236,13.3363045],
      [52.4674189,13.3363003],[52.4674350,13.3362561],[52.4674357,13.3362514],[52.4674361,13.3362466],
      [52.4674357,13.3362416],[52.4674347,13.3362370],[52.4674331,13.3362327],[52.4674296,13.3362282],
      [52.4674119,13.3362093],[52.4674285,13.3361668],[52.4674454,13.3361240],[52.4674603,13.3361397],
      [52.4674640,13.3361433],[52.4674681,13.3361451],[52.4674726,13.3361447],[52.4674758,13.3361427],
      [52.4674783,13.3361394],[52.4674813,13.3361338],[52.4674868,13.3361196],[52.4674971,13.3360933],
      [52.4675031,13.3360994],[52.4675136,13.3361100],[52.4675421,13.3361408],[52.4675693,13.3361692],
      [52.4675612,13.3361995],[52.4675544,13.3362240],[52.4675478,13.3362493],[52.4675286,13.3363260]],
  { "area:highway": "secondary", junction: "yes" });
// the main non-junction area between junction and fork
area([[52.4674363,13.3363160],[52.4674744,13.3363487],[52.4675149,13.3363835],[52.4674760,13.3365446],
      [52.4674365,13.3367052],[52.4674251,13.3367482],[52.4674128,13.3367904],[52.4673878,13.3368722],
      [52.4673644,13.3369353],[52.4673378,13.3370004],[52.4673268,13.3370270],[52.4672818,13.3369714],
      [52.4672401,13.3369199],[52.4672505,13.3368925],[52.4672838,13.3368004],[52.4673086,13.3367281],
      [52.4673307,13.3366606],[52.4673550,13.3365785],[52.4673673,13.3365368],[52.4673921,13.3364528],
      [52.4674010,13.3364240],[52.4674183,13.3363710]],
  { "area:highway": "secondary" });

const result = extractFeatures(data);
const lm = result.laneMarkings.filter((m) => m.name === "Saarstraße");
lm.sort((a, b) => a.coords[0][1] - b.coords[0][1]);
console.log(`${lm.length} Saarstraße marking pieces\n`);
console.log("way         lanes  park(L/R)  laneW    laneLeftM  laneRightM");
for (const p of lm) {
  console.log(
    `${p.id.padEnd(10)}  ${String(p.lanes).padEnd(5)}  ${p.parkingLeft ? "L" : "-"}${p.parkingRight ? "R" : "-"}        ` +
    `${p.laneW!.toFixed(3)}   ${p.laneLeftM!.toFixed(3)}     ${p.laneRightM!.toFixed(3)}`);
}
