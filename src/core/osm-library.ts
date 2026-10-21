/**
 * Waypoint library from OpenStreetMap, queried live from the public Overpass API along a corridor
 * around the track. One request per search: the track is simplified to a polyline and passed to
 * Overpass's `around` filter; results are classified into categories here.
 *
 * Fair use (read 2026-10-21, https://dev.overpass-api.de/overpass-doc/en/preface/commons.html):
 * ~10 000 requests and ~1 GB per day per client; rate-limited requests get HTTP 429, resource
 * limits HTTP 504. Results are cached per track/radius/categories so repeat searches don't re-query.
 * Data © OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright).
 */
import { osmType } from './waypoint-import';
import type { TrackPoint, Waypoint, WaypointType } from './types';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

type Tags = Record<string, string>;

export interface LibraryCategory {
  id: string;
  label: string;
  one: string; // name for an unnamed place, e.g. "Shelter"
  type: WaypointType; // fallback when the tags don't say something more specific
  /** OSM keys and values this category asks Overpass for. */
  query: { key: string; values: string[] }[];
  /** Exact client-side test (stricter than the query, e.g. drops bus-stop shelters). */
  match: (t: Tags) => boolean;
}

const yes = (v: string | undefined) => v === 'yes';

export const LIBRARY_CATEGORIES: LibraryCategory[] = [
  {
    id: 'shelter',
    label: 'Shelters & lean-tos',
    one: 'Shelter',
    type: 'camp',
    query: [{ key: 'amenity', values: ['shelter'] }],
    // OSM "shelter" also covers bus stops, changing rooms and animal shelters; keep the ones for people outdoors.
    match: (t) => t.amenity === 'shelter' && !/^(public_transport|changing_rooms|field_shelter)$/.test(t.shelter_type ?? ''),
  },
  {
    id: 'camp',
    label: 'Campsites',
    one: 'Campsite',
    type: 'camp',
    query: [{ key: 'tourism', values: ['camp_site', 'caravan_site'] }],
    match: (t) => t.tourism === 'camp_site' || t.tourism === 'caravan_site',
  },
  {
    id: 'hut',
    label: 'Huts & cabins',
    one: 'Hut',
    type: 'lodging',
    query: [{ key: 'tourism', values: ['alpine_hut', 'wilderness_hut'] }],
    match: (t) => t.tourism === 'alpine_hut' || t.tourism === 'wilderness_hut',
  },
  {
    id: 'lodging',
    label: 'Hostels & hotels',
    one: 'Lodging',
    type: 'lodging',
    query: [{ key: 'tourism', values: ['hostel', 'guest_house', 'hotel', 'motel'] }],
    match: (t) => /^(hostel|guest_house|hotel|motel)$/.test(t.tourism ?? ''),
  },
  {
    id: 'water',
    label: 'Drinking water',
    one: 'Drinking water',
    type: 'water',
    query: [
      { key: 'amenity', values: ['drinking_water', 'water_point'] },
      { key: 'natural', values: ['spring'] },
    ],
    // Springs only when mapped as drinkable.
    match: (t) =>
      t.amenity === 'drinking_water' || t.amenity === 'water_point' || (t.natural === 'spring' && yes(t.drinking_water)),
  },
  {
    id: 'grocery',
    label: 'Grocery stores',
    one: 'Grocery store',
    type: 'shop',
    query: [{ key: 'shop', values: ['supermarket', 'convenience', 'general', 'greengrocer', 'bakery'] }],
    match: (t) => /^(supermarket|convenience|general|greengrocer|bakery)$/.test(t.shop ?? ''),
  },
  {
    id: 'food',
    label: 'Cafés & restaurants',
    one: 'Café / restaurant',
    type: 'food',
    query: [{ key: 'amenity', values: ['cafe', 'restaurant', 'fast_food', 'pub'] }],
    match: (t) => /^(cafe|restaurant|fast_food|pub)$/.test(t.amenity ?? ''),
  },
  {
    id: 'bike',
    label: 'Bike shops & repair',
    one: 'Bike shop',
    type: 'bike',
    query: [
      { key: 'shop', values: ['bicycle'] },
      { key: 'amenity', values: ['bicycle_repair_station'] },
    ],
    match: (t) => t.shop === 'bicycle' || t.amenity === 'bicycle_repair_station',
  },
  {
    id: 'train',
    label: 'Train stations',
    one: 'Train station',
    type: 'train',
    query: [{ key: 'railway', values: ['station'] }],
    match: (t) => t.railway === 'station' && t.station !== 'subway',
  },
];

const byId = new Map(LIBRARY_CATEGORIES.map((c) => [c.id, c]));

// ---------- track simplification ----------

const RAD = Math.PI / 180;

/** Douglas–Peucker on an equirectangular projection; tolerance in metres. Keeps first and last point. */
export function simplifyTrack(points: { lat: number; lon: number }[], toleranceM: number): { lat: number; lon: number }[] {
  if (points.length <= 2) return points.slice();
  const k = Math.cos(points[0].lat * RAD) * 111_320;
  const xy = points.map((p) => [p.lon * k, p.lat * 110_540] as const);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = toleranceM;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > worstD) (worstD = d), (worst = i);
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Simplify until the polyline is short enough to send (tolerance grows if needed). */
export function corridorLine(points: TrackPoint[], maxPoints = 800): { lat: number; lon: number }[] {
  let tol = 100;
  let line = simplifyTrack(points, tol);
  while (line.length > maxPoints && tol < 5000) line = simplifyTrack(points, (tol *= 2));
  return line;
}

// ---------- query ----------

/** One Overpass QL query: all requested categories within radiusM of the polyline. */
export function buildQuery(line: { lat: number; lon: number }[], radiusM: number, categoryIds: string[]): string {
  const want = new Map<string, Set<string>>();
  for (const id of categoryIds) {
    for (const q of byId.get(id)?.query ?? []) {
      const set = want.get(q.key) ?? new Set<string>();
      q.values.forEach((v) => set.add(v));
      want.set(q.key, set);
    }
  }
  const coords = line.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(',');
  const around = `(around:${Math.round(radiusM)},${coords})`;
  const statements = [...want].map(([key, vals]) => `nwr${around}["${key}"~"^(${[...vals].sort().join('|')})$"];`);
  return `[out:json][timeout:90];(${statements.join('')});out tags center;`;
}

// ---------- results ----------

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Tags;
}

export interface LibraryItem extends Waypoint {
  category: string; // LibraryCategory id
}

/** Turn Overpass elements into waypoints, keeping only the requested categories. */
export function parseElements(elements: OverpassElement[], categoryIds: string[]): LibraryItem[] {
  const cats = categoryIds.map((id) => byId.get(id)).filter((c): c is LibraryCategory => !!c);
  const out: LibraryItem[] = [];
  const seen = new Set<string>();
  for (const e of elements) {
    const tags = e.tags ?? {};
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat == null || lon == null) continue;
    const cat = cats.find((c) => c.match(tags));
    if (!cat) continue;
    const id = `osm-${e.type[0]}${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = (tags.name || tags['name:en'] || '').trim() || cat.one;
    out.push({ id, lat, lon, name, type: osmType(tags) ?? cat.type, category: cat.id });
  }
  return out;
}

export class OverpassBusyError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Statuses meaning "server busy or overloaded, try later": rate limit, gateway errors, timeout. */
const BUSY = new Set([429, 502, 503, 504]);
const REQUEST_TIMEOUT_MS = 100_000; // the query itself allows 90 s
const RETRY_WAIT_MS = 8_000;

/**
 * POST the query (a form-encoded "simple" request, so no CORS preflight). When Overpass is busy,
 * overloaded or doesn't answer within 100 s, retry once after a pause; after that the caller tells
 * the user to try again later. A user abort (dialog closed) is passed straight through.
 */
export async function runQuery(query: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<OverpassElement[]> {
  let last = 'no response';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(RETRY_WAIT_MS);
    if (signal?.aborted) throw signal.reason;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetchImpl(OVERPASS_URL, { method: 'POST', body: new URLSearchParams({ data: query }), signal: combined });
    } catch (e) {
      if (signal?.aborted) throw e; // closed by the user
      last = timeout.aborted ? 'no answer within 100 s' : 'network error';
      continue; // timed out or connection dropped: treat as busy
    }
    if (res.ok) return ((await res.json()) as { elements?: OverpassElement[] }).elements ?? [];
    if (!BUSY.has(res.status)) throw new Error(`Overpass returned HTTP ${res.status}`);
    last = `HTTP ${res.status}`;
  }
  throw new OverpassBusyError(`Overpass is busy (${last})`);
}

const cache = new Map<string, LibraryItem[]>();

/** Search the corridor; repeat searches for the same track, radius and categories come from memory. */
export async function searchLibrary(
  points: TrackPoint[],
  radiusM: number,
  categoryIds: string[],
  signal?: AbortSignal,
): Promise<LibraryItem[]> {
  const ids = [...categoryIds].sort();
  const first = points[0];
  const last = points[points.length - 1];
  const key = `${points.length}|${first.lat},${first.lon}|${last.lat},${last.lon}|${radiusM}|${ids.join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const elements = await runQuery(buildQuery(corridorLine(points), radiusM, ids), signal);
  const items = parseElements(elements, ids);
  cache.set(key, items);
  return items;
}
