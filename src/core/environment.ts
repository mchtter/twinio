import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CONFIG } from '../config';
import { getMaterials } from '../world/materials';

/** Sky, sun/moon lighting, fog, shadows and the day/night cycle.
 * Also drives a small pool of real point lights for the nearest street lamps. */
export class Environment {
  private sky: Sky;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private sunTarget = new THREE.Object3D();
  private lampLights: THREE.PointLight[] = [];
  private lampTimer = 0;
  hour = 13;
  isNight = false;

  constructor(
    private scene: THREE.Scene,
    private renderer: THREE.WebGLRenderer,
  ) {
    this.sky = new Sky();
    this.sky.scale.setScalar(45000);
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(CONFIG.shadowMapSize, CONFIG.shadowMapSize);
    const r = CONFIG.shadowRange;
    this.sun.shadow.camera.left = -r;
    this.sun.shadow.camera.right = r;
    this.sun.shadow.camera.top = r;
    this.sun.shadow.camera.bottom = -r;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 1000;
    this.sun.shadow.bias = -0.0004;
    scene.add(this.sun, this.sunTarget);
    this.sun.target = this.sunTarget;

    this.hemi = new THREE.HemisphereLight(0xbdd3ea, 0x4a4a40, 0.7);
    scene.add(this.hemi);

    scene.fog = new THREE.Fog(0xcfd8e2, CONFIG.fogNear, CONFIG.fogFar);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    for (let i = 0; i < 8; i++) {
      const pl = new THREE.PointLight(0xffd9a0, 0, 28, 2);
      scene.add(pl);
      this.lampLights.push(pl);
    }

    this.setHour(this.hour);
  }

  setHour(hour: number): void {
    this.hour = hour;
    // sun elevation: day between ~06:00 and ~19:00
    const dayT = (hour - 6) / 13;
    const elev = Math.sin(Math.PI * dayT) * 62;
    const azim = 120 + dayT * 120; // east → west sweep
    this.isNight = elev < 3;

    const phi = THREE.MathUtils.degToRad(90 - elev);
    const theta = THREE.MathUtils.degToRad(azim);
    const sunPos = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    const u = this.sky.material.uniforms;
    u['sunPosition'].value.copy(sunPos);
    u['turbidity'].value = this.isNight ? 2 : 6;
    u['rayleigh'].value = this.isNight ? 0.12 : elev < 12 ? 2.6 : 1.4;
    u['mieCoefficient'].value = this.isNight ? 0.002 : 0.004;
    u['mieDirectionalG'].value = 0.8;

    this.sunDir.copy(sunPos);
    this.sun.intensity = this.isNight ? 0 : Math.min(elev / 18, 1) * 2.6;
    this.sun.castShadow = !this.isNight;
    this.hemi.intensity = this.isNight ? 0.09 : 0.7 + Math.min(elev / 25, 1) * 0.6;
    this.renderer.toneMappingExposure = this.isNight ? 0.22 : elev < 12 ? 0.5 : 0.78;

    const fog = this.scene.fog as THREE.Fog;
    fog.color.set(this.isNight ? 0x0a0d15 : elev < 12 ? 0xd9c1a8 : 0xcfd8e2);

    // emissive city lights
    const mats = getMaterials();
    mats.wall.emissiveIntensity = this.isNight ? 1.6 : 0;
    mats.lampHead.emissiveIntensity = this.isNight ? 2.4 : 0;
  }

  private sunDir = new THREE.Vector3(0, 1, 0);

  /** Follow the camera with the shadow frustum; refresh nearest lamp lights. */
  update(dt: number, camPos: THREE.Vector3, lampHeads: () => IterableIterator<THREE.Vector3>): void {
    // snap to a grid to avoid shadow shimmer
    const sx = Math.round(camPos.x / 20) * 20;
    const sz = Math.round(camPos.z / 20) * 20;
    this.sunTarget.position.set(sx, 0, sz);
    this.sun.position.copy(this.sunDir).multiplyScalar(500).add(this.sunTarget.position);

    this.lampTimer -= dt;
    if (this.lampTimer <= 0) {
      this.lampTimer = 0.7;
      if (this.isNight) {
        // pick nearest lamp heads for the point-light pool
        const nearest: { d: number; p: THREE.Vector3 }[] = [];
        for (const h of lampHeads()) {
          const d = h.distanceToSquared(camPos);
          if (d > 90 * 90) continue;
          nearest.push({ d, p: h });
        }
        nearest.sort((a, b) => a.d - b.d);
        for (let i = 0; i < this.lampLights.length; i++) {
          const pl = this.lampLights[i];
          if (i < nearest.length) {
            pl.position.copy(nearest[i].p);
            pl.position.y -= 0.3;
            pl.intensity = 55;
          } else {
            pl.intensity = 0;
          }
        }
      } else {
        for (const pl of this.lampLights) pl.intensity = 0;
      }
    }
  }
}
