import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config';
import type { RoadSpec, PoiSpec, HeightSampler } from '../types';
import { getMaterials } from './materials';
import { hashStr } from './geomUtils';
import { FootprintGrid } from './collision';

let lampPoleGeo: THREE.BufferGeometry | undefined;
let lampHeadGeo: THREE.BufferGeometry | undefined;
let signalGeo: THREE.BufferGeometry | undefined;
let bulbGeo: THREE.BufferGeometry | undefined;

function getLampGeos(): { pole: THREE.BufferGeometry; head: THREE.BufferGeometry } {
  if (!lampPoleGeo) {
    const pole = new THREE.CylinderGeometry(0.06, 0.09, 4.6, 6);
    pole.translate(0, 2.3, 0);
    const arm = new THREE.BoxGeometry(1.0, 0.07, 0.07);
    arm.translate(0.5, 4.56, 0);
    lampPoleGeo = mergeGeometries([pole, arm], false)!;
    lampPoleGeo.userData.shared = true;
    pole.dispose();
    arm.dispose();
    lampHeadGeo = new THREE.BoxGeometry(0.55, 0.13, 0.24);
    lampHeadGeo.translate(0.85, 4.5, 0);
    lampHeadGeo.userData.shared = true;
  }
  return { pole: lampPoleGeo, head: lampHeadGeo! };
}

function getSignalGeos(): { pole: THREE.BufferGeometry; bulb: THREE.BufferGeometry } {
  if (!signalGeo) {
    const pole = new THREE.CylinderGeometry(0.05, 0.07, 3.2, 6);
    pole.translate(0, 1.6, 0);
    const housing = new THREE.BoxGeometry(0.26, 0.82, 0.2);
    housing.translate(0, 3.4, 0);
    signalGeo = mergeGeometries([pole, housing], false)!;
    signalGeo.userData.shared = true;
    pole.dispose();
    housing.dispose();
    bulbGeo = new THREE.SphereGeometry(0.085, 8, 6);
    bulbGeo.userData.shared = true;
  }
  return { pole: signalGeo, bulb: bulbGeo! };
}

export interface SignalPoint {
  x: number;
  z: number;
  offset: number;
}

export interface PropsResult {
  group: THREE.Object3D | null;
  lampHeads: THREE.Vector3[];
  signals: TrafficSignalSet | null;
  signalPoints: SignalPoint[];
}

export const SIGNAL_CYCLE = 14;

/** Single source of truth for the signal phase — bulbs AND vehicles use it. */
export function signalPhase(timeSec: number, offset: number): 0 | 1 | 2 {
  const t = (timeSec + offset) % SIGNAL_CYCLE;
  return t < 6 ? 0 : t < 7.2 ? 1 : 2; // green, yellow, red
}

/** Cycles red→green phases on instanced signal bulbs; one set per tile. */
export class TrafficSignalSet {
  constructor(
    public mesh: THREE.InstancedMesh,
    private offsets: number[],
  ) {}

  update(timeSec: number): void {
    const c = new THREE.Color();
    for (let s = 0; s < this.offsets.length; s++) {
      const state = signalPhase(timeSec, this.offsets[s]);
      const colors: [number, number, number][] = [
        state === 2 ? [1, 0.1, 0.1] : [0.16, 0.05, 0.05],
        state === 1 ? [1, 0.75, 0.1] : [0.16, 0.12, 0.04],
        state === 0 ? [0.15, 1, 0.25] : [0.04, 0.14, 0.05],
      ];
      for (let k = 0; k < 3; k++) {
        this.mesh.setColorAt(s * 3 + k, c.setRGB(...colors[k]));
      }
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export function buildProps(
  roads: RoadSpec[],
  pois: PoiSpec[],
  sample: HeightSampler,
  footprints?: FootprintGrid,
): PropsResult {
  const mats = getMaterials();
  const group = new THREE.Group();
  group.userData.cat = 'props';

  // ---- street lamps: explicit OSM nodes + procedural along lit roads ----
  interface Lamp { x: number; z: number; rot: number }
  const lamps: Lamp[] = [];
  const occupied = new Set<string>();
  const gridKey = (x: number, z: number) => `${Math.round(x / 9)},${Math.round(z / 9)}`;

  const addLamp = (x: number, z: number, rot: number) => {
    if (footprints?.inside(x, z)) return; // engine rule: never inside a building
    const k = gridKey(x, z);
    if (occupied.has(k)) return;
    occupied.add(k);
    lamps.push({ x, z, rot });
  };

  for (const p of pois) {
    if (p.kind === 'lamp') addLamp(p.x, p.z, hashStr(p.id) % 6.28);
  }
  for (const r of roads) {
    if (!r.lamps || r.pts.length < 2) continue;
    let cum = 0;
    let next = CONFIG.lampSpacing * 0.5;
    let side = hashStr(r.id) % 2 === 0 ? 1 : -1;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1];
      const b = r.pts[i];
      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      if (segLen < 1e-6) continue;
      const dx = (b.x - a.x) / segLen;
      const dz = (b.z - a.z) / segLen;
      while (next <= cum + segLen) {
        const t = (next - cum) / segLen;
        const px = a.x + (b.x - a.x) * t;
        const pz = a.z + (b.z - a.z) * t;
        const off = r.width / 2 + 0.8;
        const lx = px + dz * off * side;
        const lz = pz - dx * off * side;
        // arm (+x local) must point back toward the road center:
        // rotY θ maps +x to (cosθ, 0, -sinθ)  =>  θ = atan2(-dz, dx)
        addLamp(lx, lz, Math.atan2(-(pz - lz), px - lx));
        side = -side;
        next += CONFIG.lampSpacing;
      }
      cum += segLen;
    }
  }

  const lampHeads: THREE.Vector3[] = [];
  if (lamps.length > 0) {
    const { pole, head } = getLampGeos();
    const poleMesh = new THREE.InstancedMesh(pole, mats.pole, lamps.length);
    const headMesh = new THREE.InstancedMesh(head, mats.lampHead, lamps.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < lamps.length; i++) {
      const l = lamps[i];
      const y = sample(l.x, l.z);
      q.setFromAxisAngle(up, l.rot);
      m.compose(new THREE.Vector3(l.x, y, l.z), q, one);
      poleMesh.setMatrixAt(i, m);
      headMesh.setMatrixAt(i, m);
      // head world position ≈ pole top offset toward road
      lampHeads.push(new THREE.Vector3(l.x + Math.cos(l.rot) * 0.85, y + 4.4, l.z - Math.sin(l.rot) * 0.85));
    }
    poleMesh.castShadow = true;
    poleMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
    group.add(poleMesh, headMesh);
  }

  // ---- traffic signals ----
  const signalPois = pois.filter((p) => p.kind === 'signal');
  let signals: TrafficSignalSet | null = null;
  const signalPoints: SignalPoint[] = [];
  if (signalPois.length > 0) {
    const { pole, bulb } = getSignalGeos();
    const poleMesh = new THREE.InstancedMesh(pole, mats.pole, signalPois.length);
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const bulbMesh = new THREE.InstancedMesh(bulb, bulbMat, signalPois.length * 3);
    const m = new THREE.Matrix4();
    const offsets: number[] = [];
    for (let i = 0; i < signalPois.length; i++) {
      const p = signalPois[i];
      const y = sample(p.x, p.z) + CONFIG.yRoadMajor;
      m.makeTranslation(p.x, y, p.z);
      poleMesh.setMatrixAt(i, m);
      for (let k = 0; k < 3; k++) {
        m.makeTranslation(p.x, y + 3.62 - k * 0.26, p.z + 0.13);
        bulbMesh.setMatrixAt(i * 3 + k, m);
      }
      const offset = (hashStr(p.id) % 1400) / 100;
      offsets.push(offset);
      signalPoints.push({ x: p.x, z: p.z, offset });
    }
    poleMesh.castShadow = true;
    poleMesh.instanceMatrix.needsUpdate = true;
    bulbMesh.instanceMatrix.needsUpdate = true;
    group.add(poleMesh, bulbMesh);
    signals = new TrafficSignalSet(bulbMesh, offsets);
    signals.update(0);
  }

  return { group: group.children.length > 0 ? group : null, lampHeads, signals, signalPoints };
}
