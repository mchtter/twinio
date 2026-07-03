import * as THREE from 'three';
import { CONFIG } from '../config';
import { GeoProjection, lon2tile, lat2tile, tile2lat, tile2lon, tileKey, TileBounds } from '../geo/proj';
import { ElevationManager } from './sources';
import { makeGroundTexture } from '../world/materials';
import { pointInPolygon } from '../world/geomUtils';
import type { V2 } from '../types';

interface TerrainTile {
  mesh: THREE.Mesh;
  grid: Float32Array;   // current heights (after cuts)
  orig: Float32Array;   // pristine DEM heights (cut anchors, wall tops)
  xs: Float32Array;     // world x per column (separable projection)
  zs: Float32Array;     // world z per row
  mask: HTMLCanvasElement | null; // white = keep, black = hole (tunnel trench)
  maskTex: THREE.CanvasTexture | null;
  tx: number;
  ty: number;
}

/** Underpass/tunnel corridor: centerline with target floor heights. Terrain
 * vertices inside the corridor are pushed down to the floor and the surface
 * fragments over it are discarded (alpha mask) — a real, drivable trench. */
export interface TerrainCut {
  id: string;
  pts: { x: number; z: number; y: number }[];
  halfWidth: number;
}

/** Streams DEM terrain tiles around the camera and provides height sampling
 * for every other layer (buildings, roads, props, agents, player). */
export class TerrainManager {
  private tiles = new Map<string, TerrainTile>();
  private loading = new Map<string, Promise<void>>();
  private material: THREE.MeshStandardMaterial;
  private cuts = new Map<string, TerrainCut>();
  private cutBoxes = new Map<string, { minX: number; maxX: number; minZ: number; maxZ: number }>();
  // sea polygons: the radar DSM is meters-noisy over straits/bays — terrain
  // under known water is pressed below the sea sheet so it can't poke through
  private waterZones = new Map<string, { polys: V2[][]; box: { minX: number; maxX: number; minZ: number; maxZ: number } }>();
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
      if (t.maskTex) t.maskTex.dispose();
    }
    this.tiles.clear();
    this.loading.clear();
    this.cuts.clear(); // cuts live in world coords — invalid after re-projection
    this.cutBoxes.clear();
    this.waterZones.clear();
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
        if (t.maskTex) t.maskTex.dispose();
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

  /** Register tunnel corridors; applies them to every loaded + future tile.
   * Idempotent per cut id — tiles register the same corridor independently. */
  registerCuts(cuts: TerrainCut[]): void {
    const fresh = cuts.filter((c) => c.pts.length >= 2 && !this.cuts.has(c.id));
    if (fresh.length === 0) return;
    for (const c of fresh) {
      this.cuts.set(c.id, c);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of c.pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
      const pad = c.halfWidth + 2;
      this.cutBoxes.set(c.id, { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad });
    }
    for (const t of this.tiles.values()) {
      let changed = false;
      for (const c of fresh) {
        if (this.applyCut(t, c)) changed = true;
      }
      if (changed) this.rebuildTile(t);
    }
  }

  /** Register a data tile's water polygons; presses the terrain under them
   * down to seabed on every loaded + future terrain tile. Idempotent per id. */
  registerWaterAreas(id: string, polys: V2[][]): void {
    if (polys.length === 0 || this.waterZones.has(id)) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const poly of polys) {
      for (const p of poly) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
    }
    const zone = { polys, box: { minX, maxX, minZ, maxZ } };
    this.waterZones.set(id, zone);
    for (const t of this.tiles.values()) {
      if (this.applyWater(t, zone)) this.rebuildTile(t);
    }
  }

  private applyWater(
    t: TerrainTile,
    zone: { polys: V2[][]; box: { minX: number; maxX: number; minZ: number; maxZ: number } },
  ): boolean {
    const n = CONFIG.terrainGrid;
    const size = n + 1;
    const b = zone.box;
    if (b.maxX < t.xs[0] || b.minX > t.xs[n] || b.maxZ < t.zs[0] || b.minZ > t.zs[n]) return false;
    let changed = false;
    for (let j = 0; j < size; j++) {
      const vz = t.zs[j];
      if (vz < b.minZ || vz > b.maxZ) continue;
      for (let i = 0; i < size; i++) {
        const vx = t.xs[i];
        if (vx < b.minX || vx > b.maxX) continue;
        const k = j * size + i;
        if (t.grid[k] <= -0.6) continue;
        for (const poly of zone.polys) {
          if (pointInPolygon(vx, vz, poly, [])) {
            t.grid[k] = -0.6;
            changed = true;
            break;
          }
        }
      }
    }
    return changed;
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

    const size = n + 1;
    const xs = new Float32Array(size);
    const zs = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      xs[i] = this.proj.toWorld(this.proj.originLat, tile2lon(tx + i / n, z)).x;
      zs[i] = this.proj.toWorld(tile2lat(ty + i / n, z), this.proj.originLon).z;
    }
    const tile: TerrainTile = {
      mesh: null as unknown as THREE.Mesh,
      grid, orig: grid.slice(), xs, zs, mask: null, maskTex: null, tx, ty,
    };
    for (const c of this.cuts.values()) this.applyCut(tile, c);
    for (const w of this.waterZones.values()) this.applyWater(tile, w);
    tile.mesh = this.buildMesh(tile, n);
    this.tiles.set(tileKey(z, tx, ty), tile);
    this.group.add(tile.mesh);
  }

  /** Lower grid vertices inside the corridor + paint the discard mask.
   * Returns true when the tile visually changed. */
  private applyCut(t: TerrainTile, cut: TerrainCut): boolean {
    const n = CONFIG.terrainGrid;
    const size = n + 1;
    const xs = t.xs, zs = t.zs;
    // corridor bbox vs tile bbox quick reject
    let cMinX = Infinity, cMaxX = -Infinity, cMinZ = Infinity, cMaxZ = -Infinity;
    for (const p of cut.pts) {
      if (p.x < cMinX) cMinX = p.x;
      if (p.x > cMaxX) cMaxX = p.x;
      if (p.z < cMinZ) cMinZ = p.z;
      if (p.z > cMaxZ) cMaxZ = p.z;
    }
    const pad = cut.halfWidth + 2;
    if (cMaxX + pad < xs[0] || cMinX - pad > xs[n] || cMaxZ + pad < zs[0] || cMinZ - pad > zs[n]) return false;

    let changed = false;
    // 1) vertex lowering: any grid vertex within halfWidth of the centerline
    //    drops to the corridor floor — the trench banks form from the mesh itself
    for (let j = 0; j < size; j++) {
      const vz = zs[j];
      if (vz < cMinZ - pad || vz > cMaxZ + pad) continue;
      for (let i = 0; i < size; i++) {
        const vx = xs[i];
        if (vx < cMinX - pad || vx > cMaxX + pad) continue;
        const hit = nearestOnCut(cut, vx, vz);
        if (hit.d <= cut.halfWidth) {
          const target = hit.y - 0.35;
          const k = j * size + i;
          if (t.grid[k] > target) {
            t.grid[k] = target;
            changed = true;
          }
        }
      }
    }
    // 2) discard mask: only where the corridor is genuinely buried (orig terrain
    //    above the floor) — portals at grade stay untouched
    const S = 512;
    const tileW = xs[n] - xs[0];
    const tileH = zs[n] - zs[0];
    const rPx = ((cut.halfWidth - 0.5) / tileW) * S;
    if (rPx > 0.5) {
      let ctx: CanvasRenderingContext2D | null = null;
      const step = 2.5;
      for (let s = 1; s < cut.pts.length; s++) {
        const a = cut.pts[s - 1];
        const b = cut.pts[s];
        const segLen = Math.hypot(b.x - a.x, b.z - a.z);
        const steps = Math.max(1, Math.ceil(segLen / step));
        for (let q = 0; q <= steps; q++) {
          const f = q / steps;
          const px = a.x + (b.x - a.x) * f;
          const pz = a.z + (b.z - a.z) * f;
          if (px < xs[0] - 2 || px > xs[n] + 2 || pz < zs[0] - 2 || pz > zs[n] + 2) continue;
          const floorY = a.y + (b.y - a.y) * f;
          const above = this.sampleGrid(t, px, pz, t.orig);
          if (above === null || above < floorY + 0.6) continue; // not buried here
          if (!ctx) {
            if (!t.mask) {
              t.mask = document.createElement('canvas');
              t.mask.width = t.mask.height = S;
              const c0 = t.mask.getContext('2d')!;
              c0.fillStyle = '#fff';
              c0.fillRect(0, 0, S, S);
            }
            ctx = t.mask.getContext('2d')!;
            ctx.fillStyle = '#000';
          }
          const u = ((px - xs[0]) / tileW) * S;
          const v = ((pz - zs[0]) / tileH) * S;
          ctx.beginPath();
          ctx.arc(u, v, rPx, 0, Math.PI * 2);
          ctx.fill();
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Rebuild a tile's mesh in place after cuts changed its grid/mask. */
  private rebuildTile(t: TerrainTile): void {
    this.group.remove(t.mesh);
    t.mesh.geometry.dispose();
    if (t.maskTex) {
      t.maskTex.dispose();
      t.maskTex = null;
    }
    t.mesh = this.buildMesh(t, CONFIG.terrainGrid);
    this.group.add(t.mesh);
  }

  private buildMesh(t: TerrainTile, n: number): THREE.Mesh {
    const size = n + 1;
    const grid = t.grid;
    const pos = new Float32Array(size * size * 3);
    const uv = new Float32Array(size * size * 2);
    const uv1 = new Float32Array(size * size * 2);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const k = j * size + i;
        pos[k * 3] = t.xs[i];
        pos[k * 3 + 1] = grid[k];
        pos[k * 3 + 2] = t.zs[j];
        uv[k * 2] = t.xs[i] / 24;
        uv[k * 2 + 1] = t.zs[j] / 24;
        uv1[k * 2] = i / n;
        uv1[k * 2 + 1] = j / n;
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
    geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
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

    // tunnel trench: per-tile material clone with a discard mask (uv1 channel)
    let mat: THREE.MeshStandardMaterial = this.material;
    if (t.mask) {
      const tex = new THREE.CanvasTexture(t.mask);
      tex.flipY = false;
      tex.channel = 1;
      t.maskTex = tex;
      mat = this.material.clone();
      mat.alphaMap = tex;
      mat.alphaTest = 0.5;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = `terrain-${t.tx}-${t.ty}`;
    return mesh;
  }

  /** Triangle-consistent sample of a specific tile's grid, or null if outside. */
  private sampleGrid(t: TerrainTile, x: number, zc: number, grid: Float32Array): number | null {
    const z = CONFIG.terrainZoom;
    const n = CONFIG.terrainGrid;
    const geo = this.proj.toGeo(x, zc);
    const fx = lon2tile(geo.lon, z);
    const fy = lat2tile(geo.lat, z);
    if (Math.floor(fx) !== t.tx || Math.floor(fy) !== t.ty) return null;
    const size = n + 1;
    const u = Math.min(Math.max((fx - t.tx) * n, 0), n - 1e-6);
    const v = Math.min(Math.max((fy - t.ty) * n, 0), n - 1e-6);
    const i = Math.floor(u), j = Math.floor(v);
    const fu = u - i, fv = v - j;
    const h00 = grid[j * size + i];
    const h10 = grid[j * size + i + 1];
    const h01 = grid[(j + 1) * size + i];
    const h11 = grid[(j + 1) * size + i + 1];
    if (fu + fv <= 1) return h00 + fu * (h10 - h00) + fv * (h01 - h00);
    return h11 + (1 - fu) * (h01 - h11) + (1 - fv) * (h10 - h11);
  }

  private samplerFor(pick: (t: TerrainTile) => Float32Array) {
    return (x: number, zc: number): number => {
      const z = CONFIG.terrainZoom;
      const geo = this.proj.toGeo(x, zc);
      let tx = Math.floor(lon2tile(geo.lon, z));
      let ty = Math.floor(lat2tile(geo.lat, z));
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
      const n = CONFIG.terrainGrid;
      const size = n + 1;
      const fx = lon2tile(geo.lon, z);
      const fy = lat2tile(geo.lat, z);
      const u = Math.min(Math.max((fx - tx) * n, 0), n - 1e-6);
      const v = Math.min(Math.max((fy - ty) * n, 0), n - 1e-6);
      const i = Math.floor(u), j = Math.floor(v);
      const fu = u - i, fv = v - j;
      const g = pick(tile);
      const h00 = g[j * size + i];
      const h10 = g[j * size + i + 1];
      const h01 = g[(j + 1) * size + i];
      const h11 = g[(j + 1) * size + i + 1];
      // interpolate on the SAME triangles the terrain mesh renders (split on fu+fv=1);
      // bilinear would diverge from the visible surface by up to |h00+h11-h10-h01|/4
      if (fu + fv <= 1) return h00 + fu * (h10 - h00) + fv * (h01 - h00);
      return h11 + (1 - fu) * (h01 - h11) + (1 - fv) * (h10 - h11);
    };
  }

  /** Bilinear height sample at world coords (current surface, incl. cuts). */
  sample = this.samplerFor((t) => t.grid);

  /** Pristine DEM sample (pre-cut). World geometry drapes on THIS — the cut
   * only opens the terrain mesh, so at-grade roads bridge over the trench. */
  sampleOriginal = this.samplerFor((t) => t.orig);

  /** Trench depth under a point (0 = outside every tunnel corridor). Used to
   * drop draped area triangles that would float as lids over the trench. */
  /** Is this point inside a registered water polygon (sea)? */
  isWaterAt = (x: number, z: number): boolean => {
    for (const w of this.waterZones.values()) {
      const b = w.box;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      for (const poly of w.polys) {
        if (pointInPolygon(x, z, poly, [])) return true;
      }
    }
    return false;
  };

  cutDepthAt = (x: number, z: number): number => {
    let depth = 0;
    for (const c of this.cuts.values()) {
      const box = this.cutBoxes.get(c.id);
      if (box && (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ)) continue;
      const hit = nearestOnCut(c, x, z);
      if (hit.d <= c.halfWidth + 1) {
        const d = this.sampleOriginal(x, z) - (hit.y - 0.35);
        if (d > depth) depth = d;
      }
    }
    return depth;
  };

  get tileCount(): number {
    return this.tiles.size;
  }
}

/** Closest point on a cut centerline: distance + interpolated floor height. */
function nearestOnCut(cut: TerrainCut, x: number, z: number): { d: number; y: number } {
  let bestD = Infinity;
  let bestY = 0;
  for (let s = 1; s < cut.pts.length; s++) {
    const a = cut.pts[s - 1];
    const b = cut.pts[s];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const l2 = abx * abx + abz * abz;
    if (l2 < 1e-9) continue;
    let t = ((x - a.x) * abx + (z - a.z) * abz) / l2;
    t = Math.min(Math.max(t, 0), 1);
    const dx = x - (a.x + abx * t);
    const dz = z - (a.z + abz * t);
    const d = Math.hypot(dx, dz);
    if (d < bestD) {
      bestD = d;
      bestY = a.y + (b.y - a.y) * t;
    }
  }
  return { d: bestD, y: bestY };
}
