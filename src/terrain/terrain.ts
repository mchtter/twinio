import * as THREE from 'three';
import { CONFIG } from '../config';
import { GeoProjection, lon2tile, lat2tile, tile2lat, tile2lon, tileKey, TileBounds } from '../geo/proj';
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

  /** Await DEM coverage for a geographic box (+margin) — data tiles are only
   * built once every terrain tile they can touch is loaded, so nothing is ever
   * built on guessed heights. */
  async ensureCovering(b: TileBounds, marginM = 300): Promise<void> {
    const z = CONFIG.terrainZoom;
    const dLat = marginM / 111320;
    const midLat = (b.north + b.south) / 2;
    const dLon = marginM / (111320 * Math.cos((midLat * Math.PI) / 180));
    const x0 = Math.floor(lon2tile(b.west - dLon, z));
    const x1 = Math.floor(lon2tile(b.east + dLon, z));
    const y0 = Math.floor(lat2tile(b.north + dLat, z));
    const y1 = Math.floor(lat2tile(b.south - dLat, z));
    const jobs: Promise<void>[] = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        jobs.push(this.ensureTile(tx, ty));
      }
    }
    await Promise.all(jobs);
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
    // the radar DSM is noisy over water (±1-2 m) — snap near-sea-level values
    // to exactly 0 so the flat sea sheet never fights the terrain
    for (let i = 0; i < grid.length; i++) {
      if (Math.abs(grid[i]) < 0.8) grid[i] = 0;
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

    // slope-based tinting: neutral urban soil, steeper = rockier/darker.
    // Greens come from explicit OSM polygons, not the base terrain.
    const normals = geo.getAttribute('normal');
    const col = new Float32Array(size * size * 3);
    for (let k = 0; k < size * size; k++) {
      const ny = normals.getY(k);
      const steep = Math.min(Math.max((0.995 - ny) * 30, 0), 1);
      const h = grid[k];
      const hb = Math.min(Math.max(h / 500, 0), 1) * 0.12;
      col[k * 3] = 0.6 - steep * 0.06 - hb;
      col[k * 3 + 1] = 0.58 - steep * 0.08 - hb;
      col[k * 3 + 2] = 0.54 - steep * 0.1 - hb;
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
    const h00 = g[j * size + i];
    const h10 = g[j * size + i + 1];
    const h01 = g[(j + 1) * size + i];
    const h11 = g[(j + 1) * size + i + 1];
    // interpolate on the SAME triangles the terrain mesh renders (split on fu+fv=1);
    // bilinear would diverge from the visible surface by up to |h00+h11-h10-h01|/4
    if (fu + fv <= 1) return h00 + fu * (h10 - h00) + fv * (h01 - h00);
    return h11 + (1 - fu) * (h01 - h11) + (1 - fv) * (h10 - h11);
  };

  get tileCount(): number {
    return this.tiles.size;
  }
}
