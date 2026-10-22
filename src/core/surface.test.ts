import { describe, expect, it } from 'vitest';
import { percents, surfaceShare, validSurface, viewSegs } from './surface';
import { classifySegments, linesFromLayer, lookupTileSurface, MAX_TILES, pooled, roadClass, tileXY, tilesAlong, type RoadLine } from './tile-surface';

const P = 1;
const U = 2;
const N = 0;

describe('surface classes', () => {
  it('reads OpenMapTiles road properties', () => {
    expect(roadClass({ class: 'minor', surface: 'paved' })).toBe(P);
    expect(roadClass({ class: 'track', surface: 'unpaved' })).toBe(U);
    expect(roadClass({ class: 'secondary' })).toBe(P); // untagged major road
    expect(roadClass({ class: 'primary_construction' })).toBe(P);
    expect(roadClass({ class: 'minor' })).toBe(N); // untagged minor road
    expect(roadClass({ class: 'path' })).toBe(N);
  });
});

// A straight east-west line of points at 61°N, one every ~10 m (0.000187° of longitude).
const LAT = 61;
const line = (n: number, lon0 = 16) => Array.from({ length: n }, (_, i) => ({ lat: LAT, lon: lon0 + i * 0.000187, ele: null }));
/** A road as a RoadLine through lat/lon pairs. */
const road = (cls: number, ...ll: [number, number][]): RoadLine => {
  const pts = new Float64Array(ll.length * 2);
  ll.forEach(([lat, lon], i) => {
    const { x, y } = tileXY(lat, lon);
    pts[i * 2] = x;
    pts[i * 2 + 1] = y;
  });
  return { cls: cls as RoadLine['cls'], pts };
};
/** Put roads into the tile map by the tile of their first point (fine for these short test roads). */
const tiles = (...roads: RoadLine[]) => {
  const m = new Map<string, RoadLine[]>();
  for (const r of roads) {
    const key = `${Math.floor(r.pts[0])}/${Math.floor(r.pts[1])}`;
    m.set(key, [...(m.get(key) ?? []), r]);
  }
  return m;
};
const dLat = (m: number) => m / 111_320; // metres north as degrees of latitude

describe('matching', () => {
  it('takes the class of the road the route follows', () => {
    const pts = line(20);
    const segs = classifySegments(pts, tiles(road(U, [LAT + dLat(5), 15.999], [LAT + dLat(5), 16.01])));
    expect([...segs].every((c) => c === U)).toBe(true);
  });

  it('ignores roads more than 25 m away', () => {
    const pts = line(20);
    const segs = classifySegments(pts, tiles(road(P, [LAT + dLat(40), 15.999], [LAT + dLat(40), 16.01])));
    expect([...segs].every((c) => c === N)).toBe(true);
  });

  it('prefers a road running the same way over a slightly nearer crossing one', () => {
    const pts = line(3);
    const mid = pts[1].lon + 0.0000935; // middle of segment 1
    const along = road(U, [LAT + dLat(8), 15.999], [LAT + dLat(8), 16.01]); // 8 m away, parallel
    const across = road(P, [LAT - dLat(30), mid], [LAT + dLat(30), mid]); // 0 m away, crossing at 90°
    expect(classifySegments(pts, tiles(along, across))[1]).toBe(U);
  });

  it('picks the nearer of two parallel roads', () => {
    const pts = line(10);
    const near = road(U, [LAT + dLat(4), 15.999], [LAT + dLat(4), 16.01]);
    const far = road(P, [LAT - dLat(18), 15.999], [LAT - dLat(18), 16.01]);
    expect([...classifySegments(pts, tiles(near, far))].every((c) => c === U)).toBe(true);
  });

  it('lists every tile the route (and a 25 m margin) touches, including long gaps', () => {
    const a = { lat: 61, lon: 16, ele: null };
    const b = { lat: 61, lon: 16.2, ele: null }; // ~10 km east, no points in between
    const keys = tilesAlong([a, b]);
    const xa = Math.floor(tileXY(61, 16).x);
    const xb = Math.floor(tileXY(61, 16.2).x);
    for (let x = xa; x <= xb; x++) expect(keys.some((k) => k.startsWith(`${x}/`))).toBe(true);
  });
});

describe('tile decoding and lookup', () => {
  // A fake decoded layer: one line feature across the tile's middle, one point feature (ignored), one ferry (ignored).
  const layer = (surface?: string) => ({
    length: 3,
    extent: 4096,
    feature: (i: number) =>
      [
        { type: 2, properties: { class: 'track', ...(surface ? { surface } : {}) }, loadGeometry: () => [[{ x: 0, y: 2048 }, { x: 4096, y: 2048 }]] },
        { type: 1, properties: { class: 'minor' }, loadGeometry: () => [[{ x: 10, y: 10 }]] },
        { type: 2, properties: { class: 'ferry' }, loadGeometry: () => [[{ x: 0, y: 0 }, { x: 4096, y: 4096 }]] },
      ][i],
  });

  it('turns layer features into road lines in world tile units', () => {
    const lines = linesFromLayer(layer('unpaved'), 100, 200);
    expect(lines).toHaveLength(1);
    expect(lines[0].cls).toBe(U);
    expect([...lines[0].pts]).toEqual([100, 200.5, 101, 200.5]);
    expect(linesFromLayer(undefined, 0, 0)).toEqual([]);
  });

  it('looks up a route end to end with at most four tiles in flight', async () => {
    // Points along the middle row of their tile, where the fake road runs.
    const { x, y } = tileXY(61, 16);
    const ty = Math.floor(y) + 0.5;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / 2 ** 14))) * 180) / Math.PI;
    const pts = Array.from({ length: 50 }, (_, i) => ({ lat, lon: 16 + i * 0.0005, ele: null }));
    let inFlight = 0;
    let maxInFlight = 0;
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      if (url.endsWith('/planet')) return { ok: true, json: async () => ({ tiles: ['https://t/{z}/{x}/{y}.pbf'] }) } as Response;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1) } as Response;
    }) as unknown as typeof fetch;
    const progress: number[] = [];
    const d = await lookupTileSurface(pts, () => layer('paved'), { fetchImpl: f, progress: (done) => progress.push(done) });
    expect(d.from).toBe('tiles');
    expect(validSurface(d, pts.length)).toBe(true);
    expect([...d.segs].every((c) => c === P)).toBe(true);
    expect(urls.some((u) => u.includes(`/14/${Math.floor(x)}/`))).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(progress.at(-1)).toBe(urls.length - 1); // every tile counted
  });

  it('refuses routes needing more tiles than the provider allows', async () => {
    // A zig-zag across many tiles: far more than MAX_TILES keys.
    const pts = Array.from({ length: 4000 }, (_, i) => ({ lat: 40 + (i % 2) * 0.05, lon: -9 + i * 0.01, ele: null }));
    expect(tilesAlong(pts).length).toBeGreaterThan(MAX_TILES);
    await expect(lookupTileSurface(pts, () => undefined, { fetchImpl: (async () => ({}) as Response) as unknown as typeof fetch })).rejects.toThrow(/tiles/);
  });

  it('runs a pool with a concurrency limit and keeps the order', async () => {
    let live = 0;
    let peak = 0;
    const out = await pooled([5, 1, 3, 2, 4, 6], 2, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, n));
      live--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40, 60]);
    expect(peak).toBe(2);
  });
});

describe('shares', () => {
  it('follows crops and reversal', () => {
    const segs = Uint8Array.from([1, 1, 2, 0, 2]); // segments of a 6-point track
    expect([...viewSegs(segs, { a: 1, b: 4, reversed: false })]).toEqual([1, 2, 0]);
    expect([...viewSegs(segs, { a: 1, b: 4, reversed: true })]).toEqual([0, 2, 1]);
  });

  it('measures metres per class and rounds to 100%', () => {
    const segs = Uint8Array.from([1, 2, 0]);
    const dist = Float64Array.from([0, 100, 300, 600]);
    expect(surfaceShare(segs, dist, 0, 3)).toEqual({ paved: 100, unpaved: 200, unknown: 300 });
    expect(surfaceShare(segs, dist, 1, 2)).toEqual({ paved: 0, unpaved: 200, unknown: 0 });
    expect(percents({ paved: 1, unpaved: 1, unknown: 1 })).toEqual({ paved: 34, unpaved: 33, unknown: 33 });
    expect(percents({ paved: 0, unpaved: 0, unknown: 0 })).toEqual({ paved: 0, unpaved: 0, unknown: 0 });
  });

  it('drops lookups from older versions', () => {
    expect(validSurface({ segs: new Uint8Array(4), from: 'tiles', at: '2026-10-22' }, 5)).toBe(true);
    expect(validSurface({ segs: new Uint8Array(4), from: 'estimated', at: '2026-10-22' } as never, 5)).toBe(false);
    expect(validSurface({ segs: new Uint8Array(3), from: 'tiles', at: '2026-10-22' }, 5)).toBe(false);
  });
});
