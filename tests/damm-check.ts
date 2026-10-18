/**
 * One-off validation against real Overpass data (Vorarlberger Damm ways
 * 150256318 / 1219407796): per-piece even split of the LOCAL measured
 * width — the 4-unit piece (2 lanes + parking both) and the 3-unit piece
 * (2 lanes + right parking) each fill the ~12 m road evenly.
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

// piece 1: 2 lanes + parking both = 4 units
centerline([[52.4705320,13.3478239],[52.4704852,13.3481255],[52.4703736,13.3488423]],
  { highway: "tertiary", lanes: "2", name: "Vorarlberger Damm", "parking:both": "lane" });
// piece 2: 2 lanes + right parking = 3 units
centerline([[52.4705599,13.3476428],[52.4705320,13.3478239]],
  { highway: "tertiary", lanes: "2", name: "Vorarlberger Damm",
    "parking:left": "no", "parking:right": "lane" });
// the road area
area([[52.4704263,13.3488648],[52.4703736,13.3488423],[52.4703206,13.3488196],
      [52.4704203,13.3481678],[52.4704277,13.3481193],[52.4704313,13.3480955],
      [52.4705019,13.3476377],[52.4705599,13.3476428],[52.4706143,13.3476476]],
  { "area:highway": "tertiary" });

const result = extractFeatures(data);
const lm = result.laneMarkings.filter((m) => m.name === "Vorarlberger Damm");
lm.sort((a, b) => b.coords[0][0] - a.coords[0][0]);
console.log(`${lm.length} pieces\n`);
for (const p of lm) {
  const units = p.lanes! + (p.parkingLeft ? 1 : 0) + (p.parkingRight ? 1 : 0);
  console.log(`${p.id.padEnd(3)} units=${units}  laneW=${p.laneW!.toFixed(3)}  ` +
    `block=${(p.lanes! * p.laneW!).toFixed(3)}m  fullspan=${(units * p.laneW!).toFixed(3)}m  ` +
    `leftM=${p.laneLeftM!.toFixed(3)}`);
}
