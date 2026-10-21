import { describe, expect, it } from 'vitest';
import { OverpassBusyError, buildQuery, corridorLine, parseElements, runQuery, simplifyTrack } from './osm-library';

const line = (n: number) => Array.from({ length: n }, (_, i) => ({ lat: 61 + i * 0.001, lon: 16, ele: null }));

describe('osm library', () => {
  it('simplifies a straight track to its two ends, keeps corners', () => {
    expect(simplifyTrack(line(500), 50)).toHaveLength(2);
    const corner = [...line(100), ...Array.from({ length: 100 }, (_, i) => ({ lat: 61.099, lon: 16 + (i + 1) * 0.002, ele: null }))];
    const s = simplifyTrack(corner, 50);
    expect(s).toHaveLength(3);
    expect(s[1]).toEqual(corner[99]);
  });

  it('keeps the corridor polyline within the size limit', () => {
    const wiggly = Array.from({ length: 20000 }, (_, i) => ({ lat: 61 + i * 0.0005, lon: 16 + Math.sin(i / 3) * 0.01, ele: null }));
    expect(corridorLine(wiggly, 800).length).toBeLessThanOrEqual(800);
  });

  it('builds one query covering only the requested categories', () => {
    const q = buildQuery([{ lat: 61, lon: 16 }, { lat: 61.5, lon: 16.2 }], 3000, ['shelter', 'water']);
    expect(q).toMatch(/^\[out:json\]\[timeout:90\];/);
    expect(q).toContain('(around:3000,61.00000,16.00000,61.50000,16.20000)');
    expect(q).toContain('["amenity"~"^(drinking_water|shelter|water_point)$"]');
    expect(q).toContain('["natural"~"^(spring)$"]');
    expect(q).not.toContain('shop');
    expect(q).toMatch(/out tags center;$/);
  });

  it('classifies results, drops bus-stop shelters and undrinkable springs, uses way centres', () => {
    const items = parseElements(
      [
        { type: 'node', id: 1, lat: 61.1, lon: 16.1, tags: { amenity: 'shelter', shelter_type: 'lean_to', name: 'Vindskydd Ön' } },
        { type: 'node', id: 2, lat: 61.2, lon: 16.2, tags: { amenity: 'shelter', shelter_type: 'public_transport' } },
        { type: 'way', id: 3, center: { lat: 61.3, lon: 16.3 }, tags: { tourism: 'camp_site', name: 'Lake Camping' } },
        { type: 'node', id: 4, lat: 61.4, lon: 16.4, tags: { natural: 'spring' } },
        { type: 'node', id: 5, lat: 61.5, lon: 16.5, tags: { natural: 'spring', drinking_water: 'yes' } },
        { type: 'node', id: 6, lat: 61.6, lon: 16.6, tags: { amenity: 'drinking_water' } },
        { type: 'relation', id: 7, tags: { tourism: 'camp_site' } }, // no coordinates
      ],
      ['shelter', 'camp', 'water'],
    );
    expect(items.map((w) => [w.id, w.name, w.type, w.category])).toEqual([
      ['osm-n1', 'Vindskydd Ön', 'camp', 'shelter'],
      ['osm-w3', 'Lake Camping', 'camp', 'camp'],
      ['osm-n5', 'Drinking water', 'water', 'water'],
      ['osm-n6', 'Drinking water', 'water', 'water'],
    ]);
    expect(items[1]).toMatchObject({ lat: 61.3, lon: 16.3 });
  });

  it('retries once when Overpass is busy, then reports it', async () => {
    const ok = { ok: true, status: 200, json: async () => ({ elements: [{ type: 'node', id: 1 }] }) } as Response;
    const busy = { ok: false, status: 429, json: async () => ({}) } as Response;
    const seq = (...r: Response[]) => {
      let i = 0;
      return (async () => r[i++]) as unknown as typeof fetch;
    };
    expect(await runQuery('q', undefined, seq(busy, ok))).toHaveLength(1);
    await expect(runQuery('q', undefined, seq(busy, busy))).rejects.toBeInstanceOf(OverpassBusyError);
  }, 30000);

  it('treats gateway errors and dropped connections as busy, other errors as failures', async () => {
    const ok = { ok: true, status: 200, json: async () => ({ elements: [] }) } as Response;
    const gateway = { ok: false, status: 502, json: async () => ({}) } as Response;
    const bad = { ok: false, status: 400, json: async () => ({}) } as Response;
    let calls = 0;
    const flaky = (async () => {
      if (calls++ === 0) throw new TypeError('Failed to fetch');
      return ok;
    }) as unknown as typeof fetch;
    expect(await runQuery('q', undefined, flaky)).toEqual([]);
    await expect(runQuery('q', undefined, (async () => gateway) as unknown as typeof fetch)).rejects.toBeInstanceOf(OverpassBusyError);
    const start = Date.now();
    await expect(runQuery('q', undefined, (async () => bad) as unknown as typeof fetch)).rejects.toThrow('HTTP 400');
    expect(Date.now() - start).toBeLessThan(1000); // no retry for a real error
  }, 30000);
});
