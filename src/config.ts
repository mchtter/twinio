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

  // Vertical offsets to prevent z-fighting between draped layers
  yArea: 0.06,
  yPath: 0.12,
  yRoadMinor: 0.16,
  yRoadMajor: 0.2,
  ySidewalk: 0.26,
  yCrosswalk: 0.28,
  // per-road deterministic jitter added on top (kills same-class overlap z-fighting)
  yRoadJitter: 0.035,
  // junction caps sit above every road (max 0.2+0.035) but below sidewalks (0.26)
  yJunction: 0.245,
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
  overpassEndpoints: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ],
  overpassConcurrency: 2,
  osmCacheTtlMs: 7 * 24 * 3600 * 1000,
  terrariumUrl: (z: number, x: number, y: number) =>
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  // Copernicus GLO-30 COGs — OpenTopography mirror (CORS + range requests enabled;
  // the primary AWS bucket copernicus-dem-30m sends no CORS headers, so browsers can't use it)
  copernicusUrl: (latCell: string, lonCell: string) =>
    `https://opentopography.s3.sdsc.edu/raster/COP30/COP30_hh/Copernicus_DSM_10_${latCell}_00_${lonCell}_00_DEM.tif`,
  nominatimUrl: 'https://nominatim.openstreetmap.org/search',
};
