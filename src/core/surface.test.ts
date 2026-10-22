import { describe, expect, it } from 'vitest';
import {
  NO_WAY,
  SURFACE,
  classifyTags,
  classifyValhalla,
  encodePolyline6,
  lookupSurface,
  matchChunks,
  percents,
  refineSurface,
  surfaceShare,
  viewSegs,
} from './surface';

describe('surface classes', () => {
  it('classifies OpenStreetMap tags', () => {
    expect(classifyTags({ highway: 'residential', surface: 'asphalt' })).toBe(SURFACE.paved);
    expect(classifyTags({ highway: 'track', surface: 'gravel' })).toBe(SURFACE.unpaved);
    expect(classifyTags({ highway: 'track', surface: 'fine_gravel;ground' })).toBe(SURFACE.unpaved);
    expect(classifyTags({ highway: 'track', tracktype: 'grade1' })).toBe(SURFACE.paved);
    expect(classifyTags({ highway: 'track', tracktype: 'grade3' })).toBe(SURFACE.unpaved);
    expect(classifyTags({ highway: 'secondary' })).toBe(SURFACE.paved); // untagged major road
    expect(classifyTags({ highway: 'unclassified' })).toBe(SURFACE.unknown); // untagged minor road
    expect(classifyTags({ highway: 'path', surface: 'weird_value' })).toBe(SURFACE.unknown);
    expect(classifyTags(undefined)).toBe(SURFACE.unknown);
  });

  it('turns Valhalla surfaces into an estimate', () => {
    expect(classifyValhalla('paved_smooth')).toBe(SURFACE.paved);
    expect(classifyValhalla('paved_rough')).toBe(SURFACE.paved);
    expect(classifyValhalla('compacted')).toBe(SURFACE.unpaved);
    expect(classifyValhalla(undefined)).toBe(SURFACE.unknown);
  });

  it('encodes polylines with 6 decimals', () => {
    // Google's reference example (precision 5) for (38.5, -120.2), (40.7, -120.95), (43.252, -126.453);
    // at precision 6 the same integers come from coordinates ten times smaller.
    const pts = [
      { lat: 3.85, lon: -12.02 },
      { lat: 4.07, lon: -12.095 },
      { lat: 4.3252, lon: -12.6453 },
    ];
    expect(encodePolyline6(pts)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });
});

// A straight track north from 61.0°N, a point every ~11 m.
const track = (km: number) => Array.from({ length: Math.round(km * 90) + 1 }, (_, i) => ({ lat: 61 + i * 0.0001, lon: 16, ele: null }));

describe('matching chunks', () => {
  it('thins points and splits long tracks into overlapping chunks', () => {
    const pts = track(350);
    const chunks = matchChunks(pts);
    expect(chunks.length).toBe(3); // 150 + 150 + 50 km
    expect(chunks[0][0]).toBe(0);
    expect(chunks.at(-1)!.at(-1)).toBe(pts.length - 1);
    for (let c = 1; c < chunks.length; c++) expect(chunks[c][0]).toBe(chunks[c - 1].at(-1)); // shared boundary
    expect(chunks[0][1] - chunks[0][0]).toBe(3); // ~33 m: every third point
  });
});

/** Fake Valhalla + Overpass: the first half of every chunk is way 1 (asphalt), the second way 2 (untagged unclassified). */
function fakeServers(opts: { overpassDown?: boolean } = {}) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes('trace_attributes')) {
      const body = JSON.parse(String(init?.body));
      // Decode just the point count from the polyline length is awkward; count pairs by decoding.
      let n = 0;
      for (let i = 0, s = body.encoded_polyline as string; i < s.length; ) {
        for (let k = 0; k < 2; k++) while (s.charCodeAt(i++) - 63 >= 0x20);
        n++;
      }
      const half = Math.floor(n / 2);
      return {
        ok: true,
        json: async () => ({
          edges: [
            { way_id: 1, surface: 'paved_smooth' },
            { way_id: 2, surface: 'paved_smooth' }, // Valhalla's default for an untagged road
          ],
          matched_points: Array.from({ length: n }, (_, i) => (i < half ? { type: 'matched', edge_index: 0 } : { type: 'matched', edge_index: 1 })),
        }),
      } as Response;
    }
    if (opts.overpassDown) throw new TypeError('Failed to fetch');
    return {
      ok: true,
      json: async () => ({ elements: [{ id: 1, tags: { highway: 'tertiary', surface: 'asphalt' } }, { id: 2, tags: { highway: 'unclassified' } }] }),
    } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('lookup', () => {
  it('matches, fetches the real tags and keeps untagged minor roads unknown', async () => {
    const pts = track(10);
    const { f, calls } = fakeServers();
    const d = await lookupSurface(pts, { fetchImpl: f, gapMs: 0 });
    expect(d.from).toBe('tags');
    expect(calls.filter((u) => u.includes('trace_attributes'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('overpass'))).toHaveLength(1);
    const dist = Float64Array.from(pts, (_, i) => i * 11.1);
    const p = percents(surfaceShare(d.segs, dist, 0, pts.length - 1));
    expect(p.paved + p.unpaved + p.unknown).toBe(100);
    expect(p.paved).toBeGreaterThan(40);
    expect(p.unknown).toBeGreaterThan(40); // Valhalla said paved; the tags say we don't know
    expect(p.unpaved).toBe(0);
  });

  it('falls back to Valhalla estimates when Overpass is down, and can refine later', async () => {
    const pts = track(10);
    const d = await lookupSurface(pts, { fetchImpl: fakeServers({ overpassDown: true }).f, gapMs: 0 });
    expect(d.from).toBe('estimated');
    expect([...d.segs].every((c) => c === SURFACE.paved)).toBe(true);
    const r = await refineSurface(d, fakeServers().f);
    expect(r.from).toBe('tags');
    expect([...r.segs].some((c) => c === SURFACE.unknown)).toBe(true);
  });

  it('leaves unmatched stretches unknown', async () => {
    const pts = track(2);
    const f = (async () => ({ ok: false, json: async () => ({ error: 'no candidates' }) }) as Response) as unknown as typeof fetch;
    const d = await lookupSurface(pts, { fetchImpl: f, gapMs: 0 });
    expect([...d.segWay].every((w) => w === NO_WAY)).toBe(true);
    expect([...d.segs].every((c) => c === SURFACE.unknown)).toBe(true);
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
});
