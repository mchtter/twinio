/** Global tunables for the engine. All distances in meters. */
export const CONFIG = {
  // Default start location (Antalya) — overridable via ?lat=..&lon=..
  origin: { lat: 36.902781, lon: 30.643523 },

  // OSM data tiles (slippy tile scheme)
  dataZoom: 15,
  dataRadius: 1,      // full-detail tiles around camera (1 => 3x3)
  lodRadius: 2,       // light-mode ring: buildings+roads+areas only (2 => 5x5)
  unloadRadius: 3,    // tiles farther than this get disposed

  // Terrain (DEM) tiles
  terrainZoom: 14,
  terrainRadius: 1,
  terrainUnloadRadius: 2,
  terrainGrid: 64,    // grid divisions per terrain tile => (65x65 samples)

  // Camera / rendering
  cameraFar: 6000,
  fogNear: 300,
  fogFar: 2400,
  maxPixelRatio: 2,
  shadowMapSize: 2048,
  shadowRange: 160,

  // Vertical layer stack (draped on terrain). Each band = base + its own
  // deterministic jitter; bands never overlap → no cross-layer z-fighting.
  yZone: 0.04,       // landuse tint         [0.04..0.06]
  yArea: 0.08,       // green/parking/sand   [0.08..0.11]
  yPath: 0.14,       // footways             [0.14..0.16]
  yRoadMinor: 0.18,  //                      [0.18..0.20]
  yRoadMajor: 0.22,  //                      [0.22..0.24]
  yJunction: 0.26,   // junction plates      [0.26..0.275]
  ySidewalk: 0.3,
  yCrosswalk: 0.32,
  yRoadJitter: 0.02,
  // absolute sea-surface height: DEM near-zero noise is snapped to 0, so a
  // flat sheet at +0.3 stays cleanly above the seabed terrain
  seaLevel: 0.3,
  // roads are subdivided to this max segment length so they drape the terrain
  roadSubdivision: 9,

  // Agents
  maxVehicles: 140,
  maxPedestrians: 140,
  vehicleSpawnRadius: 700,
  vehicleDespawnRadius: 950,

  // Props
  lampSpacing: 27,
  maxTreesPerTile: 1400,

  // Player
  walkSpeed: 2.4,
  runSpeed: 9,
  flySpeed: 28,
  flyFastSpeed: 110,
  eyeHeight: 1.75,

  // Data endpoints
  // fallbacks must send CORS headers (kumi.systems doesn't → unusable in browsers)
  overpassEndpoints: [
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ],
  overpassConcurrency: 2,
  overpassTimeoutMs: 45000,
  osmCacheTtlMs: 7 * 24 * 3600 * 1000,
  osmCacheVersion: 2, // bump when the Overpass query changes (invalidates cache)
  terrariumUrl: (z: number, x: number, y: number) =>
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  // Copernicus GLO-30 COGs — OpenTopography mirror (CORS + range requests enabled;
  // the primary AWS bucket copernicus-dem-30m sends no CORS headers, so browsers can't use it)
  copernicusUrl: (latCell: string, lonCell: string) =>
    `https://opentopography.s3.sdsc.edu/raster/COP30/COP30_hh/Copernicus_DSM_10_${latCell}_00_${lonCell}_00_DEM.tif`,
  nominatimUrl: 'https://nominatim.openstreetmap.org/search',
};
