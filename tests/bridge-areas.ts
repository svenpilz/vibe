/**
 * Bridges are identified ONLY by man_made=bridge (OSM wiki) — bridge=* on a
 * way does NOT mark a bridge. man_made=bridge closed ways (and multipolygon
 * relations) are extracted as deck areas (highway="bridge", bridge flag set)
 * so they render and act as the ground level for same-layer features inside
 * them (in 2D). Verified against the bundled Berlin example, which contains
 * six man_made=bridge deck ways.
 */
import { readFileSync } from "node:fs";
import { OSMPBFParser, createOSMData } from "../src/osm-pbf";
import { extractFeatures } from "../src/extract";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

// --- synthetic fixture: tag semantics ---
{
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
  const way = (id: number, coords: [number, number][], tags: Record<string, string>, closed = false) => {
    const ring = closed ? [...coords, coords[0]] : coords;
    data.ways.set(id, { id, refs: ring.map(([lat, lon]) => node(lat, lon)), tags });
  };

  // bridge=yes on a centerline: NOT a bridge (man_made only)
  way(1, [[52.46, 13.33], [52.461, 13.331]],
    { highway: "secondary", bridge: "yes", layer: "1", surface: "asphalt", lanes: "2" });
  // man_made=bridge closed way: deck area
  way(2, [[52.462, 13.332], [52.4625, 13.332], [52.4625, 13.3325], [52.462, 13.3325]],
    { man_made: "bridge", layer: "1", "bridge:structure": "beam" }, true);
  // area:highway + man_made=bridge: area that IS a bridge
  way(3, [[52.463, 13.333], [52.4635, 13.333], [52.4635, 13.3335], [52.463, 13.3335]],
    { "area:highway": "secondary", man_made: "bridge", layer: "1" }, true);
  // plain area:highway with bridge=yes: area, but NOT flagged as a bridge
  way(4, [[52.464, 13.334], [52.4645, 13.334], [52.4645, 13.3345], [52.464, 13.3345]],
    { "area:highway": "residential", bridge: "yes" }, true);
  // man_made=bridge multipolygon relation: deck area
  way(10, [[52.465, 13.335], [52.4655, 13.335], [52.4655, 13.3355], [52.465, 13.3355]], {}, true);
  data.relations.push({
    id: 100,
    tags: { type: "multipolygon", man_made: "bridge", layer: "1" },
    members: [{ type: "way", ref: 10, role: "outer" }],
  });

  const res = extractFeatures(data);
  const cl = res.centerlines.find((c) => c.id === "w1");
  ok(cl !== undefined && cl.bridge === undefined,
    "bridge=yes centerline does NOT get the bridge flag (man_made only)");
  const deck = res.areas.find((a) => a.id === "w2");
  ok(deck !== undefined && deck.highway === "bridge" && deck.bridge === "yes" && deck.layer === 1,
    "man_made=bridge closed way extracts as a deck area with the bridge flag");
  const areaMm = res.areas.find((a) => a.id === "w3");
  ok(areaMm !== undefined && areaMm.highway === "secondary" && areaMm.bridge === "yes",
    "area:highway + man_made=bridge keeps its highway kind and gets the bridge flag");
  const areaB = res.areas.find((a) => a.id === "w4");
  ok(areaB !== undefined && areaB.bridge === undefined,
    "area:highway with bridge=yes only is NOT flagged as a bridge");
  const relDeck = res.areas.find((a) => a.id === "r100");
  ok(relDeck !== undefined && relDeck.highway === "bridge" && relDeck.bridge === "yes",
    "man_made=bridge multipolygon relation extracts as a deck area");
}

// --- bundled example: the six man_made=bridge ways become deck areas ---
{
  const data = createOSMData();
  const parser = new OSMPBFParser(data);
  await parser.parseBuffer(new Uint8Array(readFileSync("public/data/berlin-example.osm.pbf")));

  const mmClosed = [...data.ways.values()].filter(
    (w) => w.tags["man_made"] === "bridge" && w.refs.length > 3 && w.refs[0] === w.refs[w.refs.length - 1],
  );
  const mmRels = data.relations.filter((r) => r.tags["man_made"] === "bridge");
  ok(mmClosed.length === 6, `example has 6 man_made=bridge closed ways (got ${mmClosed.length})`);

  const res = extractFeatures(data);
  const decks = res.areas.filter((a) => a.bridge !== undefined);
  ok(decks.length === mmClosed.length + mmRels.length,
    `all ${mmClosed.length + mmRels.length} man_made=bridge elements extract as deck areas (got ${decks.length})`);
  ok(decks.every((a) => a.highway === "bridge" && a.layer === 1),
    "deck areas carry highway=\"bridge\", the bridge flag and layer 1");
  const mmIds = new Set([...mmClosed.map((w) => `w${w.id}`), ...mmRels.map((r) => `r${r.id}`)]);
  ok(decks.every((a) => mmIds.has(a.id)),
    "every deck area comes from a man_made=bridge element");

  // bridge=* ways must no longer produce bridge-flagged features
  const bridgeStarWays = [...data.ways.values()].filter(
    (w) => w.tags["bridge"] !== undefined && w.tags["man_made"] !== "bridge",
  );
  ok(bridgeStarWays.length > 0, `example has ${bridgeStarWays.length} bridge=* ways (sanity)`);
  const allFeats: { id: string; bridge?: string }[] = [
    ...res.areas, ...res.centerlines, ...res.footways, ...res.crossings,
    ...res.kerbWays, ...res.laneMarkings, ...res.stopLines, ...res.parking,
    ...res.landuse, ...res.grass,
  ];
  const flaggedFromBridgeStar = allFeats.filter((f) => f.bridge !== undefined && !mmIds.has(f.id));
  ok(flaggedFromBridgeStar.length === 0,
    "no feature is bridge-flagged unless its source element has man_made=bridge");
}

if (failures > 0) {
  console.error(`${failures} bridge-area test(s) FAILED`);
  process.exit(1);
}
console.log("all bridge-area tests passed");
