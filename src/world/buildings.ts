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

// kinds that get a gabled roof by default (when footprint is a simple quad)
const GABLE_KINDS = new Set(['house', 'detached', 'semidetached_house', 'bungalow', 'farm', 'cabin']);

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

    const wantsGable = b.roofShape === 'gabled' || (b.roofShape === undefined && GABLE_KINDS.has(b.kind));
    if (wantsGable && outer.length === 4 && holes.length === 0) {
      const roofH = Math.min(b.roofHeight ?? 2.6, Math.max(1.2, b.height * 0.6));
      const tileColor = ROOF_TILE.clone().offsetHSL(0, 0, (rng() - 0.5) * 0.06);
      const gabled = buildGabledRoof(outer, top, roofH, tileColor, wallColor, wPos, wNor, wUv, wCol, wIdx);
      if (gabled) {
        roofGeos.push(gabled);
        continue;
      }
      // degenerate quad → fall through to flat roof
    }

    // flat roof via ShapeGeometry in (x, north) space
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
      // non-indexed so it merges with gabled roofs
      roof = new THREE.ShapeGeometry(shape).toNonIndexed();
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

/** Gabled roof over a CCW quad footprint: two slope quads (roof color) + two
 * gable triangles appended to the wall arrays (wall color). Returns the slope
 * geometry (non-indexed: position/normal/color) or null when degenerate. */
function buildGabledRoof(
  quad: { x: number; z: number }[],
  top: number,
  roofH: number,
  roofColor: THREE.Color,
  wallColor: THREE.Color,
  wPos: number[],
  wNor: number[],
  wUv: number[],
  wCol: number[],
  wIdx: number[],
): THREE.BufferGeometry | null {
  const len = (i: number) => Math.hypot(quad[(i + 1) % 4].x - quad[i].x, quad[(i + 1) % 4].z - quad[i].z);
  if (Math.min(len(0), len(1), len(2), len(3)) < 0.5) return null;
  // rotate so edges 0 and 2 are the long (eave) sides; ridge spans the short ends
  const r = len(0) + len(2) >= len(1) + len(3) ? quad : [quad[1], quad[2], quad[3], quad[0]];
  const [a, b, c, d] = r;
  const m1 = { x: (b.x + c.x) / 2, z: (b.z + c.z) / 2 }; // ridge end over edge b→c
  const m3 = { x: (d.x + a.x) / 2, z: (d.z + a.z) / 2 }; // ridge end over edge d→a
  const yr = top + roofH;

  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const quadFace = (
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    p3: [number, number, number],
  ) => {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    for (const p of [p0, p1, p2, p0, p2, p3]) {
      pos.push(p[0], p[1], p[2]);
      nor.push(nx, ny, nz);
      col.push(roofColor.r, roofColor.g, roofColor.b);
    }
  };
  // slope over eave a→b and slope over eave c→d (winding keeps normals up+outward)
  quadFace([a.x, top, a.z], [b.x, top, b.z], [m1.x, yr, m1.z], [m3.x, yr, m3.z]);
  quadFace([c.x, top, c.z], [d.x, top, d.z], [m3.x, yr, m3.z], [m1.x, yr, m1.z]);

  // gable triangles fill the wall above the short ends: (b,c,m1) and (d,a,m3)
  for (const [p, q, m] of [
    [b, c, m1],
    [d, a, m3],
  ] as const) {
    const dx = q.x - p.x, dz = q.z - p.z;
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) continue;
    const nx = -dz / l, nz = dx / l; // outward wall normal (CCW ring)
    const vi = wPos.length / 3;
    wPos.push(p.x, top, p.z, q.x, top, q.z, m.x, yr, m.z);
    for (let k = 0; k < 3; k++) {
      wNor.push(nx, 0, nz);
      wCol.push(wallColor.r, wallColor.g, wallColor.b);
    }
    wUv.push(0, 0, l / FACADE_METERS, 0, l / 2 / FACADE_METERS, roofH / FACADE_METERS);
    wIdx.push(vi, vi + 1, vi + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
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
