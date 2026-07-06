import { CONFIG } from '../config';
import { tileBounds, tileKey, GeoProjection } from '../geo/proj';
import { cacheGet, cacheSet } from '../geo/cache';
import type { ParsedTile, BuildingSpec, RoadSpec, AreaSpec, PoiSpec, V2, RoadClass, AreaKind, RuleRoad } from '../types';

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

/** Simple concurrency-limited fetch queue: public Overpass servers dislike bursts. */
let active = 0;
const waiters: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= CONFIG.overpassConcurrency) {
    await new Promise<void>((res) => waiters.push(res));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

/** Global rate-limit cooldown: one 429 pauses ALL Overpass traffic with
 * exponential backoff — hammering a throttled server only extends the ban. */
let cooldownUntil = 0;
let cooldownStep = 0;
let rateLimitHandler: ((seconds: number) => void) | undefined;

export function onOverpassRateLimit(cb: (seconds: number) => void): void {
  rateLimitHandler = cb;
}

function tripCooldown(): void {
  cooldownStep = Math.min(cooldownStep + 1, 5);
  const dur = Math.min(15000 * 2 ** (cooldownStep - 1), 240000);
  const until = Date.now() + dur;
  if (until > cooldownUntil) {
    cooldownUntil = until;
    rateLimitHandler?.(Math.round(dur / 1000));
  }
}

async function waitCooldown(): Promise<void> {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function buildQuery(s: number, w: number, n: number, e: number): string {
  const bbox = `${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`;
  return `[out:json][timeout:60][bbox:${bbox}];
(
  way["building"];
  relation["building"]["type"="multipolygon"];
  way["highway"]["highway"!~"^(proposed|construction|corridor|raceway|elevator|bus_guideway)$"]["area"!="yes"];
  way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green|cemetery|orchard|vineyard|greenfield|flowerbed)$"];
  way["landuse"~"^(residential|commercial|industrial|retail|military|farmland|farmyard|brownfield|construction|garages|religious|education|institutional)$"];
  way["natural"="coastline"];
  way["leisure"~"^(park|garden|pitch|playground|golf_course|dog_park|nature_reserve)$"];
  way["natural"~"^(wood|scrub|grassland|heath|beach|sand)$"];
  way["natural"="water"];
  relation["natural"="water"]["type"="multipolygon"];
  way["waterway"~"^(riverbank|dock)$"];
  way["amenity"="parking"];
  node["highway"="street_lamp"];
  node["highway"="traffic_signals"];
  node["highway"="crossing"];
  node["natural"="tree"];
);
out geom;`;
}

/** Fetch raw OSM elements for a slippy tile, with IndexedDB caching + endpoint failover. */
export async function fetchOsmTile(z: number, x: number, y: number): Promise<OverpassElement[]> {
  const key = `osm:v${CONFIG.osmCacheVersion}:${tileKey(z, x, y)}`;
  const cached = await cacheGet<OverpassElement[]>(key, CONFIG.osmCacheTtlMs);
  if (cached) return cached;

  const b = tileBounds(z, x, y);
  const query = buildQuery(b.south, b.west, b.north, b.east);
  // spread tiles across mirrors so one server carries half the load
  const epOffset = Math.abs(x + y) % CONFIG.overpassEndpoints.length;

  return slot(async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      await waitCooldown();
      const endpoint = CONFIG.overpassEndpoints[(epOffset + attempt) % CONFIG.overpassEndpoints.length];
      try {
        // hard timeout: a hung connection must not clog the fetch queue
        const resp = await fetch(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(CONFIG.overpassTimeoutMs),
        });
        if (resp.status === 429) {
          lastErr = new Error('overpass 429');
          tripCooldown();
          continue;
        }
        if (resp.status === 504) {
          lastErr = new Error('overpass 504');
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        if (!resp.ok) throw new Error(`overpass ${resp.status}`);
        const json = await resp.json();
        const elements = (json.elements ?? []) as OverpassElement[];
        cooldownStep = 0; // healthy again
        cacheSet(key, elements);
        return elements;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastErr;
  });
}

// ---------- parsing ----------

const ROAD_DEFS: Record<string, { cls: RoadClass; width: number; sidewalks: boolean; lamps: boolean }> = {
  motorway:      { cls: 'major', width: 15, sidewalks: false, lamps: true },
  motorway_link: { cls: 'major', width: 8, sidewalks: false, lamps: true },
  trunk:         { cls: 'major', width: 13, sidewalks: false, lamps: true },
  trunk_link:    { cls: 'major', width: 7.5, sidewalks: false, lamps: true },
  primary:       { cls: 'major', width: 11, sidewalks: true, lamps: true },
  primary_link:  { cls: 'major', width: 7, sidewalks: true, lamps: true },
  secondary:     { cls: 'major', width: 9, sidewalks: true, lamps: true },
  secondary_link:{ cls: 'major', width: 6.5, sidewalks: true, lamps: true },
  tertiary:      { cls: 'major', width: 7.5, sidewalks: true, lamps: true },
  tertiary_link: { cls: 'major', width: 6, sidewalks: true, lamps: true },
  residential:   { cls: 'minor', width: 6, sidewalks: true, lamps: true },
  unclassified:  { cls: 'minor', width: 6, sidewalks: false, lamps: true },
  living_street: { cls: 'minor', width: 5.5, sidewalks: false, lamps: true },
  service:       { cls: 'minor', width: 3.5, sidewalks: false, lamps: false },
  pedestrian:    { cls: 'path', width: 4.5, sidewalks: false, lamps: true },
  footway:       { cls: 'path', width: 2.2, sidewalks: false, lamps: false },
  path:          { cls: 'path', width: 2, sidewalks: false, lamps: false },
  cycleway:      { cls: 'path', width: 2.4, sidewalks: false, lamps: false },
  steps:         { cls: 'path', width: 2.2, sidewalks: false, lamps: false },
  track:         { cls: 'path', width: 2.5, sidewalks: false, lamps: false },
};

const GREEN_DENSITY: Record<string, number> = {
  forest: 0.005, wood: 0.005, nature_reserve: 0.003, orchard: 0.004, vineyard: 0.002,
  park: 0.002, garden: 0.0025, cemetery: 0.0018, scrub: 0.002, heath: 0.0008,
  grass: 0.0004, meadow: 0.0005, grassland: 0.0005, recreation_ground: 0.001,
  village_green: 0.001, greenfield: 0.0004, dog_park: 0.001, golf_course: 0.0006,
  flowerbed: 0, pitch: 0, playground: 0,
};

function hash01(id: number): number {
  let h = id | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function ringToLocal(geom: { lat: number; lon: number }[], proj: GeoProjection): V2[] {
  const pts: V2[] = [];
  for (const g of geom) {
    const w = proj.toWorld(g.lat, g.lon);
    pts.push({ x: w.x, z: w.z });
  }
  // drop duplicate closing point
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.z - b.z) < 0.01) pts.pop();
  }
  return pts;
}

function isClosed(geom: { lat: number; lon: number }[]): boolean {
  if (geom.length < 4) return false;
  const a = geom[0], b = geom[geom.length - 1];
  return Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
}

function parseHeight(tags: Record<string, string>, id: number, kind: string): number {
  const h = parseFloat((tags['height'] ?? '').replace('m', ''));
  if (isFinite(h) && h > 1) return Math.min(h, 400);
  const lv = parseFloat(tags['building:levels'] ?? '');
  if (isFinite(lv) && lv > 0) return Math.min(lv * 3.1 + 1.4, 400);
  const base: Record<string, number> = {
    house: 6.5, detached: 6.5, bungalow: 4, hut: 3.5, shed: 3, garage: 3, garages: 3,
    apartments: 17, residential: 13, office: 22, commercial: 12, retail: 8,
    industrial: 9, warehouse: 8, hotel: 24, hospital: 18, school: 9, university: 13,
    church: 12, mosque: 14, roof: 3.5, kiosk: 3,
    stadium: 20, sports_hall: 12, mall: 14, supermarket: 7, hangar: 10, factory: 9,
  };
  const b = base[kind] ?? 9;
  return b * (0.75 + hash01(id) * 0.6);
}

function parseRoof(tags: Record<string, string>): {
  roofShape?: 'flat' | 'gabled' | 'hipped' | 'pyramidal';
  roofHeight?: number;
  wallColour?: string;
  roofColour?: string;
} {
  const shape = tags['roof:shape'];
  const h = parseFloat(tags['roof:height'] ?? '');
  const mapped =
    shape === 'gabled' ? 'gabled'
    : shape === 'hipped' || shape === 'half-hipped' || shape === 'gambrel' || shape === 'mansard' ? 'hipped'
    : shape === 'pyramidal' || shape === 'dome' || shape === 'onion' ? 'pyramidal'
    : shape ? 'flat'
    : undefined;
  return {
    roofShape: mapped,
    roofHeight: isFinite(h) && h > 0 ? Math.min(h, 12) : undefined,
    wallColour: tags['building:colour'],
    roofColour: tags['roof:colour'],
  };
}

/** Effective vertical level of a way: bridges live at ≥1, tunnels at ≤-1. */
function parseLevel(tags: Record<string, string>): { bridge: boolean; tunnel: boolean; level: number } {
  const layer = parseInt(tags['layer'] ?? '0', 10) || 0;
  const bridge = tags['bridge'] !== undefined && tags['bridge'] !== 'no';
  const tunnel = (tags['tunnel'] !== undefined && tags['tunnel'] !== 'no') || tags['covered'] === 'yes';
  return { bridge, tunnel, level: bridge ? Math.max(layer, 1) : tunnel ? Math.min(layer, -1) : layer };
}

function polylineLen(pts: V2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return l;
}

function multipolygonRings(el: OverpassElement, proj: GeoProjection): { outers: V2[][]; holes: V2[][] } {
  const outers: V2[][] = [];
  const holes: V2[][] = [];
  for (const m of el.members ?? []) {
    if (m.type !== 'way' || !m.geometry || m.geometry.length < 4 || !isClosed(m.geometry)) continue;
    const ring = ringToLocal(m.geometry, proj);
    if (ring.length < 3) continue;
    if (m.role === 'inner') holes.push(ring);
    else outers.push(ring);
  }
  return { outers, holes };
}

/** Convert raw Overpass elements into local-space geometry specs.
 * `claim` dedupes features spanning multiple tiles: returns true if this tile owns the id. */
export function parseTile(
  elements: OverpassElement[],
  proj: GeoProjection,
  claim: (id: string) => boolean,
): ParsedTile {
  const buildings: BuildingSpec[] = [];
  const roads: RoadSpec[] = [];
  const areas: AreaSpec[] = [];
  const pois: PoiSpec[] = [];
  const ruleRoads: RuleRoad[] = [];
  const coastlines: V2[][] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    const id = `${el.type[0]}${el.id}`;

    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      let kind: PoiSpec['kind'] | undefined;
      if (tags['highway'] === 'street_lamp') kind = 'lamp';
      else if (tags['highway'] === 'traffic_signals') kind = 'signal';
      else if (tags['highway'] === 'crossing') kind = 'crossing';
      else if (tags['natural'] === 'tree') kind = 'tree';
      if (kind && claim(id)) {
        const w = proj.toWorld(el.lat, el.lon);
        pois.push({ id, x: w.x, z: w.z, kind, tags });
      }
      continue;
    }

    if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
      // coastline: claim-independent — every tile clips its own sea polygon
      if (tags['natural'] === 'coastline') {
        coastlines.push(
          el.geometry.map((g) => {
            const w = proj.toWorld(g.lat, g.lon);
            return { x: w.x, z: w.z };
          }),
        );
        continue;
      }
      // buildings
      if (tags['building'] && tags['building'] !== 'no') {
        if (!isClosed(el.geometry) && el.geometry.length < 3) continue;
        if (!claim(id)) continue;
        const outer = ringToLocal(el.geometry, proj);
        if (outer.length < 3) continue;
        buildings.push({
          id, outer, holes: [],
          height: parseHeight(tags, el.id, tags['building']),
          kind: tags['building'],
          use: buildingUse(tags),
          ...parseRoof(tags),
          tags,
        });
        continue;
      }
      // roads
      const hw = tags['highway'];
      if (hw && ROAD_DEFS[hw]) {
        const def = ROAD_DEFS[hw];
        const lanes = parseFloat(tags['lanes'] ?? '');
        const width = isFinite(lanes) && lanes > 0 ? Math.max(def.width, lanes * 3.2) : def.width;
        const pts = el.geometry.map((g) => {
          const w = proj.toWorld(g.lat, g.lon);
          return { x: w.x, z: w.z };
        });
        if (pts.length < 2) continue;
        const lvl = parseLevel(tags);
        // long mountain tunnels can't be shown as open trenches — skip them
        // entirely (short underpasses/altgeçit are kept and carved)
        if (lvl.tunnel && polylineLen(pts) > 500) continue;
        // rule geometry is claim-independent: clearance/junction rules must see
        // roads rendered by neighbouring tiles too
        const sidewalks = def.sidewalks && !lvl.tunnel && tags['sidewalk'] !== 'no';
        ruleRoads.push({ id, pts, width, cls: def.cls, sidewalks, ...lvl });
        if (!claim(id)) continue;
        roads.push({
          id,
          pts,
          cls: def.cls,
          width,
          highway: hw,
          oneway: tags['oneway'] === 'yes' || hw.startsWith('motorway'),
          lanes: isFinite(lanes) && lanes > 0 ? lanes : undefined,
          sidewalks,
          lamps: def.lamps && !lvl.tunnel && !lvl.bridge,
          ...lvl,
          tags,
        });
        continue;
      }
      // areas (closed ways)
      if (isClosed(el.geometry)) {
        const kind = classifyArea(tags);
        if (kind && claim(id)) {
          const outer = ringToLocal(el.geometry, proj);
          if (outer.length >= 3 && !(kind.kind === 'zone' && tooBigZone(outer))) {
            areas.push({
              id, outer, holes: [], kind: kind.kind, treeDensity: kind.density, zoneColor: kind.zoneColor, tags,
            });
          }
        }
      }
      continue;
    }

    if (el.type === 'relation' && el.members) {
      const isBuilding = !!tags['building'];
      const kind = isBuilding ? undefined : classifyArea(tags);
      if (!isBuilding && !kind) continue;
      if (!claim(id)) continue;
      const { outers, holes } = multipolygonRings(el, proj);
      for (let i = 0; i < outers.length; i++) {
        const subId = `${id}_${i}`;
        // naive hole assignment: attach all holes to first outer
        const myHoles = i === 0 ? holes : [];
        if (isBuilding) {
          buildings.push({
            id: subId, outer: outers[i], holes: myHoles,
            height: parseHeight(tags, el.id, tags['building']!),
            kind: tags['building']!,
            use: buildingUse(tags),
            ...parseRoof(tags),
            tags,
          });
        } else if (kind) {
          areas.push({
            id: subId, outer: outers[i], holes: myHoles,
            kind: kind.kind, treeDensity: kind.density, zoneColor: kind.zoneColor, tags,
          });
        }
      }
    }
  }

  return { buildings, roads, areas, pois, ruleRoads, coastlines };
}

/** Canonical building use for styling — building tag first, then POI tags. */
function buildingUse(tags: Record<string, string>): string {
  const b = tags['building'] ?? '';
  const amen = tags['amenity'] ?? '';
  const leis = tags['leisure'] ?? '';
  if (['stadium', 'sports_hall', 'grandstand', 'sports_centre'].includes(b) || ['stadium', 'sports_centre'].includes(leis)) return 'stadium';
  if (b === 'hospital' || amen === 'hospital' || amen === 'clinic') return 'hospital';
  if (['school', 'university', 'kindergarten', 'college'].includes(b) || ['school', 'university', 'college', 'kindergarten'].includes(amen)) return 'education';
  if (b === 'hotel' || tags['tourism'] === 'hotel') return 'hotel';
  if (b === 'mosque' || b === 'church' || amen === 'place_of_worship') return 'worship';
  if (['industrial', 'warehouse', 'factory', 'hangar'].includes(b)) return 'industrial';
  if (['commercial', 'office'].includes(b)) return 'commercial';
  if (['retail', 'mall', 'supermarket', 'kiosk'].includes(b) || tags['shop']) return 'retail';
  if (['garage', 'garages', 'shed', 'hut', 'roof', 'carport', 'service'].includes(b)) return 'utility';
  return 'residential';
}

/** Landuse zones larger than ~2.5 km across are skipped — low information,
 * huge overhang beyond the tile. */
function tooBigZone(outer: V2[]): boolean {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of outer) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return Math.hypot(maxX - minX, maxZ - minZ) > 2500;
}

// subtle desaturated zoning tints — kept close to the base terrain tone
const ZONE_COLORS: Record<string, [number, number, number]> = {
  residential: [0.71, 0.68, 0.63],
  commercial: [0.63, 0.67, 0.73],
  retail: [0.74, 0.66, 0.61],
  industrial: [0.62, 0.59, 0.66],
  military: [0.66, 0.6, 0.57],
  farmland: [0.69, 0.69, 0.55],
  farmyard: [0.68, 0.65, 0.53],
  brownfield: [0.64, 0.6, 0.54],
  construction: [0.69, 0.63, 0.53],
  garages: [0.61, 0.61, 0.61],
  religious: [0.71, 0.69, 0.65],
  education: [0.73, 0.7, 0.6],
  institutional: [0.68, 0.68, 0.66],
};

function classifyArea(
  tags: Record<string, string>,
): { kind: AreaKind; density: number; zoneColor?: [number, number, number] } | undefined {
  if (tags['natural'] === 'water' || tags['waterway'] === 'riverbank' || tags['waterway'] === 'dock') {
    return { kind: 'water', density: 0 };
  }
  if (tags['natural'] === 'beach' || tags['natural'] === 'sand') {
    return { kind: 'sand', density: 0 };
  }
  if (tags['amenity'] === 'parking') {
    return { kind: 'parking', density: 0 };
  }
  const green = tags['landuse'] ?? tags['leisure'] ?? tags['natural'];
  if (green && green in GREEN_DENSITY) {
    const density = GREEN_DENSITY[green];
    const kind: AreaKind = ['forest', 'wood', 'nature_reserve', 'scrub', 'orchard'].includes(green) ? 'forest' : 'grass';
    return { kind, density };
  }
  const zone = tags['landuse'];
  if (zone && zone in ZONE_COLORS) {
    return { kind: 'zone', density: 0, zoneColor: ZONE_COLORS[zone] };
  }
  return undefined;
}
