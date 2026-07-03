import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BuildingSpec, HeightSampler } from '../types';
import { ensureWinding, hashStr, seededRandom } from './geomUtils';
import { getMaterials, FACADE_METERS } from './materials';

const WALL_PALETTE = [
  0xd9cfc0, 0xc9c2b8, 0xd8d2c9, 0xcbb8a4, 0xbfb9ae, 0xd3c6ae, 0xc2beb2, 0xd6cdbb,
  0xd0b9a0, 0xc5cdd2, 0xb8beb2, 0xdad5c5,
  // stronger urban hues (salmon, ochre, blue-gray, pale green) — Turkish
  // apartment stock is far from uniform beige
  0xd9b8a2, 0xc9a98c, 0xb9c4c9, 0xd6c489, 0xc9d1c6, 0xc7b9a8,
].map((c) => new THREE.Color(c));

const ROOF_TILE = new THREE.Color(0x9a5f47);
// flat/large roofs: grays, browns, occasional weathered green
const ROOF_PALETTE = [
  0x8a857c, 0x77685a, 0x6f7780, 0x8a4f3d, 0xa06a50, 0x5f6b60, 0x7d7468,
].map((c) => new THREE.Color(c));

// kinds that get a gabled roof by default (when footprint is a simple quad)
const GABLE_KINDS = new Set(['house', 'detached', 'semidetached_house', 'bungalow', 'farm', 'cabin']);

/** Parse an OSM colour tag (hex or CSS name) without console warnings.
 * Saturation/lightness are clamped so mapper-picked neon stays plausible. */
const colourCache = new Map<string, THREE.Color | null>();
let colourProbe: HTMLSpanElement | undefined;
function cssColour(s?: string): THREE.Color | null {
  if (!s) return null;
  const cached = colourCache.get(s);
  if (cached !== undefined) return cached;
  if (!colourProbe) colourProbe = document.createElement('span');
  colourProbe.style.color = '';
  colourProbe.style.color = s;
  let out: THREE.Color | null = null;
  if (colourProbe.style.color) {
    out = new THREE.Color(colourProbe.style.color);
    const hsl = { h: 0, s: 0, l: 0 };
    out.getHSL(hsl);
    out.setHSL(hsl.h, Math.min(hsl.s, 0.55), Math.min(Math.max(hsl.l, 0.25), 0.85));
  }
  colourCache.set(s, out);
  return out;
}

/** Visual identity per canonical building use. `plain` = windowless facade. */
interface UseStyle {
  walls: THREE.Color[];
  roof: THREE.Color;
  plain?: boolean;
}

const c = (h: number) => new THREE.Color(h);
const USE_STYLES: Record<string, UseStyle> = {
  commercial: { walls: [c(0xb6c1cc), c(0xaab7c4), c(0xc2ccd6)], roof: c(0x6f7780) },
  retail: { walls: [c(0xd8c8ab), c(0xd2bfa0), c(0xcabca6)], roof: c(0x8a6f55) },
  industrial: { walls: [c(0xa8adb2), c(0x9aa0a6), c(0xb0b4b8)], roof: c(0x767c82), plain: true },
  stadium: { walls: [c(0xc8cdd2), c(0xbfc6cd)], roof: c(0x9aa3ab), plain: true },
  hospital: { walls: [c(0xe8e6e0), c(0xdfe3e6)], roof: c(0xa05a52) },
  education: { walls: [c(0xdcc9a5), c(0xd5c39e)], roof: c(0x9a6a4f) },
  hotel: { walls: [c(0xdccdb4), c(0xd5c2a5)], roof: c(0x77685a) },
  worship: { walls: [c(0xe3dccb), c(0xded5c0)], roof: c(0x4d7a66) },
  utility: { walls: [c(0xb3afa7)], roof: c(0x8a867e), plain: true },
};

/** Extrudes building footprints into walls + roofs, merged into 2 meshes per tile. */
export function buildBuildings(specs: BuildingSpec[], sample: HeightSampler): THREE.Object3D | null {
  if (specs.length === 0) return null;

  // two wall sets: windowed facades and plain (industrial/stadium/utility)
  interface WallArrays { pos: number[]; nor: number[]; uv: number[]; col: number[]; idx: number[] }
  const windowed: WallArrays = { pos: [], nor: [], uv: [], col: [], idx: [] };
  const plain: WallArrays = { pos: [], nor: [], uv: [], col: [], idx: [] };
  const roofGeos: THREE.BufferGeometry[] = [];

  for (const b of specs) {
    if (b.outer.length < 3) continue;
    const rng = seededRandom(hashStr(b.id));
    const style = USE_STYLES[b.use];
    const w = style?.plain ? plain : windowed;
    const wPos = w.pos, wNor = w.nor, wUv = w.uv, wCol = w.col, wIdx = w.idx;
    // real mapped colours win; then use styles; then the procedural palette
    const tagWall = cssColour(b.wallColour);
    const tagRoof = cssColour(b.roofColour);
    const wallColor =
      tagWall ??
      (style
        ? style.walls[Math.floor(rng() * style.walls.length)]
        : WALL_PALETTE[Math.floor(rng() * WALL_PALETTE.length)]);
    const roofColor = (
      tagRoof ??
      style?.roof ??
      (b.kind === 'house' || b.kind === 'detached' || b.height < 8
        ? ROOF_TILE
        : ROOF_PALETTE[Math.floor(rng() * ROOF_PALETTE.length)])
    )
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

    // roof shape: mapped tag first, then defaults, then procedural variety —
    // low residential quads split into gabled/hipped/flat so streets don't
    // read as endless identical flat boxes
    const isQuad = outer.length === 4 && holes.length === 0;
    let roofKind = b.roofShape;
    if (roofKind === undefined) {
      if (GABLE_KINDS.has(b.kind)) roofKind = 'gabled';
      else if (isQuad && !style && b.height < 17) {
        const roll = rng();
        roofKind = roll < 0.3 ? 'gabled' : roll < 0.48 ? 'hipped' : 'flat';
      }
    }
    if ((roofKind === 'gabled' || roofKind === 'hipped') && isQuad) {
      const roofH = Math.min(b.roofHeight ?? 2.6, Math.max(1.2, b.height * 0.6));
      const tileColor = (tagRoof ?? ROOF_TILE).clone().offsetHSL(0, 0, (rng() - 0.5) * 0.06);
      const pitched = buildPitchedRoof(
        outer, top, roofH, tileColor, wallColor, roofKind === 'hipped', wPos, wNor, wUv, wCol, wIdx,
      );
      if (pitched) {
        roofGeos.push(pitched);
        continue;
      }
      // degenerate quad → fall through to flat roof
    }
    if (roofKind === 'pyramidal' && holes.length === 0 && outer.length <= 10) {
      const roofH = Math.min(b.roofHeight ?? 3.2, Math.max(1.5, b.height * 0.7));
      const pyramid = buildPyramidRoof(outer, top, roofH, roofColor);
      if (pyramid) {
        roofGeos.push(pyramid);
        continue;
      }
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

  for (const [arrays, mat] of [
    [windowed, mats.wall],
    [plain, mats.wallPlain],
  ] as const) {
    if (arrays.pos.length === 0) continue;
    const wallGeo = new THREE.BufferGeometry();
    wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(arrays.pos, 3));
    wallGeo.setAttribute('normal', new THREE.Float32BufferAttribute(arrays.nor, 3));
    wallGeo.setAttribute('uv', new THREE.Float32BufferAttribute(arrays.uv, 2));
    wallGeo.setAttribute('color', new THREE.Float32BufferAttribute(arrays.col, 3));
    wallGeo.setIndex(arrays.idx);
    const walls = new THREE.Mesh(wallGeo, mat);
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

/** Pitched roof over a CCW quad footprint.
 * Gabled: two slope quads + two gable wall triangles (wall color).
 * Hipped: ridge ends pulled inward, the short ends become roof triangles. */
function buildPitchedRoof(
  quad: { x: number; z: number }[],
  top: number,
  roofH: number,
  roofColor: THREE.Color,
  wallColor: THREE.Color,
  hipped: boolean,
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
  let m1 = { x: (b.x + c.x) / 2, z: (b.z + c.z) / 2 }; // ridge end over edge b→c
  let m3 = { x: (d.x + a.x) / 2, z: (d.z + a.z) / 2 }; // ridge end over edge d→a
  if (hipped) {
    // classic ~45° hip: pull each ridge end inward by half the end width
    const ridge = Math.hypot(m1.x - m3.x, m1.z - m3.z);
    if (ridge < 1e-6) return null;
    const dx = (m3.x - m1.x) / ridge;
    const dz = (m3.z - m1.z) / ridge;
    const pull1 = Math.min(Math.hypot(c.x - b.x, c.z - b.z) / 2, ridge * 0.44);
    const pull3 = Math.min(Math.hypot(a.x - d.x, a.z - d.z) / 2, ridge * 0.44);
    m1 = { x: m1.x + dx * pull1, z: m1.z + dz * pull1 };
    m3 = { x: m3.x - dx * pull3, z: m3.z - dz * pull3 };
  }
  const yr = top + roofH;

  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const face = (pts: [number, number, number][]) => {
    const [p0, p1, , pl] = [pts[0], pts[1], pts[2], pts[pts.length - 1]];
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = pl[0] - p0[0], vy = pl[1] - p0[1], vz = pl[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const tris = pts.length === 3 ? [pts[0], pts[1], pts[2]] : [pts[0], pts[1], pts[2], pts[0], pts[2], pts[3]];
    for (const p of tris) {
      pos.push(p[0], p[1], p[2]);
      nor.push(nx, ny, nz);
      col.push(roofColor.r, roofColor.g, roofColor.b);
    }
  };
  // slope over eave a→b and slope over eave c→d (winding keeps normals up+outward)
  face([[a.x, top, a.z], [b.x, top, b.z], [m1.x, yr, m1.z], [m3.x, yr, m3.z]]);
  face([[c.x, top, c.z], [d.x, top, d.z], [m3.x, yr, m3.z], [m1.x, yr, m1.z]]);

  for (const [p, q, m] of [
    [b, c, m1],
    [d, a, m3],
  ] as const) {
    if (hipped) {
      // hip end: a roof triangle instead of a gable wall
      face([[p.x, top, p.z], [q.x, top, q.z], [m.x, yr, m.z]]);
      continue;
    }
    // gable triangles fill the wall above the short ends: (b,c,m1) and (d,a,m3)
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

/** Pyramidal roof: triangle fan from every outer edge to an apex over the
 * footprint centroid (mosques, kiosks, towers — roof:shape=pyramidal/dome). */
function buildPyramidRoof(
  ring: { x: number; z: number }[],
  top: number,
  roofH: number,
  roofColor: THREE.Color,
): THREE.BufferGeometry | null {
  let cx = 0, cz = 0;
  for (const p of ring) {
    cx += p.x;
    cz += p.z;
  }
  cx /= ring.length;
  cz /= ring.length;
  const apex: [number, number, number] = [cx, top + roofH, cz];
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const ux = q.x - p.x, uz = q.z - p.z;
    const vx = apex[0] - p.x, vy = roofH, vz = apex[2] - p.z;
    // n = (q-p) × (apex-p); flip inward-facing normals up/outward
    let nx = -uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy;
    if (ny < 0) {
      nx = -nx; ny = -ny; nz = -nz;
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    for (const v of [[p.x, top, p.z], [q.x, top, q.z], apex] as const) {
      pos.push(v[0], v[1], v[2]);
      nor.push(nx / nl, ny / nl, nz / nl);
      col.push(roofColor.r, roofColor.g, roofColor.b);
    }
  }
  if (pos.length < 9) return null;
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
