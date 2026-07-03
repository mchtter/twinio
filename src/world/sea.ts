import * as THREE from 'three';
import { CONFIG } from '../config';
import type { V2, HeightSampler } from '../types';
import { signedArea } from './geomUtils';
import { getMaterials } from './materials';

/** OSM has no sea polygons — the sea is implied by natural=coastline ways
 * (land on the LEFT of the way direction, water on the RIGHT). Per tile we
 * clip the coastline chains to the tile rectangle and close them along the
 * rectangle perimeter (clockwise in x/north space keeps water on the right),
 * producing real sea polygons. Open-sea tiles with no coastline are detected
 * by the DEM heuristic in the tile manager. */

export interface TileRect {
  xMin: number;
  xMax: number;
  zMin: number; // north edge (z = -north)
  zMax: number; // south edge
}

interface Chain {
  pts: V2[];
  tIn: number;  // perimeter param of entry point
  tOut: number; // perimeter param of exit point
}

/** Perimeter parameter, walking CW in (x, north):
 * NW→NE (top, z=zMin), NE→SE (right), SE→SW (bottom), SW→NW (left). */
function perimeterT(p: V2, r: TileRect): number {
  const w = r.xMax - r.xMin;
  const h = r.zMax - r.zMin;
  const eps = 1e-4;
  if (Math.abs(p.z - r.zMin) < eps) return p.x - r.xMin; // top
  if (Math.abs(p.x - r.xMax) < eps) return w + (p.z - r.zMin); // right
  if (Math.abs(p.z - r.zMax) < eps) return w + h + (r.xMax - p.x); // bottom
  return w + h + w + (r.zMax - p.z); // left
}

const CORNERS = (r: TileRect): { p: V2; t: number }[] => {
  const w = r.xMax - r.xMin;
  const h = r.zMax - r.zMin;
  return [
    { p: { x: r.xMax, z: r.zMin }, t: w },             // NE
    { p: { x: r.xMax, z: r.zMax }, t: w + h },         // SE
    { p: { x: r.xMin, z: r.zMax }, t: w + h + w },     // SW
    { p: { x: r.xMin, z: r.zMin }, t: w + h + w + h }, // NW (=0 mod P)
  ];
};

function inside(p: V2, r: TileRect): boolean {
  return p.x >= r.xMin && p.x <= r.xMax && p.z >= r.zMin && p.z <= r.zMax;
}

/** Liang-Barsky segment/rect clip → [t0, t1] of the inside portion, or null. */
function clipSegment(a: V2, b: V2, r: TileRect): [number, number] | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, a.x - r.xMin],
    [dx, r.xMax - a.x],
    [-dz, a.z - r.zMin],
    [dz, r.zMax - a.z],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [t0, t1];
}

/** Clip a coastline polyline to the rect → boundary-to-boundary chains. */
function clipChains(line: V2[], r: TileRect): Chain[] {
  const chains: Chain[] = [];
  let cur: V2[] | null = null;
  const lerp = (a: V2, b: V2, t: number): V2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });

  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const clip = clipSegment(a, b, r);
    if (!clip) {
      if (cur && cur.length >= 2) finishChain(cur);
      cur = null;
      continue;
    }
    const [t0, t1] = clip;
    const p0 = t0 > 0 ? lerp(a, b, t0) : a;
    const p1 = t1 < 1 ? lerp(a, b, t1) : b;
    if (!cur) cur = [p0];
    cur.push(p1);
    if (t1 < 1) {
      if (cur.length >= 2) finishChain(cur);
      cur = null;
    }
  }
  if (cur && cur.length >= 2) finishChain(cur);

  function finishChain(pts: V2[]): void {
    const first = pts[0];
    const last = pts[pts.length - 1];
    // only boundary-to-boundary chains can be closed along the perimeter
    const onB = (p: V2) =>
      Math.abs(p.x - r.xMin) < 1e-3 || Math.abs(p.x - r.xMax) < 1e-3 ||
      Math.abs(p.z - r.zMin) < 1e-3 || Math.abs(p.z - r.zMax) < 1e-3;
    if (!onB(first) || !onB(last)) return;
    chains.push({ pts, tIn: perimeterT(first, r), tOut: perimeterT(last, r) });
  }
  return chains;
}

/** Consecutive coastline WAYS share endpoints mid-tile — stitch them into
 * long polylines first, otherwise chains end inside the rect and get dropped. */
function stitchCoastlines(lines: V2[][]): V2[][] {
  const key = (p: V2) => `${Math.round(p.x * 2)}_${Math.round(p.z * 2)}`;
  const byStart = new Map<string, V2[]>();
  for (const l of lines) {
    if (l.length >= 2) byStart.set(key(l[0]), l.slice());
  }
  const used = new Set<V2[]>();
  const out: V2[][] = [];
  for (const l of byStart.values()) {
    if (used.has(l)) continue;
    used.add(l);
    const merged = l.slice();
    let guard = 0;
    while (guard++ < 200) {
      const next = byStart.get(key(merged[merged.length - 1]));
      if (!next || used.has(next) || next === l) break;
      used.add(next);
      merged.push(...next.slice(1));
    }
    out.push(merged);
  }
  return out;
}

/** Build the sea mesh for a tile from its coastline ways (or null if none). */
export function buildSea(coastlines: V2[][], rect: TileRect, sample: HeightSampler): THREE.Mesh | null {
  const chains: Chain[] = [];
  for (const line of stitchCoastlines(coastlines)) {
    chains.push(...clipChains(line, rect));
  }
  if (chains.length === 0) return null;

  const P = 2 * (rect.xMax - rect.xMin) + 2 * (rect.zMax - rect.zMin);
  const corners = CORNERS(rect);
  const polygons: V2[][] = [];
  const visited = new Set<Chain>();

  for (const start of chains) {
    if (visited.has(start)) continue;
    const poly: V2[] = [];
    let chain = start;
    let guard = 0;
    while (guard++ < 20) {
      visited.add(chain);
      poly.push(...chain.pts);
      // walk the perimeter CW from this exit to the nearest next entry
      const from = chain.tOut;
      let best: Chain | null = null;
      let bestDelta = Infinity;
      for (const c of chains) {
        let delta = c.tIn - from;
        if (delta <= 1e-6) delta += P;
        if (delta < bestDelta) {
          bestDelta = delta;
          best = c;
        }
      }
      if (!best) break;
      // append rect corners passed on the way, in walk order
      const passed: { p: V2; d: number }[] = [];
      for (const corner of corners) {
        let dc = corner.t - from;
        if (dc <= 1e-6) dc += P;
        if (dc < bestDelta) passed.push({ p: corner.p, d: dc });
      }
      passed.sort((a, b) => a.d - b.d);
      for (const c of passed) poly.push(c.p);
      if (best === start) break;
      chain = best;
      if (visited.has(chain)) break;
    }
    if (poly.length >= 3) polygons.push(poly);
  }

  const geos: THREE.BufferGeometry[] = [];
  for (let poly of polygons) {
    // triangulation-friendly winding: CCW in (x, north)
    if (signedArea(poly) < 0) poly = poly.slice().reverse();
    const shape = new THREE.Shape();
    shape.moveTo(poly[0].x, -poly[0].z);
    for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x, -poly[i].z);
    shape.closePath();
    try {
      // flat sheet at absolute sea level — DEM noise under it is snapped to 0
      const g = new THREE.ShapeGeometry(shape).toNonIndexed();
      g.rotateX(-Math.PI / 2);
      const pos = g.getAttribute('position');
      const uv = g.getAttribute('uv');
      const nor = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        pos.setY(i, CONFIG.seaLevel);
        uv.setXY(i, pos.getX(i) / 30, pos.getZ(i) / 30);
        nor[i * 3 + 1] = 1;
      }
      pos.needsUpdate = true;
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geos.push(g);
    } catch {
      // degenerate polygon — skip
    }
  }
  if (geos.length === 0) return null;
  return seaMeshFromGeos(geos);
}

/** Flat full-tile sea quad (open-sea tiles detected via the DEM heuristic). */
export function buildOpenSea(rect: TileRect): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  const y = CONFIG.seaLevel;
  const pos = new Float32Array([
    rect.xMin, y, rect.zMin, rect.xMin, y, rect.zMax, rect.xMax, y, rect.zMin,
    rect.xMax, y, rect.zMin, rect.xMin, y, rect.zMax, rect.xMax, y, rect.zMax,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const uv = new Float32Array(12);
  for (let i = 0; i < 6; i++) {
    uv[i * 2] = pos[i * 3] / 30;
    uv[i * 2 + 1] = pos[i * 3 + 2] / 30;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const nor = new Float32Array(18);
  for (let i = 0; i < 6; i++) nor[i * 3 + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return seaMeshFromGeos([g]);
}

function seaMeshFromGeos(geos: THREE.BufferGeometry[]): THREE.Mesh {
  let geo = geos[0];
  if (geos.length > 1) {
    // manual merge (all non-indexed, position+uv+normal)
    const total = geos.reduce((s, g) => s + g.getAttribute('position').count, 0);
    const pos = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const nor = new Float32Array(total * 3);
    let o = 0;
    for (const g of geos) {
      const n = g.getAttribute('position').count;
      pos.set(g.getAttribute('position').array as Float32Array, o * 3);
      uv.set(g.getAttribute('uv').array as Float32Array, o * 2);
      nor.set(g.getAttribute('normal').array as Float32Array, o * 3);
      o += n;
      g.dispose();
    }
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  }
  const mesh = new THREE.Mesh(geo, getMaterials().water);
  mesh.userData.cat = 'water';
  return mesh;
}
