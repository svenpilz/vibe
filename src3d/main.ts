/**
 * heightfield POC: 3D OpenStreetMap around S Friedenau, Berlin.
 * Mouse orbits the scene (OrbitControls), a small car can be driven on the
 * road network with WASD/arrows — including under bridges, because every
 * road deck sits at its real OSM layer elevation above the SRTM terrain.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { BakedData } from "./schema";
import { sampleTerrainM } from "./schema";
import { buildTerrainMesh, buildRoads, buildBuildings, buildGround, RoadIndex, type MeshData } from "./mesh";

const container = document.getElementById("scene") as HTMLElement;
const hud = {
  stats: document.getElementById("stats") as HTMLElement,
  status: document.getElementById("status") as HTMLElement,
  loading: document.getElementById("loading") as HTMLElement,
};

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0x9fc4e8);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 3000, 8000);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 20000);
camera.position.set(1600, 1100, 1600);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;
controls.maxDistance = 9000;
controls.minDistance = 5;

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9a7a, 1.0));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
sun.position.set(2500, 3500, 1200);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const SC = 2600;
sun.shadow.camera.left = -SC;
sun.shadow.camera.right = SC;
sun.shadow.camera.top = SC;
sun.shadow.camera.bottom = -SC;
sun.shadow.camera.far = 12000;
sun.shadow.bias = -0.0005;
scene.add(sun);

function toGeometry(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(m.positions, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(m.normals, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(m.colors, 3));
  g.setIndex(m.indices);
  return g;
}

function addMesh(m: MeshData, shadow: boolean): void {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(toGeometry(m), mat);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

interface CarState {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  steer: number;
}

function makeCar(): THREE.Group {
  const car = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xc8322b });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 4.2), bodyMat);
  body.position.y = 0.62;
  body.castShadow = true;
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.5, 2.0),
    new THREE.MeshLambertMaterial({ color: 0x223344 })
  );
  cabin.position.set(0, 1.12, -0.2);
  cabin.castShadow = true;
  car.add(body, cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
  for (const [wx, wz] of [
    [-0.85, 1.4],
    [0.85, 1.4],
    [-0.85, -1.4],
    [0.85, -1.4],
  ] as const) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.position.set(wx, 0.34, wz);
    car.add(w);
  }
  return car;
}

async function boot(): Promise<void> {
  hud.loading.textContent = "loading OSM + terrain data…";
  const res = await fetch("data/friedenau-2km.json");
  const data: BakedData = await res.json();

  const t0 = performance.now();
  addMesh(buildTerrainMesh(data.terrain), false);
  addMesh(buildGround(data), false);
  const roads = buildRoads(data);
  addMesh(roads.mesh, false);
  addMesh(buildBuildings(data), true);
  const index = new RoadIndex(roads.segments);
  hud.loading.textContent = "";
  hud.stats.textContent =
    `${data.ways.length.toLocaleString("en-US")} ways · ` +
    `${roads.segments.length.toLocaleString("en-US")} road segments · ` +
    `2 km around S Friedenau · built in ${(performance.now() - t0).toFixed(0)} ms`;

  const centerH = sampleTerrainM(data.terrain, 0, 0);
  controls.target.set(0, centerH + 2, 0);

  // spawn the car on the widest nearby ground-level road
  let spawn: { x: number; y: number; z: number; heading: number } | undefined;
  let bestW = -1;
  for (const s of roads.segments) {
    const mx = (s.ax + s.bx) / 2;
    const my = (s.ay + s.by) / 2;
    if (mx * mx + my * my > 500 * 500) continue;
    if (s.layer !== 0) continue;
    if (s.halfW > bestW) {
      bestW = s.halfW;
      spawn = { x: mx, y: s.elevA, z: my, heading: Math.atan2(s.by - s.ay, s.bx - s.ax) };
    }
  }
  const carState: CarState = {
    x: spawn?.x ?? 0,
    y: spawn?.y ?? centerH,
    z: spawn?.z ?? 0,
    heading: spawn?.heading ?? 0,
    speed: 0,
    steer: 0,
  };
  const car = makeCar();
  scene.add(car);

  const keys = new Set<string>();
  let follow = true;
  window.addEventListener("keydown", (e) => {
    keys.add(e.code);
    if (e.code === "KeyC") follow = !follow;
    if (e.code === "KeyR" && spawn) {
      carState.x = spawn.x;
      carState.y = spawn.y;
      carState.z = spawn.z;
      carState.heading = spawn.heading;
      carState.speed = 0;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));

  const clock = new THREE.Clock();
  let hudTimer = 0;

  function updateCar(dt: number): void {
    const up = keys.has("KeyW") || keys.has("ArrowUp");
    const down = keys.has("KeyS") || keys.has("ArrowDown");
    const left = keys.has("KeyA") || keys.has("ArrowLeft");
    const right = keys.has("KeyD") || keys.has("ArrowRight");
    const accel = up ? 9 : down ? -7 : 0;
    carState.speed += accel * dt;
    carState.speed -= carState.speed * 0.55 * dt + Math.sign(carState.speed) * 1.2 * dt;
    carState.speed = Math.max(-8, Math.min(28, carState.speed));
    if (!up && !down && Math.abs(carState.speed) < 0.4) carState.speed = 0;

    const steerTarget = (left ? 1 : 0) - (right ? 1 : 0);
    carState.steer += (steerTarget * 0.55 - carState.steer) * Math.min(1, dt * 8);
    if (Math.abs(carState.speed) > 0.05) {
      carState.heading += (carState.speed / 2.8) * Math.tan(carState.steer) * dt;
    }

    let nx = carState.x + Math.cos(carState.heading) * carState.speed * dt;
    let nz = carState.z + Math.sin(carState.heading) * carState.speed * dt;

    const q = index.nearest(nx, nz, 80);
    if (q) {
      const allowed = q.halfW + 0.95;
      if (q.dist > allowed) {
        const abx = q.seg.bx - q.seg.ax;
        const aby = q.seg.by - q.seg.ay;
        const len = Math.hypot(abx, aby) || 1;
        const px = q.seg.ax + abx * q.t;
        const py = q.seg.ay + aby * q.t;
        let ox = nx - px;
        let oy = nz - py;
        const ol = Math.hypot(ox, oy) || 1;
        ox /= ol;
        oy /= ol;
        nx = px + ox * allowed;
        nz = py + oy * allowed;
        carState.speed *= 0.55;
      }
      carState.y = q.elev;
    } else {
      carState.y = sampleTerrainM(data.terrain, nx, nz);
    }
    carState.x = nx;
    carState.z = nz;

    car.position.set(carState.x, carState.y, carState.z);
    car.rotation.y = -carState.heading + Math.PI / 2;
    const qf = index.nearest(carState.x + Math.cos(carState.heading) * 2.1, carState.z + Math.sin(carState.heading) * 2.1, 30);
    const qb = index.nearest(carState.x - Math.cos(carState.heading) * 2.1, carState.z - Math.sin(carState.heading) * 2.1, 30);
    if (qf && qb) car.rotation.x = Math.atan2(qb.elev - qf.elev, 4.2);
    const ql = index.nearest(carState.x - Math.sin(carState.heading) * 1, carState.z + Math.cos(carState.heading) * 1, 30);
    const qr = index.nearest(carState.x + Math.sin(carState.heading) * 1, carState.z - Math.cos(carState.heading) * 1, 30);
    if (ql && qr) car.rotation.z = Math.atan2(ql.elev - qr.elev, 2);
  }

  function animate(): void {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, clock.getDelta());
    updateCar(dt);
    if (follow) {
      controls.target.lerp(new THREE.Vector3(carState.x, carState.y + 1.5, carState.z), Math.min(1, dt * 5));
    }
    controls.update();
    renderer.render(scene, camera);
    hudTimer += dt;
    if (hudTimer > 0.25) {
      hudTimer = 0;
      const kmh = Math.round(Math.abs(carState.speed) * 3.6);
      const q = index.nearest(carState.x, carState.z, 30);
      hud.status.textContent =
        `${kmh} km/h · ${carState.y.toFixed(1)} m a.s.l.` +
        (q ? ` · layer ${q.layer} road` : " · off road") +
        ` · ${follow ? "chase cam (C)" : "free cam (C)"} · R reset · commit ${__COMMIT__}`;
    }
  }
  animate();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

boot().catch((e) => {
  hud.loading.textContent = `failed to load: ${e}`;
  console.error(e);
});
