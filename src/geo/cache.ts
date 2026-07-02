import { get, set, del } from 'idb-keyval';

/** IndexedDB-backed cache with TTL for fetched tile data. Failures degrade to no-cache. */

interface Entry<T> {
  t: number;
  v: T;
}

export async function cacheGet<T>(key: string, ttlMs: number): Promise<T | undefined> {
  try {
    const e = (await get(key)) as Entry<T> | undefined;
    if (!e) return undefined;
    if (Date.now() - e.t > ttlMs) {
      del(key).catch(() => {});
      return undefined;
    }
    return e.v;
  } catch {
    return undefined;
  }
}

export async function cacheSet<T>(key: string, v: T): Promise<void> {
  try {
    await set(key, { t: Date.now(), v });
  } catch {
    // quota / private mode — ignore
  }
}
