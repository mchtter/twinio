import type { V2 } from '../types';

/** Signed area in (x, north) space — positive = CCW. Note north = -z. */
export function signedArea(ring: V2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * -q.z - q.x * -p.z;
  }
  return a / 2;
}

export function ensureWinding(ring: V2[], ccw: boolean): V2[] {
  const a = signedArea(ring);
  if ((a > 0) !== ccw) return ring.slice().reverse();
  return ring;
}

export function ringCentroid(ring: V2[]): V2 {
  let x = 0, z = 0;
  for (const p of ring) {
    x += p.x;
    z += p.z;
  }
  return { x: x / ring.length, z: z / ring.length };
}

export function ringBBox(ring: V2[]): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, minZ, maxX, maxZ };
}

export function pointInRing(x: number, z: number, ring: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i], pj = ring[j];
    if (pi.z > z !== pj.z > z && x < ((pj.x - pi.x) * (z - pi.z)) / (pj.z - pi.z) + pi.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygon(x: number, z: number, outer: V2[], holes: V2[][]): boolean {
  if (!pointInRing(x, z, outer)) return false;
  for (const h of holes) {
    if (pointInRing(x, z, h)) return false;
  }
  return true;
}

export function polygonAreaAbs(ring: V2[]): number {
  return Math.abs(signedArea(ring));
}

/** Offset a polyline sideways by `d` meters (miter joins, clamped). */
export function offsetPolyline(pts: V2[], d: number): V2[] {
  const out: V2[] = [];
  const n = pts.length;
  if (n < 2) return out;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[Math.max(i - 1, 0)];
    const next = pts[Math.min(i + 1, n - 1)];
    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) {
      out.push({ x: p.x, z: p.z });
      continue;
    }
    dx /= len;
    dz /= len;
    // left normal of direction (dx,dz) in xz-plane: (dz, -dx)
    out.push({ x: p.x + dz * d, z: p.z - dx * d });
  }
  return out;
}

/** Insert intermediate points so no segment exceeds maxLen (terrain draping). */
export function subdividePolyline(pts: V2[], maxLen: number): V2[] {
  if (pts.length < 2) return pts.slice();
  const out: V2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / maxLen));
    for (let k = 1; k <= n; k++) {
      out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
    }
  }
  return out;
}

export function polylineLength(pts: V2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) {
    l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  }
  return l;
}

/** Mulberry32 seeded PRNG — deterministic scattering per feature id. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
