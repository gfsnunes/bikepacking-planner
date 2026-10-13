// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { guessType, parseGpx, toGpx } from './gpx';

const SAMPLE = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="61.35" lon="16.39"><name>Lake campsite</name></wpt>
  <wpt lat="61.36" lon="16.40"><name>Fountain</name><sym>Drinking Water</sym></wpt>
  <trk><name>Test &amp; route</name>
    <trkseg>
      <trkpt lat="61.34" lon="16.38"><ele>50</ele></trkpt>
      <trkpt lat="61.34" lon="16.38"><ele>50</ele></trkpt>
      <trkpt lat="61.35" lon="16.39"><ele>60</ele></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="61.36" lon="16.40"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('gpx', () => {
  it('parses tracks across segments, drops duplicates, reads waypoints', () => {
    const g = parseGpx(SAMPLE);
    expect(g.name).toBe('Test & route');
    expect(g.points).toHaveLength(3);
    expect(g.points[2].ele).toBeNull();
    expect(g.waypoints.map((w) => w.type)).toEqual(['camp', 'water']);
  });

  it('round-trips', () => {
    const g = parseGpx(SAMPLE);
    const again = parseGpx(toGpx(g.name, g.points, [{ lat: 61, lon: 16, name: 'A <b>' }]));
    expect(again.name).toBe(g.name);
    expect(again.points).toHaveLength(3);
    expect(again.waypoints[0].name).toBe('A <b>');
  });

  it('rejects files without a track', () => {
    expect(() => parseGpx('<gpx></gpx>')).toThrow();
  });

  it('guesses waypoint types from names', () => {
    const cases: [string, string][] = [
      ['Lake campsite', 'camp'], ['Vindskydd Norrsjön', 'camp'], ['Hostel Central', 'lodging'],
      ['Fjällstuga', 'lodging'], ['Drinking water', 'water'], ['Fonte da vila', 'water'],
      ['Café Fika', 'cafe'], ['Pizza place', 'food'], ['ICA Nära', 'shop'], ['Coop', 'shop'],
      ['Bike repair', 'bike'], ['Bollnäs station', 'train'], ['Ferry to Gotland', 'ferry'],
      ['Summit', 'summit'], ['Utsikt', 'viewpoint'], ['Village', 'town'], ['Warning: gravel', 'danger'],
      ['Nearby spot', 'other'], ['Taper', 'other'],
    ];
    for (const [name, type] of cases) expect([name, guessType(name)]).toEqual([name, type]);
  });
});
