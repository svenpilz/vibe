import { parseHeightM, parseLevels, buildingHeightM, minHeightM, osmLayer, layerElevationM, roadWidthM, surfaceColor, sampleTerrainM, type TerrainGrid } from "../src3d/schema";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

check("height '12.5'", parseHeightM("12.5") === 12.5);
check("height '12 m'", parseHeightM("12 m") === 12);
check("height '12,5'", parseHeightM("12,5") === 12.5);
check("height junk -> undefined", parseHeightM("unknown") === undefined);
check("levels '4'", parseLevels("4") === 4);

check("building height tag wins", buildingHeightM({ height: "22", "building:levels": "3" }) === 22);
check("levels 4 -> 4*3+2 = 14", buildingHeightM({ "building:levels": "4" }) === 14);
check("levels + roof levels", buildingHeightM({ "building:levels": "3", "roof:levels": "1" }) === 3 * 3 + 1 * 3 + 2);
check("default height", buildingHeightM({}) === 10);
check("min_height", minHeightM({ min_height: "3" }) === 3 && minHeightM({}) === 0);

check("layer default 0", osmLayer({}) === 0);
check("layer=2", osmLayer({ layer: "2" }) === 2);
check("layer=-2.5 rounds to -2", osmLayer({ layer: "-2.5" }) === -2);
check("bridge=yes implies layer 1", osmLayer({ bridge: "yes" }) === 1);
check("tunnel=yes implies layer -1", osmLayer({ tunnel: "yes" }) === -1);
check("explicit layer beats bridge", osmLayer({ bridge: "yes", layer: "2" }) === 2);
check("layer elevation 1 -> 5 m", layerElevationM({ layer: "1" }) === 5);
check("layer elevation -1 -> -5 m", layerElevationM({ tunnel: "yes" }) === -5);

check("width tag wins", roadWidthM({ highway: "residential", width: "9" }) === 9);
check("lanes=2 -> 6.4 m", roadWidthM({ highway: "primary", lanes: "2" }) === 6.4);
check("motorway default 13", roadWidthM({ highway: "motorway" }) === 13);
check("residential default 7.5", roadWidthM({ highway: "residential" }) === 7.5);
check("footway default 2", roadWidthM({ highway: "footway" }) === 2);

const sc = surfaceColor({ highway: "motorway" });
const res = surfaceColor({ highway: "residential" });
check("motorway darker than residential asphalt", sc[0] < res[0], `${sc[0]} vs ${res[0]}`);
check("footway lighter", surfaceColor({ highway: "footway" })[0] > 0.5);

function grid(heightsDm: number[]): TerrainGrid {
  return { n: 1, sizeM: 100, originX: 0, originY: 0, heightsDm };
}
check("flat terrain sample", sampleTerrainM(grid([500, 500, 500, 500]), 50, 50) === 50);
const g2 = grid([0, 1000, 0, 1000]); // corners (0,0)=0m (100,0)=100m (0,100)=0m (100,100)=100m
check("terrain bilinear midpoint", Math.abs(sampleTerrainM(g2, 50, 50) - 50) < 1e-9);
check("terrain corner", Math.abs(sampleTerrainM(g2, 100, 100) - 100) < 1e-6);

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all heightfield schema tests passed");
