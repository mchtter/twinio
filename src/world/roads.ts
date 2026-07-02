import * as THREE from 'three';
import { CONFIG } from '../config';
import type { RoadSpec, PoiSpec, HeightSampler, V2 } from '../types';
import { offsetPolyline, subdividePolyline, hashStr } from './geomUtils';
import { getMaterials } from './materials';
import { FootprintGrid } from './collision';

interface Bucket {
  pos: number[];
  nor: number[];
  uv: number[];
  idx: number[];
}

function newBucket(): Bucket {
  return { pos: [], nor: [], uv: [], idx: [] };
}

export interface RoadBuildResult {
  group: THREE.Object3D | null;
  /** center polylines with elevation, for the vehicle graph */
  drivable: { pts: THREE.Vector3[]; highway: string; oneway: boolean }[];
  /** polylines pedestrians can walk (footpaths + sidewalks) */
  walkable: THREE.Vector3[][];
}

/** Builds road ribbons (with lane markings), sidewalks and zebra crossings.
 * Engine rules against broken/overlapping data:
 * - polylines are subdivided (~9 m) and draped vertex-by-vertex on the terrain
 * - every road gets a deterministic micro-offset in y → no same-class z-fighting
 * - sidewalk segments falling inside building footprints are skipped */
export function buildRoads(
  roads: RoadSpec[],
  crossings: PoiSpec[],
  sample: HeightSampler,
  footprints?: FootprintGrid,
): RoadBuildResult {
  const buckets = {
    major: newBucket(),
    minor: newBucket(),
    path: newBucket(),
    sidewalk: newBucket(),
    crosswalk: newBucket(),
    junction: newBucket(),
  };
  const drivable: RoadBuildResult['drivable'] = [];
  const walkable: THREE.Vector3[][] = [];

  for (const r of roads) {
    if (r.pts.length < 2) continue;
    const pts = subdividePolyline(r.pts, CONFIG.roadSubdivision);
    const jitter = ((hashStr(r.id) % 1000) / 1000) * CONFIG.yRoadJitter;
    const yOff =
      (r.cls === 'major' ? CONFIG.yRoadMajor : r.cls === 'minor' ? CONFIG.yRoadMinor : CONFIG.yPath) + jitter;
    addRibbon(buckets[r.cls], pts, r.width, yOff, sample, r.cls === 'major' ? 8 : 6);

    if (r.cls !== 'path') {
      const pts3 = pts.map((p, i) => new THREE.Vector3(p.x, probedHeight(pts, i, sample) + yOff + 0.05, p.z));
      if (pts3.length >= 2) drivable.push({ pts: pts3, highway: r.highway, oneway: r.oneway });
    } else {
      walkable.push(pts.map((p, i) => new THREE.Vector3(p.x, probedHeight(pts, i, sample) + yOff + 0.05, p.z)));
    }

    if (r.sidewalks && pts.length >= 2) {
      for (const side of [1, -1]) {
        const line = offsetPolyline(pts, side * (r.width / 2 + 1.05));
        for (const run of splitOutsideFootprints(line, footprints)) {
          addRibbon(buckets.sidewalk, run, 1.9, CONFIG.ySidewalk, sample, 2);
          walkable.push(run.map((p) => new THREE.Vector3(p.x, sample(p.x, p.z) + CONFIG.ySidewalk + 0.03, p.z)));
        }
      }
    }
  }

  // ---- junction caps: an asphalt disc over every node where ≥3 road arms meet,
  // hiding overlapping ribbon ends, forks and T-junction seams
  interface JNode { x: number; z: number; width: number; arms: number }
  const jnodes = new Map<string, JNode>();
  for (const r of roads) {
    if (r.cls === 'path' || r.pts.length < 2) continue;
    for (let k = 0; k < r.pts.length; k++) {
      const p = r.pts[k];
      const key = `${Math.round(p.x)}_${Math.round(p.z)}`;
      let nd = jnodes.get(key);
      if (!nd) {
        nd = { x: p.x, z: p.z, width: 0, arms: 0 };
        jnodes.set(key, nd);
      }
      nd.width = Math.max(nd.width, r.width);
      // each neighbor vertex = one arm leaving this node
      if (k > 0) nd.arms++;
      if (k < r.pts.length - 1) nd.arms++;
    }
  }
  for (const nd of jnodes.values()) {
    if (nd.arms < 3) continue; // straight continuations (2 arms) need no cap
    const radius = Math.min(Math.max(nd.width * 0.72 + 0.6, 2.5), 12);
    addJunctionFan(buckets.junction, nd.x, nd.z, radius, sample);
  }

  // zebra crossings snapped onto the nearest drivable road segment
  const roadSegs: { a: V2; b: V2; width: number }[] = [];
  for (const r of roads) {
    if (r.cls === 'path') continue;
    for (let i = 1; i < r.pts.length; i++) {
      roadSegs.push({ a: r.pts[i - 1], b: r.pts[i], width: r.width });
    }
  }
  for (const c of crossings) {
    if (c.kind !== 'crossing') continue;
    const hit = nearestSegment(c.x, c.z, roadSegs, 15);
    if (!hit) continue;
    addCrosswalk(buckets.crosswalk, hit.px, hit.pz, hit.dx, hit.dz, hit.width, sample);
  }

  const mats = getMaterials();
  const group = new THREE.Group();
  const defs: [Bucket, THREE.Material, boolean][] = [
    [buckets.major, mats.roadMajor, true],
    [buckets.minor, mats.roadMinor, true],
    [buckets.path, mats.path, true],
    [buckets.junction, mats.junction, true],
    [buckets.sidewalk, mats.sidewalk, true],
    [buckets.crosswalk, mats.crosswalk, false],
  ];
  for (const [b, mat, shadow] of defs) {
    if (b.pos.length === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    geo.setIndex(b.idx);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = shadow;
    group.add(mesh);
  }
  group.userData.cat = 'roads';
  return { group: group.children.length > 0 ? group : null, drivable, walkable };
}

/** Miter-joined ribbon along a polyline, draped on the terrain. */
function addRibbon(b: Bucket, pts: V2[], width: number, yOff: number, sample: HeightSampler, vMeters: number): void {
  // filter near-duplicate points
  const p: V2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = p[p.length - 1];
    if (Math.hypot(pts[i].x - prev.x, pts[i].z - prev.z) > 0.15) p.push(pts[i]);
  }
  if (p.length < 2) return;

  const hw = width / 2;
  const base = b.pos.length / 3;
  let cum = 0;
  for (let i = 0; i < p.length; i++) {
    const prev = p[Math.max(i - 1, 0)];
    const next = p[Math.min(i + 1, p.length - 1)];
    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    const dl = Math.hypot(dx, dz);
    if (dl < 1e-6) {
      dx = 1;
      dz = 0;
    } else {
      dx /= dl;
      dz /= dl;
    }
    // miter scale relative to the incoming segment normal
    let scale = 1;
    if (i > 0 && i < p.length - 1) {
      let sx = p[i].x - p[i - 1].x;
      let sz = p[i].z - p[i - 1].z;
      const sl = Math.hypot(sx, sz);
      if (sl > 1e-6) {
        sx /= sl;
        sz /= sl;
        const dot = dx * sx + dz * sz;
        scale = Math.min(1 / Math.max(Math.abs(dot), 0.4), 2.5);
      }
    }
    if (i > 0) cum += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
    // left normal (dz, -dx)
    const lx = p[i].x + dz * hw * scale;
    const lz = p[i].z - dx * hw * scale;
    const rx = p[i].x - dz * hw * scale;
    const rz = p[i].z + dx * hw * scale;
    // drape rule: edges never drop below the centerline level → the ribbon
    // can bank with the terrain but cannot sink under it on cross-slopes.
    // probedHeight also checks segment midpoints so terrain crests between
    // samples cannot poke through the ribbon.
    const ch = probedHeight(p, i, sample);
    b.pos.push(
      lx, Math.max(sample(lx, lz), ch) + yOff, lz,
      rx, Math.max(sample(rx, rz), ch) + yOff, rz,
    );
    b.nor.push(0, 1, 0, 0, 1, 0);
    const v = cum / vMeters;
    b.uv.push(0, v, 1, v);
  }
  for (let i = 0; i < p.length - 1; i++) {
    const li = base + i * 2;
    const ri = li + 1;
    const li1 = li + 2;
    const ri1 = li + 3;
    b.idx.push(li, ri, li1, ri, ri1, li1);
  }
}

/** Terrain height at pts[i], also probing the midpoints toward both neighbors —
 * catches terrain-triangle crests between consecutive samples. */
function probedHeight(pts: V2[], i: number, sample: HeightSampler): number {
  const p = pts[i];
  let h = sample(p.x, p.z);
  if (i > 0) {
    const q = pts[i - 1];
    h = Math.max(h, sample((p.x + q.x) / 2, (p.z + q.z) / 2));
  }
  if (i < pts.length - 1) {
    const q = pts[i + 1];
    h = Math.max(h, sample((p.x + q.x) / 2, (p.z + q.z) / 2));
  }
  return h;
}

/** Draped asphalt disc (triangle fan) capping a junction. */
function addJunctionFan(b: Bucket, cx: number, cz: number, r: number, sample: HeightSampler): void {
  const segs = 14;
  const ch = sample(cx, cz);
  const base = b.pos.length / 3;
  b.pos.push(cx, ch + CONFIG.yJunction, cz);
  b.nor.push(0, 1, 0);
  b.uv.push(cx / 7, cz / 7);
  for (let s = 0; s <= segs; s++) {
    const a = (s / segs) * Math.PI * 2;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    b.pos.push(x, Math.max(sample(x, z), ch) + CONFIG.yJunction, z);
    b.nor.push(0, 1, 0);
    b.uv.push(x / 7, z / 7);
  }
  for (let s = 0; s < segs; s++) {
    // (center, next, current) → face up
    b.idx.push(base, base + 2 + s, base + 1 + s);
  }
}

/** Split a polyline into runs whose vertices lie outside building footprints. */
function splitOutsideFootprints(line: V2[], footprints?: FootprintGrid): V2[][] {
  if (!footprints) return line.length >= 2 ? [line] : [];
  const runs: V2[][] = [];
  let cur: V2[] = [];
  for (const p of line) {
    if (footprints.inside(p.x, p.z)) {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    } else {
      cur.push(p);
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

function nearestSegment(
  x: number,
  z: number,
  segs: { a: V2; b: V2; width: number }[],
  maxDist: number,
): { px: number; pz: number; dx: number; dz: number; width: number } | null {
  let best: { px: number; pz: number; dx: number; dz: number; width: number } | null = null;
  let bestD = maxDist;
  for (const s of segs) {
    const abx = s.b.x - s.a.x;
    const abz = s.b.z - s.a.z;
    const l2 = abx * abx + abz * abz;
    if (l2 < 1e-6) continue;
    let t = ((x - s.a.x) * abx + (z - s.a.z) * abz) / l2;
    t = Math.min(Math.max(t, 0), 1);
    const px = s.a.x + abx * t;
    const pz = s.a.z + abz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < bestD) {
      bestD = d;
      const l = Math.sqrt(l2);
      best = { px, pz, dx: abx / l, dz: abz / l, width: s.width };
    }
  }
  return best;
}

function addCrosswalk(
  b: Bucket,
  px: number,
  pz: number,
  dx: number,
  dz: number,
  roadWidth: number,
  sample: HeightSampler,
): void {
  const alongHalf = 1.6; // meters along road axis
  const acrossHalf = roadWidth / 2 + 0.2;
  // perp (left) of road dir
  const nx = dz;
  const nz = -dx;
  const corners = [
    { x: px - dx * alongHalf - nx * acrossHalf, z: pz - dz * alongHalf - nz * acrossHalf }, // u0 v0
    { x: px + dx * alongHalf - nx * acrossHalf, z: pz + dz * alongHalf - nz * acrossHalf }, // u1 v0
    { x: px + dx * alongHalf + nx * acrossHalf, z: pz + dz * alongHalf + nz * acrossHalf }, // u1 v1
    { x: px - dx * alongHalf + nx * acrossHalf, z: pz - dz * alongHalf + nz * acrossHalf }, // u0 v1
  ];
  const vRep = (acrossHalf * 2) / 6; // ~1m stripe pitch (6 stripes per texture repeat)
  const uvs = [
    [0, 0],
    [1, 0],
    [1, vRep],
    [0, vRep],
  ];
  const base = b.pos.length / 3;
  for (let i = 0; i < 4; i++) {
    const c = corners[i];
    b.pos.push(c.x, sample(c.x, c.z) + CONFIG.yCrosswalk, c.z);
    b.nor.push(0, 1, 0);
    b.uv.push(uvs[i][0], uvs[i][1]);
  }
  // wind so normal points +y
  b.idx.push(base, base + 1, base + 3, base + 1, base + 2, base + 3);
}
