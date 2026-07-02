import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config';
import type { AreaSpec, PoiSpec, HeightSampler } from '../types';
import { pointInPolygon, polygonAreaAbs, ringBBox, seededRandom, hashStr } from './geomUtils';
import { getMaterials } from './materials';

/** Green/water/parking area polygons draped onto the terrain + instanced trees. */
export function buildAreas(
  areas: AreaSpec[],
  treePois: PoiSpec[],
  sample: HeightSampler,
): { areas: THREE.Object3D | null; trees: THREE.Object3D | null } {
  const geoBuckets: Record<string, THREE.BufferGeometry[]> = {
    grass: [], forest: [], sand: [], parking: [], water: [],
  };
  const treeSpots: { x: number; z: number; s: number }[] = [];

  for (const a of areas) {
    if (a.outer.length < 3) continue;
    const geo = polygonGeometry(a, sample);
    if (geo) geoBuckets[a.kind].push(geo);

    // scatter trees
    if (a.treeDensity > 0 && treeSpots.length < CONFIG.maxTreesPerTile) {
      const area = polygonAreaAbs(a.outer);
      const count = Math.min(Math.floor(area * a.treeDensity), CONFIG.maxTreesPerTile - treeSpots.length);
      if (count > 0) {
        const bb = ringBBox(a.outer);
        const rng = seededRandom(hashStr(a.id));
        let placed = 0;
        let tries = 0;
        const maxTries = count * 25;
        while (placed < count && tries < maxTries) {
          tries++;
          const x = bb.minX + rng() * (bb.maxX - bb.minX);
          const z = bb.minZ + rng() * (bb.maxZ - bb.minZ);
          if (!pointInPolygon(x, z, a.outer, a.holes)) continue;
          treeSpots.push({ x, z, s: 0.7 + rng() * 0.8 });
          placed++;
        }
      }
    }
  }
  for (const t of treePois) {
    if (t.kind === 'tree') treeSpots.push({ x: t.x, z: t.z, s: 0.9 + (hashStr(t.id) % 100) / 160 });
  }

  const mats = getMaterials();
  const group = new THREE.Group();
  const matFor: Record<string, THREE.Material> = {
    grass: mats.grass, forest: mats.forest, sand: mats.sand, parking: mats.parking, water: mats.water,
  };
  for (const [kind, geos] of Object.entries(geoBuckets)) {
    if (geos.length === 0) continue;
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, matFor[kind]);
    mesh.receiveShadow = kind !== 'water';
    mesh.userData.cat = kind === 'water' ? 'water' : 'areas';
    group.add(mesh);
  }
  group.userData.cat = 'areas';

  return {
    areas: group.children.length > 0 ? group : null,
    trees: treeSpots.length > 0 ? buildTrees(treeSpots, sample) : null,
  };
}

function polygonGeometry(a: AreaSpec, sample: HeightSampler): THREE.BufferGeometry | null {
  const shape = new THREE.Shape();
  shape.moveTo(a.outer[0].x, -a.outer[0].z);
  for (let i = 1; i < a.outer.length; i++) shape.lineTo(a.outer[i].x, -a.outer[i].z);
  shape.closePath();
  for (const h of a.holes) {
    if (h.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(h[0].x, -h[0].z);
    for (let i = 1; i < h.length; i++) path.lineTo(h[i].x, -h[i].z);
    path.closePath();
    shape.holes.push(path);
  }
  let geo: THREE.BufferGeometry;
  try {
    geo = new THREE.ShapeGeometry(shape);
  } catch {
    return null;
  }
  geo.rotateX(-Math.PI / 2); // (sx, sy, 0) -> (sx, 0, -sy) = local (x, 0, z)
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');

  if (a.kind === 'water') {
    // water is a flat sheet slightly below the lowest shore point
    let minH = Infinity;
    for (const p of a.outer) {
      const h = sample(p.x, p.z);
      if (h < minH) minH = h;
    }
    if (!isFinite(minH)) minH = 0;
    const y = Math.max(minH - 0.3, -0.2);
    for (let i = 0; i < pos.count; i++) pos.setY(i, y);
  } else {
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, sample(pos.getX(i), pos.getZ(i)) + CONFIG.yArea);
    }
  }
  // world-space uvs in meters (textures set their own repeat scale)
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, pos.getX(i), pos.getZ(i));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

let treeGeo: THREE.BufferGeometry | undefined;

/** Low-poly tree: trunk cylinder + icosahedron canopy, vertex-colored. */
function getTreeGeometry(): THREE.BufferGeometry {
  if (treeGeo) return treeGeo;
  // note: cylinder is indexed, icosahedron is not — normalize before merging
  const trunk = new THREE.CylinderGeometry(0.14, 0.2, 1.8, 5).toNonIndexed();
  trunk.translate(0, 0.9, 0);
  paintGeo(trunk, 0.42, 0.3, 0.2);
  const canopy = new THREE.IcosahedronGeometry(1.5, 1);
  canopy.scale(1, 1.25, 1);
  canopy.translate(0, 3.1, 0);
  paintGeo(canopy, 0.24, 0.42, 0.18);
  trunk.deleteAttribute('uv');
  canopy.deleteAttribute('uv');
  treeGeo = mergeGeometries([trunk, canopy], false)!;
  treeGeo.userData.shared = true;
  trunk.dispose();
  canopy.dispose();
  return treeGeo;
}

function paintGeo(g: THREE.BufferGeometry, r: number, gr: number, b: number): void {
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = r;
    col[i * 3 + 1] = gr;
    col[i * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

function buildTrees(spots: { x: number; z: number; s: number }[], sample: HeightSampler): THREE.Object3D {
  const mats = getMaterials();
  const mesh = new THREE.InstancedMesh(getTreeGeometry(), mats.tree, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  for (let i = 0; i < spots.length; i++) {
    const t = spots[i];
    q.setFromAxisAngle(up, (t.x * 13.7 + t.z * 7.3) % 6.28);
    m.compose(
      new THREE.Vector3(t.x, sample(t.x, t.z), t.z),
      q,
      new THREE.Vector3(t.s, t.s * (0.85 + ((i * 37) % 40) / 100), t.s),
    );
    mesh.setMatrixAt(i, m);
    const tint = 0.8 + ((i * 53) % 45) / 100;
    mesh.setColorAt(i, c.setRGB(tint, tint * (0.9 + ((i * 29) % 25) / 100), tint * 0.95));
  }
  mesh.castShadow = true;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.userData.cat = 'trees';
  return mesh;
}
