import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BuildingSpec, HeightSampler } from '../types';
import { ensureWinding, hashStr, seededRandom } from './geomUtils';
import { getMaterials, FACADE_METERS } from './materials';

const WALL_PALETTE = [
  0xd9cfc0, 0xc9c2b8, 0xd8d2c9, 0xcbb8a4, 0xbfb9ae, 0xd3c6ae, 0xc2beb2, 0xd6cdbb,
  0xd0b9a0, 0xc5cdd2, 0xb8beb2, 0xdad5c5,
].map((c) => new THREE.Color(c));

const ROOF_FLAT = new THREE.Color(0x8a857c);
const ROOF_TILE = new THREE.Color(0x9a5f47);

/** Extrudes building footprints into walls + roofs, merged into 2 meshes per tile. */
export function buildBuildings(specs: BuildingSpec[], sample: HeightSampler): THREE.Object3D | null {
  if (specs.length === 0) return null;

  // walls accumulated manually (custom UVs per wall run)
  const wPos: number[] = [];
  const wNor: number[] = [];
  const wUv: number[] = [];
  const wCol: number[] = [];
  const wIdx: number[] = [];
  const roofGeos: THREE.BufferGeometry[] = [];

  for (const b of specs) {
    if (b.outer.length < 3) continue;
    const rng = seededRandom(hashStr(b.id));
    const wallColor = WALL_PALETTE[Math.floor(rng() * WALL_PALETTE.length)];
    const roofColor = (b.kind === 'house' || b.kind === 'detached' || b.height < 8 ? ROOF_TILE : ROOF_FLAT)
      .clone()
      .offsetHSL(0, 0, (rng() - 0.5) * 0.06);

    // ground elevation: min over footprint so the building digs into slopes
    let base = Infinity;
    for (const p of b.outer) {
      const h = sample(p.x, p.z);
      if (h < base) base = h;
    }
    if (!isFinite(base)) base = 0;
    base -= 0.5;
    const top = base + 0.5 + b.height;

    const outer = ensureWinding(b.outer, true);
    const holes = b.holes.map((h) => ensureWinding(h, false));

    for (const ring of [outer, ...holes]) {
      addWallRing(ring, base, top, wallColor, wPos, wNor, wUv, wCol, wIdx);
    }

    // roof via ShapeGeometry in (x, north) space
    const shape = new THREE.Shape();
    shape.moveTo(outer[0].x, -outer[0].z);
    for (let i = 1; i < outer.length; i++) shape.lineTo(outer[i].x, -outer[i].z);
    shape.closePath();
    for (const h of holes) {
      const path = new THREE.Path();
      path.moveTo(h[0].x, -h[0].z);
      for (let i = 1; i < h.length; i++) path.lineTo(h[i].x, -h[i].z);
      path.closePath();
      shape.holes.push(path);
    }
    let roof: THREE.BufferGeometry;
    try {
      roof = new THREE.ShapeGeometry(shape);
    } catch {
      continue; // degenerate footprint
    }
    // shape (sx, sy, 0) -> world (sx, top, -sy)
    roof.rotateX(-Math.PI / 2);
    roof.translate(0, top, 0);
    const rc = new Float32Array(roof.getAttribute('position').count * 3);
    for (let i = 0; i < rc.length; i += 3) {
      rc[i] = roofColor.r;
      rc[i + 1] = roofColor.g;
      rc[i + 2] = roofColor.b;
    }
    roof.setAttribute('color', new THREE.BufferAttribute(rc, 3));
    roof.deleteAttribute('uv');
    roofGeos.push(roof);
  }

  const group = new THREE.Group();
  const mats = getMaterials();

  if (wPos.length > 0) {
    const wallGeo = new THREE.BufferGeometry();
    wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
    wallGeo.setAttribute('normal', new THREE.Float32BufferAttribute(wNor, 3));
    wallGeo.setAttribute('uv', new THREE.Float32BufferAttribute(wUv, 2));
    wallGeo.setAttribute('color', new THREE.Float32BufferAttribute(wCol, 3));
    wallGeo.setIndex(wIdx);
    const walls = new THREE.Mesh(wallGeo, mats.wall);
    walls.castShadow = true;
    walls.receiveShadow = true;
    group.add(walls);
  }
  if (roofGeos.length > 0) {
    const roofGeo = mergeGeometries(roofGeos, false);
    if (roofGeo) {
      const roofs = new THREE.Mesh(roofGeo, mats.roof);
      roofs.castShadow = true;
      roofs.receiveShadow = true;
      group.add(roofs);
    }
    for (const g of roofGeos) g.dispose();
  }
  group.userData.cat = 'buildings';
  return group.children.length > 0 ? group : null;
}

function addWallRing(
  ring: { x: number; z: number }[],
  base: number,
  top: number,
  color: THREE.Color,
  pos: number[],
  nor: number[],
  uv: number[],
  col: number[],
  idx: number[],
): void {
  let cum = 0;
  const height = top - base;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    // outward normal for CCW-in-(x,north) ring: (dn, 0, dx) where dn = -dz
    const nx = -dz / len;
    const nz = dx / len;
    const vi = pos.length / 3;
    pos.push(p.x, base, p.z, q.x, base, q.z, q.x, top, q.z, p.x, top, p.z);
    for (let k = 0; k < 4; k++) {
      nor.push(nx, 0, nz);
      col.push(color.r, color.g, color.b);
    }
    const u0 = cum / FACADE_METERS;
    const u1 = (cum + len) / FACADE_METERS;
    const v1 = height / FACADE_METERS;
    uv.push(u0, 0, u1, 0, u1, v1, u0, v1);
    idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    cum += len;
  }
}
