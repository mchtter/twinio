import * as THREE from 'three';
import { RoadGraph } from '../agents/graph';

/** Traffic-flow scenario: the drivable graph is re-drawn as glowing fiber
 * ribbons. Light pulses run in the travel direction — their SPEED is the live
 * average vehicle speed on that edge+direction, their COLOR is the fluidity
 * (cyan = free flow → amber → red = jammed) and their BRIGHTNESS rises with
 * vehicle density. Fed by the agent simulation itself, so a queue forming at
 * a red light is visible as a red, slow-crawling fiber in real time. */

/** Per edge+direction live stats, keyed `${edgeId}:${sign}`. */
export type FlowStats = Map<string, { n: number; sumV: number }>;

interface Range {
  key: string;
  speed: number; // free-flow speed of the edge
  len: number;
  start: number; // first vertex
  count: number;
}

export const FIBER_VERT = /* glsl */ `
attribute float aU;
attribute float aSide;
attribute vec4 aFlow; // rgb = fluidity color * brightness, w = pulse speed m/s
varying float vU;
varying float vSide;
varying vec4 vFlow;
void main() {
  vU = aU;
  vSide = aSide;
  vFlow = aFlow;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const FIBER_FRAG = /* glsl */ `
uniform float uTime;
varying float vU;
varying float vSide;
varying vec4 vFlow;
void main() {
  // comet pulses sliding toward +u (the travel direction), 16 m wavelength
  float ph = fract((vU - uTime * vFlow.w) / 16.0);
  float comet = pow(1.0 - ph, 3.0);
  // soft fiber core: bright center, glow falloff to the ribbon edges
  float lat = 1.0 - abs(vSide);
  float glow = lat * lat;
  vec3 c = vFlow.rgb * (0.22 + 1.7 * comet) * glow;
  gl_FragColor = vec4(c, 1.0);
}
`;

/** Fluidity color ramp: 1 → cyan, ~0.5 → amber, ≤0.15 → red. */
function ramp(t: number): [number, number, number] {
  const mix = (a: [number, number, number], b: [number, number, number], k: number): [number, number, number] =>
    [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const cyan: [number, number, number] = [0.15, 0.95, 1.0];
  const amber: [number, number, number] = [1.0, 0.68, 0.12];
  const red: [number, number, number] = [1.0, 0.08, 0.25];
  if (t > 0.55) return mix(amber, cyan, (t - 0.55) / 0.45);
  return mix(red, amber, Math.max(0, (t - 0.12) / 0.43));
}

export class TrafficFibers {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private ranges: Range[] = [];
  private builtVersion = -1;
  private statTimer = 0;
  private flows: FlowStats = new Map();

  constructor(scene: THREE.Scene) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: FIBER_VERT,
      fragmentShader: FIBER_FRAG,
      transparent: true,
      depthWrite: false,
      // no depth test: the renderer's logarithmic depth buffer would reject a
      // plain ShaderMaterial's fragments, and a hologram overlay should shine
      // through buildings/terrain anyway
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 50; // after the transparent hologram shells
    scene.add(this.mesh);
  }

  setActive(on: boolean): void {
    this.mesh.visible = on;
    if (on) this.builtVersion = -1; // force a rebuild against the current graph
  }

  update(dt: number, graph: RoadGraph, getFlows: (out: FlowStats) => void): void {
    this.mat.uniforms['uTime'].value += dt;
    if (graph.version !== this.builtVersion) {
      this.rebuild(graph);
      this.builtVersion = graph.version;
      this.statTimer = 0;
    }
    this.statTimer -= dt;
    if (this.statTimer <= 0) {
      this.statTimer = 0.4;
      getFlows(this.flows);
      this.refreshFlow();
    }
  }

  /** One ribbon per edge+direction (two-way edges get two, offset to their
   * right-hand side like the vehicles). u runs along the travel direction. */
  private rebuild(graph: RoadGraph): void {
    const pos: number[] = [];
    const aU: number[] = [];
    const aSide: number[] = [];
    const idx: number[] = [];
    this.ranges = [];
    const HALF = 0.9; // fiber half-width

    for (const e of graph.edges.values()) {
      for (const sign of e.oneway ? [1] : [1, -1]) {
        const pts = sign > 0 ? e.pts : [...e.pts].reverse();
        const lateral = e.oneway ? 0 : Math.min(e.halfW * 0.5, 1.5);
        const start = pos.length / 3;
        let u = 0;
        for (let i = 0; i < pts.length; i++) {
          const prev = pts[Math.max(i - 1, 0)];
          const next = pts[Math.min(i + 1, pts.length - 1)];
          let dx = next.x - prev.x;
          let dz = next.z - prev.z;
          const l = Math.hypot(dx, dz) || 1;
          dx /= l;
          dz /= l;
          const px = -dz; // right of travel
          const pz = dx;
          if (i > 0) u += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
          const cx = pts[i].x + px * lateral;
          const cy = pts[i].y + 0.55;
          const cz = pts[i].z + pz * lateral;
          pos.push(cx - px * HALF, cy, cz - pz * HALF, cx + px * HALF, cy, cz + pz * HALF);
          aU.push(u, u);
          aSide.push(-1, 1);
          if (i > 0) {
            const v = start + i * 2;
            idx.push(v - 2, v - 1, v, v, v - 1, v + 1);
          }
        }
        this.ranges.push({ key: `${e.id}:${sign}`, speed: e.speed, len: e.len, start, count: pts.length * 2 });
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aU', new THREE.Float32BufferAttribute(aU, 1));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(aSide, 1));
    geo.setAttribute('aFlow', new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
    geo.setIndex(idx);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
  }

  private refreshFlow(): void {
    const attr = this.mesh.geometry.getAttribute('aFlow') as THREE.BufferAttribute | undefined;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    for (const r of this.ranges) {
      const f = this.flows.get(r.key);
      let speed: number;
      let bright: number;
      let ratio: number;
      if (!f || f.n === 0) {
        // empty road: free-flow ghost pulse, dim
        speed = r.speed;
        ratio = 1;
        bright = 0.3;
      } else {
        const avg = f.sumV / f.n;
        speed = Math.max(avg, 0.6); // jammed fibers crawl, never freeze
        ratio = Math.min(avg / r.speed, 1);
        bright = 0.55 + 0.45 * Math.min(1, (f.n * 60) / r.len);
      }
      const [cr, cg, cb] = ramp(ratio);
      for (let i = r.start; i < r.start + r.count; i++) {
        arr[i * 4] = cr * bright;
        arr[i * 4 + 1] = cg * bright;
        arr[i * 4 + 2] = cb * bright;
        arr[i * 4 + 3] = speed;
      }
    }
    attr.needsUpdate = true;
  }
}
