import * as THREE from 'three';
import type { AreaSpec, HeightSampler } from '../types';
import { pointInPolygon, seededRandom, hashStr } from './geomUtils';
import { getMaterials } from './materials';
import { getCarGeometry, CAR_COLORS } from '../agents/vehicles';
import { FootprintGrid, RoadClearanceGrid } from './collision';

/** Inspector + future live-occupancy API metadata for one parking lot. */
export interface ParkingLotMeta {
  id: string;
  capacity: number; // usable stalls the engine found
  parked: number;   // cars actually placed
  occupancy: number; // simulated ratio (Faz 6: replace with live feed)
}

const ROW_PITCH = 9.5;   // stall depth + aisle
const STALL_PITCH = 3.0; // along-row spacing
const MAX_CARS_PER_TILE = 600;

/** Fill amenity=parking areas with parked cars in aligned rows. Rows follow
 * the lot's longest edge; every stall is checked against the polygon, building
 * footprints and crossing carriageways. Occupancy is a deterministic per-lot
 * ratio today and becomes a live API feed later — the layout code won't change. */
export function buildParkedCars(
  areas: AreaSpec[],
  sample: HeightSampler,
  footprints?: FootprintGrid,
  clearance?: RoadClearanceGrid,
): { mesh: THREE.InstancedMesh | null; lots: ParkingLotMeta[] } {
  interface Spot { x: number; z: number; rot: number }
  const spots: Spot[] = [];
  const lots: ParkingLotMeta[] = [];

  for (const a of areas) {
    if (a.kind !== 'parking' || a.outer.length < 3) continue;
    // underground/rooftop lots have no visible surface cars
    const pk = a.tags?.['parking'];
    if (pk === 'underground' || pk === 'multi-storey' || pk === 'rooftop') continue;
    if (spots.length >= MAX_CARS_PER_TILE) break;

    // dominant direction: the longest polygon edge orients the rows
    let bestLen = 0;
    let theta = 0;
    for (let i = 0; i < a.outer.length; i++) {
      const p = a.outer[i];
      const q = a.outer[(i + 1) % a.outer.length];
      const l = Math.hypot(q.x - p.x, q.z - p.z);
      if (l > bestLen) {
        bestLen = l;
        theta = Math.atan2(q.z - p.z, q.x - p.x);
      }
    }
    const ex = Math.cos(theta), ez = Math.sin(theta);   // along rows
    const nx = -ez, nz = ex;                             // across rows

    // oriented bbox in (u=along, v=across)
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const p of a.outer) {
      const u = p.x * ex + p.z * ez;
      const v = p.x * nx + p.z * nz;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    const rng = seededRandom(hashStr(a.id));
    const occupancy = 0.35 + ((hashStr(a.id) % 100) / 100) * 0.45;
    let capacity = 0;
    let parked = 0;

    outer:
    for (let v = vMin + 2.6; v <= vMax - 2.6; v += ROW_PITCH) {
      for (let u = uMin + 2; u <= uMax - 2; u += STALL_PITCH) {
        const x = ex * u + nx * v;
        const z = ez * u + nz * v;
        if (!pointInPolygon(x, z, a.outer, a.holes)) continue;
        if (footprints?.inside(x, z)) continue;
        if (clearance?.blocked(x, z, 0.6)) continue; // aisle roads cross real lots
        capacity++;
        if (capacity > 500) break outer;
        if (rng() > occupancy) continue;
        // nose-in perpendicular to the row, half the cars backed in
        const rot = Math.atan2(nx, nz) + (rng() < 0.5 ? Math.PI : 0) + (rng() - 0.5) * 0.1;
        spots.push({ x, z, rot });
        parked++;
        if (spots.length >= MAX_CARS_PER_TILE) break outer;
      }
    }
    if (capacity > 0) lots.push({ id: a.id, capacity, parked, occupancy });
  }

  if (spots.length === 0) return { mesh: null, lots };

  const mesh = new THREE.InstancedMesh(getCarGeometry(), getMaterials().vehicle, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const c = new THREE.Color();
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    q.setFromAxisAngle(up, s.rot); // rotY(θ) maps car-forward +z to (sinθ, cosθ)
    m.compose(new THREE.Vector3(s.x, sample(s.x, s.z) + 0.06, s.z), q, one);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.copy(CAR_COLORS[(i * 7 + 3) % CAR_COLORS.length]));
  }
  mesh.castShadow = true;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.userData.cat = 'vehicles';
  return { mesh, lots };
}
