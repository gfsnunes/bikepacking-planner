// @vitest-environment happy-dom
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  kmlFromKmz,
  mergeWaypoints,
  parseCsv,
  parseGeoJson,
  parseGpxText,
  parseKml,
  splitCsv,
} from './waypoint-import';

const pick = (ws: { name: string; lat: number; lon: number; type: string }[]) =>
  ws.map(({ name, lat, lon, type }) => ({ name, lat, lon, type }));

describe('waypoint import', () => {
  it('detects formats by extension and content', () => {
    expect(detectFormat('a.KML', '')).toBe('kml');
    expect(detectFormat('pois.json', '')).toBe('geojson');
    expect(detectFormat('noext', '<?xml version="1.0"?><gpx version="1.1">')).toBe('gpx');
    expect(detectFormat('noext', '{"type":"FeatureCollection"}')).toBe('geojson');
    expect(detectFormat('noext', 'PK\u0003\u0004')).toBe('kmz');
    expect(detectFormat('noext', 'lat;lon;name')).toBe('csv');
  });

  it('parses GPX waypoints and ignores the track', () => {
    const r = parseGpxText(`<gpx><wpt lat="61.3" lon="16.4"><name>Lake camp</name></wpt>
      <wpt lat="95" lon="16"><name>Bad</name></wpt>
      <trk><trkseg><trkpt lat="61" lon="16"/><trkpt lat="62" lon="16"/></trkseg></trk></gpx>`);
    expect(pick(r.waypoints)).toEqual([{ name: 'Lake camp', lat: 61.3, lon: 16.4, type: 'camp' }]);
    expect(r.skipped).toBe(1);
  });

  const KML = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
    <Placemark><name>Fika stop</name><Point><coordinates>16.40,61.30,0</coordinates></Point></Placemark>
    <Placemark><name>Spot 2</name><description>Great drinking water tap</description><Point><coordinates> 16.5,61.4 </coordinates></Point></Placemark>
    <Placemark><name>A line</name><LineString><coordinates>16,61 17,62</coordinates></LineString></Placemark>
    <Placemark><name>Broken</name><Point><coordinates>abc</coordinates></Point></Placemark>
  </Document></kml>`;

  it('parses KML placemarks (points only), using the description when the name says nothing', () => {
    const r = parseKml(KML);
    expect(pick(r.waypoints)).toEqual([
      { name: 'Fika stop', lat: 61.3, lon: 16.4, type: 'cafe' },
      { name: 'Spot 2', lat: 61.4, lon: 16.5, type: 'water' },
    ]);
    expect(r.skipped).toBe(1);
  });

  it('reads the KML inside a KMZ', async () => {
    const zip = new JSZip();
    zip.file('files/readme.txt', 'x');
    zip.file('doc.kml', KML);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    expect(parseKml(await kmlFromKmz(buf)).waypoints).toHaveLength(2);
  });

  it('parses GeoJSON points and maps OSM tags to types', () => {
    const r = parseGeoJson(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'Point', coordinates: [16.4, 61.3] }, properties: { name: 'Björnbo', tourism: 'camp_site' } },
          { type: 'Feature', geometry: { type: 'Point', coordinates: [16.5, 61.4] }, properties: { amenity: 'drinking_water' } },
          { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[16.6, 61.5], [16.7, 61.6]] }, properties: { name: 'Summit', natural: 'peak' } },
          { type: 'Feature', geometry: { type: 'LineString', coordinates: [[16, 61], [17, 62]] }, properties: {} },
          { type: 'Feature', geometry: { type: 'Point', coordinates: [500, 61] }, properties: { name: 'Bad' } },
        ],
      }),
    );
    expect(r.waypoints.map((w) => [w.name, w.type])).toEqual([
      ['Björnbo', 'camp'],
      ['Point 2', 'water'],
      ['Summit', 'summit'],
      ['Summit', 'summit'],
    ]);
    expect(r.skipped).toBe(1);
  });

  it('parses CSV with semicolons, quotes, header aliases and decimal commas', () => {
    const r = parseCsv('﻿Title;Latitude;Lng;Category\n"Coop; Järvsö";61,71;16,17;shop\nNo coords;;;\n"He said ""hi""";61.8;16.2;water\n');
    expect(pick(r.waypoints)).toEqual([
      { name: 'Coop; Järvsö', lat: 61.71, lon: 16.17, type: 'shop' },
      { name: 'He said "hi"', lat: 61.8, lon: 16.2, type: 'water' },
    ]);
    expect(r.skipped).toBe(1);
  });

  it('parses headerless CSV (first two numeric columns are lat, lon)', () => {
    const r = parseCsv('Vindskydd Ön,61.2,16.1\nBike repair Edsbyn,61.37,15.82\n');
    expect(pick(r.waypoints)).toEqual([
      { name: 'Vindskydd Ön', lat: 61.2, lon: 16.1, type: 'camp' },
      { name: 'Bike repair Edsbyn', lat: 61.37, lon: 15.82, type: 'bike' },
    ]);
  });

  it('splits quoted CSV fields with newlines', () => {
    expect(splitCsv('a,"b\nc",d\r\n1,2,3', ',')).toEqual([
      ['a', 'b\nc', 'd'],
      ['1', '2', '3'],
    ]);
  });

  it('skips duplicates (same name within 25 m), including inside the incoming list', () => {
    const w = (id: string, name: string, lat: number, lon = 16) => ({ id, name, lat, lon, type: 'camp' as const });
    const existing = [w('a', 'Lake camp', 61)];
    const incoming = [
      w('b', 'lake CAMP ', 61.0001), // ~11 m, same name → duplicate
      w('c', 'Lake camp', 61.001), // ~111 m → kept
      w('d', 'Other', 61),
      w('e', 'Other', 61.00005), // duplicate of d
    ];
    const r = mergeWaypoints(existing, incoming);
    expect(r.added.map((x) => x.id)).toEqual(['c', 'd']);
    expect(r.duplicates).toBe(2);
  });
});
