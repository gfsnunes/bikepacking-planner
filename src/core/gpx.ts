import type { TrackPoint, Waypoint, WaypointType } from './types';

export interface ParsedGpx {
  name: string;
  points: TrackPoint[];
  waypoints: Waypoint[];
}

const num = (s: string | null | undefined) => (s == null || s.trim() === '' ? null : Number(s));

// Keyword rules, first match wins. English plus common Swedish and Portuguese words.
const TYPE_RULES: [WaypointType, RegExp][] = [
  ['danger', /danger|warning|caution|closed|varning|fara|perigo|atenção/],
  ['camp', /camp|tent|bivy|bivouac|wild ?camp|tält|vindskydd|lägerplats|campismo|acampamento/],
  ['lodging', /hotel|hostel|motel|lodg|\binn\b|b&b|guest ?house|\bhut\b|cabin|refuge|stuga|vandrarhem|pousada|albergue|alojamento|sleep/],
  ['water', /water|fountain|spring|\btap\b|drinking|vatten|källa|brunn|água|fonte|bica/],
  ['cafe', /caf[eé]|coffee|fika|konditori|pastelaria|bakery|bageri|padaria/],
  ['food', /food|restaurant|pizza|burger|diner|\bpub\b|\bbar\b|kiosk|grill|lunch|\bmat\b|restaurante|tasca/],
  ['shop', /shop|store|market|grocery|supermarket|\bica\b|\bcoop\b|konsum|lidl|willys|butik|affär|mercado|loja|continente|pingo doce/],
  ['bike', /bike|bicycle|cycle|cykel|bicicleta|repair|verkstad/],
  ['train', /train|station|railway|tåg|järnväg|comboio|estação|bus stop|busshållplats/],
  ['ferry', /ferry|färja|båt|\bboat\b|ferje|barco|\bpier\b|harbou?r|\bhamn\b/],
  ['summit', /summit|peak|\btop\b|mountain|\bcol\b|\bpass\b|topp|fjäll|\bberg\b|\bpico\b|serra|cume/],
  ['viewpoint', /view|lookout|scenic|utsikt|miradouro|miradoiro|panorama/],
  ['town', /town|city|village|\bstad\b|\bby\b|\bort\b|\bvila\b|aldeia|cidade/],
];

export function guessType(label: string): WaypointType {
  const s = label.toLowerCase();
  for (const [type, re] of TYPE_RULES) if (re.test(s)) return type;
  return 'other';
}

const childText = (el: Element, tag: string) => el.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';

/** Unique id for a new waypoint (safe across repeated loads and imports). */
export const newWaypointId = (() => {
  let n = 0;
  return (prefix = 'wp') => `${prefix}-${Date.now().toString(36)}-${(n++).toString(36)}`;
})();

/** `<wpt>` elements of a GPX document. Points with missing or invalid coordinates are counted as skipped. */
export function parseGpxWaypoints(doc: Document): { waypoints: Waypoint[]; skipped: number } {
  const waypoints: Waypoint[] = [];
  let skipped = 0;
  Array.from(doc.getElementsByTagName('wpt')).forEach((w, i) => {
    const lat = num(w.getAttribute('lat'));
    const lon = num(w.getAttribute('lon'));
    if (lat == null || lon == null || !validLatLon(lat, lon)) return void skipped++;
    const name = childText(w, 'name') || `Waypoint ${i + 1}`;
    waypoints.push({
      id: newWaypointId('gpx'),
      lat,
      lon,
      name,
      type: guessType(`${name} ${childText(w, 'sym')} ${childText(w, 'type')}`),
    });
  });
  return { waypoints, skipped };
}

export const validLatLon = (lat: number, lon: number) =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

export function parseGpx(xml: string): ParsedGpx {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Not a valid GPX/XML file');
  const text = (el: Element, tag: string) => el.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';

  // All track segments in order; fall back to route points if there is no track.
  let nodes = Array.from(doc.getElementsByTagName('trkpt'));
  if (!nodes.length) nodes = Array.from(doc.getElementsByTagName('rtept'));
  const points: TrackPoint[] = [];
  for (const n of nodes) {
    const lat = num(n.getAttribute('lat'));
    const lon = num(n.getAttribute('lon'));
    if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) continue;
    const prev = points[points.length - 1];
    if (prev && prev.lat === lat && prev.lon === lon) continue; // drop exact duplicates
    const e = num(n.getElementsByTagName('ele')[0]?.textContent);
    points.push({ lat, lon, ele: e == null || Number.isNaN(e) ? null : e });
  }
  if (points.length < 2) throw new Error('GPX has no track or route with at least 2 points');

  const { waypoints } = parseGpxWaypoints(doc);

  const trk = doc.getElementsByTagName('trk')[0] ?? doc.getElementsByTagName('rte')[0];
  const meta = doc.getElementsByTagName('metadata')[0];
  const name = (trk && text(trk, 'name')) || (meta && text(meta, 'name')) || 'Untitled route';
  return { name, points, waypoints };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface GpxWpt {
  lat: number;
  lon: number;
  name: string;
  sym?: string;
}

export function toGpx(
  name: string,
  pts: { lat: number; lon: number; ele?: number | null }[],
  wpts: GpxWpt[] = [],
): string {
  const w = wpts
    .map(
      (p) =>
        `  <wpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><name>${esc(p.name)}</name>` +
        `${p.sym ? `<sym>${esc(p.sym)}</sym>` : ''}</wpt>`,
    )
    .join('\n');
  const t = pts
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">` +
        `${p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : ''}</trkpt>`,
    )
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Bikepacking Day Planner" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${esc(name)}</name></metadata>`,
    w,
    '  <trk>',
    `    <name>${esc(name)}</name>`,
    '    <trkseg>',
    t,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
