import { CENTER, RADIUS_M, LAYER_H, metersPerDegLat, metersPerDegLon, lonLatToMeters, metersToLonLat, quantizeDeg, dequantizeDeg, lonLatToUtm33 } from "../src3d/geo";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

check("center is S Friedenau", Math.abs(CENTER.lat - 52.4784) < 1e-3 && Math.abs(CENTER.lon - 13.341) < 1e-3);
check("radius is 2 km", RADIUS_M === 2000);
check("layer height is 5 m", LAYER_H === 5);

const mPerLat = metersPerDegLat(52.4784);
check("1 deg lat ~111.3 km", mPerLat > 111000 && mPerLat < 111500, `${mPerLat}`);
const mPerLon = metersPerDegLon(52.4784);
check("1 deg lon ~67.8 km at Berlin", mPerLon > 67000 && mPerLon < 68500, `${mPerLon}`);

const [x0, y0] = lonLatToMeters(CENTER.lon, CENTER.lat);
check("center maps to origin", x0 === 0 && y0 === 0, `${x0},${y0}`);

const [x1, y1] = lonLatToMeters(CENTER.lon, CENTER.lat + 0.01);
check("0.01 deg lat ~1.1 km north", Math.abs(y1 - 1112.8) < 20 && Math.abs(x1) < 1, `${x1},${y1}`);

const [lon2, lat2] = metersToLonLat(1000, -500);
const [x2, y2] = lonLatToMeters(lon2, lat2);
check("roundtrip 1000m east, 500m south", Math.abs(x2 - 1000) < 0.01 && Math.abs(y2 + 500) < 0.01, `${x2},${y2}`);

check("quantize roundtrip", dequantizeDeg(quantizeDeg(13.341)) === 13.341);

const [E, N] = lonLatToUtm33(13.341, 52.4784);
check("UTM33N of S Friedenau ~ (387331, 5815543)", Math.abs(E - 387331) < 5 && Math.abs(N - 5815543) < 5, `${E},${N}`);

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all heightfield geo tests passed");
