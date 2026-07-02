import * as THREE from 'three';
import { CONFIG } from '../config';
import { GeoProjection, lon2tile, lat2tile, tile2lat, tile2lon, tileKey } from '../geo/proj';
import { ElevationManager } from './sources';
import { makeGroundTexture } from '../world/materials';

interface TerrainTile {
  mesh: THREE.Mesh;
  grid: Float32Array;
  tx: number;
  ty: number;
}

/** Streams DEM terrain tiles around the camera and provides height sampling
 * for every other layer (buildings, roads, props, agents, player). */
export class TerrainManager {
  private tiles = new Map<string, TerrainTile>();
  private loading = new Map<string, Promise<void>>();
  private material: THREE.MeshStandardMaterial;
  readonly group = new THREE.Group();
  generation = 0;

  constructor(
    private scene: THREE.Scene,
    private elevation: ElevationManager,
    public proj: GeoProjection,
  ) {
    const tex = makeGroundTexture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    this.material = new THREE.MeshStandardMaterial({
      map: tex,
      vertexColors: true,
      roughness: 1.0,
      metalness: 0.0,
    });
    this.group.name = 'terrain';
    scene.add(this.group);
  }

  reset(proj: GeoProjection): void {
    this.generation++;
    for (const t of this.tiles.values()) {
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
    }
    this.tiles.clear();
    this.loading.clear();
    this.proj = proj;
  }

  /** Ensure the 3×3 (radius) neighborhood of terrain tiles around lat/lon is loaded. */
  async ensureAround(lat: number, lon: number): Promise<void> {
    const z = CONFIG.terrainZoom;
    const cx = Math.floor(lon2tile(lon, z));
    const cy = Math.floor(lat2tile(lat, z));
    const r = CONFIG.terrainRadius;
    const jobs: Promise<void>[] = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        jobs.push(this.ensureTile(cx + dx, cy + dy));
      }
    }
    await Promise.all(jobs);
    // unload far tiles
    for (const [key, t] of this.tiles) {
      if (Math.max(Math.abs(t.tx - cx), Math.abs(t.ty - cy)) > CONFIG.terrainUnloadRadius) {
        this.group.remove(t.mesh);
        t.mesh.geometry.dispose();
        this.tiles.delete(key);
      }
    }
  }

  ensureTile(tx: number, ty: number): Promise<void> {
    const key = tileKey(CONFIG.terrainZoom, tx, ty);
    if (this.tiles.has(key)) return Promise.resolve();
    let p = this.loading.get(key);
    if (!p) {
      const gen = this.generation;
      p = this.loadTile(tx, ty, gen).finally(() => this.loading.delete(key));
      this.loading.set(key, p);
    }
    return p;
  }

  private async loadTile(tx: number, ty: number, gen: number): Promise<void> {
    const z = CONFIG.terrainZoom;
    const n = CONFIG.terrainGrid;
    let grid: Float32Array;
    try {
      grid = await this.elevation.getGrid(z, tx, ty, n);
    } catch (e) {
      console.warn('DEM tile failed', tx, ty, e);
      grid = new Float32Array((n + 1) * (n + 1));
    }
    if (gen !== this.generation) return;
    const mesh = this.buildMesh(grid, tx, ty, n);
    this.tiles.set(tileKey(z, tx, ty), { mesh, grid, tx, ty });
    this.group.add(mesh);
  }

  private buildMesh(grid: Float32Array, tx: number, ty: number, n: number): THREE.Mesh {
    const z = CONFIG.terrainZoom;
    const size = n + 1;
    const pos = new Float32Array(size * size * 3);
    const uv = new Float32Array(size * size * 2);
    for (let j = 0; j < size; j++) {
      const lat = tile2lat(ty + j / n, z);
      for (let i = 0; i < size; i++) {
        const lon = tile2lon(tx + i / n, z);
        const w = this.proj.toWorld(lat, lon);
        const k = j * size + i;
        pos[k * 3] = w.x;
        pos[k * 3 + 1] = grid[k];
        pos[k * 3 + 2] = w.z;
        uv[k * 2] = w.x / 24;
        uv[k * 2 + 1] = w.z / 24;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * size + i;
        const b = (j + 1) * size + i;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    // slope-based tinting: steep = rocky brown, flat = greenish
    const normals = geo.getAttribute('normal');
    const col = new Float32Array(size * size * 3);
    for (let k = 0; k < size * size; k++) {
      const ny = normals.getY(k);
      const steep = Math.min(Math.max((0.995 - ny) * 30, 0), 1);
      const h = grid[k];
      const hb = Math.min(Math.max(h / 400, 0), 1) * 0.15;
      col[k * 3] = 0.62 + steep * 0.1 - hb;
      col[k * 3 + 1] = 0.66 - steep * 0.12 - hb;
      col[k * 3 + 2] = 0.52 - steep * 0.14 - hb;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.name = `terrain-${tx}-${ty}`;
    return mesh;
  }

  /** Bilinear height sample at world coords. Clamps to nearest loaded tile if outside. */
  sample = (x: number, zc: number): number => {
    const geo = this.proj.toGeo(x, zc);
    const z = CONFIG.terrainZoom;
    const n = CONFIG.terrainGrid;
    const fx = lon2tile(geo.lon, z);
    const fy = lat2tile(geo.lat, z);
    let tx = Math.floor(fx);
    let ty = Math.floor(fy);
    let tile = this.tiles.get(tileKey(z, tx, ty));
    if (!tile) {
      // clamp to nearest loaded tile (grid distance)
      let best: TerrainTile | undefined;
      let bestD = Infinity;
      for (const t of this.tiles.values()) {
        const d = Math.max(Math.abs(t.tx - tx), Math.abs(t.ty - ty));
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      if (!best) return 0;
      tile = best;
      tx = tile.tx;
      ty = tile.ty;
    }
    const size = n + 1;
    const u = Math.min(Math.max((fx - tx) * n, 0), n - 1e-6);
    const v = Math.min(Math.max((fy - ty) * n, 0), n - 1e-6);
    const i = Math.floor(u), j = Math.floor(v);
    const fu = u - i, fv = v - j;
    const g = tile.grid;
    return (
      g[j * size + i] * (1 - fu) * (1 - fv) +
      g[j * size + i + 1] * fu * (1 - fv) +
      g[(j + 1) * size + i] * (1 - fu) * fv +
      g[(j + 1) * size + i + 1] * fu * fv
    );
  };

  get tileCount(): number {
    return this.tiles.size;
  }
}
