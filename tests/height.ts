// Tests for the height policy (src/height.ts): DGM ground vs DOM surface,
// layer>0 bridge decks, and kerb/lane-marking vertex sticking to road areas.
// Run with: tsx tests/height.ts
import { readFileSync } from "node:fs";
import { DemField, type DemHeader } from "../src/dem";
import { HeightField } from "../src/height";

let failures = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
}

console.log("height policy tests");

function loadGrid(name: string): DemField {
  const h = JSON.parse(readFileSync(`public/data/dem/${name}.json`, "utf8")) as DemHeader;
  const b = readFileSync(`public/data/dem/${name}.bin`);
  return DemField.fromData(h, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const hf = new HeightField();
hf.dem = loadGrid("dgm1-berlin-example");
hf.dom = loadGrid("dom1-berlin-example");
ok(hf.ready, "height field ready with DGM+DOM");

// example center: open ground, DOM == DGM there roughly; structure spot has DOM >> DGM
const cLon = (13.1915938 + 13.3601090) / 2, cLat = (52.4279043 + 52.4861066) / 2;
const sLon = 13.3202708, sLat = 52.4559146; // high-rise: DGM 43.2, DOM 162.8
const groundC = hf.groundM(cLon, cLat)!;
const surfS = hf.surfaceM(sLon, sLat)!;
const groundS = hf.groundM(sLon, sLat)!;
ok(surfS - groundS > 50, `structure spot DOM ${surfS.toFixed(1)} >> DGM ${groundS.toFixed(1)}`);

// layer-0 area (road under a bridge): fillM(0) must stay on the GROUND even
// where the DOM shows a bridge/building above
const roadRing: [number, number][] = [
  [sLon, sLat], // shared vertex, on the structure
  [sLon + 0.0004, sLat - 0.0004],
  [sLon + 0.0004, sLat + 0.0004],
  [sLon - 0.0004, sLat + 0.0004],
];
hf.registerArea(roadRing, 0);
const f0 = hf.fillM(0);
ok(Math.abs(f0(sLon, sLat) - groundS) < 0.5,
  `layer-0 area:highway under a bridge stays at ground ${f0(sLon, sLat).toFixed(1)} m (not DOM ${surfS.toFixed(1)} m)`);

// kerb on the road boundary reuses the road vertex: stickM at the exact
// vertex == the area's height at that vertex
ok(Math.abs(hf.stickM(sLon, sLat) - f0(sLon, sLat)) < 1e-9,
  "kerb vertex on road boundary reuses the road vertex height");
// point inside the road area sticks to the road (ground), not the DOM
ok(Math.abs(hf.stickM(sLon + 0.0002, sLat + 0.0002) - groundS) < 0.5,
  `point inside layer-0 road sticks to ground ${hf.stickM(sLon + 0.0002, sLat + 0.0002).toFixed(1)} m, not DOM`);

// a layer-1 bridge deck over the same spot: its area and its kerbs take DOM
const hf2 = new HeightField();
hf2.dem = hf.dem;
hf2.dom = hf.dom;
hf2.registerArea(roadRing, 1);
const f1 = hf2.fillM(1);
ok(Math.abs(f1(sLon, sLat) - surfS) < 0.5,
  `layer-1 bridge deck takes DOM height ${f1(sLon, sLat).toFixed(1)} m`);
ok(Math.abs(hf2.stickM(sLon, sLat) - surfS) < 0.5,
  "kerb on bridge-deck boundary vertex sticks to the deck (DOM) height");

// shared vertex between ground road (layer 0) and bridge deck (layer 1):
// the higher layer wins — the visible top from above
const hf3 = new HeightField();
hf3.dem = hf.dem;
hf3.dom = hf.dom;
hf3.registerArea(roadRing, 0);
hf3.registerArea(roadRing, 1);
ok(Math.abs(hf3.stickM(sLon, sLat) - surfS) < 0.5 && hf3.stickM(sLon, sLat) > groundS + 50,
  "shared vertex: higher layer (bridge deck) height wins");

// point outside all areas falls back to the DOM surface
ok(Math.abs(hf.stickM(13.19, 52.428) - (hf.surfaceM(13.19, 52.428) ?? 0)) < 1e-9,
  "outside all areas: falls back to DOM surface height");

if (failures > 0) {
  console.error(`${failures} height policy test(s) FAILED`);
  process.exit(1);
}
console.log("all height policy tests passed");
