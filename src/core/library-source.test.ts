import { beforeEach, describe, expect, it } from 'vitest';
import { POI_BASE, findPlaces, resetLibraryCache } from './library-source';
import type { TileMeta, TileRow } from './poi-tiles';

const meta: TileMeta = {
  built: '2026-10-21',
  regions: [{ name: 'Sweden', bbox: [10.5, 55.3, 24.2, 69.1] }],
  tiles: ['61_16', '61_17'],
};
const tiles: Record<string, TileRow[]> = {
  '61_16': [
    ['osm-n1', 61.5, 16.5, 'Vindskydd', 'camp', 'shelter'],
    ['osm-n2', 61.6, 16.6, 'ICA', 'shop', 'grocery'],
  ],
  '61_17': [['osm-n3', 61.5, 17.5, 'Water', 'water', 'water']],
};

function fakeFetch(log: string[], opts: { metaDown?: boolean } = {}) {
  return (async (url: string) => {
    log.push(url);
    if (url.endsWith('/meta.json')) return opts.metaDown ? ({ ok: false, status: 503 } as Response) : ({ ok: true, json: async () => meta } as Response);
    const key = url.match(/tiles\/(.+)\.json$/)?.[1];
    if (key && tiles[key]) return { ok: true, json: async () => ({ items: tiles[key] }) } as Response;
    return { ok: false, status: 404 } as Response;
  }) as unknown as typeof fetch;
}

// A route along 61.5°N from 16.2°E to 17.8°E (inside Sweden's box).
const route = Array.from({ length: 200 }, (_, i) => ({ lat: 61.5, lon: 16.2 + (i * 1.6) / 199, ele: null }));

describe('library source', () => {
  beforeEach(() => resetLibraryCache());

  it('uses pre-built tiles when the route is covered, fetching only existing cells', async () => {
    const log: string[] = [];
    const r = await findPlaces(route, 2000, ['shelter', 'water'], undefined, fakeFetch(log));
    expect(r.source).toBe('tiles');
    expect(r.built).toBe('2026-10-21');
    expect(r.items.map((i) => i.id).sort()).toEqual(['osm-n1', 'osm-n3']); // grocery filtered out
    expect(log.filter((u) => u.includes('/tiles/')).sort()).toEqual([`${POI_BASE}/tiles/61_16.json`, `${POI_BASE}/tiles/61_17.json`]);
  });

  it('caches tiles between searches', async () => {
    const log: string[] = [];
    const f = fakeFetch(log);
    await findPlaces(route, 2000, ['shelter'], undefined, f);
    await findPlaces(route, 2000, ['grocery'], undefined, f);
    expect(log.filter((u) => u.includes('/tiles/'))).toHaveLength(2);
    expect(log.filter((u) => u.endsWith('meta.json'))).toHaveLength(1);
  });
});
