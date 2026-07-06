import * as THREE from 'three';

/** Drivable road network assembled incrementally from streamed tiles.
 * One edge per OSM way; ways are split at junctions in OSM, so endpoints
 * connect the network. Node keys are endpoints quantized to 1 m. */

export interface GraphEdge {
  id: number;
  tile: string;
  pts: THREE.Vector3[];
  cum: number[];
  len: number;
  a: string;
  b: string;
  speed: number;
  oneway: boolean;
  highway: string;
  /** lanes PER DIRECTION (1–3) — from the OSM `lanes` tag, else road width */
  lanes: number;
  /** lane width; lane i (0 = rightmost/kerb) centers at halfW - laneW*(i+0.5) */
  laneW: number;
  halfW: number;
}

const SPEEDS: Record<string, number> = {
  motorway: 25, motorway_link: 14, trunk: 22, trunk_link: 12,
  primary: 15, primary_link: 10, secondary: 13, secondary_link: 9,
  tertiary: 11, tertiary_link: 8, residential: 8, unclassified: 8,
  living_street: 5, service: 5,
};

function nodeKey(p: THREE.Vector3): string {
  return `${Math.round(p.x)}:${Math.round(p.z)}`;
}

export class RoadGraph {
  edges = new Map<number, GraphEdge>();
  nodes = new Map<string, number[]>();
  private byTile = new Map<string, number[]>();
  private nextId = 1;
  totalLength = 0;
  version = 0;

  addTile(
    tile: string,
    drivable: { pts: THREE.Vector3[]; highway: string; oneway: boolean; width: number; lanes?: number }[],
  ): void {
    const ids: number[] = [];
    for (const d of drivable) {
      if (d.pts.length < 2) continue;
      const cum: number[] = [0];
      for (let i = 1; i < d.pts.length; i++) {
        cum.push(cum[i - 1] + d.pts[i].distanceTo(d.pts[i - 1]));
      }
      const len = cum[cum.length - 1];
      if (len < 4) continue;
      // per-direction lane count: tagged total split by direction, else inferred
      // from the carriageway width (~3.4 m per lane)
      const dirWidth = d.oneway ? d.width : d.width / 2;
      const lanes = Math.min(
        3,
        Math.max(1, Math.round(d.lanes ? (d.oneway ? d.lanes : d.lanes / 2) : dirWidth / 3.4)),
      );
      const edge: GraphEdge = {
        id: this.nextId++,
        tile,
        pts: d.pts,
        cum,
        len,
        a: nodeKey(d.pts[0]),
        b: nodeKey(d.pts[d.pts.length - 1]),
        speed: SPEEDS[d.highway] ?? 8,
        oneway: d.oneway,
        highway: d.highway,
        lanes,
        laneW: dirWidth / lanes,
        halfW: d.width / 2,
      };
      this.edges.set(edge.id, edge);
      ids.push(edge.id);
      this.totalLength += len;
      for (const nk of [edge.a, edge.b]) {
        let arr = this.nodes.get(nk);
        if (!arr) {
          arr = [];
          this.nodes.set(nk, arr);
        }
        arr.push(edge.id);
      }
    }
    this.byTile.set(tile, ids);
    this.version++;
  }

  removeTile(tile: string): void {
    const ids = this.byTile.get(tile);
    if (!ids) return;
    for (const id of ids) {
      const e = this.edges.get(id);
      if (!e) continue;
      this.edges.delete(id);
      this.totalLength -= e.len;
      for (const nk of [e.a, e.b]) {
        const arr = this.nodes.get(nk);
        if (arr) {
          const i = arr.indexOf(id);
          if (i >= 0) arr.splice(i, 1);
          if (arr.length === 0) this.nodes.delete(nk);
        }
      }
    }
    this.byTile.delete(tile);
    this.version++;
  }

  /** Sever one edge (rubble/roadblock). Returns it for a later restore. */
  removeEdge(id: number): GraphEdge | null {
    const e = this.edges.get(id);
    if (!e) return null;
    this.edges.delete(id);
    this.totalLength -= e.len;
    for (const nk of [e.a, e.b]) {
      const arr = this.nodes.get(nk);
      if (arr) {
        const i = arr.indexOf(id);
        if (i >= 0) arr.splice(i, 1);
        if (arr.length === 0) this.nodes.delete(nk);
      }
    }
    const tileArr = this.byTile.get(e.tile);
    if (tileArr) {
      const i = tileArr.indexOf(id);
      if (i >= 0) tileArr.splice(i, 1);
    }
    this.version++;
    return e;
  }

  /** Re-insert a severed edge — no-op if its tile has been unloaded meanwhile. */
  restoreEdge(e: GraphEdge): void {
    if (this.edges.has(e.id) || !this.byTile.has(e.tile)) return;
    this.edges.set(e.id, e);
    this.totalLength += e.len;
    for (const nk of [e.a, e.b]) {
      let arr = this.nodes.get(nk);
      if (!arr) {
        arr = [];
        this.nodes.set(nk, arr);
      }
      arr.push(e.id);
    }
    this.byTile.get(e.tile)!.push(e.id);
    this.version++;
  }

  /** Sample position along an edge into `out`. */
  posAt(e: GraphEdge, dist: number, out: THREE.Vector3): void {
    const d = Math.min(Math.max(dist, 0), e.len);
    let i = 1;
    while (i < e.cum.length - 1 && e.cum[i] < d) i++;
    const segLen = e.cum[i] - e.cum[i - 1];
    const t = segLen > 1e-6 ? (d - e.cum[i - 1]) / segLen : 0;
    out.copy(e.pts[i - 1]).lerp(e.pts[i], t);
  }

  /** Direction of travel at dist (unit, xz-plane-ish) into `out`. */
  dirAt(e: GraphEdge, dist: number, sign: number, out: THREE.Vector3): void {
    const d = Math.min(Math.max(dist, 0), e.len);
    let i = 1;
    while (i < e.cum.length - 1 && e.cum[i] < d) i++;
    out.copy(e.pts[i]).sub(e.pts[i - 1]).multiplyScalar(sign).normalize();
  }

  /** Edges leaving `node`, respecting oneway. Excludes `except` unless it's the only option. */
  nextEdges(node: string, except: number): GraphEdge[] {
    const ids = this.nodes.get(node) ?? [];
    const out: GraphEdge[] = [];
    for (const id of ids) {
      const e = this.edges.get(id);
      if (!e || id === except) continue;
      if (e.oneway && e.b === node) continue; // can only enter oneway at its start
      out.push(e);
    }
    if (out.length === 0) {
      const e = this.edges.get(except);
      if (e && !(e.oneway && e.b === node)) out.push(e);
    }
    return out;
  }

  randomEdgeNear(pos: THREE.Vector3, radius: number, rnd: () => number): GraphEdge | null {
    const candidates: GraphEdge[] = [];
    for (const e of this.edges.values()) {
      const mid = e.pts[Math.floor(e.pts.length / 2)];
      const dx = mid.x - pos.x;
      const dz = mid.z - pos.z;
      if (dx * dx + dz * dz < radius * radius) {
        candidates.push(e);
        // arterials carry more traffic — double spawn weight for fast roads
        if (e.speed >= 13) candidates.push(e);
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(rnd() * candidates.length)];
  }
}
