// Tests for the quadtree scene graph + frustum culling in src/gl.ts.
// Run with: tsx tests/scene-graph.ts
import { GlMap, SceneGraph } from "../src/gl";

let failures = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
}

function makeStubGL(calls: string[]): any {
  return new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "getShaderParameter" || prop === "getProgramParameter") return () => true;
      if (prop === "getUniformLocation") return () => ({});
      if (prop === "getAttribLocation") return (_p: any, n: string) => ({ a_pos: 0, a_color: 1, a_uv: 2, a_zgeo: 3, a_zord: 4 })[n] ?? 0;
      if (prop === "createShader" || prop === "createProgram" || prop === "createBuffer" || prop === "createTexture" || prop === "createVertexArray") return () => ({});
      if (/^[A-Z0-9_]+$/.test(prop)) return 1;
      return (...args: any[]) => {
        calls.push(String(prop) + (prop === "drawArrays" ? `(${args.join(",")})` : ""));
      };
    },
  });
}

console.log("scene graph tests");
const calls: string[] = [];
const canvas: any = {
  clientWidth: 1280,
  clientHeight: 800,
  width: 0,
  height: 0,
  getContext: () => makeStubGL(calls),
};
const g = new GlMap(canvas);
g.setViewState(1280, 800, 1);

// two clusters of 30 small squares each, far apart; >48 items forces a split
const cluster = (cx: number, cy: number) => {
  for (let i = 0; i < 30; i++) {
    const x = cx + (i % 6) * 30, y = cy + Math.floor(i / 6) * 30, d = 10;
    g.fillPolygon(
      [[[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d]]],
      [],
      { color: [1, 0, 0, 1] },
    );
  }
};
g.beginFrame();
g.beginRecord();
cluster(0, 0);
cluster(0, -100000); // far south: behind a north-looking tilted camera
const scene = g.finishScene();
ok(scene.totalCmds === 60, `scene recorded 60 commands (got ${scene.totalCmds})`);

const countDraws = () => calls.filter((c) => c.startsWith("drawArrays")).length;

// zoomed in on cluster A only: scale 2560 -> half-view width = 640/(2560/2000) = 500 world units
calls.length = 0;
g.setCamera(0, 0, 2560, 0, 0);
g.beginFrame();
g.renderScene(scene);
const onlyA = countDraws();
// ranges are merged per node: cluster A sits in one leaf -> 1 merged draw
ok(onlyA === 1, `frustum culls + merges: ${onlyA} draw for cluster A only (60 raw ranges)`);

// wide view covering both clusters: one merged draw per visible leaf
calls.length = 0;
g.setCamera(0, -50000, 10, 0, 0);
g.beginFrame();
g.renderScene(scene);
const both = countDraws();
ok(both === 2, `wide view draws both leaves as ${both} merged draws (60 raw ranges)`);

// tilted camera (pitch 60 deg, looking north): cluster B is behind the near
// plane and must be culled; cluster A at the target stays visible
calls.length = 0;
g.setCamera(0, 0, 2560, 0, Math.PI / 3);
g.beginFrame();
g.renderScene(scene);
const tilted = countDraws();
ok(tilted === 1, `tilted view culls the behind-camera cluster: ${tilted} draw`);

// paint order: later commands must get SMALLER z (win under LEQUAL)
SceneGraph.keepData = true;
calls.length = 0;
g.beginFrame();
g.beginRecord();
g.fillPolygon([[[0, 0], [100, 0], [100, 100], [0, 100]]], [], { color: [1, 0, 0, 1] }); // bottom
g.fillPolygon([[[50, 50], [150, 50], [150, 150], [50, 150]]], [], { color: [0, 0, 1, 1] }); // top
const scene2 = g.finishScene();
const rootData = scene2.root.data!;
ok(rootData !== null && rootData.length > 0, "scene data retained for z-order check");
const zFirst = rootData[9]; // zord of first vertex of first command (stride 10)
const zSecond = rootData[6 * 10 + 9]; // first vertex of second command
ok(
  zSecond < zFirst,
  `paint order via depth: later command z ${zSecond.toFixed(4)} < earlier ${zFirst.toFixed(4)}`,
);
SceneGraph.keepData = false;

// wireframe mode draws LINES from the line buffer
calls.length = 0;
g.wireframe = true;
g.setCamera(0, 50, 2000, 0, 0);
g.beginFrame();
g.renderScene(scene2);
ok(
  calls.some((c) => c.startsWith("drawArrays")),
  `wireframe mode issues line draws (${calls.filter((c) => c.startsWith("drawArrays")).length} drawArrays)`,
);
g.wireframe = false;

if (failures > 0) {
  console.error(`${failures} scene graph test(s) FAILED`);
  process.exit(1);
}
console.log("all scene graph tests passed");
