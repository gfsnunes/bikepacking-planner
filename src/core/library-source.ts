/**
 * Where the waypoint library gets its places: the pre-built tile site when the whole route lies in
 * the regions it covers (fast, no Overpass), otherwise the live Overpass search.
 */
import { corridorLine, searchLibrary, type LibraryItem } from './osm-library';
import { TILE_VERSION, cellsAlong, covered, rowToItem, type TileMeta, type TileRow } from './poi-tiles';
import type { TrackPoint } from './types';

export const POI_BASE = `https://bikepacking-poi.pages.dev/${TILE_VERSION}`;
const PARALLEL = 6;

export interface LibraryResult {
  items: LibraryItem[];
  source: 'tiles' | 'live';
  built?: string; // tiles: date the library was built
  regions?: string[]; // tiles: regions covered
}

let metaPromise: Promise<TileMeta | null> | null = null;
const tileCache = new Map<string, Promise<LibraryItem[]>>();

/** For tests: forget cached meta and tiles. */
export function resetLibraryCache() {
  metaPromise = null;
  tileCache.clear();
}

function loadMeta(fetchImpl: typeof fetch): Promise<TileMeta | null> {
  metaPromise ??= fetchImpl(`${POI_BASE}/meta.json`)
    .then((r) => (r.ok ? (r.json() as Promise<TileMeta>) : null))
    .catch(() => null)
    .then((m) => {
      if (!m) metaPromise = null; // try again next search
      return m;
    });
  return metaPromise;
}

function loadTile(key: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<LibraryItem[]> {
  let p = tileCache.get(key);
  if (!p) {
    p = fetchImpl(`${POI_BASE}/tiles/${key}.json`, { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Library tile ${key}: HTTP ${r.status}`);
        return r.json() as Promise<{ items: TileRow[] }>;
      })
      .then((t) => t.items.map(rowToItem));
    p.catch(() => tileCache.delete(key)); // don't cache failures
    tileCache.set(key, p);
  }
  return p;
}

export async function findPlaces(
  points: TrackPoint[],
  radiusM: number,
  categoryIds: string[],
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<LibraryResult> {
  const line = corridorLine(points);
  const meta = await loadMeta(fetchImpl);
  if (meta && covered(line, meta)) {
    const have = new Set(meta.tiles);
    const keys = cellsAlong(line, radiusM).filter((k) => have.has(k));
    const want = new Set(categoryIds);
    const items: LibraryItem[] = [];
    for (let i = 0; i < keys.length; i += PARALLEL) {
      const batch = await Promise.all(keys.slice(i, i + PARALLEL).map((k) => loadTile(k, fetchImpl, signal)));
      for (const tile of batch) for (const it of tile) if (want.has(it.category)) items.push(it);
    }
    return { items, source: 'tiles', built: meta.built, regions: meta.regions.map((r) => r.name) };
  }
  return { items: await searchLibrary(points, radiusM, categoryIds, signal), source: 'live' };
}
