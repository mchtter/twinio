/** Geographic projection and slippy-tile math.
 *
 * World space: local tangent plane centered on an origin lat/lon.
 * +x = east, +y = up (elevation), +z = south (so north is -z, matching
 * three.js default camera forward -z => looking north).
 */

const R_EARTH = 6378137;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export class GeoProjection {
  readonly cosLat: number;

  constructor(public originLat: number, public originLon: number) {
    this.cosLat = Math.cos(originLat * D2R);
  }

  /** lat/lon -> world meters (x east, z south). */
  toWorld(lat: number, lon: number): { x: number; z: number } {
    const x = R_EARTH * (lon - this.originLon) * D2R * this.cosLat;
    const north = R_EARTH * (lat - this.originLat) * D2R;
    return { x, z: -north };
  }

  /** world meters -> lat/lon. */
  toGeo(x: number, z: number): { lat: number; lon: number } {
    const lat = this.originLat + (-z / R_EARTH) * R2D;
    const lon = this.originLon + (x / (R_EARTH * this.cosLat)) * R2D;
    return { lat, lon };
  }
}

/** lon -> tile x (fractional) */
export function lon2tile(lon: number, z: number): number {
  return ((lon + 180) / 360) * Math.pow(2, z);
}

/** lat -> tile y (fractional) */
export function lat2tile(lat: number, z: number): number {
  const rad = lat * D2R;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
}

export function tile2lon(x: number, z: number): number {
  return (x / Math.pow(2, z)) * 360 - 180;
}

export function tile2lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return R2D * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export interface TileBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export function tileBounds(z: number, x: number, y: number): TileBounds {
  return {
    west: tile2lon(x, z),
    east: tile2lon(x + 1, z),
    north: tile2lat(y, z),
    south: tile2lat(y + 1, z),
  };
}

export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}
