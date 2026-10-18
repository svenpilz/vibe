/**
 * One-off validation against real Overpass data around way 1122774351
 * (Rubensstraße, Berlin). Not part of npm test.
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

// ---- Rubensstraße centerline pieces (south -> north) ----
centerline([[52.4728269,13.3433651],[52.4737052,13.3432498],[52.4740519,13.3432017]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "lane" });
centerline([[52.4740519,13.3432017],[52.4741052,13.3431944]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "no" });
centerline([[52.4741052,13.3431944],[52.4741525,13.3431879],[52.4747858,13.3431022]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "lane" });
centerline([[52.4747858,13.3431022],[52.4748325,13.3430959],[52.4750004,13.3430734]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:left": "no", "parking:right": "lane" });
centerline([[52.4750004,13.3430734],[52.4750761,13.3430632]],           // <- the way from the request
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "lane" });
centerline([[52.4750761,13.3430632],[52.4752362,13.3430417],[52.4752689,13.3430373]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:left": "lane", "parking:right": "no" });
centerline([[52.4752689,13.3430373],[52.4757242,13.3429758],[52.4757775,13.3429689]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "lane" });
centerline([[52.4757775,13.3429689],[52.4758123,13.3429643],[52.4758440,13.3429599],[52.4759168,13.3429506]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "no" });
centerline([[52.4759168,13.3429506],[52.4760028,13.3429390]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:left": "no", "parking:right": "lane" });
centerline([[52.4760028,13.3429390],[52.4765847,13.3428590]],
  { highway: "tertiary", lanes: "2", name: "Rubensstraße", "parking:both": "lane" });

// ---- area:highway=tertiary polygons (incl. the junction ones to be skipped) ----
area([[52.4728269,13.3433651],[52.4728304,13.3434467],[52.4731659,13.3434020],[52.4740562,13.3432823],
      [52.4740519,13.3432017],[52.4740474,13.3431173],[52.4740196,13.3431209],[52.4728233,13.3432834]],
  { "area:highway": "tertiary" });
area([[52.4741563,13.3432681],[52.4741525,13.3431879],[52.4741486,13.3431033],[52.4741265,13.3431063],
      [52.4741071,13.3431090],[52.4741010,13.3431099],[52.4740942,13.3431108],[52.4740744,13.3431136],
      [52.4740719,13.3431141],[52.4740474,13.3431173],[52.4740519,13.3432017],[52.4740562,13.3432823],
      [52.4740586,13.3433260],[52.4740590,13.3433336],[52.4740864,13.3433300],[52.4740878,13.3433578],
      [52.4740881,13.3433640],[52.4741136,13.3433604],[52.4741385,13.3433569],[52.4741382,13.3433505],
      [52.4741369,13.3433238],[52.4741591,13.3433208],[52.4741587,13.3433126]],
  { "area:highway": "tertiary", junction: "yes" });
area([[52.4757199,13.3428908],[52.4757242,13.3429758],[52.4757283,13.3430558],[52.4752690,13.3431165],
      [52.4752570,13.3430922],[52.4750915,13.3431121],[52.4750808,13.3431424],[52.4741563,13.3432681],
      [52.4741525,13.3431879],[52.4741486,13.3431033],[52.4747867,13.3430161],[52.4748081,13.3430480],
      [52.4749837,13.3430244],[52.4750000,13.3429877]],
  { "area:highway": "tertiary" });
area([[52.4760068,13.3430184],[52.4760028,13.3429390],[52.4759984,13.3428541],[52.4766439,13.3427704],
      [52.4766614,13.3427681],[52.4766651,13.3428466],[52.4766690,13.3429313],[52.4761876,13.3429950],
      [52.4761321,13.3430015]],
  { "area:highway": "tertiary" });

const result = extractFeatures(data);
const lm = result.laneMarkings.filter((m) => m.name === "Rubensstraße");
lm.sort((a, b) => a.coords[0][1] - b.coords[0][1]);
console.log(`${lm.length} Rubensstraße marking pieces\n`);
console.log("id(lat0)      park(L/R)  laneW    laneLeftM  border-offset");
const border: number[] = [];
for (const p of lm) {
  const off = -p.laneLeftM! + p.lanesFwd! * p.laneW!;
  border.push(off);
  console.log(
    (p.coords[0][1] / 1e7).toFixed(7).slice(3) +
    `  ${p.parkingLeft ? "L" : "-"}${p.parkingRight ? "R" : "-"}        ` +
    `${p.laneW!.toFixed(3)}    ${p.laneLeftM!.toFixed(3)}      ${off.toFixed(3)}`);
}
const laneWs = new Set(lm.map((p) => p.laneW!.toFixed(4)));
const borders = new Set(border.map((o) => o.toFixed(4)));
console.log(`\ndistinct lane widths : ${[...laneWs].join(", ") || "-"}`);
console.log(`distinct border off. : ${[...borders].join(", ") || "-"}`);
