import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config';
import { getMaterials } from '../world/materials';

const OUTFITS = [
  0x8c3b3b, 0x3b5a8c, 0x3f7046, 0x8c7a3b, 0x5d4a7a, 0x777777, 0x2f4f5f, 0xa06030, 0x374151, 0x9a4f6e,
].map((c) => new THREE.Color(c));

interface WalkLine {
  pts: THREE.Vector3[];
  cum: number[];
  len: number;
  tile: string;
}

interface Ped {
  line: WalkLine | null;
  d: number;
  sign: number;
  speed: number;
  phase: number;
}

let bodyGeo: THREE.BufferGeometry | undefined;

function getBodyGeometry(): THREE.BufferGeometry {
  if (bodyGeo) return bodyGeo;
  const torso = new THREE.CapsuleGeometry(0.17, 0.62, 3, 8);
  torso.translate(0, 0.95, 0);
  const head = new THREE.SphereGeometry(0.115, 8, 8);
  head.translate(0, 1.52, 0);
  torso.deleteAttribute('uv');
  head.deleteAttribute('uv');
  // vertex colors: torso = white (tinted per instance), head = skin
  const paint = (g: THREE.BufferGeometry, r: number, gr: number, b: number) => {
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = r;
      col[i * 3 + 1] = gr;
      col[i * 3 + 2] = b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  };
  paint(torso, 1, 1, 1);
  paint(head, 0.98, 0.8, 0.66);
  bodyGeo = mergeGeometries([torso, head], false)!;
  bodyGeo.userData.shared = true;
  torso.dispose();
  head.dispose();
  return bodyGeo;
}

/** Pedestrians stroll along sidewalks and footpaths, bouncing at line ends. */
export class PedestrianSystem {
  mesh: THREE.InstancedMesh;
  private lines: WalkLine[] = [];
  private peds: Ped[] = [];
  private time = 0;
  // 8m grid of active pedestrian positions, rebuilt every update —
  // vehicles query it for "someone on the zebra ahead?"
  private posCells = new Map<string, number[]>();
  private tmpPos = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private zero = new THREE.Vector3(0, 0, 0);
  private one = new THREE.Vector3(1, 1, 1);

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.InstancedMesh(getBodyGeometry(), getMaterials().person, CONFIG.maxPedestrians);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    const c = new THREE.Color();
    for (let i = 0; i < CONFIG.maxPedestrians; i++) {
      this.peds.push({
        line: null,
        d: 0,
        sign: 1,
        speed: 1.1 + Math.random() * 0.7,
        phase: Math.random() * 6.28,
      });
      // tint towards the outfit color but keep head skin-colored-ish (multiply is approximate)
      this.mesh.setColorAt(i, c.copy(OUTFITS[i % OUTFITS.length]));
      this.tmpM.compose(this.zero, this.tmpQ.identity(), this.zero);
      this.mesh.setMatrixAt(i, this.tmpM);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    scene.add(this.mesh);
  }

  addTile(tile: string, walkable: THREE.Vector3[][]): void {
    for (const pts of walkable) {
      if (pts.length < 2) continue;
      const cum: number[] = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const len = cum[cum.length - 1];
      if (len < 12) continue;
      this.lines.push({ pts, cum, len, tile });
    }
  }

  removeTile(tile: string): void {
    this.lines = this.lines.filter((l) => l.tile !== tile);
    for (const p of this.peds) {
      if (p.line && p.line.tile === tile) p.line = null;
    }
  }

  reset(): void {
    this.lines = [];
    for (const p of this.peds) p.line = null;
  }

  /** Any pedestrian within `r` of (x,z)? Positions are from the last update. */
  anyNear(x: number, z: number, r: number): boolean {
    const r2 = r * r;
    for (let cx = Math.floor((x - r) / 8); cx <= Math.floor((x + r) / 8); cx++) {
      for (let cz = Math.floor((z - r) / 8); cz <= Math.floor((z + r) / 8); cz++) {
        const cell = this.posCells.get(`${cx},${cz}`);
        if (!cell) continue;
        for (let i = 0; i < cell.length; i += 2) {
          const dx = cell[i] - x;
          const dz = cell[i + 1] - z;
          if (dx * dx + dz * dz < r2) return true;
        }
      }
    }
    return false;
  }

  update(dt: number, camPos: THREE.Vector3): void {
    this.time += dt;
    this.posCells.clear();
    const target = Math.min(CONFIG.maxPedestrians, this.lines.length * 2);

    let active = 0;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];

      if (p.line) {
        this.posAt(p.line, p.d, this.tmpPos);
        if (this.tmpPos.distanceTo(camPos) > CONFIG.vehicleDespawnRadius) p.line = null;
      }

      if (!p.line && active < target && this.lines.length > 0) {
        // try a few random lines near the camera
        for (let t = 0; t < 4 && !p.line; t++) {
          const l = this.lines[Math.floor(Math.random() * this.lines.length)];
          const mid = l.pts[Math.floor(l.pts.length / 2)];
          if (mid.distanceTo(camPos) < CONFIG.vehicleSpawnRadius) {
            p.line = l;
            p.d = Math.random() * l.len;
            p.sign = Math.random() < 0.5 ? 1 : -1;
          }
        }
      }

      if (!p.line) {
        this.tmpM.compose(this.zero, this.tmpQ.identity(), this.zero);
        this.mesh.setMatrixAt(i, this.tmpM);
        continue;
      }
      active++;

      p.d += p.speed * p.sign * dt;
      if (p.d <= 0 || p.d >= p.line.len) {
        p.sign = -p.sign;
        p.d = Math.min(Math.max(p.d, 0), p.line.len);
      }

      this.posAt(p.line, p.d, this.tmpPos);
      const ck = `${Math.floor(this.tmpPos.x / 8)},${Math.floor(this.tmpPos.z / 8)}`;
      let cell = this.posCells.get(ck);
      if (!cell) {
        cell = [];
        this.posCells.set(ck, cell);
      }
      cell.push(this.tmpPos.x, this.tmpPos.z);
      this.tmpPos.y += 0.03 + Math.abs(Math.sin(this.time * 7 + p.phase)) * 0.05;
      const yaw = this.headingAt(p.line, p.d, p.sign);
      this.tmpQ.setFromAxisAngle(this.up, yaw);
      this.tmpM.compose(this.tmpPos, this.tmpQ, this.one);
      this.mesh.setMatrixAt(i, this.tmpM);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private posAt(l: WalkLine, d: number, out: THREE.Vector3): void {
    const dd = Math.min(Math.max(d, 0), l.len);
    let i = 1;
    while (i < l.cum.length - 1 && l.cum[i] < dd) i++;
    const segLen = l.cum[i] - l.cum[i - 1];
    const t = segLen > 1e-6 ? (dd - l.cum[i - 1]) / segLen : 0;
    out.copy(l.pts[i - 1]).lerp(l.pts[i], t);
  }

  private headingAt(l: WalkLine, d: number, sign: number): number {
    const dd = Math.min(Math.max(d, 0), l.len);
    let i = 1;
    while (i < l.cum.length - 1 && l.cum[i] < dd) i++;
    const dx = (l.pts[i].x - l.pts[i - 1].x) * sign;
    const dz = (l.pts[i].z - l.pts[i - 1].z) * sign;
    // rotY θ maps +z forward to (sinθ, 0, cosθ) => θ = atan2(dx, dz)
    return Math.atan2(dx, dz);
  }
}
