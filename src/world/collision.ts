import type { BuildingSpec } from '../types';

interface Edge {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  tile: string;
}

const CELL = 8; // meters

/** 2D collision index over building footprint edges (walk mode).
 * Uniform grid hash; player is resolved as a circle pushed out of nearby edges. */
export class CollisionIndex {
  private cells = new Map<string, Edge[]>();

  addTile(tile: string, buildings: BuildingSpec[]): void {
    for (const b of buildings) {
      for (const ring of [b.outer, ...b.holes]) {
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i];
          const q = ring[(i + 1) % ring.length];
          this.insert({ ax: p.x, az: p.z, bx: q.x, bz: q.z, tile });
        }
      }
    }
  }

  removeTile(tile: string): void {
    for (const [key, edges] of this.cells) {
      const kept = edges.filter((e) => e.tile !== tile);
      if (kept.length === 0) this.cells.delete(key);
      else if (kept.length !== edges.length) this.cells.set(key, kept);
    }
  }

  clear(): void {
    this.cells.clear();
  }

  private insert(e: Edge): void {
    const minX = Math.floor(Math.min(e.ax, e.bx) / CELL);
    const maxX = Math.floor(Math.max(e.ax, e.bx) / CELL);
    const minZ = Math.floor(Math.min(e.az, e.bz) / CELL);
    const maxZ = Math.floor(Math.max(e.az, e.bz) / CELL);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const key = `${cx},${cz}`;
        let arr = this.cells.get(key);
        if (!arr) {
          arr = [];
          this.cells.set(key, arr);
        }
        arr.push(e);
      }
    }
  }

  /** Push a circle of radius r out of all nearby footprint edges. */
  resolve(x: number, z: number, r: number): { x: number; z: number } {
    for (let pass = 0; pass < 2; pass++) {
      const cx = Math.floor(x / CELL);
      const cz = Math.floor(z / CELL);
      let moved = false;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const edges = this.cells.get(`${cx + dx},${cz + dz}`);
          if (!edges) continue;
          for (const e of edges) {
            const abx = e.bx - e.ax;
            const abz = e.bz - e.az;
            const l2 = abx * abx + abz * abz;
            if (l2 < 1e-9) continue;
            let t = ((x - e.ax) * abx + (z - e.az) * abz) / l2;
            t = Math.min(Math.max(t, 0), 1);
            const px = e.ax + abx * t;
            const pz = e.az + abz * t;
            let dxp = x - px;
            let dzp = z - pz;
            const d = Math.hypot(dxp, dzp);
            if (d >= r) continue;
            if (d < 1e-6) {
              // dead center on the edge: push along the edge normal
              const l = Math.sqrt(l2);
              dxp = -abz / l;
              dzp = abx / l;
              x += dxp * r;
              z += dzp * r;
            } else {
              x += (dxp / d) * (r - d);
              z += (dzp / d) * (r - d);
            }
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    return { x, z };
  }
}
