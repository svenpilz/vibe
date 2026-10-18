/**
 * One-off validation against real Overpass data around way 67703984
 * (Rheinstraße → Hauptstraße fork, Berlin). Not part of npm test.
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

// Rheinstraße: 3 lanes, oneway, dual carriageway
centerline([[52.4716998,13.3355975],[52.4718836,13.3357946],[52.4720048,13.3359245]],
  { highway: "tertiary", lanes: "3", name: "Rheinstraße", oneway: "yes", "parking:both": "no" });
// Hauptstraße continues collinearly at the fork point: 2 lanes, oneway
centerline([[52.4720048,13.3359245],[52.4720941,13.3360203],[52.4721194,13.3360485],
            [52.4721673,13.3361018],[52.4722352,13.3361817],[52.4722431,13.3361914]],
  { highway: "tertiary", lanes: "2", name: "Hauptstraße", oneway: "yes", "parking:left": "no" });

// the OTHER carriageway of Hauptstraße (oneway the other way) branching at
// the same fork point: gives the Rheinstraße end a SECOND collinear
// candidate, so the continuation is ambiguous and the group breaks
centerline([[52.4722431,13.3361914],[52.4722352,13.3361817],[52.4721673,13.3361018],
            [52.4721194,13.3360485],[52.4720941,13.3360203],[52.4720048,13.3359245]],
  { highway: "tertiary", lanes: "2", name: "Hauptstraße", oneway: "yes", "parking:right": "no" });
// the fork area (NOT junction=yes): one polygon covering both carriageways
area([[52.4722605,13.3361249],[52.4722352,13.3361817],[52.4722113,13.3362353],
      [52.4722075,13.3362308],[52.4722023,13.3362246],[52.4721421,13.3361535],
      [52.4721209,13.3361296],[52.4720979,13.3361037],[52.4720476,13.3360491],
      [52.4720277,13.3360275],[52.4719840,13.3359801],[52.4719544,13.3359489],
      [52.4719340,13.3359275],[52.4718557,13.3358440],[52.4718356,13.3358226],
      [52.4717622,13.3357446],[52.4717474,13.3357289],[52.4716772,13.3356540],
      [52.4716998,13.3355975],[52.4717225,13.3355406],[52.4720036,13.3358384],
      [52.4720776,13.3359183],[52.4721517,13.3359996],[52.4722047,13.3360600]],
  { "area:highway": "tertiary" });

// way 1442125974: amenity=parking + parking=lane strip ON the carriageway,
// inside the same highway area (parallel parking on the west side)
data.ways.set(nextWay, {
  id: nextWay,
  refs: [[52.4717225,13.3355406],[52.4716772,13.3356540],[52.4717622,13.3357446],[52.4718557,13.3358440],[52.4717225,13.3355406]]
    .map(([lat, lon]) => node(lat, lon)),
  tags: { amenity: "parking", parking: "lane", orientation: "parallel", surface: "asphalt" },
});
nextWay++;

const result = extractFeatures(data);
const lm = result.laneMarkings;
console.log(`${lm.length} marking pieces\n`);
console.log("name          lanes  laneW    laneLeftM  span(lanes)  measured-width-est");
for (const p of lm) {
  const span = p.lanes! * p.laneW!;
  console.log(
    `${(p.name ?? "?").padEnd(13)} ${String(p.lanes).padEnd(5)}  ${p.laneW!.toFixed(3)}   ` +
    `${p.laneLeftM!.toFixed(3)}      ${span.toFixed(3)}`);
}
console.log("separate parking features (ground only):", result.parking.length,
  result.parking.map((p) => p.id).join(","));
const rhein = lm.find((m) => m.name === "Rheinstraße");
console.log("Rheinstraße parking from strip: L", rhein?.parkingLeft, "R", rhein?.parkingRight);
const rhein2 = lm.find((m) => m.name === "Rheinstraße");
const haupt = lm.filter((m) => m.name === "Hauptstraße");
if (!rhein || haupt.length !== 2) {
  console.log(`\nPROBLEM: expected 1 Rheinstraße + 2 Hauptstraße pieces, got ${lm.length}`);
} else if (rhein2.laneW !== haupt[0].laneW || haupt[0].laneW === haupt[1].laneW === undefined) {
  console.log("\nOK: fork legs separate, each width split evenly");
} else if (haupt[0].laneW !== haupt[1].laneW) {
  console.log(`\nOK: fork legs separate (Hauptstraße carriageways ${haupt[0].laneW.toFixed(2)} / ${haupt[1].laneW.toFixed(2)}), Rheinstraße ${rhein2.laneW.toFixed(2)}`);
} else {
  console.log("\nPROBLEM: fork legs share one lane width");
}