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

check("terrain grid 220 (20 m cells)", data.terrain.n === 220);
let mn = Infinity, mx = -Infinity;
for (const h of data.terrain.heightsDm) {
  mn = Math.min(mn, h);
  mx = Math.max(mx, h);
}
check("terrain heights in Berlin DGM1/DHHN2016 range (30..80 m)", mn >= 300 && mx <= 800, `${mn / 10}..${mx / 10} m`);

check("tag tables non-empty", data.keys.includes("highway") && data.keys.includes("building") && data.keys.includes("layer"));

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all heightfield dataset tests passed");
