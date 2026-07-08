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
import { renderInspectorHtml } from './ui/inspector';
import { TrafficFibers } from './scenario/trafficFlow';
import { InfraLayer } from './scenario/infrastructure';
import { EarthquakeScenario, RISK_BANDS } from './scenario/earthquake';
import { setHoloLook } from './world/materials';
import type { ScenarioName } from './ui/hud';

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

// ---------- scenarios (data overlays + simulations) ----------
const fibers = new TrafficFibers(scene);
const infra = new InfraLayer(scene);
const quake = new EarthquakeScenario(scene);
let activeScenario: ScenarioName | null = null;

const SCENARIO_TOASTS: Record<ScenarioName, string> = {
  traffic: 'Trafik yoğunluğu: fiber hızı = araç hızı, renk = akıcılık (camgöbeği→kırmızı)',
  infra: 'Altyapı: su (mavi) + kanalizasyon (yeşil, yokuş aşağı) cadde ağından türetilmiş TAHMİNİ şebeke; pipeline/rögar/hidrant gerçek OSM verisi',
  quake: 'Deprem senaryosu: binalar risk durumuna göre boyanır (mavi=çok düşük → kırmızı=çok yüksek; start_date varsa yaş belirler). Riskli binalar daha sık çöker; yıkılanlar soluk silüet bırakır, enkaz yolları kapatabilir. Çıkınca şehir eski haline döner',
};

function setScenario(name: ScenarioName | null): void {
  if (name === activeScenario) return;
  const prev = activeScenario;
  activeScenario = name;
  // hologram look belongs to the data-overlay scenarios; the quake plays in daylight
  const holo = name === 'traffic' || name === 'infra';
  if (holo !== (prev === 'traffic' || prev === 'infra')) {
    setHoloLook(holo);
    env.setHolo(holo);
    terrain.setHolo(holo);
  }
  fibers.setActive(name === 'traffic');
  infra.setActive(name === 'infra');
  if (prev === 'quake') {
    quake.stop(world, graph);
    hud.setScenarioReport('', null);
  }
  if (name === 'quake') quake.start(world, graph, lookFocus(), terrain.sampleOriginal);
  hud.showToast(name ? SCENARIO_TOASTS[name] : 'Senaryo kapatıldı', 7000);
}

/** Ground point the camera looks at — scenarios act on what the USER sees,
 * not on the camera's own (often far-behind) position. */
function lookFocus(): THREE.Vector3 {
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const rc = new THREE.Raycaster(camera.position.clone(), dir);
  const hit = rc.intersectObjects(terrain.group.children, false)[0];
  return hit ? hit.point : camera.position;
}

function quakeReportHtml(): string {
  const r = quake.report();
  const pct = r.scanned > 0 ? Math.round((r.victims / r.scanned) * 100) : 0;
  // legend runs highest → lowest risk, matching the "danger first" reading
  const legend = [...RISK_BANDS.keys()]
    .reverse()
    .map(
      (i) =>
        `<span style="white-space:nowrap" title="${RISK_BANDS[i].label}">` +
        `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;` +
        `background:${RISK_BANDS[i].css};margin:0 3px 0 7px"></span>${r.bands[i]}</span>`,
    )
    .join('');
  return (
    `<div>Sarsıntı: <b>${r.shaking ? 'sürüyor' : 'bitti'}</b></div>` +
    `<div>Taranan bina: <b>${r.scanned}</b> <span class="dim">(yapım yılı verili: ${r.dated})</span></div>` +
    `<div>Risk dağılımı:${legend}</div>` +
    `<div class="dim">kırmızı=çok yüksek → mavi=çok düşük · yıkılan soluk silüet kalır</div>` +
    `<div>Yıkılan: <b>${r.fallen}/${r.victims}</b> <span class="dim">(%${pct} — yaş kuralı ${r.byAge} · rastgele ${r.byChance})</span></div>` +
    `<div>Kapanan yol: <b>${r.blockedEdges} kesim</b> <span class="dim">· ~${Math.round(r.blockedMeters)} m</span></div>` +
    (r.dated === 0
      ? `<div class="dim" style="margin-top:4px">Bu bölgede OSM'de yapım yılı (start_date) verisi yok — risk, yükseklik + kararlı gürültüyle tahmin edildi</div>`
      : '')
  );
}

const hud = new Hud({
  onHourChange: (h) => env.setHour(h),
  onLayerToggle: (cat, visible) => {
    if (cat === 'vehicles') {
      vehicles.mesh.visible = visible;
      world.setLayerVisible(cat, visible); // parked cars live in tile groups
    } else if (cat === 'pedestrians') pedestrians.mesh.visible = visible;
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
  onScenarioSelect: (name) => setScenario(name),
  onInspectorClose: () => {
    marker.visible = false;
  },
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

// ---------- click-to-inspect (debug modal) ----------
const marker = (() => {
  const g = new THREE.RingGeometry(1.1, 1.6, 32);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(
    g,
    new THREE.MeshBasicMaterial({ color: 0xffd479, transparent: true, opacity: 0.9, depthTest: false }),
  );
  m.renderOrder = 999;
  m.visible = false;
  scene.add(m);
  return m;
})();

const raycaster = new THREE.Raycaster();

function catOf(o: THREE.Object3D | null): string | undefined {
  while (o) {
    if (o.userData.cat) return o.userData.cat as string;
    if (o.name.startsWith('terrain')) return 'terrain';
    o = o.parent;
  }
  return undefined;
}

function chainVisible(o: THREE.Object3D | null): boolean {
  while (o) {
    if (!o.visible) return false;
    o = o.parent;
  }
  return true;
}

function inspectAt(cx: number, cy: number): void {
  const ndc = new THREE.Vector2((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  for (const hit of raycaster.intersectObjects(scene.children, true)) {
    if (hit.object === marker || !chainVisible(hit.object)) continue;
    const cat = catOf(hit.object);
    if (!cat) continue;
    const p = hit.point;
    const geo = proj.toGeo(p.x, p.z);
    const vehicle =
      cat === 'vehicles' && hit.object === vehicles.mesh && hit.instanceId !== undefined
        ? vehicles.carInfo(hit.instanceId)
        : null;
    const res = world.features.query(p.x, p.z);
    hud.showInspector(
      renderInspectorHtml(res, {
        lat: geo.lat, lon: geo.lon, x: p.x, z: p.z,
        terrain: terrain.sample(p.x, p.z), cat, vehicle,
      }),
    );
    marker.position.set(p.x, p.y + 0.4, p.z);
    marker.visible = true;
    return;
  }
}

// a click is a press+release without drag (iso mode keeps the cursor free)
let downX = 0;
let downY = 0;
let downOk = false;
renderer.domElement.addEventListener('mousedown', (e) => {
  downOk = e.button === 0;
  downX = e.clientX;
  downY = e.clientY;
});
renderer.domElement.addEventListener('mouseup', (e) => {
  if (!downOk || e.button !== 0 || controls.isLocked) return;
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return;
  inspectAt(e.clientX, e.clientY);
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
const shakeTmp = new THREE.Vector3();
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
    // pedestrians first: vehicles query their fresh position grid for zebras
    pedestrians.update(dt, camera.position);
    vehicles.update(
      dt, camera.position, graph,
      (p, d) => world.redSignalAhead(p, d, simTime),
      (p, d) => world.pedCrossingAhead(p, d, (x, z, r) => pedestrians.anyNear(x, z, r)),
    );
    for (const s of world.signalSets()) s.update(simTime);
    if (activeScenario === 'traffic') fibers.update(dt, graph, (out) => vehicles.edgeFlows(out));
    else if (activeScenario === 'infra') infra.update(dt, graph, () => world.infraData(), terrain.sampleOriginal);
    else if (activeScenario === 'quake') quake.update(dt);
  }
  env.update(dt, camera.position, () => world.allLampHeads());

  // quake camera shake wraps the render only — controls never see the offset
  const sh = quake.shake(shakeTmp);
  camera.position.add(sh);
  renderer.render(scene, camera);
  camera.position.sub(sh);

  statTimer -= dt;
  if (statTimer <= 0) {
    if (activeScenario === 'quake') hud.setScenarioReport('🌋 Deprem Raporu', quakeReportHtml());
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
  // click-to-inspect from code (e2e + console debugging)
  inspect: (x: number, z: number) => world.features.query(x, z),
  // Faz 6 hook: live congestion feeds scale traffic here
  setTrafficDensity: (f: number) => vehicles.setDensity(f),
  quakeDebug: () => quake.report(),
  // raw scenario object (e2e probes poke at private fields at runtime)
  quakeObj: () => quake,
  // scenario switch from code (e2e + console); keeps the HUD buttons in sync
  setScenario: (name: ScenarioName | boolean | null) => {
    const n = name === true ? 'traffic' : name === false ? null : name;
    hud.setScenario(n);
    setScenario(n);
  },
};
