/** Shared data structures exchanged between data layer and world builders. */

export interface V2 {
  x: number;
  z: number;
}

export type RoadClass = 'major' | 'minor' | 'path';

export interface BuildingSpec {
  id: string;
  outer: V2[];        // open ring (last point != first)
  holes: V2[][];
  height: number;
  kind: string;       // raw building tag value
  use: string;        // canonical use (residential/commercial/industrial/stadium/…)
  roofShape?: 'flat' | 'gabled';
  roofHeight?: number;
}

export interface RoadSpec {
  id: string;
  pts: V2[];
  cls: RoadClass;
  width: number;
  highway: string;
  oneway: boolean;
  sidewalks: boolean;
  lamps: boolean;
}

export type AreaKind = 'grass' | 'forest' | 'sand' | 'water' | 'parking' | 'zone';

export interface AreaSpec {
  id: string;
  outer: V2[];
  holes: V2[][];
  kind: AreaKind;
  treeDensity: number; // trees per m²
  zoneColor?: [number, number, number]; // landuse tint (kind === 'zone')
}

export type PoiKind = 'lamp' | 'signal' | 'crossing' | 'tree';

export interface PoiSpec {
  id: string;
  x: number;
  z: number;
  kind: PoiKind;
}

/** Minimal road geometry used for clearance/junction rules — includes ways
 * claimed (rendered) by neighbouring tiles, so rules work across tile borders. */
export interface RuleRoad {
  id: string;
  pts: V2[];
  width: number;
  cls: RoadClass;
  sidewalks: boolean;
}

export interface ParsedTile {
  buildings: BuildingSpec[];
  roads: RoadSpec[];
  areas: AreaSpec[];
  pois: PoiSpec[];
  ruleRoads: RuleRoad[];
  /** natural=coastline ways (claim-independent; each tile clips its own sea) */
  coastlines: V2[][];
}

/** Height sampler: world x/z -> terrain elevation (meters). */
export type HeightSampler = (x: number, z: number) => number;
