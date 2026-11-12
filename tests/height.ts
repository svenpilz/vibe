// Tests for the height policy (src/height.ts): DGM ground vs DOM surface,
// layer>0 bridge decks, and kerb/lane-marking vertex sticking to road areas.
// Run with: tsx tests/height.ts
import { readFileSync } from "node:fs";
import { DemField, lonLatToUtm33, type DemHeader } from "../src/dem";
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

// fallback outside all areas: layer>0 -> DOM surface, layer 0 -> DGM ground
ok(Math.abs(hf.stickM(13.19, 52.428, 1) - (hf.surfaceM(13.19, 52.428) ?? 0)) < 1e-9,
  "outside all areas, layer 1: falls back to DOM surface height");
ok(Math.abs(hf.stickM(13.19, 52.428, 0) - (hf.groundM(13.19, 52.428) ?? 0)) < 1e-9,
  "outside all areas, layer 0: falls back to DGM ground");

// the bridge deck polygon is the ground level for SAME-layer features inside
// it (2D), while lower-layer features inside it (road under the bridge in 2D)
// stay on the ground
const hf6 = new HeightField();
hf6.dem = hf.dem;
hf6.dom = hf.dom;
hf6.registerArea(roadRing, 1, true); // bridge deck over the structure spot
const insideP: [number, number] = [sLon + 0.0002, sLat + 0.0002];
ok(Math.abs(hf6.stickM(insideP[0], insideP[1], 1) - (hf6.surfaceM(insideP[0], insideP[1]) ?? 0)) < 1e-9,
  "same-layer feature inside bridge polygon takes the deck (DOM) height");
ok(Math.abs(hf6.stickM(insideP[0], insideP[1], 0) - (hf6.groundM(insideP[0], insideP[1]) ?? 0)) < 1e-9,
  "layer-0 feature inside bridge polygon (road underneath in 2D) stays on ground");

// connected polygons: a layer-0 area sharing a vertex with a layer>0 bridge
// line takes the DOM surface, so it stays continuous with the deck
const hf4 = new HeightField();
hf4.dem = hf.dem;
hf4.dom = hf.dom;
hf4.markHighLine([[sLon, sLat], [sLon + 0.001, sLat]], 1);
const connectedRing: [number, number][] = [
  [sLon, sLat],
  [sLon + 0.0004, sLat],
  [sLon + 0.0004, sLat + 0.0004],
  [sLon, sLat + 0.0004],
];
ok(Math.abs(hf4.fillMFor([connectedRing], 0)(sLon + 0.0002, sLat + 0.0002) - (hf4.surfaceM(sLon + 0.0002, sLat + 0.0002) ?? 0)) < 1e-9,
  "layer-0 area connected to a bridge line takes DOM height (continuous)");
const farRing: [number, number][] = [
  [cLon - 0.0003, cLat - 0.0003],
  [cLon + 0.0003, cLat - 0.0003],
  [cLon + 0.0003, cLat + 0.0003],
  [cLon - 0.0003, cLat + 0.0003],
];
ok(Math.abs(hf4.fillMFor([farRing], 0)(cLon, cLat) - (hf4.groundM(cLon, cLat) ?? 0)) < 1e-9,
  "disconnected layer-0 area stays on DGM ground");
// landuse exemption: connected=false skips the vertex-sharing rule, so even a
// polygon sharing a vertex with the bridge line stays on the DGM ground
ok(Math.abs(hf4.fillMFor([connectedRing], 0, false, false)(sLon + 0.0002, sLat + 0.0002) - (hf4.groundM(sLon + 0.0002, sLat + 0.0002) ?? 0)) < 1e-9,
  "landuse (connected=false) sharing a bridge vertex still stays on DGM ground");

// man_made=bridge deck without layer: the deck still takes the DOM surface
// (OSM wiki: man_made=bridge marks the structure) and occludes the ground below
const hf5 = new HeightField();
hf5.dem = hf.dem;
hf5.dom = hf.dom;
const bridgeRing: [number, number][] = [
  [sLon, sLat],
  [sLon + 0.0004, sLat],
  [sLon + 0.0004, sLat + 0.0004],
  [sLon, sLat + 0.0004],
];
hf5.registerArea(bridgeRing, 0, true);
ok(Math.abs(hf5.fillMFor([bridgeRing], 0, true)(sLon, sLat) - surfS) < 0.5,
  `man_made=bridge area at layer 0 takes DOM height ${hf5.fillMFor([bridgeRing], 0, true)(sLon, sLat).toFixed(1)} m`);
ok(Math.abs(hf5.stickM(sLon, sLat) - surfS) < 0.5,
  "kerb on a man_made=bridge boundary vertex sticks to the deck (DOM) height");
ok((hf5 as unknown as { vertexMaxLayer: Map<string, number> }).vertexMaxLayer.get(`${Math.round(sLon * 1e7)}:${Math.round(sLat * 1e7)}`) === 1,
  "man_made=bridge vertex counts as layer 1 for connectivity");

// --- road flattening: plane-fit removes local DEM bumps but keeps the slope ---
{
  // synthetic DEM: 40 m base + 1% eastward slope + a 5 m bump at the center cell
  const tLon = 13.32, tLat = 52.456;
  const [tE, tN] = lonLatToUtm33(tLon, tLat);
  const cols = 20, rows = 20, cellM = 10;
  // origin chosen so (tE,tN) is the CENTER of cell (10,10): sampling there
  // returns that cell's value exactly (no bilinear dilution of the bump)
  const header: DemHeader = {
    crs: "EPSG:25833", cellM, originE: tE - 105, originN: tN - 105,
    cols, rows, heightOffsetM: 0, heightScaleM: 0.01, nodata: 65535,
  };
  const raw = new Uint16Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const E = header.originE + (c + 0.5) * cellM;
      const z = 40 + 0.01 * (E - tE); // 1% grade eastward
      raw[r * cols + c] = Math.round(z / header.heightScaleM);
    }
  // bump: +5 m in the single center cell (a local DEM noise spike)
  const cc = Math.floor((tE - header.originE) / cellM), cr = Math.floor((tN - header.originN) / cellM);
  raw[cr * cols + cc] += Math.round(5 / header.heightScaleM);
  const synth = DemField.fromData(header, raw.buffer);

  const hFlat = new HeightField();
  hFlat.dem = synth;
  const ring: [number, number][] = [
    [tLon - 0.0005, tLat - 0.0003],
    [tLon + 0.0005, tLat - 0.0003],
    [tLon + 0.0005, tLat + 0.0003],
    [tLon - 0.0005, tLat + 0.0003],
  ];
  const rawF = hFlat.fillMFor([ring], 0, false, true, false);
  const flatF = hFlat.fillMFor([ring], 0, false, true, true);
  const rawAtBump = rawF(tLon, tLat);
  const flatAtBump = flatF(tLon, tLat);
  ok(rawAtBump - flatAtBump > 3,
    `plane-fit removes the local bump: raw ${rawAtBump.toFixed(1)} m -> flat ${flatAtBump.toFixed(1)} m`);
  // slope preserved: east edge vs west edge still differ by ~1% grade
  const spanM = 0.001 * 111320 * Math.cos((tLat * Math.PI) / 180); // ring width in m
  const slopeDrop = flatF(tLon + 0.0005, tLat) - flatF(tLon - 0.0005, tLat);
  ok(Math.abs(slopeDrop - 0.01 * spanM) < 0.3,
    `overall slope kept: ${slopeDrop.toFixed(2)} m over ${spanM.toFixed(0)} m (expected ~${(0.01 * spanM).toFixed(2)} m)`);
  // kerbs/markings on the road stick to the FLATTENED surface, not the bump
  hFlat.registerArea(ring, 0, false, true);
  ok(Math.abs(hFlat.stickM(tLon, tLat) - flatAtBump) < 0.05,
    `point inside a road area sticks to the flattened plane (${hFlat.stickM(tLon, tLat).toFixed(2)} m), not the raw bump (${rawAtBump.toFixed(2)} m)`);
  // non-road areas keep the raw surface
  const hFlat2 = new HeightField();
  hFlat2.dem = synth;
  hFlat2.registerArea(ring, 0, false, false);
  ok(Math.abs(hFlat2.stickM(tLon, tLat) - rawAtBump) < 0.05,
    "non-road area (landuse) still sticks to the raw DEM height");
}

// --- one-hop adjacency for connected ROADS (ramps), via shared/adjacent vertices ---
{
  const hf7 = new HeightField();
  hf7.dem = hf.dem;
  hf7.dom = hf.dom;
  // bridge line through the structure spot: marks its vertices high
  hf7.markHighLine([[sLon, sLat], [sLon + 0.001, sLat]], 1);
  // ramp road area sharing a vertex with the bridge line -> direct
  const rampRing: [number, number][] = [
    [sLon, sLat], [sLon + 0.0004, sLat],
    [sLon + 0.0004, sLat + 0.0004], [sLon, sLat + 0.0004],
  ];
  // adjacent road: shares only ramp's corner vertex -> one hop (ramp case)
  const adjRing: [number, number][] = [
    [sLon + 0.0004, sLat + 0.0004], [sLon + 0.0008, sLat + 0.0004],
    [sLon + 0.0008, sLat + 0.0008], [sLon + 0.0004, sLat + 0.0008],
  ];
  // near-adjacent road: NO exact shared vertex with the direct ramp, but its
  // corner sits ~0.5 m from the ramp's corner (mapped with non-coincident
  // nodes) -> still one hop ("connected roads share adjacent vertices")
  const nearRing: [number, number][] = [
    [sLon + 0.0004 + 0.000008, sLat + 0.0004], [sLon + 0.0008 + 0.000008, sLat + 0.0004],
    [sLon + 0.0008 + 0.000008, sLat + 0.0008], [sLon + 0.0004 + 0.000008, sLat + 0.0008],
  ];
  // two hops away: shares a vertex with nearRing only (not with any direct
  // area) -> NOT transitive
  const farRing2: [number, number][] = [
    [sLon + 0.0008 + 0.000008, sLat + 0.0008], [sLon + 0.0012, sLat + 0.0008],
    [sLon + 0.0012, sLat + 0.0012], [sLon + 0.0008 + 0.000008, sLat + 0.0012],
  ];
  // non-road polygon adjacent to the ramp -> roads only, stays on ground
  const landRing: [number, number][] = [
    [sLon, sLat + 0.0004], [sLon + 0.0004, sLat + 0.0004],
    [sLon + 0.0004, sLat + 0.0008], [sLon, sLat + 0.0008],
  ];
  hf7.registerArea(rampRing, 0, false, true);
  hf7.registerArea(adjRing, 0, false, true);
  hf7.registerArea(nearRing, 0, false, true);
  hf7.registerArea(farRing2, 0, false, true);
  hf7.registerArea(landRing, 0, false, false);
  hf7.finalizeConnections();

  const pRamp = [sLon + 0.0002, sLat + 0.0002] as [number, number];
  const pAdj = [sLon + 0.0006, sLat + 0.0006] as [number, number];
  const pNear = [sLon + 0.0006, sLat + 0.0006] as [number, number];
  const pFar = [sLon + 0.0010, sLat + 0.0010] as [number, number];
  const pLand = [sLon + 0.0002, sLat + 0.0006] as [number, number];
  ok(Math.abs(hf7.fillMFor([rampRing], 0)(pRamp[0], pRamp[1]) - (hf7.surfaceM(pRamp[0], pRamp[1]) ?? 0)) < 0.5,
    "ramp sharing a bridge-line vertex takes DOM (direct)");
  ok(Math.abs(hf7.fillMFor([adjRing], 0)(pAdj[0], pAdj[1]) - (hf7.surfaceM(pAdj[0], pAdj[1]) ?? 0)) < 0.5,
    "adjacent road (shared vertex with the ramp) takes DOM — one hop");
  ok(Math.abs(hf7.fillMFor([nearRing], 0)(pNear[0], pNear[1]) - (hf7.surfaceM(pNear[0], pNear[1]) ?? 0)) < 0.5,
    "road with only near-coincident (~1 m) boundary vertices counts as adjacent (enforced shared adjacent vertices)");
  ok(Math.abs(hf7.fillMFor([farRing2], 0)(pFar[0], pFar[1]) - (hf7.groundM(pFar[0], pFar[1]) ?? 0)) < 0.5,
    "two hops away stays on the ground — NOT transitive");
  ok(Math.abs(hf7.fillMFor([landRing], 0)(pLand[0], pLand[1]) - (hf7.groundM(pLand[0], pLand[1]) ?? 0)) < 0.5,
    "adjacent NON-road polygon (landuse) stays on ground — propagation is for roads only");
  // lane markings stick to the road's rendered (flattened DOM) surface
  const flatAdj = hf7.fillMFor([adjRing], 0, false, true, true)(pAdj[0], pAdj[1]);
  ok(Math.abs(hf7.stickM(pAdj[0], pAdj[1]) - flatAdj) < 0.05,
    `lane marking inside the connected ramp sticks to the road surface (${hf7.stickM(pAdj[0], pAdj[1]).toFixed(2)} m = flattened fill ${flatAdj.toFixed(2)} m)`);
}

if (failures > 0) {
  console.error(`${failures} height policy test(s) FAILED`);
  process.exit(1);
}
console.log("all height policy tests passed");
