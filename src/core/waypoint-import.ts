import JSZip from 'jszip';
import { haversine } from './geo';
import { guessType, newWaypointId, parseGpxWaypoints, validLatLon } from './gpx';
import type { Waypoint, WaypointType } from './types';

export type WaypointFormat = 'gpx' | 'kml' | 'kmz' | 'geojson' | 'csv';

export interface ImportResult {
  waypoints: Waypoint[];
  skipped: number; // unreadable entries (no or invalid coordinates)
  format: WaypointFormat;
}

// ---------- format detection ----------

export function detectFormat(fileName: string, head: string): WaypointFormat | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'gpx') return 'gpx';
  if (ext === 'kml') return 'kml';
  if (ext === 'kmz') return 'kmz';
  if (ext === 'geojson' || ext === 'json') return 'geojson';
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv';
  const t = head.trimStart();
  if (t.startsWith('PK')) return 'kmz';
  if (t.startsWith('{') || t.startsWith('[')) return 'geojson';
  if (/<gpx[\s>]/i.test(t)) return 'gpx';
  if (/<kml[\s>]/i.test(t)) return 'kml';
  return t.includes(',') || t.includes(';') || t.includes('\t') ? 'csv' : null;
}

export async function importWaypointFile(file: File): Promise<ImportResult> {
  const head = await file.slice(0, 512).text();
  const format = detectFormat(file.name, head);
  if (!format) throw new Error('Unrecognised waypoint file (expected GPX, KML/KMZ, GeoJSON or CSV)');
  if (format === 'kmz') return { ...parseKml(await kmlFromKmz(await file.arrayBuffer())), format };
  const text = await file.text();
  const parsed =
    format === 'gpx' ? parseGpxText(text) : format === 'kml' ? parseKml(text) : format === 'geojson' ? parseGeoJson(text) : parseCsv(text);
  return { ...parsed, format };
}

type Parsed = { waypoints: Waypoint[]; skipped: number };

const make = (lat: number, lon: number, name: string, type: WaypointType, prefix: string): Waypoint => ({
  id: newWaypointId(prefix),
  lat,
  lon,
  name,
  type,
});

/** Type from the name first; fall back to other hints (symbol, category, description) only if the name says nothing. */
function typeFrom(name: string, ...hints: (string | undefined)[]): WaypointType {
  const byName = guessType(name);
  if (byName !== 'other') return byName;
  return guessType(hints.filter(Boolean).join(' '));
}

function xml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Not a valid XML file');
  return doc;
}

// ---------- GPX ----------

export function parseGpxText(text: string): Parsed {
  return parseGpxWaypoints(xml(text));
}

// ---------- KML / KMZ ----------

export async function kmlFromKmz(data: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const entry = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith('.kml'));
  if (!entry) throw new Error('KMZ contains no .kml file');
  return entry.async('string');
}

export function parseKml(text: string): Parsed {
  const doc = xml(text);
  const out: Waypoint[] = [];
  let skipped = 0;
  const child = (el: Element, tag: string) => el.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';
  Array.from(doc.getElementsByTagName('Placemark')).forEach((pm, i) => {
    const point = pm.getElementsByTagName('Point')[0];
    if (!point) return; // lines and polygons are not waypoints
    const [lon, lat] = child(point, 'coordinates').split(',').map(Number);
    if (!validLatLon(lat, lon)) return void skipped++;
    const name = child(pm, 'name') || `Placemark ${i + 1}`;
    // Descriptions can be long free text, so they only count when the name says nothing.
    const desc = child(pm, 'description').replace(/<[^>]*>/g, ' ').slice(0, 200);
    out.push(make(lat, lon, name, typeFrom(name, child(pm, 'styleUrl'), desc), 'kml'));
  });
  return { waypoints: out, skipped };
}

// ---------- GeoJSON ----------

/** OpenStreetMap tags → waypoint type (Overpass / OSM exports). */
export function osmType(p: Record<string, unknown>): WaypointType | null {
  const tag = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  const tourism = tag('tourism');
  const amenity = tag('amenity');
  if (/^(camp_site|caravan_site)$/.test(tourism) || amenity === 'shelter') return 'camp';
  if (/^(alpine_hut|wilderness_hut|hotel|hostel|guest_house|motel|chalet)$/.test(tourism)) return 'lodging';
  if (tourism === 'viewpoint') return 'viewpoint';
  if (amenity === 'drinking_water' || amenity === 'water_point' || tag('natural') === 'spring') return 'water';
  if (amenity === 'cafe') return 'cafe';
  if (/^(restaurant|fast_food|pub|bar|food_court)$/.test(amenity)) return 'food';
  if (amenity === 'bicycle_repair_station' || tag('shop') === 'bicycle') return 'bike';
  if (tag('shop')) return 'shop';
  if (tag('natural') === 'peak' || tag('mountain_pass') === 'yes') return 'summit';
  if (tag('railway') === 'station' || tag('public_transport') === 'station') return 'train';
  if (amenity === 'ferry_terminal') return 'ferry';
  if (/^(town|village|city|hamlet)$/.test(tag('place'))) return 'town';
  return null;
}

type GeoJsonGeometry = { type: string; coordinates?: unknown };
type GeoJsonFeature = { type: string; geometry?: GeoJsonGeometry | null; properties?: Record<string, unknown> | null };

export function parseGeoJson(text: string): Parsed {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file');
  }
  const features: GeoJsonFeature[] = Array.isArray(data)
    ? (data as GeoJsonFeature[])
    : (data as { type?: string }).type === 'FeatureCollection'
      ? ((data as { features?: GeoJsonFeature[] }).features ?? [])
      : [data as GeoJsonFeature];
  const out: Waypoint[] = [];
  let skipped = 0;
  features.forEach((f, i) => {
    const g = f?.geometry;
    if (!g || (g.type !== 'Point' && g.type !== 'MultiPoint')) return; // not a point feature
    const props = f.properties ?? {};
    const str = (k: string) => (typeof props[k] === 'string' ? (props[k] as string) : '');
    const name = str('name') || str('title') || str('label') || `Point ${i + 1}`;
    const type = osmType(props) ?? typeFrom(name, str('type'), str('category'), str('sym'));
    const coords = (g.type === 'Point' ? [g.coordinates] : (g.coordinates as unknown[])) as unknown[];
    for (const c of coords) {
      const [lon, lat] = Array.isArray(c) ? c.map(Number) : [NaN, NaN];
      if (!validLatLon(lat, lon)) skipped++;
      else out.push(make(lat, lon, name, type, 'geo'));
    }
  });
  return { waypoints: out, skipped };
}

// ---------- CSV ----------

/** Split CSV text into rows of fields; handles quoted fields with embedded delimiters, quotes and newlines. */
export function splitCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      (row = []), (field = '');
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function detectDelimiter(firstLine: string): string {
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

const LAT = /^(lat|latitude|y)$/i;
const LON = /^(lon|lng|long|longitude|x)$/i;
const NAME = /^(name|title|label|description)$/i;
const TYPE = /^(type|category|sym|symbol|kind)$/i;

/** European decimal commas ("61,35") are accepted when the delimiter isn't a comma. */
function numOf(s: string | undefined, delim: string): number {
  const t = (s ?? '').trim();
  if (t === '') return NaN;
  return Number(delim === ',' ? t : t.replace(',', '.'));
}

export function parseCsv(text: string): Parsed {
  const clean = text.replace(/^﻿/, '');
  const delim = detectDelimiter(clean.split(/\r?\n/, 1)[0] ?? '');
  const rows = splitCsv(clean, delim);
  if (!rows.length) return { waypoints: [], skipped: 0 };

  const header = rows[0].map((h) => h.trim());
  const find = (re: RegExp) => header.findIndex((h) => re.test(h));
  let iLat = find(LAT);
  let iLon = find(LON);
  let iName = find(NAME);
  const iType = find(TYPE);
  let body = rows.slice(1);

  if (iLat < 0 || iLon < 0) {
    // No usable header: first two numeric columns are lat, lon; first non-numeric column is the name.
    body = rows;
    const first = rows[0];
    const numeric = first.map((f) => f.trim() !== '' && Number.isFinite(numOf(f, delim)));
    iLat = numeric.indexOf(true);
    iLon = numeric.indexOf(true, iLat + 1);
    iName = numeric.findIndex((n, i) => !n && first[i].trim() !== '');
    if (iLat < 0 || iLon < 0) throw new Error('CSV needs latitude and longitude columns');
  }

  const out: Waypoint[] = [];
  let skipped = 0;
  body.forEach((r, i) => {
    const lat = numOf(r[iLat], delim);
    const lon = numOf(r[iLon], delim);
    if (!validLatLon(lat, lon)) return void skipped++;
    const name = (iName >= 0 ? r[iName]?.trim() : '') || `Point ${i + 1}`;
    out.push(make(lat, lon, name, typeFrom(name, iType >= 0 ? r[iType] : ''), 'csv'));
  });
  return { waypoints: out, skipped };
}

// ---------- merging ----------

const DUPLICATE_M = 25;

/**
 * New waypoints that aren't already present (same name, case-insensitive, within 25 m), also
 * de-duplicating within the incoming list itself.
 */
export function mergeWaypoints(existing: Waypoint[], incoming: Waypoint[]): { added: Waypoint[]; duplicates: number } {
  const byName = new Map<string, Waypoint[]>();
  const add = (w: Waypoint) => {
    const k = w.name.trim().toLowerCase();
    const list = byName.get(k);
    if (list) list.push(w);
    else byName.set(k, [w]);
  };
  existing.forEach(add);
  const added: Waypoint[] = [];
  let duplicates = 0;
  for (const w of incoming) {
    const same = byName.get(w.name.trim().toLowerCase()) ?? [];
    if (same.some((o) => haversine(o.lat, o.lon, w.lat, w.lon) <= DUPLICATE_M)) {
      duplicates++;
      continue;
    }
    added.push(w);
    add(w);
  }
  return { added, duplicates };
}
