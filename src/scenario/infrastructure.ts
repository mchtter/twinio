import * as THREE from 'three';
import { RoadGraph } from '../agents/graph';
import type { HeightSampler, PoiSpec, UtilitySpec } from '../types';
import { subdividePolyline } from '../world/geomUtils';
import { FIBER_VERT, FIBER_FRAG } from './trafficFlow';

/** Infrastructure scenario: the city's underground utilities as glowing fiber
 * lines beneath the streets, in the same hologram style as the traffic mode.
 *
 * Data honesty: OSM carries almost no real distribution network — mains live
 * in municipal GIS (the Faz 5 GeoJSON/WFS import will feed real geometry into
 * this same renderer). Until then the network is SYNTHESIZED from the street
 * graph, which is how real utilities are laid out anyway:
 *  - sewer main under every street centerline (~2.6 m deep), pulses flowing
 *    DOWNHILL (gravity), toxic green
 *  - water main offset to the right of the centerline (~1.4 m deep),
 *    pressurized fast pulses, electric blue
 *  - manholes at street junctions + every ~45 m along sewers (plus real OSM
 *    manhole nodes), hydrants from real OSM nodes
 *  - real mapped pipelines (man_made=pipeline, sparse) overlay in magenta */

const WATER: [number, number, number] = [0.15, 0.62, 1.0];
const SEWER: [number, number, number] = [0.45, 1.0, 0.22];
const PIPELINE: [number, number, number] = [1.0, 0.3, 0.9];

interface P3 {
  x: number;
  y: number;
  z: number;
}

export class InfraLayer {
  readonly group = new THREE.Group();
  private fiberMat: THREE.ShaderMaterial;
  private fiberMesh: THREE.Mesh;
  private markers: THREE.Object3D[] = [];
  private builtVersion = -1;

  constructor(scene: THREE.Scene) {
    this.fiberMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: FIBER_VERT,
      fragmentShader: FIBER_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false, // underground must shine through the terrain hologram
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.fiberMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.fiberMat);
    this.fiberMesh.frustumCulled = false;
    this.fiberMesh.renderOrder = 50;
    this.group.add(this.fiberMesh);
    this.group.visible = false;
    scene.add(this.group);
  }

  setActive(on: boolean): void {
    this.group.visible = on;
    if (on) this.builtVersion = -1;
  }

  update(
    dt: number,
    graph: RoadGraph,
    infra: () => { utilities: UtilitySpec[]; pois: PoiSpec[] },
    sample: HeightSampler,
  ): void {
    this.fiberMat.uniforms['uTime'].value += dt;
    if (graph.version !== this.builtVersion) {
      this.builtVersion = graph.version;
      this.rebuild(graph, infra(), sample);
    }
  }

  private rebuild(
    graph: RoadGraph,
    infra: { utilities: UtilitySpec[]; pois: PoiSpec[] },
    sample: HeightSampler,
  ): void {
    const pos: number[] = [];
    const aU: number[] = [];
    const aSide: number[] = [];
    const aFlow: number[] = [];
    const idx: number[] = [];

    const ribbon = (pts: P3[], color: [number, number, number], speed: number, halfW: number): void => {
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
        const px = -dz;
        const pz = dx;
        if (i > 0) u += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        const p = pts[i];
        pos.push(p.x - px * halfW, p.y, p.z - pz * halfW, p.x + px * halfW, p.y, p.z + pz * halfW);
        aU.push(u, u);
        aSide.push(-1, 1);
        aFlow.push(color[0], color[1], color[2], speed, color[0], color[1], color[2], speed);
        if (i > 0) {
          const v = start + i * 2;
          idx.push(v - 2, v - 1, v, v, v - 1, v + 1);
        }
      }
    };

    // manholes: junctions + interval spots, deduped on a coarse grid
    const manholes: P3[] = [];
    const mhSeen = new Set<string>();
    const addManhole = (x: number, z: number): void => {
      const k = `${Math.round(x / 6)}:${Math.round(z / 6)}`;
      if (mhSeen.has(k)) return;
      mhSeen.add(k);
      manholes.push({ x, y: sample(x, z) + 0.3, z });
    };

    // ---- synthesized street-following network ----
    for (const e of graph.edges.values()) {
      const pts = e.pts;
      if (pts.length < 2) continue;
      // no utilities inside a bridge deck: skip elevated edges
      const mid = pts[Math.floor(pts.length / 2)];
      if (mid.y - sample(mid.x, mid.z) > 1.5) continue;

      // sewer under the centerline, flowing downhill
      const aY = sample(pts[0].x, pts[0].z);
      const bY = sample(pts[pts.length - 1].x, pts[pts.length - 1].z);
      const order = aY >= bY ? pts : [...pts].reverse();
      const sewer: P3[] = order.map((p) => ({ x: p.x, y: sample(p.x, p.z) - 2.6, z: p.z }));
      ribbon(sewer, SEWER, 1.6, 1.05);

      // pressurized water main, offset to the right of the centerline
      const water: P3[] = [];
      for (let i = 0; i < pts.length; i++) {
        const prev = pts[Math.max(i - 1, 0)];
        const next = pts[Math.min(i + 1, pts.length - 1)];
        let dx = next.x - prev.x;
        let dz = next.z - prev.z;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l;
        dz /= l;
        const off = Math.min(e.halfW * 0.6, 2.0);
        const x = pts[i].x + -dz * off;
        const z = pts[i].z + dx * off;
        water.push({ x, y: sample(x, z) - 1.4, z });
      }
      ribbon(water, WATER, 4.5, 0.65);

      // interval manholes along the sewer
      let cum = 0;
      let next = 45;
      for (let i = 1; i < sewer.length; i++) {
        cum += Math.hypot(sewer[i].x - sewer[i - 1].x, sewer[i].z - sewer[i - 1].z);
        if (cum >= next) {
          addManhole(sewer[i].x, sewer[i].z);
          next += 45;
        }
      }
    }
    // junction manholes (graph node keys are quantized world coords)
    for (const [key, ids] of graph.nodes) {
      if (ids.length < 3) continue;
      const [x, z] = key.split(':').map(Number);
      addManhole(x, z);
    }

    // ---- real mapped utilities (sparse but honest) ----
    for (const u of infra.utilities) {
      if (u.pts.length < 2) continue;
      const sub = subdividePolyline(u.pts, 12);
      const depth = u.location === 'overground' || u.location === 'overhead' ? -0.6 : 3.2;
      const line: P3[] = sub.map((p) => ({ x: p.x, y: sample(p.x, p.z) - depth, z: p.z }));
      ribbon(line, PIPELINE, 3, 1.3);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aU', new THREE.Float32BufferAttribute(aU, 1));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(aSide, 1));
    geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(aFlow, 4));
    geo.setIndex(idx);
    this.fiberMesh.geometry.dispose();
    this.fiberMesh.geometry = geo;

    this.rebuildMarkers(manholes, infra.pois, sample);
  }

  /** Surface markers: cyan manhole rings + orange hydrant posts (real OSM nodes). */
  private rebuildMarkers(manholes: P3[], pois: PoiSpec[], sample: HeightSampler): void {
    for (const m of this.markers) {
      this.group.remove(m);
      (m as THREE.InstancedMesh).geometry.dispose();
      ((m as THREE.InstancedMesh).material as THREE.Material).dispose();
    }
    this.markers = [];

    for (const p of pois) {
      if (p.kind === 'manhole') manholes.push({ x: p.x, y: sample(p.x, p.z) + 0.3, z: p.z });
    }
    const hydrants = pois.filter((p) => p.kind === 'hydrant');

    const make = (geoSrc: THREE.BufferGeometry, color: number, points: P3[]): void => {
      if (points.length === 0) {
        geoSrc.dispose();
        return;
      }
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.InstancedMesh(geoSrc, mat, points.length);
      const m4 = new THREE.Matrix4();
      for (let i = 0; i < points.length; i++) {
        m4.makeTranslation(points[i].x, points[i].y, points[i].z);
        mesh.setMatrixAt(i, m4);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      mesh.renderOrder = 51;
      this.group.add(mesh);
      this.markers.push(mesh);
    };

    const ring = new THREE.RingGeometry(0.42, 0.72, 16);
    ring.rotateX(-Math.PI / 2);
    make(ring, 0x2fe0ff, manholes);

    const post = new THREE.CylinderGeometry(0.13, 0.16, 0.75, 8);
    post.translate(0, 0.4, 0);
    make(post, 0xff5a26, hydrants.map((h) => ({ x: h.x, y: sample(h.x, h.z), z: h.z })));
  }
}
