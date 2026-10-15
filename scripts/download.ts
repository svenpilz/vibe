/**
 * Downloads the Geofabrik Berlin PBF using Node's fetch with streaming,
 * writing to data/berlin-latest.osm.pbf.
 */
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const URL = process.env.PBF_URL ?? "https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf";
const OUT = "data/berlin-latest.osm.pbf";
const TMP = OUT + ".part";

async function main() {
  mkdirSync("data", { recursive: true });

  if (existsSync(OUT) && !process.env.FORCE) {
    console.log(`${OUT} already exists (${(statSync(OUT).size / 1e6).toFixed(1)} MB) — set FORCE=1 to re-download`);
    return;
  }

  console.log(`downloading ${URL}`);
  const res = await fetch(URL, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get("content-length") ?? 0);
  console.log(`size: ${total ? (total / 1e6).toFixed(1) + " MB" : "unknown"}`);

  const body = Readable.fromWeb(res.body as any);
  let received = 0;
  const timer = setInterval(() => {
    const pct = total ? ((received / total) * 100).toFixed(1) + "%" : (received / 1e6).toFixed(1) + " MB";
    process.stdout.write(`\r  ${pct}`);
  }, 1000);

  await pipeline(body, createWriteStream(TMP));
  clearInterval(timer);
  process.stdout.write("\n");

  renameSync(TMP, OUT);
  console.log(`saved ${OUT} (${(statSync(OUT).size / 1e6).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error("download failed:", err.message);
  process.exit(1);
});
