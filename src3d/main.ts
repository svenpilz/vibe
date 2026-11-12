/**
 * heightfield POC: 3D OpenStreetMap around S Friedenau, Berlin.
 * Mouse orbits the scene (OrbitControls), a small car can be driven on the
 * road network with WASD/arrows — including under bridges, because every
 * road deck sits at its real OSM layer elevation above the SRTM terrain.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { BakedData } from "./schema";
import { sampleTerrainM, wayTags } from "./schema";
import { lonLatToMeters } from "./geo";
import { buildTerrainMesh, buildRoads, buildBuildings, buildGround, buildLaneMarkings, buildKerbs, buildFurniture, buildRails, buildRoutes, RouteTrack, RoadIndex, BuildingIndex, buildingPolygons, type MeshData } from "./mesh";

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
const SKY = new THREE.Color(0xbcd8ec);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 3500, 9000);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 20000);
camera.position.set(1600, 1100, 1600);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495;
controls.maxDistance = 9000;
controls.minDistance = 5;

scene.add(new THREE.HemisphereLight(0xffffff, 0xa8b898, 1.25));
const sun = new THREE.DirectionalLight(0xfff3e0, 1.5);
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
  g.setAttribute("uv", new THREE.Float32BufferAttribute(m.uvs, 2));
  g.setIndex(m.indices);
  return g;
}

/** Procedural facade texture: window grid, a few lit windows. Tinted per
 *  building by the vertex colors (map * color). */
function makeFacadeTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 128, 256);
  const cols = 4, rows = 8, wx = 128 / cols, wy = 256 / rows;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const lit = Math.random() < 0.12;
      ctx.fillStyle = lit ? "#ffd97a" : "#2c3844";
      ctx.fillRect(col * wx + wx * 0.22, r * wy + wy * 0.25, wx * 0.56, wy * 0.5);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function addMesh(m: MeshData, shadow: boolean, mat?: THREE.Material): void {
  const material = mat ?? new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(toGeometry(m), material);
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
  addMesh(buildLaneMarkings(data, roads.segments), false);
  addMesh(buildKerbs(data), false);
  addMesh(buildFurniture(data), false);
  addMesh(buildRails(data), false);
  addMesh(buildRoutes(data), false);
  const facadeMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, map: makeFacadeTexture() });
  addMesh(buildBuildings(data), true, facadeMat);
  const index = new RoadIndex(roads.segments);
  const buildings = new BuildingIndex(buildingPolygons(data));
  hud.loading.textContent = "";
  hud.stats.textContent =
    `${data.ways.length.toLocaleString("en-US")} ways · ${data.points.length.toLocaleString("en-US")} street objects · ` +
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
  let driverView = false;
  window.addEventListener("keydown", (e) => {
    keys.add(e.code);
    if (e.code === "KeyC") { follow = !follow; driverView = false; }
    if (e.code === "KeyV") { driverView = !driverView; follow = false; }
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

  // buses and S-Bahn trains driving their OSM route relations
  interface Vehicle {
    track: RouteTrack;
    dist: number;
    speed: number;
    mesh: THREE.Group;
  }
  const vehicles: Vehicle[] = [];
  const routeTracks = data.routes
    .map((route) => {
      const pts = route.r.map((r) => {
        const lon = (data.nodes[r * 2] as number) / 1e7;
        const lat = (data.nodes[r * 2 + 1] as number) / 1e7;
        return [lon, lat] as [number, number];
      });
      const xy = pts.map(([lon, lat]) => lonLatToMeters(lon, lat));
      const elevs = xy.map(([x, y]) => sampleTerrainM(data.terrain, x, y) + 0.18);
      return { tags: wayTags(data, route), track: new RouteTrack(xy, elevs) };
    })
    .filter((r) => r.track.length > 800)
    .sort((a, b) => b.track.length - a.track.length);
  const makeBus = (): THREE.Group => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.6, 10), new THREE.MeshLambertMaterial({ color: 0xf5b81d }));
    body.position.y = 1.5;
    body.castShadow = true;
    const windows = new THREE.Mesh(new THREE.BoxGeometry(2.52, 0.9, 9), new THREE.MeshLambertMaterial({ color: 0x1d2733 }));
    windows.position.y = 2.0;
    g.add(body, windows);
    return g;
  };
  const makeTrain = (): THREE.Group => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.9, 3.2, 38), new THREE.MeshLambertMaterial({ color: 0xf5b81d }));
    body.position.y = 1.9;
    body.castShadow = true;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.92, 0.5, 37), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    stripe.position.y = 2.6;
    const windows = new THREE.Mesh(new THREE.BoxGeometry(2.92, 0.8, 36), new THREE.MeshLambertMaterial({ color: 0x1d2733 }));
    windows.position.y = 3.1;
    g.add(body, stripe, windows);
    return g;
  };
  let buses = 0, trains = 0;
  for (const r of routeTracks) {
    const isTrain = r.tags["route"] === "train" || r.tags["route"] === "light_rail";
    if (isTrain && trains >= 2) continue;
    if (!isTrain && buses >= 5) continue;
    const mesh = isTrain ? makeTrain() : makeBus();
    scene.add(mesh);
    vehicles.push({ track: r.track, dist: Math.random() * r.track.length, speed: isTrain ? 22 : 11, mesh });
    if (isTrain) trains++;
    else buses++;
  }

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

    if (buildings.collides(nx, nz, 1.0)) {
      nx = carState.x;
      nz = carState.z;
      carState.speed *= -0.3;
    }
    const q = index.nearest(nx, nz, 80, carState.y);
    const onRoad = q !== undefined && q.dist <= q.halfW + 0.95;
    if (onRoad && q) {
      carState.y = q.elev;
    } else {
      // off-road: follow the bare-earth terrain, with extra drag
      carState.y = sampleTerrainM(data.terrain, nx, nz);
      carState.speed *= Math.max(0, 1 - 1.8 * dt);
    }
    carState.x = nx;
    carState.z = nz;

    car.position.set(carState.x, carState.y, carState.z);
    car.rotation.y = -carState.heading + Math.PI / 2;
    const qf = index.nearest(carState.x + Math.cos(carState.heading) * 2.1, carState.z + Math.sin(carState.heading) * 2.1, 30, carState.y);
    const qb = index.nearest(carState.x - Math.cos(carState.heading) * 2.1, carState.z - Math.sin(carState.heading) * 2.1, 30, carState.y);
    if (qf && qb) car.rotation.x = Math.atan2(qb.elev - qf.elev, 4.2);
    const ql = index.nearest(carState.x - Math.sin(carState.heading) * 1, carState.z + Math.cos(carState.heading) * 1, 30, carState.y);
    const qr = index.nearest(carState.x + Math.sin(carState.heading) * 1, carState.z - Math.cos(carState.heading) * 1, 30, carState.y);
    if (ql && qr) car.rotation.z = Math.atan2(ql.elev - qr.elev, 2);
  }

  function animate(): void {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, clock.getDelta());
    updateCar(dt);
    for (const v of vehicles) {
      v.dist += v.speed * dt;
      const p = v.track.pointAt(v.dist);
      v.mesh.position.set(p.x, p.elev, p.z);
      v.mesh.rotation.y = -p.heading + Math.PI / 2;
    }
    if (driverView) {
      // first-person driver view: eye height in the car, looking along heading
      controls.enabled = false;
      const eye = 1.62;
      const fx = Math.cos(carState.heading);
      const fz = Math.sin(carState.heading);
      const qf = index.nearest(carState.x + fx * 2.1, carState.z + fz * 2.1, 30, carState.y);
      const qb = index.nearest(carState.x - fx * 2.1, carState.z - fz * 2.1, 30, carState.y);
      const pitch = qf && qb ? Math.atan2(qb.elev - qf.elev, 4.2) : 0;
      camera.position.set(carState.x, carState.y + eye, carState.z);
      camera.rotation.set(0, 0, 0);
      camera.rotateY(-carState.heading + Math.PI / 2);
      camera.rotateX(-pitch);
    } else {
      controls.enabled = true;
    }
    if (follow && !driverView) {
      controls.target.lerp(new THREE.Vector3(carState.x, carState.y + 1.5, carState.z), Math.min(1, dt * 5));
    }
    controls.update();
    renderer.render(scene, camera);
    hudTimer += dt;
    if (hudTimer > 0.25) {
      hudTimer = 0;
      const kmh = Math.round(Math.abs(carState.speed) * 3.6);
      const q = index.nearest(carState.x, carState.z, 30, carState.y);
      hud.status.textContent =
        `${kmh} km/h · ${carState.y.toFixed(1)} m a.s.l.` +
        (q ? ` · layer ${q.layer} road` : " · off road") +
        ` · ${driverView ? "driver view (V)" : follow ? "chase cam (C)" : "free cam (C)"} · R reset · commit ${__COMMIT__}`;
    }
  }
  animate();

  // debug/screenshot handle
  (window as unknown as Record<string, unknown>).__vibe = { camera, controls, carState, index, data, scene, renderer };

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
