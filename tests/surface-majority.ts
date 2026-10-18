/**
 * Real-data regression (footway area 1364345063, Berlin): the area's
 * surface must be decided by ONE majority vote — every compatible way with
 * surface=* contributes the length of its parts strictly inside the area.
 * Two long paving_stones sidewalks running along the area boundary must
 * beat a short sett spur crossing the interior; the old containment rule
 * (longest entirely-inside donor) let the spur win.
 */
import { createOSMData } from "../src/osm-pbf";
import { extractFeatures } from "../src/extract";

let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const data = createOSMData();
let n = 1;
const nb = new Map<string, number>();
const node = (lat: number, lon: number): number => {
  const k = `${lat},${lon}`;
  if (nb.has(k)) return nb.get(k)!;
  const id = n++;
  data.nodeCoords.set(id, Math.round(lon * 1e7), Math.round(lat * 1e7));
  nb.set(k, id);
  return id;
};
let w = 1;
const way = (coords: [number, number][], tags: Record<string, string>, close = false) => {
  data.ways.set(w, { id: w, refs: [...coords, ...(close ? [coords[0]] : [])].map(([a, b]) => node(a, b)), tags });
  w++;
};

// long paving_stones sidewalk along the area's upper boundary (way 1096132995)
way([[52.4692414,13.3353808],[52.4692412,13.3353997],[52.4692360,13.3356955],[52.4692342,13.3357968],
     [52.4692319,13.3359206],[52.4692285,13.3361092],[52.4692268,13.3361984],[52.4692221,13.3364616],
     [52.4692172,13.3367174],[52.4692142,13.3368811],[52.4692099,13.3371185],[52.4692083,13.3372033],
     [52.4692077,13.3372316]],
  { highway: "footway", footway: "sidewalk", surface: "paving_stones", lit: "yes" });
// long paving_stones sidewalk along the area's left boundary (way 1101572979)
way([[52.4692543,13.3354003],[52.4692412,13.3353997],[52.4691376,13.3353942],[52.4690257,13.3353882],
     [52.4689167,13.3353829],[52.4688067,13.3353776],[52.4687599,13.3353753],[52.4685616,13.3353657],
     [52.4685380,13.3353645],[52.4683568,13.3353557],[52.4683264,13.3353543],[52.4682218,13.3353492],
     [52.4682109,13.3353374],[52.4681042,13.3352221],[52.4680823,13.3351985]],
  { highway: "footway", footway: "sidewalk", surface: "paving_stones", lit: "yes" });
// short sett spur crossing the interior (way 1276040614)
way([[52.4691795,13.3356932],[52.4692360,13.3356955]],
  { highway: "footway", surface: "sett", lit: "yes" });
// the footway area (way 1364345063)
way([[52.4691745,13.3357943],[52.4692238,13.3357964],[52.4692342,13.3357968],[52.4692541,13.3357977],
     [52.4692566,13.3356590],[52.4692473,13.3356585],[52.4692479,13.3356326],[52.4692571,13.3356331],
     [52.4692607,13.3354336],[52.4692601,13.3354261],[52.4692590,13.3354186],[52.4692578,13.3354121],
     [52.4692561,13.3354059],[52.4692543,13.3354003],[52.4692520,13.3353953],[52.4692490,13.3353896],
     [52.4692453,13.3353848],[52.4692414,13.3353808],[52.4692384,13.3353787],[52.4692350,13.3353766],
     [52.4692304,13.3353752],[52.4692144,13.3353742],[52.4691672,13.3353718],[52.4691669,13.3353890],
     [52.4691377,13.3353877],[52.4691376,13.3353942],[52.4691374,13.3354083],[52.4691362,13.3354970],
     [52.4691548,13.3354979],[52.4691589,13.3355053],[52.4691649,13.3354967],[52.4691724,13.3355105],
     [52.4691799,13.3355242],[52.4691749,13.3355315],[52.4691794,13.3355399],[52.4691767,13.3356760],
     [52.4691798,13.3356792],[52.4691795,13.3356932],[52.4691792,13.3357072],[52.4691761,13.3357081]],
  { "area:highway": "footway" }, true);

const r = extractFeatures(data);
const area = r.areas.find((a) => a.id === "w4");
check("footway area found", area !== undefined);
check("majority vote picks paving_stones over the short sett spur",
  area?.surface === "paving_stones", `surface=${area?.surface}`);

if (failures > 0) { console.error(`${failures} test(s) failed`); process.exit(1); }
console.log("all surface majority tests passed");
