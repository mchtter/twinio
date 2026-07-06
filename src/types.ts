/** Shared data structures exchanged between data layer and world builders. */

export interface V2 {
  x: number;
  z: number;
}

export type RoadClass = 'major' | 'minor' | 'path';

export type RoofShape = 'flat' | 'gabled' | 'hipped' | 'pyramidal';

export interface BuildingSpec {
  id: string;
  outer: V2[];        // open ring (last point != first)
  holes: V2[][];
  height: number;
  kind: string;       // raw building tag value
  use: string;        // canonical use (residential/commercial/industrial/stadium/…)
  roofShape?: RoofShape;
  roofHeight?: number;
  wallColour?: string; // raw building:colour tag (CSS color)
  roofColour?: string; // raw roof:colour tag (CSS color)
  tags?: Record<string, string>; // raw OSM tags (inspector)
}

export interface RoadSpec {
  id: string;
  pts: V2[];
  cls: RoadClass;
  width: number;
  highway: string;
  oneway: boolean;
  /** total lane count from the OSM `lanes` tag (both directions), if tagged */
  lanes?: number;
  sidewalks: boolean;
  lamps: boolean;
  bridge: boolean;
  tunnel: boolean;
  /** effective vertical level: bridge ≥ 1, tunnel ≤ -1, else OSM layer (0) */
  level: number;
  tags?: Record<string, string>;
}

export type AreaKind = 'grass' | 'forest' | 'sand' | 'water' | 'parking' | 'zone';

export interface AreaSpec {
  id: string;
  outer: V2[];
  holes: V2[][];
  kind: AreaKind;
  treeDensity: number; // trees per m²
  zoneColor?: [number, number, number]; // landuse tint (kind === 'zone')
  tags?: Record<string, string>;
}

export type PoiKind = 'lamp' | 'signal' | 'crossing' | 'tree' | 'hydrant' | 'manhole';

/** Real mapped utility line (man_made=pipeline) — sparse in OSM; the
 * infrastructure scenario renders these alongside the synthesized network. */
export interface UtilitySpec {
  id: string;
  pts: V2[];
  substance: string; // water | sewage | gas | … ('' if untagged)
  location: string;  // underground | overground | ''
  tags?: Record<string, string>;
}

export interface PoiSpec {
  id: string;
  x: number;
  z: number;
  kind: PoiKind;
  tags?: Record<string, string>;
}

/** Minimal road geometry used for clearance/junction rules — includes ways
 * claimed (rendered) by neighbouring tiles, so rules work across tile borders. */
export interface RuleRoad {
  id: string;
  pts: V2[];
  width: number;
  cls: RoadClass;
  sidewalks: boolean;
  bridge: boolean;
  tunnel: boolean;
  level: number;
}

export interface ParsedTile {
  buildings: BuildingSpec[];
  roads: RoadSpec[];
  areas: AreaSpec[];
  pois: PoiSpec[];
  utilities: UtilitySpec[];
  ruleRoads: RuleRoad[];
  /** natural=coastline ways (claim-independent; each tile clips its own sea) */
  coastlines: V2[][];
}

/** Height sampler: world x/z -> terrain elevation (meters). */
export type HeightSampler = (x: number, z: number) => number;
