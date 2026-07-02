import * as THREE from 'three';
import { CONFIG } from '../config';
import { lon2tile, lat2tile, tileKey } from '../geo/proj';
import { fetchOsmTile, parseTile } from '../data/overpass';
import { TerrainManager } from '../terrain/terrain';
import { buildBuildings } from './buildings';
import { buildRoads } from './roads';
import { buildAreas } from './greenery';
import { buildProps, TrafficSignalSet } from './props';
import { RoadGraph } from '../agents/graph';
import { PedestrianSystem } from '../agents/pedestrians';

interface TileEntry {
  key: string;
  x: number;
  y: number;
  group: THREE.Group | null; // null while loading
  signals: TrafficSignalSet | null;
  lampHeads: THREE.Vector3[];
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Streams OSM data tiles around the camera: fetch → parse → build → register. */
export class World {
  private tiles = new Map<string, TileEntry>();
  private claims = new Map<string, string>();
  private hidden = new Set<string>();
  private loadingCount = 0;
  generation = 0;
  onStatus?: (loading: number, total: number) => void;
  onError?: (msg: string) => void;

  constructor(
    private scene: THREE.Scene,
    private terrain: TerrainManager,
    private graph: RoadGraph,
    private pedestrians: PedestrianSystem,
  ) {}

  get loadedCount(): number {
    return this.tiles.size;
  }

  get isLoading(): boolean {
    return this.loadingCount > 0;
  }

  *signalSets(): IterableIterator<TrafficSignalSet> {
    for (const t of this.tiles.values()) {
      if (t.signals) yield t.signals;
    }
  }

  *allLampHeads(): IterableIterator<THREE.Vector3> {
    for (const t of this.tiles.values()) {
      for (const h of t.lampHeads) yield h;
    }
  }

  /** Called when the camera moved; loads/unloads tiles as needed. */
  update(lat: number, lon: number): void {
    const z = CONFIG.dataZoom;
    const cx = Math.floor(lon2tile(lon, z));
    const cy = Math.floor(lat2tile(lat, z));

    for (let dy = -CONFIG.dataRadius; dy <= CONFIG.dataRadius; dy++) {
      for (let dx = -CONFIG.dataRadius; dx <= CONFIG.dataRadius; dx++) {
        const key = tileKey(z, cx + dx, cy + dy);
        if (!this.tiles.has(key)) {
          this.loadTile(cx + dx, cy + dy).catch((e) => {
            console.warn('tile load failed', key, e);
            this.tiles.delete(key);
            this.onError?.('OSM verisi alınamadı — tekrar denenecek');
          });
        }
      }
    }

    for (const [key, t] of this.tiles) {
      if (Math.max(Math.abs(t.x - cx), Math.abs(t.y - cy)) > CONFIG.unloadRadius) {
        this.unloadTile(key);
      }
    }
  }

  reset(): void {
    this.generation++;
    for (const key of [...this.tiles.keys()]) this.unloadTile(key);
    this.claims.clear();
    this.loadingCount = 0;
  }

  private async loadTile(x: number, y: number): Promise<void> {
    const z = CONFIG.dataZoom;
    const key = tileKey(z, x, y);
    const gen = this.generation;
    const entry: TileEntry = { key, x, y, group: null, signals: null, lampHeads: [] };
    this.tiles.set(key, entry);
    this.loadingCount++;
    this.emitStatus();

    try {
      const elements = await fetchOsmTile(z, x, y);
      if (gen !== this.generation || !this.tiles.has(key)) return;

      const claim = (id: string): boolean => {
        const owner = this.claims.get(id);
        if (owner && owner !== key) return false;
        this.claims.set(id, key);
        return true;
      };
      const parsed = parseTile(elements, this.terrain.proj, claim);
      const sample = this.terrain.sample;
      const group = new THREE.Group();
      group.name = `tile-${key}`;

      // build in slices with frame yields to avoid long main-thread stalls
      const buildings = buildBuildings(parsed.buildings, sample);
      if (buildings) group.add(buildings);
      await nextFrame();
      if (gen !== this.generation || !this.tiles.has(key)) return;

      const roads = buildRoads(parsed.roads, parsed.pois, sample);
      if (roads.group) group.add(roads.group);
      await nextFrame();
      if (gen !== this.generation || !this.tiles.has(key)) return;

      const areas = buildAreas(parsed.areas, parsed.pois, sample);
      if (areas.areas) group.add(areas.areas);
      if (areas.trees) group.add(areas.trees);
      await nextFrame();
      if (gen !== this.generation || !this.tiles.has(key)) return;

      const props = buildProps(parsed.roads, parsed.pois, sample);
      if (props.group) group.add(props.group);

      entry.group = group;
      entry.signals = props.signals;
      entry.lampHeads = props.lampHeads;
      this.applyVisibility(group);
      this.scene.add(group);
      this.graph.addTile(key, roads.drivable);
      this.pedestrians.addTile(key, roads.walkable);
    } finally {
      this.loadingCount--;
      this.emitStatus();
    }
  }

  private unloadTile(key: string): void {
    const t = this.tiles.get(key);
    if (!t) return;
    this.tiles.delete(key);
    if (t.group) {
      this.scene.remove(t.group);
      t.group.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.dispose();
        if (o instanceof THREE.Mesh && !o.geometry.userData.shared) o.geometry.dispose();
      });
    }
    for (const [id, owner] of this.claims) {
      if (owner === key) this.claims.delete(id);
    }
    this.graph.removeTile(key);
    this.pedestrians.removeTile(key);
    this.emitStatus();
  }

  setLayerVisible(cat: string, visible: boolean): void {
    if (visible) this.hidden.delete(cat);
    else this.hidden.add(cat);
    for (const t of this.tiles.values()) {
      if (t.group) this.applyVisibility(t.group);
    }
  }

  private applyVisibility(group: THREE.Group): void {
    group.traverse((o) => {
      const cat = o.userData.cat as string | undefined;
      if (cat) o.visible = !this.hidden.has(cat);
    });
  }

  private emitStatus(): void {
    this.onStatus?.(this.loadingCount, this.tiles.size);
  }
}
