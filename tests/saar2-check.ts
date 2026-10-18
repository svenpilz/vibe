/**
 * One-off validation against real Overpass data around ways 35313907 /
 * 1436394161 (Saarstraße, Berlin — curved one-way carriageway, one piece
 * with a right parking lane, one without). Not part of npm test.
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

// Saarstraße piece 1: 2 lanes, no parking (south-west bend)
centerline([[52.4676171,13.3361901],[52.4676636,13.3360413],[52.4677481,13.3358253]],
  { highway: "secondary", lanes: "2", name: "Saarstraße", oneway: "yes", "parking:both": "no" });
// Saarstraße piece 2: 2 lanes + right parking lane (long north-east run)
centerline([[52.4677481,13.3358253],[52.4680030,13.3351743]],
  { highway: "secondary", lanes: "2", name: "Saarstraße", oneway: "yes",
    "parking:left": "no", "parking:right": "lane" });
// the curved carriageway area
area([[52.4680265,13.3351984],[52.4680030,13.3351743],[52.4679793,13.3351502],
      [52.4679549,13.3352099],[52.4679304,13.3352726],[52.4678812,13.3353959],
      [52.4677849,13.3356448],[52.4677328,13.3357774],[52.4676822,13.3359122],
      [52.4676325,13.3360485],[52.4676130,13.3361088],[52.4675944,13.3361700],
      [52.4676171,13.3361901],[52.4676417,13.3362118],[52.4676569,13.3361654],
      [52.4676828,13.3360854],[52.4677130,13.3360036],[52.4677438,13.3359233],
      [52.4678202,13.3357235]],
  { "area:highway": "secondary" });

const result = extractFeatures(data);
const lm = result.laneMarkings.filter((m) => m.name === "Saarstraße");
lm.sort((a, b) => a.coords[0][0] - b.coords[0][0]);
console.log(`${lm.length} Saarstraße marking pieces\n`);
console.log("way  lanes  park(L/R)  laneW    leftM    span(units)");
for (const p of lm) {
  const units = p.lanes! + (p.parkingLeft ? 1 : 0) + (p.parkingRight ? 1 : 0);
  console.log(
    `${p.id.padEnd(4)}  ${String(p.lanes).padEnd(5)}  ${p.parkingLeft ? "L" : "-"}${p.parkingRight ? "R" : "-"}        ` +
    `${p.laneW!.toFixed(3)}   ${p.laneLeftM!.toFixed(3)}   ${(units * p.laneW!).toFixed(3)}`);
}
