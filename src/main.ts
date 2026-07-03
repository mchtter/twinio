import * as THREE from 'three';
import { CONFIG } from './config';
import { GeoProjection } from './geo/proj';
import { ElevationManager } from './terrain/sources';
import { onOverpassRateLimit } from './data/overpass';
import { TerrainManager } from './terrain/terrain';
import { World } from './world/tileManager';
import { CollisionIndex } from './world/collision';
import { RoadGraph } from './agents/graph';
import { VehicleSystem } from './agents/vehicles';
import { PedestrianSystem } from './agents/pedestrians';
import { PlayerControls } from './core/controls';
import { Environment } from './core/environment';
import { Hud } from './ui/hud';

const params = new URLSearchParams(location.search);
const startLat = parseFloat(params.get('lat') ?? '') || CONFIG.origin.lat;
const startLon = parseFloat(params.get('lon') ?? '') || CONFIG.origin.lon;
const startHour = parseFloat(params.get('hour') ?? '') || 13;

// ---------- renderer / scene ----------
const app = document.getElementById('app')!;
// logarithmic depth: uniform ~mm depth precision at any distance — the layer
// bands (cm apart) stay separated even in far aerial views
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  logarithmicDepthBuffer: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.maxPixelRatio));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, CONFIG.cameraFar);
camera.position.set(0, 45, 0);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- engine modules ----------
let proj = new GeoProjection(startLat, startLon);
const elevation = new ElevationManager();
const terrain = new TerrainManager(scene, elevation, proj);
const graph = new RoadGraph();
const pedestrians = new PedestrianSystem(scene);
const vehicles = new VehicleSystem(scene);
const collision = new CollisionIndex();
const world = new World(scene, terrain, graph, pedestrians, collision);
const env = new Environment(scene, renderer);
const controls = new PlayerControls(camera, renderer.domElement, terrain.sample, (x, z, r) =>
  collision.resolve(x, z, r),
);

const hud = new Hud({
  onHourChange: (h) => env.setHour(h),
  onLayerToggle: (cat, visible) => {
    if (cat === 'vehicles') vehicles.mesh.visible = visible;
    else if (cat === 'pedestrians') pedestrians.mesh.visible = visible;
    else world.setLayerVisible(cat, visible);
  },
  onSearch: async (q) => {
    hud.showToast(`Aranıyor: ${q}…`);
    const hit = await hud.geocode(q);
    if (!hit) {
      hud.showToast('Sonuç bulunamadı');
      return;
    }
    hud.showToast(hit.name.split(',').slice(0, 3).join(','), 6000);
    await teleport(hit.lat, hit.lon);
  },
  onLockRequest: () => controls.requestLock(),
  onShadowToggle: (on) => {
    renderer.shadowMap.enabled = on;
    // force material refresh
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const m = o.material as THREE.Material | THREE.Material[];
        for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true;
      }
    });
  },
});

// lock overlay is only relevant in walk mode while the pointer is free
const refreshOverlay = () => hud.setLocked(!(controls.mode === 'walk' && !controls.isLocked));
controls.onLock(refreshOverlay);
controls.onUnlock(refreshOverlay);
controls.onModeChange = (m) => {
  hud.setMode(m);
  refreshOverlay();
};
hud.setMode(controls.mode);
refreshOverlay();

elevation.onSourceChange = (name) => hud.showToast(`Copernicus DEM erişilemedi → ${name} kullanılıyor`);

world.onError = (msg) => hud.showToast(msg);
onOverpassRateLimit((sec) =>
  hud.showToast(`OSM sunucusu yoğun (429) — ~${sec} sn beklenip otomatik denenecek`, Math.min(sec, 12) * 1000),
);

// ---------- boot / teleport ----------
let booted = false;

async function teleport(lat: number, lon: number): Promise<void> {
  booted = false;
  proj = new GeoProjection(lat, lon);
  world.reset();
  terrain.reset(proj);
  vehicles.reset();
  pedestrians.reset();
  await boot(lat, lon);
}

async function boot(lat: number, lon: number): Promise<void> {
  hud.showToast('Arazi yükleniyor…', 15000);
  try {
    await terrain.ensureAround(lat, lon);
  } catch (e) {
    console.error('terrain boot failed', e);
    hud.showToast('Arazi yüklenemedi — düz zeminle devam ediliyor');
  }
  controls.focus(0, 0, 300);
  world.update(lat, lon);
  hud.showToast('OSM verileri yükleniyor…', 6000);
  booted = true;
}

// ---------- main loop ----------
const clock = new THREE.Clock();
let streamTimer = 0;
let statTimer = 0;
let frames = 0;
let fps = 0;
let simTime = 0;

function loop(): void {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  simTime += dt;
  frames++;

  controls.update(dt);

  // stream tiles around the camera (throttled)
  streamTimer -= dt;
  if (booted && streamTimer <= 0) {
    streamTimer = 0.5;
    const geo = proj.toGeo(camera.position.x, camera.position.z);
    terrain.ensureAround(geo.lat, geo.lon).catch(() => {});
    world.update(geo.lat, geo.lon);
  }

  if (booted) {
    vehicles.update(dt, camera.position, graph, (p, d) => world.redSignalAhead(p, d, simTime));
    pedestrians.update(dt, camera.position);
    for (const s of world.signalSets()) s.update(simTime);
  }
  env.update(dt, camera.position, () => world.allLampHeads());

  renderer.render(scene, camera);

  statTimer -= dt;
  if (statTimer <= 0) {
    fps = frames / (0.5 - Math.min(statTimer, 0));
    frames = 0;
    statTimer = 0.5;
    const geo = proj.toGeo(camera.position.x, camera.position.z);
    hud.updateStats({
      fps,
      lat: geo.lat,
      lon: geo.lon,
      elev: camera.position.y,
      tiles: world.loadedCount,
      loading: world.isLoading ? 1 : 0,
      calls: renderer.info.render.calls,
      tris: renderer.info.render.triangles,
      dem: elevation.sourceName,
    });
  }
}

hud.setHourFromUrl(startHour);
boot(startLat, startLon);
loop();

// debug / e2e-test hook
(window as unknown as Record<string, unknown>)['__twinio'] = {
  camera,
  setHour: (h: number) => env.setHour(h),
  place: (x: number, y: number, z: number, pitch = 0, yaw = 0) => {
    controls.detachForDebug();
    camera.position.set(x, y, z);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  },
};
