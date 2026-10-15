import { OSMPBFParser, createOSMData } from "../src/osm-pbf";
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const data = createOSMData();
const parser = new OSMPBFParser(data);
parser.parseBuffer(new Uint8Array(readFileSync("tests/fixtures/synthetic.osm.pbf")));

console.log(`nodes:${data.nodeCoords.size} tagged:${data.nodeTags.size} ways:${data.ways.size} rels:${data.relations.length}`);

check("all 25 nodes parsed", data.nodeCoords.size === 25, `got ${data.nodeCoords.size}`);

const node1 = data.nodeCoords.get(1);
check("node 1 coord exists", node1 !== undefined);
if (node1) {
  check("node 1 lon ~ 13.40", Math.abs(node1.lon - 13.40) < 1e-6, `lon=${node1.lon}`);
  check("node 1 lat ~ 52.52", Math.abs(node1.lat - 52.52) < 1e-6, `lat=${node1.lat}`);
}

check("way 100 area:highway", data.ways.get(100)?.tags["area:highway"] === "pedestrian");
check("way 101 surface=sett", data.ways.get(101)?.tags["surface"] === "sett");
check("way 112 width=2.5", data.ways.get(112)?.tags["width"] === "2.5");
check("way 113 crossing=zebra", data.ways.get(113)?.tags["crossing"] === "zebra");
check("way 114 markings=dashes", data.ways.get(114)?.tags["crossing:markings"] === "dashes");

const rel = data.relations[0];
check("relation 200 parsed", rel?.id === 200 && rel.members.length === 2);
check("relation roles", rel?.members[0].role === "outer" && rel?.members[1].role === "inner");
check("relation type multipolygon", rel?.tags["type"] === "multipolygon");
check("relation area:highway", rel?.tags["area:highway"] === "footway");

check("kerb tags kept", data.nodeTags.get(7)?.["kerb"] === "lowered" && data.nodeTags.get(7)?.["tactile_paving"] === "yes");
check("untagged node has no tags entry", !data.nodeTags.has(1));

// way refs decode (delta)
const refs101 = data.ways.get(101)!.refs;
check("way 101 refs", refs101.length === 3 && refs101[0] === 8 && refs101[2] === 10, JSON.stringify(refs101));

// relation member refs decode (delta)
check("relation member refs", rel?.members[0].ref === 110 && rel?.members[1].ref === 111, `${rel?.members.map(m=>m.ref)}`);
check("relation member types", rel?.members[0].type === "way");

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all parser tests passed");
