import * as THREE from 'three';
import { CONFIG } from '../config';
import type { RoadSpec, PoiSpec, HeightSampler, V2, RuleRoad } from '../types';
import { offsetPolyline, subdividePolyline, hashStr } from './geomUtils';
import { getMaterials } from './materials';
import { FootprintGrid, RoadClearanceGrid } from './collision';

interface Bucket {
  pos: number[];
  nor: number[];
  uv: number[];
  idx: number[];
}

function newBucket(): Bucket {
  return { pos: [], nor: [], uv: [], idx: [] };
}

/** Junction info surfaced to the inspector (first-class intersection data). */
export interface JunctionInfo {
  x: number;
  z: number;
  ext: number;
  arms: number;
}

export interface RoadBuildResult {
  group: THREE.Object3D | null;
  /** center polylines with elevation, for the vehicle graph */
  drivable: { pts: THREE.Vector3[]; highway: string; oneway: boolean }[];
  /** polylines pedestrians can walk (footpaths + sidewalks) */
  walkable: THREE.Vector3[][];
  /** junction plates owned (claimed) by this tile — inspector data */
  junctions: JunctionInfo[];
  /** ALL junctions (claim-independent) with a canonical main axis — signal phase plans */
  signalJunctions: SignalJunction[];
  /** zebra centers snapped on the carriageway — vehicles yield to pedestrians here */
  crossingPoints: CrossingPoint[];
}

/** Phase-plan anchor: junction center + main axis (fold of the widest arm, [0,π)).
 * Derived from claim-independent geometry so neighbouring tiles agree. */
export interface SignalJunction {
  x: number;
  z: number;
  axis: number;
}

export interface CrossingPoint {
  x: number;
  z: number;
  halfW: number;
}

/** Topological junction: a first-class intersection object. Arms point outward
 * from the node; every arm's ribbon is trimmed back by `ext` so the junction
 * plate is the real surface (no overlapping geometry inside the junction). */
export interface JunctionArm {
  dx: number;
  dz: number;
  hw: number;
  sw: boolean; // does this arm's road carry sidewalks?
}

export interface Junction {
  x: number;
  z: number;
  ext: number;
  arms: JunctionArm[];
}

function junctionNodeKey(p: V2): string {
  return `${Math.round(p.x)}_${Math.round(p.z)}`;
}

/** Detect intersections from claim-independent rule roads: any node shared by
 * ≥3 arms. OSM ways share node coordinates at true crossings, so this is the
 * topology already present in the data — made explicit. Only ground-level
 * (level 0) roads take part: a viaduct crossing above a street is NOT an
 * intersection, even when broken data shares a node. */
function buildJunctions(
  roads: { pts: V2[]; width: number; cls: string; sidewalks?: boolean; level?: number }[],
): Map<string, Junction> {
  interface Node { x: number; z: number; arms: JunctionArm[] }
  const nodes = new Map<string, Node>();
  for (const r of roads) {
    if (r.cls === 'path' || r.pts.length < 2 || (r.level ?? 0) !== 0) continue;
    for (let k = 0; k < r.pts.length; k++) {
      const p = r.pts[k];
      const key = junctionNodeKey(p);
      let nd = nodes.get(key);
      if (!nd) {
        nd = { x: p.x, z: p.z, arms: [] };
        nodes.set(key, nd);
      }
      for (const nb of [r.pts[k - 1], r.pts[k + 1]]) {
        if (!nb) continue;
        const dx = nb.x - p.x;
        const dz = nb.z - p.z;
        const l = Math.hypot(dx, dz);
        if (l > 1e-6) nd.arms.push({ dx: dx / l, dz: dz / l, hw: r.width / 2, sw: r.sidewalks ?? false });
      }
    }
  }
  const junctions = new Map<string, Junction>();
  for (const [key, nd] of nodes) {
    if (nd.arms.length < 3) continue;
    let maxHw = 0;
    for (const a of nd.arms) {
      if (a.hw > maxHw) maxHw = a.hw;
    }
    junctions.set(key, { x: nd.x, z: nd.z, ext: Math.min(maxHw * 1.2 + 1.0, 14), arms: nd.arms });
  }
  return junctions;
}

/** Split a centerline at interior junction vertices, then trim every piece end
 * that touches a junction back by that junction's ext. */
function splitAndTrim(pts: V2[], junctions: Map<string, Junction>): V2[][] {
  const pieces: V2[][] = [];
  let cur: V2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    cur.push(pts[i]);
    if (i < pts.length - 1 && junctions.has(junctionNodeKey(pts[i]))) {
      pieces.push(cur);
      cur = [pts[i]];
    }
  }
  pieces.push(cur);

  const out: V2[][] = [];
  for (let piece of pieces) {
    const jStart = junctions.get(junctionNodeKey(piece[0]));
    if (jStart) piece = trimStart(piece, jStart.ext);
    if (piece.length >= 2) {
      const jEnd = junctions.get(junctionNodeKey(piece[piece.length - 1]));
      if (jEnd) piece = trimStart(piece.slice().reverse(), jEnd.ext).reverse();
    }
    if (piece.length >= 2) out.push(piece);
  }
  return out;
}

function trimStart(pts: V2[], dist: number): V2[] {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (acc + seg > dist) {
      const t = (dist - acc) / seg;
      const np = {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t,
      };
      return [np, ...pts.slice(i)];
    }
    acc += seg;
  }
  return []; // consumed entirely by the junction area
}

/** Vertical profile for bridge/tunnel ways (already subdivided points):
 * a straight line between the terrain heights at both portals/abutments.
 * Bridges never sink below the terrain (+0.3 clearance keeps the deck riding
 * over DSM humps); tunnels deliberately stay below it — the terrain trench
 * is carved to this same profile, so road and trench floor always agree. */
export function elevationProfile(
  pts: V2[],
  kind: 'bridge' | 'tunnel',
  sample: HeightSampler,
  sampleOrig: HeightSampler,
): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  const len = Math.max(cum[cum.length - 1], 1e-6);
  const h0 = sampleOrig(pts[0].x, pts[0].z);
  const h1 = sampleOrig(pts[pts.length - 1].x, pts[pts.length - 1].z);
  return pts.map((p, i) => {
    const line = h0 + (h1 - h0) * (cum[i] / len);
    return kind === 'bridge' ? Math.max(line, sample(p.x, p.z) + 0.3) : line;
  });
}

const UNDERPASS_CLEARANCE = 5.2; // vertical gap under the crossing road
const RAMP_GRADE = 0.12;         // ~12% approach ramps inside the tunnel way

/** Tunnel/underpass profile. The 30 m DSM flattens narrow trenches, so the
 * portal-to-portal line alone often stays at grade — the dip the data IMPLIES
 * (layer<0 under a crossing road) must be synthesized: wherever a ground-level
 * way crosses above, the profile is pushed ≥5.2 m below it, ramping back up to
 * the portals so the tunnel still meets its connecting roads. */
export function tunnelProfile(
  pts: V2[],
  ownId: string,
  others: RuleRoad[],
  sample: HeightSampler,
  sampleOrig: HeightSampler,
): number[] {
  const base = elevationProfile(pts, 'tunnel', sample, sampleOrig);
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  const len = Math.max(cum[cum.length - 1], 1e-6);

  // find crossings with ground-level ways (bridges above don't force a dip —
  // they already clear the road; other tunnels are siblings, not constraints)
  const crossings: { cum: number; y: number }[] = [];
  for (const o of others) {
    if (o.id === ownId || o.tunnel || o.bridge || o.level !== 0 || o.pts.length < 2) continue;
    for (let i = 1; i < pts.length; i++) {
      for (let k = 1; k < o.pts.length; k++) {
        const hit = segIntersect(pts[i - 1], pts[i], o.pts[k - 1], o.pts[k]);
        if (!hit) continue;
        crossings.push({
          cum: cum[i - 1] + hit.t * (cum[i] - cum[i - 1]),
          y: sampleOrig(hit.x, hit.z),
        });
      }
    }
  }
  if (crossings.length === 0) return base;

  return base.map((b, i) => {
    let y = b;
    for (const c of crossings) {
      y = Math.min(y, c.y - UNDERPASS_CLEARANCE + RAMP_GRADE * Math.abs(cum[i] - c.cum));
    }
    // never dip faster than the ramp grade from either portal — the tunnel
    // must still meet its connecting roads at grade
    return Math.max(y, b - RAMP_GRADE * Math.min(cum[i], len - cum[i]));
  });
}

function segIntersect(a: V2, b: V2, c: V2, d: V2): { x: number; z: number; t: number } | null {
  const r1x = b.x - a.x, r1z = b.z - a.z;
  const r2x = d.x - c.x, r2z = d.z - c.z;
  const den = r1x * r2z - r1z * r2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * r2z - (c.z - a.z) * r2x) / den;
  const u = ((c.x - a.x) * r1z - (c.z - a.z) * r1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + r1x * t, z: a.z + r1z * t, t };
}

let pierGeo: THREE.BufferGeometry | undefined;

function getPierGeometry(): THREE.BufferGeometry {
  if (!pierGeo) {
    pierGeo = new THREE.BoxGeometry(1.7, 1, 1.7);
    pierGeo.translate(0, 0.5, 0); // base at origin → scale.y = pier height
    pierGeo.userData.shared = true;
  }
  return pierGeo;
}

/** Builds road ribbons (with lane markings), sidewalks and zebra crossings.
 * Engine rules against broken/overlapping data:
 * - junctions are first-class: arms are trimmed, the plate IS the surface
 * - polylines are subdivided (~9 m) and draped vertex-by-vertex on the terrain
 * - every road gets a deterministic micro-offset in y → no same-class z-fighting
 * - sidewalk segments falling inside building footprints are skipped
 * - sidewalk segments on ANY other same-level road's carriageway are skipped
 * - offset fold-backs (sharp corners) are culled by direction-reversal detection
 * - kerb arcs connect adjacent arms' sidewalks around each junction
 * - bridges/viaducts ride a straight deck profile with piers + parapets
 * - tunnels/underpasses descend a portal-to-portal profile inside a carved trench */
export function buildRoads(
  roads: RoadSpec[],
  crossings: PoiSpec[],
  sample: HeightSampler,
  footprints?: FootprintGrid,
  clearance?: RoadClearanceGrid,
  ruleRoads?: RuleRoad[],
  claimNode?: (key: string) => boolean,
  sampleOrig?: HeightSampler,
): RoadBuildResult {
  const buckets = {
    major: newBucket(),
    minor: newBucket(),
    path: newBucket(),
    sidewalk: newBucket(),
    crosswalk: newBucket(),
    junction: newBucket(),
    barrier: newBucket(),
  };
  const drivable: RoadBuildResult['drivable'] = [];
  const walkable: THREE.Vector3[][] = [];
  const junctionInfos: JunctionInfo[] = [];
  const piers: { x: number; z: number; y: number; h: number }[] = [];
  const orig = sampleOrig ?? sample;

  // first-class intersections from claim-independent geometry (cross-tile safe)
  const junctions = buildJunctions(ruleRoads ?? roads);

  // phase-plan anchors: main axis = fold of the widest arm; ties resolve to the
  // smallest fold so the pick is deterministic regardless of way order
  const signalJunctions: SignalJunction[] = [];
  for (const j of junctions.values()) {
    let axis = 0;
    let bestHw = -1;
    for (const a of j.arms) {
      const fold = ((Math.atan2(a.dz, a.dx) % Math.PI) + Math.PI) % Math.PI;
      if (a.hw > bestHw + 1e-6 || (a.hw > bestHw - 1e-6 && fold < axis)) {
        bestHw = a.hw;
        axis = fold;
      }
    }
    signalJunctions.push({ x: j.x, z: j.z, axis });
  }

  for (const r of roads) {
    if (r.pts.length < 2) continue;
    const jitter = ((hashStr(r.id) % 1000) / 1000) * CONFIG.yRoadJitter;
    const yOff =
      (r.cls === 'major' ? CONFIG.yRoadMajor : r.cls === 'minor' ? CONFIG.yRoadMinor : CONFIG.yPath) + jitter;
    const vMeters = r.cls === 'major' ? 8 : 6;

    // ---- elevated / buried ways: profile instead of terrain drape ----
    if (r.bridge || r.tunnel) {
      const pts = subdividePolyline(r.pts, CONFIG.roadSubdivision);
      if (pts.length < 2) continue;
      const prof = r.bridge
        ? elevationProfile(pts, 'bridge', sample, orig)
        : tunnelProfile(pts, r.id, ruleRoads ?? [], sample, orig);
      // tunnels render wider so the ribbon fills the trench floor wall-to-wall
      const renderW = r.tunnel ? r.width + 2.6 : r.width;
      addRibbon(buckets[r.cls], pts, renderW, yOff, sample, vMeters, prof);

      if (r.tunnel) {
        // retaining walls where the way is genuinely buried
        for (const side of [1, -1]) {
          const line = offsetPolyline(pts, side * (r.width / 2 + 1.4));
          const yBot = prof.map((y) => y + yOff - 0.3);
          const yTop = line.map((p, i) => Math.max(orig(p.x, p.z), prof[i] + yOff) + 0.35);
          const buried = line.map((p, i) => orig(p.x, p.z) - prof[i] > 0.5);
          for (const run of splitRunsIdx(line, buried.map((b) => !b))) {
            addWallStrip(
              buckets.barrier,
              run.pts,
              yBot.slice(run.start, run.start + run.pts.length),
              yTop.slice(run.start, run.start + run.pts.length),
            );
          }
        }
      } else {
        // parapets along elevated deck sections + piers down to the ground
        for (const side of [1, -1]) {
          const line = offsetPolyline(pts, side * (r.width / 2 + 0.12));
          const high = pts.map((p, i) => prof[i] - sample(p.x, p.z) > 1.1);
          for (const run of splitRunsIdx(line, high.map((h) => !h))) {
            const yBot = prof.slice(run.start, run.start + run.pts.length).map((y) => y + yOff - 0.1);
            const yTop = prof.slice(run.start, run.start + run.pts.length).map((y) => y + yOff + 1.0);
            addWallStrip(buckets.barrier, run.pts, yBot, yTop);
          }
        }
        let cum = 0;
        let next = 14;
        for (let i = 1; i < pts.length; i++) {
          cum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
          if (cum < next) continue;
          next += 26;
          const ground = sample(pts[i].x, pts[i].z);
          const deck = prof[i] + yOff;
          if (deck - ground > 3.2) {
            piers.push({ x: pts[i].x, z: pts[i].z, y: ground - 0.6, h: deck - ground + 0.5 });
          }
        }
      }

      // sidewalks ride the deck (bridges only; tunnels have none)
      if (r.sidewalks) {
        for (const side of [1, -1]) {
          const line = offsetPolyline(pts, side * (r.width / 2 + 1.05));
          const bad = new Array<boolean>(line.length).fill(false);
          for (let k = 0; k + 1 < line.length; k++) {
            const dox = line[k + 1].x - line[k].x;
            const doz = line[k + 1].z - line[k].z;
            const dpx = pts[k + 1].x - pts[k].x;
            const dpz = pts[k + 1].z - pts[k].z;
            if (dox * dpx + doz * dpz < 0) bad[k] = bad[k + 1] = true;
          }
          for (const run of splitRunsIdx(line, bad)) {
            const p3 = run.pts.map(
              (p, k) => new THREE.Vector3(p.x, prof[run.start + k] + CONFIG.ySidewalk + 0.03, p.z),
            );
            addRibbon(
              buckets.sidewalk, run.pts, 1.9, CONFIG.ySidewalk, sample, 2,
              prof.slice(run.start, run.start + run.pts.length),
            );
            walkable.push(p3);
          }
        }
      }

      // agents follow the same profile — cars/pedestrians really cross the span
      const pts3 = pts.map((p, i) => new THREE.Vector3(p.x, prof[i] + yOff + 0.05, p.z));
      if (r.cls !== 'path') drivable.push({ pts: pts3, highway: r.highway, oneway: r.oneway });
      else walkable.push(pts3);
      continue;
    }

    // ---- ground-level roads: split at junctions + drape on terrain ----
    const trimmed = r.cls === 'path' ? [r.pts] : splitAndTrim(r.pts, junctions);
    for (const piece of trimmed) {
      const pts = subdividePolyline(piece, CONFIG.roadSubdivision);
      if (pts.length < 2) continue;
      addRibbon(buckets[r.cls], pts, r.width, yOff, sample, vMeters);

      if (r.sidewalks && pts.length >= 2) {
        for (const side of [1, -1]) {
          const line = offsetPolyline(pts, side * (r.width / 2 + 1.05));
          const bad = new Array<boolean>(line.length).fill(false);
          // offset fold-back culling: a segment running opposite to its parent
          // segment means the offset line self-intersected at a sharp corner
          for (let k = 0; k + 1 < line.length; k++) {
            const dox = line[k + 1].x - line[k].x;
            const doz = line[k + 1].z - line[k].z;
            const dpx = pts[k + 1].x - pts[k].x;
            const dpz = pts[k + 1].z - pts[k].z;
            if (dox * dpx + doz * dpz < 0) {
              bad[k] = bad[k + 1] = true;
            }
          }
          for (let k = 0; k < line.length; k++) {
            if (bad[k]) continue;
            if (footprints?.inside(line[k].x, line[k].z)) bad[k] = true;
            else if (clearance?.blocked(line[k].x, line[k].z, 1.15, r.id, r.level)) bad[k] = true;
          }
          for (const run of splitRuns(line, bad)) {
            addRibbon(buckets.sidewalk, run, 1.9, CONFIG.ySidewalk, sample, 2);
            walkable.push(run.map((p) => new THREE.Vector3(p.x, sample(p.x, p.z) + CONFIG.ySidewalk + 0.03, p.z)));
          }
        }
      }
    }

    // agents use the UNtrimmed centerline: vehicles drive across the plate
    const full = subdividePolyline(r.pts, CONFIG.roadSubdivision);
    if (r.cls !== 'path') {
      const pts3 = full.map((p, i) => new THREE.Vector3(p.x, probedHeight(full, i, sample) + yOff + 0.05, p.z));
      if (pts3.length >= 2) drivable.push({ pts: pts3, highway: r.highway, oneway: r.oneway });
    } else {
      walkable.push(full.map((p, i) => new THREE.Vector3(p.x, probedHeight(full, i, sample) + yOff + 0.05, p.z)));
    }
  }

  // ---- junction surfaces + kerb arcs (owned by one tile via claimNode) ----
  for (const [key, j] of junctions) {
    if (claimNode && !claimNode(`jn:${key}`)) continue; // built by another tile
    addJunctionPlate(buckets.junction, j, key, sample);
    addKerbArcs(buckets.sidewalk, j, sample, walkable, footprints, clearance);
    junctionInfos.push({ x: j.x, z: j.z, ext: j.ext, arms: j.arms.length });
  }

  // zebra crossings snapped onto the nearest GROUND-level drivable segment
  const roadSegs: { a: V2; b: V2; width: number }[] = [];
  for (const r of roads) {
    if (r.cls === 'path' || r.level !== 0) continue;
    for (let i = 1; i < r.pts.length; i++) {
      roadSegs.push({ a: r.pts[i - 1], b: r.pts[i], width: r.width });
    }
  }
  const crossingPoints: CrossingPoint[] = [];
  for (const c of crossings) {
    if (c.kind !== 'crossing') continue;
    const hit = nearestSegment(c.x, c.z, roadSegs, 15);
    if (!hit) continue;
    addCrosswalk(buckets.crosswalk, hit.px, hit.pz, hit.dx, hit.dz, hit.width, sample);
    crossingPoints.push({ x: hit.px, z: hit.pz, halfW: hit.width / 2 });
  }

  const mats = getMaterials();
  const group = new THREE.Group();
  const defs: [Bucket, THREE.Material, boolean][] = [
    [buckets.major, mats.roadMajor, true],
    [buckets.minor, mats.roadMinor, true],
    [buckets.path, mats.path, true],
    [buckets.junction, mats.junction, true],
    [buckets.sidewalk, mats.sidewalk, true],
    [buckets.barrier, mats.barrier, true],
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
  if (piers.length > 0) {
    const mesh = new THREE.InstancedMesh(getPierGeometry(), mats.barrier, piers.length);
    const m = new THREE.Matrix4();
    for (let i = 0; i < piers.length; i++) {
      const p = piers[i];
      m.makeScale(1, p.h, 1);
      m.setPosition(p.x, p.y, p.z);
      mesh.setMatrixAt(i, m);
    }
    mesh.castShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }
  group.userData.cat = 'roads';
  return {
    group: group.children.length > 0 ? group : null,
    drivable, walkable, junctions: junctionInfos, signalJunctions, crossingPoints,
  };
}

/** Miter-joined ribbon along a polyline. Draped on the terrain by default;
 * with `profile` (bridge/tunnel) both edges take the given deck height. */
function addRibbon(
  b: Bucket,
  pts: V2[],
  width: number,
  yOff: number,
  sample: HeightSampler,
  vMeters: number,
  profile?: number[],
): void {
  // filter near-duplicate points (remember source indices for the profile)
  const p: V2[] = [pts[0]];
  const src: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const prev = p[p.length - 1];
    if (Math.hypot(pts[i].x - prev.x, pts[i].z - prev.z) > 0.15) {
      p.push(pts[i]);
      src.push(i);
    }
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
    if (profile) {
      // deck profile: flat across the width (bridges/tunnels don't bank)
      const y = profile[src[i]] + yOff;
      b.pos.push(lx, y, lz, rx, y, rz);
    } else {
      // drape rule: edges never drop below the centerline level → the ribbon
      // can bank with the terrain but cannot sink under it on cross-slopes.
      // probedHeight also checks segment midpoints so terrain crests between
      // samples cannot poke through the ribbon.
      const ch = probedHeight(p, i, sample);
      b.pos.push(
        lx, Math.max(sample(lx, lz), ch) + yOff, lz,
        rx, Math.max(sample(rx, rz), ch) + yOff, rz,
      );
    }
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

/** Vertical wall strip along a polyline (parapets, retaining walls). */
function addWallStrip(b: Bucket, line: V2[], yBot: number[], yTop: number[]): void {
  let cum = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const p = line[i];
    const q = line[i + 1];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 0.05) continue;
    const nx = -(q.z - p.z) / len;
    const nz = (q.x - p.x) / len;
    const vi = b.pos.length / 3;
    b.pos.push(p.x, yBot[i], p.z, q.x, yBot[i + 1], q.z, q.x, yTop[i + 1], q.z, p.x, yTop[i], p.z);
    for (let k = 0; k < 4; k++) b.nor.push(nx, 0, nz);
    b.uv.push(cum / 4, 0, (cum + len) / 4, 0, (cum + len) / 4, 1, cum / 4, 1);
    b.idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    cum += len;
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

/** Draped merged junction plate: for every arm, two corner points at the arm
 * mouth (center + dir·ext ± perp·halfWidth); all corners sorted by angle and
 * fanned from the node. Arms are trimmed to the same ext, so this polygon IS
 * the junction surface — nothing overlaps beneath it. */
function addJunctionPlate(b: Bucket, j: Junction, key: string, sample: HeightSampler): void {
  const { x: cx, z: cz, ext, arms } = j;
  // small deterministic offset so neighbouring plates on short blocks never z-fight
  const y = CONFIG.yJunction + ((hashStr(key) % 100) / 100) * 0.015;
  const corners: { x: number; z: number; ang: number }[] = [];
  for (const a of arms) {
    const w = a.hw + 0.15;
    // perp (left) of arm dir
    const px = a.dz;
    const pz = -a.dx;
    for (const s of [1, -1]) {
      const x = cx + a.dx * ext + px * w * s;
      const z = cz + a.dz * ext + pz * w * s;
      corners.push({ x, z, ang: Math.atan2(z - cz, x - cx) });
    }
  }
  if (corners.length < 3) return;
  corners.sort((p, q) => p.ang - q.ang);

  const ch = sample(cx, cz);
  const base = b.pos.length / 3;
  b.pos.push(cx, ch + y, cz);
  b.nor.push(0, 1, 0);
  b.uv.push(cx / 7, cz / 7);
  for (const c of corners) {
    b.pos.push(c.x, Math.max(sample(c.x, c.z), ch) + y, c.z);
    b.nor.push(0, 1, 0);
    b.uv.push(c.x / 7, c.z / 7);
  }
  const n = corners.length;
  for (let s = 0; s < n; s++) {
    // (center, next, current) → face up (angle-ascending ring)
    b.idx.push(base, base + 1 + ((s + 1) % n), base + 1 + s);
  }
}

/** Kerb arcs: for each pair of angularly adjacent sidewalk-carrying arms,
 * connect their sidewalk mouths with an arc around the junction — sidewalks
 * flow continuously around every corner instead of stopping dead. */
function addKerbArcs(
  b: Bucket,
  j: Junction,
  sample: HeightSampler,
  walkable: THREE.Vector3[][],
  footprints?: FootprintGrid,
  clearance?: RoadClearanceGrid,
): void {
  const arms = j.arms
    .map((a) => ({ ...a, ang: Math.atan2(a.dz, a.dx) }))
    .sort((p, q) => p.ang - q.ang);
  const n = arms.length;
  for (let i = 0; i < n; i++) {
    const a = arms[i];
    const c = arms[(i + 1) % n];
    if (!a.sw || !c.sw) continue;
    // corner sector runs CCW from arm a to arm c.
    // sidewalk mouth beside arm a on its CCW side: perpCCW(dir) = (-dz, dx)
    const pa = {
      x: j.x + a.dx * j.ext - a.dz * (a.hw + 1.05),
      z: j.z + a.dz * j.ext + a.dx * (a.hw + 1.05),
    };
    // beside arm c on its CW side: perpCW(dir) = (dz, -dx)
    const pc = {
      x: j.x + c.dx * j.ext + c.dz * (c.hw + 1.05),
      z: j.z + c.dz * j.ext - c.dx * (c.hw + 1.05),
    };
    // follow the junction plate's shape: the plate boundary between two arm
    // mouths is a straight chord, so the kerb is the parallel chord 1.05 m out
    // (subdivided for terrain draping) — no circular bulges
    if (Math.hypot(pc.x - pa.x, pc.z - pa.z) < 0.6) continue;
    const line: V2[] = subdividePolyline([pa, pc], 6);
    // rule check with tight margin: arc endpoints sit 1.05 m off their own
    // carriageways by construction; only genuine overlaps get culled
    const bad = line.map(
      (p) => footprints?.inside(p.x, p.z) === true || clearance?.blocked(p.x, p.z, 0.1) === true,
    );
    for (const run of splitRuns(line, bad)) {
      addRibbon(b, run, 1.9, CONFIG.ySidewalk, sample, 2);
      walkable.push(run.map((p) => new THREE.Vector3(p.x, sample(p.x, p.z) + CONFIG.ySidewalk + 0.03, p.z)));
    }
  }
}

/** Split a polyline into runs of consecutive non-flagged vertices. */
function splitRuns(line: V2[], bad: boolean[]): V2[][] {
  return splitRunsIdx(line, bad).map((r) => r.pts);
}

/** Like splitRuns, but keeps each run's start index (profile alignment). */
function splitRunsIdx(line: V2[], bad: boolean[]): { pts: V2[]; start: number }[] {
  const runs: { pts: V2[]; start: number }[] = [];
  let cur: V2[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (bad[i]) {
      if (cur.length >= 2) runs.push({ pts: cur, start });
      cur = [];
    } else {
      if (cur.length === 0) start = i;
      cur.push(line[i]);
    }
  }
  if (cur.length >= 2) runs.push({ pts: cur, start });
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
