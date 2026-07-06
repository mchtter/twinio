import type { BuildingSpec, RoadSpec, AreaSpec, PoiSpec, V2 } from '../types';
import { pointInPolygon, polygonAreaAbs, ringBBox } from './geomUtils';
import type { JunctionInfo } from './roads';
import type { ParkingLotMeta } from './parking';

/** Everything the engine knows about a clicked point — debug/inspector data. */
export interface InspectResult {
  building?: BuildingSpec;
  roads: { spec: RoadSpec; dist: number }[];
  junction?: JunctionInfo & { dist: number };
  areas: AreaSpec[];
  poi?: PoiSpec & { dist: number };
  lot?: ParkingLotMeta;
}

interface TileFeatures {
  buildings: { spec: BuildingSpec; bb: { minX: number; minZ: number; maxX: number; maxZ: number } }[];
  roads: RoadSpec[];
  areas: { spec: AreaSpec; bb: { minX: number; minZ: number; maxX: number; maxZ: number }; size: number }[];
  pois: PoiSpec[];
  junctions: JunctionInfo[];
  lots: Map<string, ParkingLotMeta>;
}

/** Per-tile registry of parsed features for point queries (click-to-inspect).
 * Kept as raw specs — the inspector shows OSM tags AND engine decisions. */
export class FeatureIndex {
  private tiles = new Map<string, TileFeatures>();

  addTile(
    key: string,
    data: {
      buildings: BuildingSpec[];
      roads: RoadSpec[];
      areas: AreaSpec[];
      pois: PoiSpec[];
      junctions: JunctionInfo[];
      lots: ParkingLotMeta[];
    },
  ): void {
    this.tiles.set(key, {
      buildings: data.buildings
        .filter((b) => b.outer.length >= 3)
        .map((b) => ({ spec: b, bb: ringBBox(b.outer) })),
      roads: data.roads,
      areas: data.areas
        .filter((a) => a.outer.length >= 3)
        .map((a) => ({ spec: a, bb: ringBBox(a.outer), size: polygonAreaAbs(a.outer) })),
      pois: data.pois,
      junctions: data.junctions,
      lots: new Map(data.lots.map((l) => [l.id, l])),
    });
  }

  removeTile(key: string): void {
    this.tiles.delete(key);
  }

  /** Raw building specs of one tile (earthquake scenario rebuilds from these). */
  buildingsOf(key: string): BuildingSpec[] | null {
    const t = this.tiles.get(key);
    return t ? t.buildings.map((b) => b.spec) : null;
  }

  *allBuildings(): IterableIterator<{ key: string; spec: BuildingSpec }> {
    for (const [key, t] of this.tiles) {
      for (const b of t.buildings) yield { key, spec: b.spec };
    }
  }

  /** Collect every feature at/near a world point. */
  query(x: number, z: number): InspectResult {
    const out: InspectResult = { roads: [], areas: [] };
    let bestJn = Infinity;
    let bestPoi = 4;

    for (const t of this.tiles.values()) {
      for (const b of t.buildings) {
        if (out.building) break;
        if (x < b.bb.minX - 1 || x > b.bb.maxX + 1 || z < b.bb.minZ - 1 || z > b.bb.maxZ + 1) continue;
        if (pointInPolygon(x, z, b.spec.outer, b.spec.holes)) out.building = b.spec;
      }
      for (const r of t.roads) {
        const d = distToPolyline(x, z, r.pts);
        if (d <= r.width / 2 + 3) out.roads.push({ spec: r, dist: d });
      }
      for (const j of t.junctions) {
        const d = Math.hypot(x - j.x, z - j.z);
        if (d <= j.ext + 3 && d < bestJn) {
          bestJn = d;
          out.junction = { ...j, dist: d };
        }
      }
      for (const a of t.areas) {
        if (x < a.bb.minX || x > a.bb.maxX || z < a.bb.minZ || z > a.bb.maxZ) continue;
        if (pointInPolygon(x, z, a.spec.outer, a.spec.holes)) {
          out.areas.push(a.spec);
          if (a.spec.kind === 'parking') {
            const lot = t.lots.get(a.spec.id);
            if (lot) out.lot = lot;
          }
        }
      }
      for (const p of t.pois) {
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < bestPoi) {
          bestPoi = d;
          out.poi = { ...p, dist: d };
        }
      }
    }

    out.roads.sort((a, b) => a.dist - b.dist);
    out.roads = out.roads.slice(0, 4);
    // smallest containing polygon first (most specific)
    const sizes = new Map<string, number>();
    for (const t of this.tiles.values()) {
      for (const a of t.areas) sizes.set(a.spec.id, a.size);
    }
    out.areas.sort((a, b) => (sizes.get(a.id) ?? 0) - (sizes.get(b.id) ?? 0));
    out.areas = out.areas.slice(0, 4);
    return out;
  }
}

function distToPolyline(x: number, z: number, pts: V2[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].x, az = pts[i - 1].z;
    const bx = pts[i].x, bz = pts[i].z;
    const abx = bx - ax, abz = bz - az;
    const l2 = abx * abx + abz * abz;
    if (l2 < 1e-9) continue;
    let t = ((x - ax) * abx + (z - az) * abz) / l2;
    t = Math.min(Math.max(t, 0), 1);
    const d = Math.hypot(x - (ax + abx * t), z - (az + abz * t));
    if (d < best) best = d;
  }
  return best;
}
