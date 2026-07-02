import { fromUrl, GeoTIFF, GeoTIFFImage } from 'geotiff';
import { CONFIG } from '../config';
import { tile2lat, tile2lon, tileKey } from '../geo/proj';
import { cacheGet, cacheSet } from '../geo/cache';

/** Elevation sources produce a (n+1)² row-major height grid for a slippy tile.
 * Row 0 = tile north edge, col 0 = west edge. Heights in meters (EGM-ish, close enough). */
export interface ElevationSource {
  readonly name: string;
  getGrid(z: number, x: number, y: number, n: number): Promise<Float32Array>;
}

/** Copernicus GLO-30 DSM, read directly from Cloud-Optimized GeoTIFFs on AWS Open Data. */
export class CopernicusSource implements ElevationSource {
  readonly name = 'Copernicus GLO-30';
  private cells = new Map<string, Promise<{ img: GeoTIFFImage; bbox: number[]; w: number; h: number } | null>>();
  private healthy = false;

  private cellUrl(latF: number, lonF: number): string {
    const latCell = (latF >= 0 ? 'N' : 'S') + String(Math.abs(latF)).padStart(2, '0');
    const lonCell = (lonF >= 0 ? 'E' : 'W') + String(Math.abs(lonF)).padStart(3, '0');
    return CONFIG.copernicusUrl(latCell, lonCell);
  }

  private getCell(latF: number, lonF: number) {
    const key = `${latF}/${lonF}`;
    let p = this.cells.get(key);
    if (!p) {
      p = this.openCell(latF, lonF);
      this.cells.set(key, p);
    }
    return p;
  }

  private async openCell(latF: number, lonF: number) {
    const url = this.cellUrl(latF, lonF);
    // Probe with a tiny ranged fetch so we can distinguish "no such cell" (ocean)
    // from "bucket unreachable" (network/CORS) — only the latter should trigger fallback.
    let resp: Response;
    try {
      resp = await fetch(url, { headers: { Range: 'bytes=0-3' } });
    } catch (e) {
      if (!this.healthy) throw new Error('copernicus-unavailable');
      return null;
    }
    if (!resp.ok && resp.status !== 206) {
      if (resp.status === 404 || resp.status === 403) return null; // ocean cell
      if (!this.healthy) throw new Error('copernicus-unavailable');
      return null;
    }
    this.healthy = true;
    const tiff: GeoTIFF = await fromUrl(url);
    const img = await tiff.getImage();
    return { img, bbox: img.getBoundingBox(), w: img.getWidth(), h: img.getHeight() };
  }

  async getGrid(z: number, x: number, y: number, n: number): Promise<Float32Array> {
    const size = n + 1;
    const out = new Float32Array(size * size);
    const lats = new Float64Array(size);
    const lons = new Float64Array(size);
    for (let j = 0; j < size; j++) lats[j] = tile2lat(y + j / n, z);
    for (let i = 0; i < size; i++) lons[i] = tile2lon(x + i / n, z);

    // Group grid points by 1°×1° DEM cell
    const groups = new Map<string, { latF: number; lonF: number; idx: number[] }>();
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const latF = Math.floor(lats[j]);
        const lonF = Math.floor(lons[i]);
        const key = `${latF}/${lonF}`;
        let g = groups.get(key);
        if (!g) {
          g = { latF, lonF, idx: [] };
          groups.set(key, g);
        }
        g.idx.push(j * size + i);
      }
    }

    for (const g of groups.values()) {
      const cell = await this.getCell(g.latF, g.lonF);
      if (!cell) continue; // ocean → 0
      const { img, bbox, w, h } = cell;
      const [west, south, east, north] = bbox;
      // pixel coords for each point in this group
      const pxs = new Float64Array(g.idx.length);
      const pys = new Float64Array(g.idx.length);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let k = 0; k < g.idx.length; k++) {
        const gi = g.idx[k];
        const lat = lats[Math.floor(gi / size)];
        const lon = lons[gi % size];
        const px = ((lon - west) / (east - west)) * w;
        const py = ((north - lat) / (north - south)) * h;
        pxs[k] = px; pys[k] = py;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      const x0 = Math.max(0, Math.floor(minX) - 1);
      const y0 = Math.max(0, Math.floor(minY) - 1);
      const x1 = Math.min(w, Math.ceil(maxX) + 2);
      const y1 = Math.min(h, Math.ceil(maxY) + 2);
      const rw = x1 - x0;
      const rh = y1 - y0;
      if (rw <= 0 || rh <= 0) continue;
      const rasters = await img.readRasters({ window: [x0, y0, x1, y1], samples: [0] });
      const data = (Array.isArray(rasters) ? rasters[0] : rasters) as unknown as ArrayLike<number>;
      for (let k = 0; k < g.idx.length; k++) {
        // bilinear between pixel centers
        const gx = Math.min(Math.max(pxs[k] - x0 - 0.5, 0), rw - 1.001);
        const gy = Math.min(Math.max(pys[k] - y0 - 0.5, 0), rh - 1.001);
        const ix = Math.floor(gx), iy = Math.floor(gy);
        const fx = gx - ix, fy = gy - iy;
        const i00 = data[iy * rw + ix] as number;
        const i10 = data[iy * rw + Math.min(ix + 1, rw - 1)] as number;
        const i01 = data[Math.min(iy + 1, rh - 1) * rw + ix] as number;
        const i11 = data[Math.min(iy + 1, rh - 1) * rw + Math.min(ix + 1, rw - 1)] as number;
        let v = i00 * (1 - fx) * (1 - fy) + i10 * fx * (1 - fy) + i01 * (1 - fx) * fy + i11 * fx * fy;
        if (!isFinite(v) || v < -1000) v = 0;
        out[g.idx[k]] = v;
      }
    }
    return out;
  }
}

/** Terrarium-encoded raster tiles (AWS Open Data joerd) — fallback DEM. */
export class TerrariumSource implements ElevationSource {
  readonly name = 'Terrarium DEM';
  private tiles = new Map<string, Promise<Float32Array>>();

  private getTile(z: number, x: number, y: number): Promise<Float32Array> {
    const key = tileKey(z, x, y);
    let p = this.tiles.get(key);
    if (!p) {
      p = this.decodeTile(z, x, y);
      this.tiles.set(key, p);
    }
    return p;
  }

  private async decodeTile(z: number, x: number, y: number): Promise<Float32Array> {
    const resp = await fetch(CONFIG.terrariumUrl(z, x, y));
    if (!resp.ok) throw new Error(`terrarium ${resp.status}`);
    const bmp = await createImageBitmap(await resp.blob());
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const d = img.data;
    const out = new Float32Array(bmp.width * bmp.height);
    for (let i = 0; i < out.length; i++) {
      out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
    }
    return out;
  }

  async getGrid(z: number, x: number, y: number, n: number): Promise<Float32Array> {
    const px = await this.getTile(z, x, y); // 256×256
    const size = n + 1;
    const out = new Float32Array(size * size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const gx = (i / n) * 255;
        const gy = (j / n) * 255;
        const ix = Math.floor(gx), iy = Math.floor(gy);
        const fx = gx - ix, fy = gy - iy;
        const ix1 = Math.min(ix + 1, 255), iy1 = Math.min(iy + 1, 255);
        out[j * size + i] =
          px[iy * 256 + ix] * (1 - fx) * (1 - fy) +
          px[iy * 256 + ix1] * fx * (1 - fy) +
          px[iy1 * 256 + ix] * (1 - fx) * fy +
          px[iy1 * 256 + ix1] * fx * fy;
      }
    }
    return out;
  }
}

/** Prefers Copernicus, permanently falls back to Terrarium if the bucket is unreachable. */
export class ElevationManager {
  private copernicus = new CopernicusSource();
  private terrarium = new TerrariumSource();
  private active: ElevationSource = this.copernicus;
  onSourceChange?: (name: string) => void;

  get sourceName(): string {
    return this.active.name;
  }

  async getGrid(z: number, x: number, y: number, n: number): Promise<Float32Array> {
    const key = `dem:${this.active.name}:${tileKey(z, x, y)}:${n}`;
    const cached = await cacheGet<ArrayBuffer>(key, CONFIG.osmCacheTtlMs);
    if (cached) return new Float32Array(cached);
    try {
      const grid = await this.active.getGrid(z, x, y, n);
      cacheSet(key, grid.buffer.slice(0) as ArrayBuffer);
      return grid;
    } catch (e) {
      if (this.active === this.copernicus) {
        this.active = this.terrarium;
        this.onSourceChange?.(this.active.name);
        return this.getGrid(z, x, y, n);
      }
      throw e;
    }
  }
}
