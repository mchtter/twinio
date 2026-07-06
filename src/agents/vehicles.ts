import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config';
import { getMaterials } from '../world/materials';
import { RoadGraph, GraphEdge } from './graph';

export const CAR_COLORS = [
  0xdedede, 0xb8bcc2, 0x2e3338, 0x8a1f24, 0x1f3f6e, 0x3d5a3f, 0xc7b299, 0x74797f, 0xe8e6e0, 0x50261f,
].map((c) => new THREE.Color(c));

interface Car {
  edge: GraphEdge | null;
  d: number;
  sign: number;
  speed: number;    // cruise speed for the current edge
  v: number;        // current speed
  lane: number;     // occupied/target lane (0 = rightmost)
  laneFrom: number; // source lane while a change animates
  laneT: number;    // lateral blend laneFrom→lane; 1 = settled
  think: number;    // seconds until the next lane-change consideration
}

interface Slot {
  d: number;
  sign: number;
  v: number;
  lane: number;
  laneFrom: number;
  laneT: number;
}

/** Distance to a blocking (non-green) signal ahead, or Infinity. */
export type SignalQuery = (pos: THREE.Vector3, dir: THREE.Vector3) => number;

// --- IDM (Intelligent Driver Model) — one law for leaders, red lights, zebras ---
const IDM_A = 2.5;  // max acceleration m/s²
const IDM_B = 3.0;  // comfortable deceleration
const IDM_T = 1.4;  // desired time headway s
const IDM_S0 = 2.0; // standstill jam gap m
const CAR_LEN = 4.5;
const LANE_CHANGE_TIME = 1.4;

/** IDM acceleration toward an obstacle `gap` meters ahead moving at `vLead`
 * (Infinity gap = free road). Negative result brakes; capped at -9 (emergency). */
function idmAccel(v: number, v0: number, gap: number, vLead: number): number {
  const free = 1 - Math.pow(v / Math.max(v0, 0.1), 4);
  if (!isFinite(gap)) return IDM_A * free;
  const sStar = IDM_S0 + Math.max(0, v * IDM_T + (v * (v - vLead)) / (2 * Math.sqrt(IDM_A * IDM_B)));
  return Math.max(IDM_A * (free - (sStar / Math.max(gap, 0.1)) ** 2), -9);
}

/** A car mid-change occupies BOTH lanes until it settles. */
function occupies(s: Slot, lane: number): boolean {
  return s.lane === lane || (s.laneT < 1 && s.laneFrom === lane);
}

/** Nearest car ahead of `d` (travel direction `sign`) in `lane`, as bumper gap. */
function leaderIn(slots: Slot[] | undefined, d: number, sign: number, lane: number) {
  let gap = Infinity;
  let v = 0;
  if (slots) {
    for (const s of slots) {
      if (s.sign !== sign || !occupies(s, lane)) continue;
      const g = (sign > 0 ? s.d - d : d - s.d) - CAR_LEN;
      if (g > -CAR_LEN + 0.01 && g < gap) {
        gap = g;
        v = s.v;
      }
    }
  }
  return { gap, v };
}

/** Nearest car behind `d` in `lane` — safety check before merging in front of it. */
function followerIn(slots: Slot[] | undefined, d: number, sign: number, lane: number) {
  let gap = Infinity;
  let v = 0;
  if (slots) {
    for (const s of slots) {
      if (s.sign !== sign || !occupies(s, lane)) continue;
      const g = (sign > 0 ? d - s.d : s.d - d) - CAR_LEN;
      if (g > -CAR_LEN + 0.01 && g < gap) {
        gap = g;
        v = s.v;
      }
    }
  }
  return { gap, v };
}

let carGeo: THREE.BufferGeometry | undefined;

/** Shared low-poly car geometry — moving traffic AND parked cars use it. */
export function getCarGeometry(): THREE.BufferGeometry {
  if (carGeo) return carGeo;
  const body = new THREE.BoxGeometry(1.75, 0.52, 4.0);
  body.translate(0, 0.55, 0);
  paint(body, 1, 1, 1);
  const cabin = new THREE.BoxGeometry(1.55, 0.48, 2.0);
  cabin.translate(0, 1.03, -0.1);
  paint(cabin, 0.2, 0.2, 0.22);
  body.deleteAttribute('uv');
  cabin.deleteAttribute('uv');
  carGeo = mergeGeometries([body, cabin], false)!;
  carGeo.userData.shared = true;
  body.dispose();
  cabin.dispose();
  return carGeo;
}

function paint(g: THREE.BufferGeometry, r: number, gr: number, b: number): void {
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = r;
    col[i * 3 + 1] = gr;
    col[i * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/** Simple traffic: cars roam the drivable graph, picking random turns at nodes. */
export class VehicleSystem {
  mesh: THREE.InstancedMesh;
  /** global traffic multiplier — hook for live congestion feeds (Faz 6):
   * red roads from a traffic API can push this (or per-road weights) up */
  densityScale = 1;
  private cars: Car[] = [];
  private tmpPos = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private one = new THREE.Vector3(1, 1, 1);
  private zero = new THREE.Vector3(0, 0, 0);
  private fwd = new THREE.Vector3(0, 0, 1);

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.InstancedMesh(getCarGeometry(), getMaterials().vehicle, CONFIG.maxVehicles);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = CONFIG.maxVehicles;
    const c = new THREE.Color();
    for (let i = 0; i < CONFIG.maxVehicles; i++) {
      this.cars.push({ edge: null, d: 0, sign: 1, speed: 10, v: 0, lane: 0, laneFrom: 0, laneT: 1, think: 0 });
      this.mesh.setColorAt(i, c.copy(CAR_COLORS[i % CAR_COLORS.length]));
      this.tmpM.compose(this.zero, this.tmpQ.identity(), this.zero);
      this.mesh.setMatrixAt(i, this.tmpM);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.userData.cat = 'vehicles';
    scene.add(this.mesh);
  }

  reset(): void {
    for (const c of this.cars) c.edge = null;
  }

  setDensity(f: number): void {
    this.densityScale = Math.min(Math.max(f, 0), 4);
  }

  /** Inspector: live state of a car instance. */
  carInfo(i: number): { speed: number; cruise: number; highway?: string; lane?: number; lanes?: number } | null {
    const c = this.cars[i];
    if (!c || !c.edge) return null;
    return { speed: c.v, cruise: c.speed, highway: c.edge.highway, lane: c.lane + 1, lanes: c.edge.lanes };
  }

  update(
    dt: number,
    camPos: THREE.Vector3,
    graph: RoadGraph,
    signalAhead?: SignalQuery,
    crossingAhead?: SignalQuery,
  ): void {
    const target = Math.min(CONFIG.maxVehicles, Math.floor((graph.totalLength / 90) * this.densityScale));
    let activeCount = 0;

    // per-edge occupancy for car-following and lane changes (leader/follower gaps)
    const occupancy = new Map<number, Slot[]>();
    for (const car of this.cars) {
      if (!car.edge || !graph.edges.has(car.edge.id)) continue;
      let arr = occupancy.get(car.edge.id);
      if (!arr) {
        arr = [];
        occupancy.set(car.edge.id, arr);
      }
      arr.push({ d: car.d, sign: car.sign, v: car.v, lane: car.lane, laneFrom: car.laneFrom, laneT: car.laneT });
    }

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];

      // despawn: edge unloaded or too far from camera
      if (car.edge && !graph.edges.has(car.edge.id)) car.edge = null;
      if (car.edge) {
        graph.posAt(car.edge, car.d, this.tmpPos);
        if (this.tmpPos.distanceTo(camPos) > CONFIG.vehicleDespawnRadius) car.edge = null;
      }

      // spawn if below target
      if (!car.edge && activeCount < target) {
        const e = graph.randomEdgeNear(camPos, CONFIG.vehicleSpawnRadius, Math.random);
        if (e) {
          car.edge = e;
          car.sign = e.oneway ? 1 : Math.random() < 0.5 ? 1 : -1;
          car.d = Math.random() * e.len;
          car.speed = e.speed * (0.75 + Math.random() * 0.4);
          car.v = car.speed * 0.5;
          car.lane = Math.floor(Math.random() * e.lanes);
          car.laneFrom = car.lane;
          car.laneT = 1;
          car.think = Math.random();
        }
      }

      if (!car.edge) {
        this.tmpM.compose(this.zero, this.tmpQ.identity(), this.zero);
        this.mesh.setMatrixAt(i, this.tmpM);
        continue;
      }
      activeCount++;

      graph.posAt(car.edge, car.d, this.tmpPos);
      graph.dirAt(car.edge, car.d, car.sign, this.tmpDir);

      // --- IDM: the most restrictive of leader / red light / occupied zebra wins ---
      const slots = occupancy.get(car.edge.id);
      const lead = leaderIn(slots, car.d, car.sign, car.lane);
      let acc = idmAccel(car.v, car.speed, lead.gap, lead.v);
      if (car.laneT < 1) {
        // still straddling the source lane: respect its leader too
        const old = leaderIn(slots, car.d, car.sign, car.laneFrom);
        acc = Math.min(acc, idmAccel(car.v, car.speed, old.gap, old.v));
      }
      if (signalAhead) {
        const sd = signalAhead(this.tmpPos, this.tmpDir);
        if (isFinite(sd)) acc = Math.min(acc, idmAccel(car.v, car.speed, sd - 3.0, 0));
      }
      if (crossingAhead) {
        const cd = crossingAhead(this.tmpPos, this.tmpDir);
        if (isFinite(cd)) acc = Math.min(acc, idmAccel(car.v, car.speed, cd - 3.5, 0));
      }
      car.v = Math.max(0, car.v + acc * dt);

      // --- lane changes: overtake left for a clear gain, drift back right ---
      car.think -= dt;
      if (car.laneT < 1) {
        car.laneT = Math.min(1, car.laneT + dt / LANE_CHANGE_TIME);
      } else if (
        car.think <= 0 && car.edge.lanes > 1 && car.v > 2 &&
        car.d > 12 && car.d < car.edge.len - 12
      ) {
        car.think = 0.8 + Math.random() * 0.6;
        for (const target of [car.lane - 1, car.lane + 1]) {
          if (target < 0 || target >= car.edge.lanes) continue;
          const tLead = leaderIn(slots, car.d, car.sign, target);
          const tFol = followerIn(slots, car.d, car.sign, target);
          // safety: room in the gap, and the new follower never brakes hard
          if (tLead.gap < IDM_S0 + 2) continue;
          if (tFol.gap < IDM_S0 + 2 || idmAccel(tFol.v, tFol.v, tFol.gap, car.v) < -IDM_B) continue;
          const gain = idmAccel(car.v, car.speed, tLead.gap, tLead.v) - acc;
          const wantRight = target < car.lane && gain > -0.15; // keep right unless it costs
          const wantLeft = target > car.lane && gain > 0.5;    // overtake for a clear win
          if (wantRight || wantLeft) {
            car.laneFrom = car.lane;
            car.lane = target;
            car.laneT = 0;
            break;
          }
        }
      }

      car.d += car.v * car.sign * dt;
      if (car.d >= car.edge.len || car.d <= 0) {
        const node = car.sign > 0 ? car.edge.b : car.edge.a;
        const options = graph.nextEdges(node, car.edge.id);
        if (options.length === 0) {
          car.edge = null;
          continue;
        }
        const next = options[Math.floor(Math.random() * options.length)];
        car.sign = next.a === node ? 1 : -1;
        car.d = car.sign > 0 ? 0 : next.len;
        car.edge = next;
        car.speed = next.speed * (0.75 + Math.random() * 0.4);
        // settle any in-progress change at the node; clamp to the new lane count
        car.lane = Math.min(car.lane, next.lanes - 1);
        car.laneFrom = car.lane;
        car.laneT = 1;
      }

      graph.posAt(car.edge, car.d, this.tmpPos);
      graph.dirAt(car.edge, car.d, car.sign, this.tmpDir);
      // lateral placement: lane centers sit at halfW - laneW*(i+0.5) right of the
      // centerline (right = cross(dir, up) = (-dz, 0, dx)); changes blend smoothly
      const off = (l: number) => car.edge!.halfW - car.edge!.laneW * (l + 0.5);
      const t = car.laneT < 1 ? car.laneT * car.laneT * (3 - 2 * car.laneT) : 1;
      const lane = off(car.laneFrom) * (1 - t) + off(car.lane) * t;
      this.tmpPos.x += -this.tmpDir.z * lane;
      this.tmpPos.z += this.tmpDir.x * lane;
      this.tmpDir.y = 0;
      if (this.tmpDir.lengthSq() < 1e-6) this.tmpDir.set(0, 0, 1);
      this.tmpDir.normalize();
      this.tmpQ.setFromUnitVectors(this.fwd, this.tmpDir);
      this.tmpM.compose(this.tmpPos, this.tmpQ, this.one);
      this.mesh.setMatrixAt(i, this.tmpM);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
