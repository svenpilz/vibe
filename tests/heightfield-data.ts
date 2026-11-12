import { readFileSync } from "node:fs";
import type { BakedData } from "../src3d/schema";
import { getTag } from "../src3d/schema";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const data: BakedData = JSON.parse(readFileSync("public/data/friedenau-2km.json", "utf8"));

check("center ~ S Friedenau", Math.abs(data.centerLat - 52.4784) < 1e-3 && Math.abs(data.centerLon - 13.341) < 1e-3);
check("radius 2 km", data.radiusM === 2000);

const nodeCount = data.nodes.length / 2;
check("node count plausible", nodeCount > 100000, `${nodeCount}`);
check("way count plausible", data.ways.length > 30000, `${data.ways.length}`);

let badRefs = 0;
for (const w of data.ways) for (const r of w.r) if (r < 0 || r >= nodeCount) badRefs++;
check("all way node refs in range", badRefs === 0, `${badRefs}`);

let buildings = 0, highways = 0, bridges = 0, tunnels = 0, layered = 0, negLayer = 0, heights = 0, levels = 0;
for (const w of data.ways) {
  if (getTag(data, w, "building")) buildings++;
  if (getTag(data, w, "height")) heights++;
  if (getTag(data, w, "building:levels")) levels++;
  const hw = getTag(data, w, "highway");
  if (hw) {
    highways++;
    const layer = getTag(data, w, "layer");
    const bridge = getTag(data, w, "bridge") === "yes";
    const tunnel = getTag(data, w, "tunnel") === "yes";
    if (bridge) bridges++;
    if (tunnel) tunnels++;
    if (layer && parseFloat(layer) > 0) layered++;
    if (layer && parseFloat(layer) < 0) negLayer++;
  }
}
check("buildings present", buildings > 8000, `${buildings}`);
check("building heights tagged", heights > 100 && levels > 5000, `height=${heights} levels=${levels}`);
check("highways present", highways > 15000, `${highways}`);
check("bridges present (multi-level above)", bridges > 100 && layered > 100, `bridges=${bridges} layered=${layered}`);
check("tunnels present (multi-level below)", tunnels > 100 && negLayer > 100, `tunnels=${tunnels} negLayer=${negLayer}`);

check("terrain grid 440 (10 m cells)", data.terrain.n === 440);
check("DOM1 surface model present", data.terrainDom !== undefined && data.terrainDom.n === 440);
if (data.terrainDom) {
  let dmn = Infinity, dmx = -Infinity;
  for (const h of data.terrainDom.heightsDm) { dmn = Math.min(dmn, h); dmx = Math.max(dmx, h); }
  let gmx = -Infinity;
  for (const h of data.terrain.heightsDm) gmx = Math.max(gmx, h);
  check("DOM1 includes building roofs (max > DGM max)", dmx > gmx, `dom max ${(dmx/10).toFixed(1)} m vs dgm max ${(gmx/10).toFixed(1)} m`);
}
let mn = Infinity, mx = -Infinity;
for (const h of data.terrain.heightsDm) {
  mn = Math.min(mn, h);
  mx = Math.max(mx, h);
}
check("terrain heights in Berlin DGM1/DHHN2016 range (30..80 m)", mn >= 300 && mx <= 800, `${mn / 10}..${mx / 10} m`);

check("tag tables non-empty", data.keys.includes("highway") && data.keys.includes("building") && data.keys.includes("layer"));

let lamps = 0, signals = 0, trees = 0, kerbWays = 0, shapedRoofs = 0;
for (const pt of data.points) {
  const hw = getTag(data, pt, "highway");
  if (hw === "street_lamp") lamps++;
  if (hw === "traffic_signals") signals++;
  if (getTag(data, pt, "natural") === "tree") trees++;
}
for (const w of data.ways) {
  if (getTag(data, w, "barrier") === "kerb") kerbWays++;
  if (getTag(data, w, "roof:shape")) shapedRoofs++;
}
check("street furniture points present", lamps > 1000 && signals > 100 && trees > 5000, `lamps=${lamps} signals=${signals} trees=${trees}`);
check("kerb ways present", kerbWays > 500, `${kerbWays}`);
check("shaped roofs present", shapedRoofs > 500, `${shapedRoofs}`);

let routeCount = 0, trainRoutes = 0, railWays = 0, busStops = 0;
for (const r of data.routes) {
  routeCount++;
  if (getTag(data, r, "route") === "train" || getTag(data, r, "route") === "light_rail") trainRoutes++;
}
for (const w of data.ways) if (getTag(data, w, "railway")) railWays++;
for (const pt of data.points) {
  if (getTag(data, pt, "highway") === "bus_stop" || getTag(data, pt, "amenity") === "bus_station") busStops++;
}
check("bus/train route relations present", routeCount > 5 && trainRoutes > 0, `routes=${routeCount} trains=${trainRoutes}`);
check("railway ways present (S-Bahn)", railWays > 30, `${railWays}`);
check("bus stops present", busStops > 30, `${busStops}`);
{
  let eleWays = 0, eleNodes = 0;
  for (const w of data.ways) if (w.ele) { eleWays++; eleNodes += w.ele.filter((e) => e >= 0).length; }
  check("road node ele=* tags baked (surveyed point heights)", eleWays > 100 && eleNodes > 200, `ways=${eleWays} nodes=${eleNodes}`);
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all heightfield dataset tests passed");
