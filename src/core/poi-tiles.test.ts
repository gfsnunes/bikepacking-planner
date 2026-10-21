import { describe, expect, it } from 'vitest';
import { cellKey, cellsAlong, covered, featuresToItems, osmiumFilters, rowToItem, toTiles } from './poi-tiles';

const feat = (type: string, id: number, geometry: { type: string; coordinates: unknown }, tags: Record<string, string>) => ({
  type: 'Feature' as const,
  geometry,
  properties: { '@type': type, '@id': id, ...tags },
});

describe('pre-built tiles', () => {
  it('derives osmium filters from the library categories', () => {
    const f = osmiumFilters();
    expect(f).toContain('nwr/amenity=bicycle_repair_station,cafe,drinking_water,fast_food,pub,restaurant,shelter,water_point');
    expect(f).toContain('nwr/natural=spring');
    expect(f.every((x) => x.startsWith('nwr/'))).toBe(true);
  });

  it('classifies osmium features with the app rules, using original ids and area centres', () => {
    const items = featuresToItems([
      feat('node', 1, { type: 'Point', coordinates: [16.1, 61.1] }, { amenity: 'shelter', shelter_type: 'lean_to', name: 'Vindskydd' }),
      feat('node', 2, { type: 'Point', coordinates: [16.2, 61.2] }, { amenity: 'shelter', shelter_type: 'public_transport' }),
      feat('way', 30, { type: 'MultiPolygon', coordinates: [[[[16.0, 61.0], [16.4, 61.0], [16.4, 61.2], [16.0, 61.2], [16.0, 61.0]]]] }, { tourism: 'camp_site', name: 'Lake Camping' }),
      feat('node', 4, { type: 'Point', coordinates: [16.3, 61.3] }, { shop: 'supermarket', name: 'ICA' }),
    ]);
    expect(items.map((i) => [i.id, i.name, i.category])).toEqual([
      ['osm-n1', 'Vindskydd', 'shelter'],
      ['osm-w30', 'Lake Camping', 'camp'],
      ['osm-n4', 'ICA', 'grocery'],
    ]);
    expect(items[1]).toMatchObject({ lat: 61.1, lon: 16.2 }); // bbox centre
  });

  it('groups into 1° tiles, dedupes border overlaps, round-trips rows', () => {
    const a = { id: 'osm-n1', lat: 61.5, lon: 16.5, name: 'A', type: 'camp' as const, category: 'shelter' };
    const b = { id: 'osm-n2', lat: -0.5, lon: -10.2, name: 'B', type: 'water' as const, category: 'water' };
    const tiles = toTiles([a, a, b]);
    expect([...tiles.keys()].sort()).toEqual(['-1_-11', '61_16']);
    expect(tiles.get('61_16')).toHaveLength(1);
    expect(rowToItem(tiles.get('61_16')![0])).toEqual(a);
    expect(cellKey(61.99, 16.0)).toBe('61_16');
  });

  it('finds the cells a route passes, including between distant points and within the radius', () => {
    const cells = cellsAlong([{ lat: 61.5, lon: 15.5 }, { lat: 61.5, lon: 18.5 }], 2000);
    expect(cells.sort()).toEqual(['61_15', '61_16', '61_17', '61_18']);
    // 2 km from a cell edge pulls in the neighbour
    expect(cellsAlong([{ lat: 61.99, lon: 16.5 }], 2000).sort()).toEqual(['61_16', '62_16']);
  });

  it('checks route coverage against the built regions', () => {
    const meta = { built: '2026-10-21', regions: [{ name: 'Spain', bbox: [-18.2, 27.6, 4.4, 43.8] as [number, number, number, number] }], tiles: ['61_16', '40_-4'] };
    expect(covered([{ lat: 61.3, lon: 16.4 }], meta)).toBe(true);
    expect(covered([{ lat: 61.3, lon: 16.4 }, { lat: 45.0, lon: 9.0 }], meta)).toBe(false);
    expect(covered([{ lat: 40.4, lon: -3.7 }], meta)).toBe(true);
    // Inside Spain's bounding box (because of the Canaries) but a cell with no data: Morocco.
    expect(covered([{ lat: 31.6, lon: -8.0 }], meta)).toBe(false);
  });
});
