// Tests for the DEM heightfield loader (src/dem.ts). Run with: tsx tests/dem.ts
import { readFileSync } from "node:fs";
import { DemField, lonLatToUtm33, type DemHeader } from "../src/dem";

let failures = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
}

console.log("dem tests");

// UTM33N sanity: central meridian of zone 33 is 15E -> easting 500000, lat 0 -> northing 0
const [e0, n0] = lonLatToUtm33(15, 0);
ok(Math.abs(e0 - 500000) < 1 && Math.abs(n0) < 1, `utm33(15,0) = (${e0.toFixed(2)}, ${n0.toFixed(2)}) ~ (500000, 0)`);
// Berlin example bbox corners (computed independently)
const [e1, n1] = lonLatToUtm33(13.1915938, 52.4279043);
const [e2, n2] = lonLatToUtm33(13.3601090, 52.4861066);
ok(Math.abs(e1 - 377044.3) < 1 && Math.abs(n1 - 5810170.8) < 1, `utm33 SW corner = (${e1.toFixed(1)}, ${n1.toFixed(1)})`);
ok(Math.abs(e2 - 388648.0) < 1 && Math.abs(n2 - 5816370.8) < 1, `utm33 NE corner = (${e2.toFixed(1)}, ${n2.toFixed(1)})`);

// load the bundled example DEM artifact
const header = JSON.parse(
  readFileSync("public/data/dem/dgm1-berlin-example.json", "utf8"),
) as DemHeader;
const bin = readFileSync("public/data/dem/dgm1-berlin-example.bin");
const dem = DemField.fromData(header, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
ok(dem.cols === header.cols && dem.rows === header.rows, `grid ${dem.cols}x${dem.rows} = ${header.cols}x${header.rows}`);

// sample inside the example bbox: within the recorded height range, non-null
const cLon = (13.1915938 + 13.3601090) / 2,
  cLat = (52.4279043 + 52.4861066) / 2;
const hC = dem.sampleM(cLon, cLat);
ok(hC !== null && hC >= (header.minHM ?? 0) && hC <= (header.maxHM ?? 200),
  `sample at example center = ${hC?.toFixed(2)} m within [${header.minHM}, ${header.maxHM}]`);
// outside coverage -> null
ok(dem.sampleM(13.0, 52.0) === null, "sample outside DEM grid -> null");

// occlusion + inpainting: occlude a ring near the center, heights must stay
// finite and within the local neighborhood range
const ring: [number, number][] = [
  [cLon - 0.0005, cLat - 0.0005],
  [cLon + 0.0005, cLat - 0.0005],
  [cLon + 0.0005, cLat + 0.0005],
  [cLon - 0.0005, cLat + 0.0005],
];
const before = dem.sampleM(cLon, cLat)!;
dem.occludeRing(ring);
dem.inpaint();
const after = dem.sampleM(cLon, cLat)!;
ok(Number.isFinite(after), `occluded center inpainted to finite height ${after.toFixed(2)} m (raw was ${before.toFixed(2)})`);
ok(Math.abs(after - before) < 30, `inpainted height ${after.toFixed(2)} within 30 m of raw ${before.toFixed(2)}`);

if (failures > 0) {
  console.error(`${failures} dem test(s) FAILED`);
  process.exit(1);
}
console.log("all dem tests passed");
