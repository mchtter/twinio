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
  speed: number; // cruise speed for the current edge
  v: number;     // current speed (accelerates / brakes toward a target)
}

/** Distance to a blocking (non-green) signal ahead, or Infinity. */
export type SignalQuery = (pos: THREE.Vector3, dir: THREE.Vector3) => number;

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
      this.cars.push({ edge: null, d: 0, sign: 1, speed: 10, v: 0 });
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
  carInfo(i: number): { speed: number; cruise: number; highway?: string } | null {
    const c = this.cars[i];
    if (!c || !c.edge) return null;
    return { speed: c.v, cruise: c.speed, highway: c.edge.highway };
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

    // per-edge occupancy for car-following (leader gap)
    const occupancy = new Map<number, { d: number; sign: number; v: number }[]>();
    for (const car of this.cars) {
      if (!car.edge || !graph.edges.has(car.edge.id)) continue;
      let arr = occupancy.get(car.edge.id);
      if (!arr) {
        arr = [];
        occupancy.set(car.edge.id, arr);
      }
      arr.push({ d: car.d, sign: car.sign, v: car.v });
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

      // --- desired speed: cruise, then brake for red lights and leaders ---
      let desired = car.speed;
      if (signalAhead) {
        const sd = signalAhead(this.tmpPos, this.tmpDir);
        if (sd < 5) desired = 0;
        else if (sd < 22) desired = Math.min(desired, (sd - 5) * 0.7);
      }
      // yield to pedestrians on a zebra ahead (stop a car-length short of it)
      if (crossingAhead) {
        const cd = crossingAhead(this.tmpPos, this.tmpDir);
        if (cd < 4.5) desired = 0;
        else if (cd < 18) desired = Math.min(desired, (cd - 4.5) * 0.8);
      }
      const others = occupancy.get(car.edge.id);
      if (others) {
        let gap = Infinity;
        let leaderV = 0;
        for (const o of others) {
          if (o.sign !== car.sign) continue;
          const g = car.sign > 0 ? o.d - car.d : car.d - o.d;
          if (g > 0.01 && g < gap) {
            gap = g;
            leaderV = o.v;
          }
        }
        if (gap < 7) desired = Math.min(desired, Math.max(leaderV - 1, 0));
        if (gap < 5) desired = 0;
      }
      // accelerate 2.5 m/s², brake 7 m/s²
      if (car.v < desired) car.v = Math.min(car.v + 2.5 * dt, desired);
      else car.v = Math.max(car.v - 7 * dt, desired);

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
      }

      graph.posAt(car.edge, car.d, this.tmpPos);
      graph.dirAt(car.edge, car.d, car.sign, this.tmpDir);
      // lane offset: keep right of the centerline (right = cross(dir, up) = (-dz, 0, dx))
      const lane = 1.6;
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
