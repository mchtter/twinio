import * as THREE from 'three';
import type { BuildingSpec, HeightSampler } from '../types';
import { RoadGraph, GraphEdge } from '../agents/graph';
import { World } from '../world/tileManager';

/** Earthquake scenario: camera shake + procedural rumble, then staggered
 * building collapses around the viewpoint. Victim selection uses the OSM
 * `start_date` tag when present (buildings ≥15 years old collapse far more
 * often); untagged buildings — the common case — fall randomly. Collapsing
 * buildings leave rubble piles; buildings next to a street can spill rubble
 * onto the carriageway, severing that edge of the vehicle graph (cars vanish
 * from the blocked segment and route around it). Exiting the scenario restores
 * the skyline, the graph and the silence exactly as they were. */

const VICTIM_RADIUS = 420; // only the area being looked at collapses
const MAX_VICTIMS = 90;
const FALL_DURATION = 2.4;
const SHAKE_END = 9;

interface Victim {
  key: string;
  spec: BuildingSpec;
  mesh: THREE.Mesh;
  cx: number;
  cz: number;
  baseY: number;
  h: number;
  rx: number; // footprint half-extents for rubble scatter
  rz: number;
  start: number; // scenario-clock second the fall begins
  axis: THREE.Vector3;
  maxTilt: number;
  done: boolean;
  blockEdgeId: number | null;
  blockPt: THREE.Vector3 | null;
}

export class EarthquakeScenario {
  active = false;
  private group = new THREE.Group();
  private t = 0;
  private victims: Victim[] = [];
  private rubble: THREE.InstancedMesh | null = null;
  private rubbleUsed = 0;
  private removedEdges: GraphEdge[] = [];
  private affectedTiles = new Map<string, Set<string>>();
  private concrete = new THREE.MeshStandardMaterial({ color: 0x9a948a, roughness: 0.95 });
  private rubbleMat = new THREE.MeshStandardMaterial({ color: 0x847e73, roughness: 1 });
  private audioCtx: AudioContext | null = null;
  private graph: RoadGraph | null = null;

  constructor(scene: THREE.Scene) {
    this.group.visible = false;
    scene.add(this.group);
  }

  start(world: World, graph: RoadGraph, camPos: THREE.Vector3, sample: HeightSampler): void {
    this.stopInternal(world, graph); // safety: never double-start
    this.active = true;
    this.t = 0;
    this.graph = graph;
    this.group.visible = true;
    this.startRumble();

    // ---- pick victims around the viewpoint ----
    const yrNow = new Date().getFullYear();
    for (const { key, spec } of world.features.allBuildings()) {
      if (this.victims.length >= MAX_VICTIMS) break;
      if (spec.outer.length < 3) continue;
      let cx = 0;
      let cz = 0;
      for (const p of spec.outer) {
        cx += p.x;
        cz += p.z;
      }
      cx /= spec.outer.length;
      cz /= spec.outer.length;
      if (Math.hypot(cx - camPos.x, cz - camPos.z) > VICTIM_RADIUS) continue;

      const yr = parseInt(spec.tags?.['start_date'] ?? spec.tags?.['construction_date'] ?? '', 10);
      const chance = isFinite(yr) ? (yrNow - yr >= 15 ? 0.6 : 0.04) : 0.25;
      if (Math.random() >= chance) continue;

      let rx = 0;
      let rz = 0;
      for (const p of spec.outer) {
        rx = Math.max(rx, Math.abs(p.x - cx));
        rz = Math.max(rz, Math.abs(p.z - cz));
      }
      const baseY = sample(cx, cz);
      const mesh = this.buildPrism(spec, cx, cz);
      mesh.position.set(cx, baseY, cz);
      this.group.add(mesh);

      // does this one spill onto a street? nearest graph edge within reach
      let blockEdgeId: number | null = null;
      let blockPt: THREE.Vector3 | null = null;
      if (Math.random() < 0.65) {
        const hit = nearestEdge(graph, cx, cz, Math.max(rx, rz) + 9);
        if (hit) {
          blockEdgeId = hit.id;
          blockPt = hit.pt;
        }
      }

      const angle = Math.random() * Math.PI * 2;
      this.victims.push({
        key, spec, mesh, cx, cz, baseY,
        h: spec.height,
        rx: Math.max(rx * 0.7, 2),
        rz: Math.max(rz * 0.7, 2),
        start: 1.6 + Math.random() * 4.5,
        axis: new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)),
        maxTilt: 0.12 + Math.random() * 0.25,
        done: false,
        blockEdgeId,
        blockPt,
      });
      let set = this.affectedTiles.get(key);
      if (!set) {
        set = new Set();
        this.affectedTiles.set(key, set);
      }
      set.add(spec.id);
    }

    // swap victims out of the merged tile meshes — the animated prisms take over
    for (const [key, ids] of this.affectedTiles) world.setCollapsedBuildings(key, ids);

    // rubble pool: piles (8 boxes) + street spills (3 boxes), placed as falls complete
    const cap = this.victims.length * 11;
    if (cap > 0) {
      this.rubble = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.rubbleMat, cap);
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < cap; i++) this.rubble.setMatrixAt(i, zero);
      this.rubble.instanceMatrix.needsUpdate = true;
      this.rubble.castShadow = true;
      this.rubble.frustumCulled = false;
      this.group.add(this.rubble);
    }
  }

  update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    for (const v of this.victims) {
      if (v.done) continue;
      const tau = (this.t - v.start) / FALL_DURATION;
      if (tau < 0) continue;
      if (tau >= 1) {
        v.done = true;
        v.mesh.visible = false;
        this.spawnRubble(v);
        if (v.blockEdgeId !== null && this.graph) {
          const e = this.graph.removeEdge(v.blockEdgeId);
          if (e) this.removedEdges.push(e);
        }
        continue;
      }
      const ease = tau * tau; // gravity: slow start, hard finish
      v.mesh.quaternion.setFromAxisAngle(v.axis, v.maxTilt * ease);
      v.mesh.position.y = v.baseY - v.h * 0.78 * ease;
      v.mesh.scale.y = 1 - 0.45 * ease;
    }
  }

  /** Camera shake for this frame — add before render, subtract after. */
  shake(out: THREE.Vector3): THREE.Vector3 {
    if (!this.active || this.t >= SHAKE_END) return out.set(0, 0, 0);
    const t = this.t;
    const amp = t < 0.9 ? t / 0.9 : t < 5.5 ? 1 : 1 - (t - 5.5) / (SHAKE_END - 5.5);
    return out.set(
      (Math.sin(t * 23.7) + 0.5 * Math.sin(t * 41.3)) * 0.3,
      Math.sin(t * 31.1) * 0.16,
      (Math.sin(t * 27.9) + 0.5 * Math.sin(t * 37.1)) * 0.3,
    ).multiplyScalar(amp);
  }

  stop(world: World, graph: RoadGraph): void {
    this.stopInternal(world, graph);
  }

  /** e2e/console probe. */
  debugState(): { active: boolean; t: number; victims: number; fallen: number; blocked: number } {
    return {
      active: this.active,
      t: this.t,
      victims: this.victims.length,
      fallen: this.victims.filter((v) => v.done).length,
      blocked: this.removedEdges.length,
    };
  }

  private stopInternal(world: World, graph: RoadGraph): void {
    if (!this.active && this.victims.length === 0) return;
    this.active = false;
    for (const [key] of this.affectedTiles) world.setCollapsedBuildings(key, new Set());
    this.affectedTiles.clear();
    for (const v of this.victims) {
      this.group.remove(v.mesh);
      v.mesh.geometry.dispose();
    }
    this.victims = [];
    if (this.rubble) {
      this.group.remove(this.rubble);
      this.rubble.geometry.dispose();
      this.rubble = null;
    }
    this.rubbleUsed = 0;
    for (const e of this.removedEdges) graph.restoreEdge(e);
    this.removedEdges = [];
    this.group.visible = false;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  /** Simple extruded footprint prism — the stand-in that tilts and sinks. */
  private buildPrism(spec: BuildingSpec, cx: number, cz: number): THREE.Mesh {
    const shape = new THREE.Shape(spec.outer.map((p) => new THREE.Vector2(p.x - cx, -(p.z - cz))));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: spec.height, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // extrude axis → up
    const mesh = new THREE.Mesh(geo, this.concrete);
    mesh.castShadow = true;
    return mesh;
  }

  private spawnRubble(v: Victim): void {
    if (!this.rubble) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    const place = (x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
      if (this.rubbleUsed >= this.rubble!.count) return;
      eul.set((Math.random() - 0.5) * 0.3, Math.random() * Math.PI, (Math.random() - 0.5) * 0.3);
      m.compose(new THREE.Vector3(x, y, z), q.setFromEuler(eul), new THREE.Vector3(sx, sy, sz));
      this.rubble!.setMatrixAt(this.rubbleUsed++, m);
    };
    for (let i = 0; i < 8; i++) {
      const sy = 0.7 + Math.random() * 1.3;
      place(
        v.cx + (Math.random() - 0.5) * 2 * v.rx,
        v.baseY + sy / 2,
        v.cz + (Math.random() - 0.5) * 2 * v.rz,
        1.8 + Math.random() * 3.2, sy, 1.8 + Math.random() * 3.2,
      );
    }
    if (v.blockPt) {
      for (let i = 0; i < 3; i++) {
        const sy = 0.6 + Math.random() * 0.9;
        place(
          v.blockPt.x + (Math.random() - 0.5) * 4,
          v.blockPt.y + sy / 2,
          v.blockPt.z + (Math.random() - 0.5) * 4,
          1.6 + Math.random() * 2.2, sy, 1.6 + Math.random() * 2.2,
        );
      }
    }
    this.rubble.instanceMatrix.needsUpdate = true;
  }

  /** Procedural rumble: filtered brown noise, no audio assets. The scenario
   * button click is the user gesture that unlocks the AudioContext. */
  private startRumble(): void {
    try {
      const ctx = new AudioContext();
      const dur = SHAKE_END + 1;
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        d[i] = last * 3.5;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 95;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.85, ctx.currentTime + 0.8);
      gain.gain.setValueAtTime(0.85, ctx.currentTime + 5.5);
      gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + SHAKE_END);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      src.start();
      this.audioCtx = ctx;
    } catch {
      // no audio available — the quake stays silent
    }
  }
}

/** Nearest drivable edge within `maxDist` of a point (rubble spill target). */
function nearestEdge(
  graph: RoadGraph,
  x: number,
  z: number,
  maxDist: number,
): { id: number; pt: THREE.Vector3 } | null {
  let best: { id: number; pt: THREE.Vector3 } | null = null;
  let bestD = maxDist;
  for (const e of graph.edges.values()) {
    const mid = e.pts[Math.floor(e.pts.length / 2)];
    if (Math.abs(mid.x - x) > 150 || Math.abs(mid.z - z) > 150) continue;
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1];
      const b = e.pts[i];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const l2 = abx * abx + abz * abz;
      if (l2 < 1e-9) continue;
      let t = ((x - a.x) * abx + (z - a.z) * abz) / l2;
      t = Math.min(Math.max(t, 0), 1);
      const px = a.x + abx * t;
      const pz = a.z + abz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bestD) {
        bestD = d;
        best = { id: e.id, pt: new THREE.Vector3(px, a.y + (b.y - a.y) * t, pz) };
      }
    }
  }
  return best;
}
