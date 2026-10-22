/**
 * Road surface along the route: on road (paved), off road (unpaved) or unknown, per track segment.
 *
 * 1. Map matching: the FOSSGIS Valhalla server (`trace_attributes`) finds the OpenStreetMap way
 *    each stretch follows. Its own `surface` value is not enough: for a way without a surface tag
 *    Valhalla fills one in from the road type (every public road becomes "paved_smooth"), so it
 *    can't tell unknown apart. It is kept only as the fallback estimate.
 * 2. The real tags of those ways come from Overpass, by way id (one small query).
 *
 * FOSSGIS terms (read 2026-10-22): at most one request per second to the routing servers, OSM
 * attribution with a "report a map error" link, an operator contact on the site, no heavy use.
 */
import { haversine } from './geo';
import type { TrackPoint } from './types';

export const SURFACE = { unknown: 0, paved: 1, unpaved: 2 } as const;
export type SurfaceClass = (typeof SURFACE)[keyof typeof SURFACE];

export interface SurfaceData {
  /** Class per segment of the original track (segment i runs from point i to i+1). */
  segs: Uint8Array;
  /** 'tags': from OpenStreetMap tags; 'estimated': Valhalla's own values (the tag lookup failed). */
  from: 'tags' | 'estimated';
  /** Matched way per segment (index into `ways`, NO_WAY when unmatched) and Valhalla's class, for a retry of the tags. */
  segWay: Uint32Array;
  ways: number[];
  valhalla: Uint8Array;
  at: string; // ISO date of the lookup
}

export const NO_WAY = 0xffffffff;
export const VALHALLA_URL = 'https://valhalla1.openstreetmap.de';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const CHUNK_M = 150_000; // the server refuses traces over 200 km
const SPACING_M = 30; // points sent to the matcher are at least this far apart
const REQUEST_GAP_MS = 1100; // FOSSGIS: at most one request per second

const PAVED = new Set([
  'paved', 'asphalt', 'chipseal', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'paving_stones:lanes',
  'sett', 'unhewn_cobblestone', 'cobblestone', 'bricks', 'metal', 'metal_grid', 'wood', 'rubber', 'tartan', 'acrylic',
]);
const UNPAVED = new Set([
  'unpaved', 'compacted', 'fine_gravel', 'gravel', 'shells', 'rock', 'pebblestone', 'ground', 'dirt', 'earth', 'grass',
  'grass_paver', 'mud', 'sand', 'woodchips', 'snow', 'ice', 'salt', 'clay', 'stepping_stones',
]);
// Untagged roads of these classes are paved almost without exception in Europe.
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);

/** Class from a way's OpenStreetMap tags: the surface tag, else tracktype, else major road = paved, else unknown. */
export function classifyTags(tags: Record<string, string> | undefined): SurfaceClass {
  if (!tags) return SURFACE.unknown;
  const s = tags.surface?.split(';')[0].trim();
  if (s && PAVED.has(s)) return SURFACE.paved;
  if (s && UNPAVED.has(s)) return SURFACE.unpaved;
  if (!s && tags.tracktype) return tags.tracktype === 'grade1' ? SURFACE.paved : SURFACE.unpaved;
  if (!s && MAJOR.has(tags.highway)) return SURFACE.paved;
  return SURFACE.unknown;
}

/** Valhalla's surface value (filled in from the road type when untagged): only used as an estimate. */
export function classifyValhalla(surface: string | undefined): SurfaceClass {
  if (!surface) return SURFACE.unknown;
  return surface.startsWith('paved') ? SURFACE.paved : SURFACE.unpaved;
}

/** Google polyline with 6 decimals, as Valhalla expects for `encoded_polyline`. */
export function encodePolyline6(pts: { lat: number; lon: number }[]): string {
  let out = '';
  let pLat = 0;
  let pLon = 0;
  const enc = (v: number) => {
    let x = v < 0 ? ~(v << 1) : v << 1;
    while (x >= 0x20) {
      out += String.fromCharCode((0x20 | (x & 0x1f)) + 63);
      x >>>= 5;
    }
    out += String.fromCharCode(x + 63);
  };
  for (const p of pts) {
    const lat = Math.round(p.lat * 1e6);
    const lon = Math.round(p.lon * 1e6);
    enc(lat - pLat);
    enc(lon - pLon);
    pLat = lat;
    pLon = lon;
  }
  return out;
}

/**
 * Indices of the points to send, at least SPACING_M apart, cut into chunks of at most CHUNK_M.
 * Consecutive chunks share their boundary point, so every segment is covered.
 */
export function matchChunks(points: TrackPoint[], chunkM = CHUNK_M, spacingM = SPACING_M): number[][] {
  const chunks: number[][] = [];
  let cur = [0];
  let since = 0; // distance since the last kept point
  let inChunk = 0;
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    since += d;
    inChunk += d;
    const last = i === points.length - 1;
    if (since >= spacingM || last) {
      cur.push(i);
      since = 0;
    }
    if (inChunk >= chunkM && !last) {
      if (cur[cur.length - 1] !== i) cur.push(i);
      chunks.push(cur);
      cur = [i];
      inChunk = 0;
      since = 0;
    }
  }
  if (cur.length > 1) chunks.push(cur);
  return chunks;
}

interface TraceEdge {
  way_id?: number;
  surface?: string;
}
interface TraceResponse {
  edges?: TraceEdge[];
  matched_points?: { type: string; edge_index?: number }[];
  error?: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(signal.reason)), { once: true });
  });

/** The edge each sent point lies on (undefined when unmatched). */
function pointEdges(r: TraceResponse): (TraceEdge | undefined)[] {
  return (r.matched_points ?? []).map((m) =>
    m.type !== 'unmatched' && m.edge_index != null && r.edges ? r.edges[m.edge_index] : undefined,
  );
}

/** Fetch OpenStreetMap tags for way ids from Overpass (throws when Overpass fails). */
export async function fetchWayTags(ids: number[], fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
  const tags = new Map<number, Record<string, string>>();
  for (let i = 0; i < ids.length; i += 2000) {
    const q = `[out:json][timeout:60];way(id:${ids.slice(i, i + 2000).join(',')});out tags;`;
    const res = await fetchImpl(OVERPASS_URL, {
      method: 'POST',
      body: new URLSearchParams({ data: q }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(70_000)]) : AbortSignal.timeout(70_000),
    });
    if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
    const json = (await res.json()) as { elements: { id: number; tags?: Record<string, string> }[] };
    for (const e of json.elements) tags.set(e.id, e.tags ?? {});
  }
  return tags;
}

/** Classes per segment from the stored matching and a tag table (or Valhalla's estimate without one). */
export function classesFrom(d: Pick<SurfaceData, 'segWay' | 'ways' | 'valhalla'>, tags: Map<number, Record<string, string>> | null) {
  const segs = new Uint8Array(d.segWay.length);
  for (let i = 0; i < segs.length; i++) {
    const w = d.segWay[i];
    if (w === NO_WAY) continue; // unmatched: unknown
    segs[i] = tags ? classifyTags(tags.get(d.ways[w])) : d.valhalla[i];
  }
  return segs;
}

/** Map-match the track and classify every segment. `progress(done, total)` counts matcher requests. */
export async function lookupSurface(
  points: TrackPoint[],
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; progress?: (done: number, total: number) => void; gapMs?: number } = {},
): Promise<SurfaceData> {
  const { fetchImpl = fetch, signal, progress, gapMs = REQUEST_GAP_MS } = opts;
  const n = points.length;
  const segWay = new Uint32Array(Math.max(0, n - 1)).fill(NO_WAY);
  const valhalla = new Uint8Array(Math.max(0, n - 1));
  const ways: number[] = [];
  const wayIndex = new Map<number, number>();
  const chunks = matchChunks(points);
  for (let c = 0; c < chunks.length; c++) {
    if (c > 0) await sleep(gapMs, signal);
    progress?.(c, chunks.length);
    const idx = chunks[c];
    const res = await fetchImpl(`${VALHALLA_URL}/trace_attributes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        encoded_polyline: encodePolyline6(idx.map((i) => points[i])),
        shape_match: 'map_snap',
        costing: 'bicycle',
        costing_options: { bicycle: { bicycle_type: 'mountain' } },
        filters: { attributes: ['edge.way_id', 'edge.surface', 'matched.type', 'matched.edge_index'], action: 'include' },
      }),
      signal,
    });
    const r = (await res.json()) as TraceResponse;
    // A chunk the matcher can't handle (e.g. no roads at all) just stays unknown.
    if (!res.ok || r.error) continue;
    const pe = pointEdges(r);
    for (let k = 0; k < idx.length - 1; k++) {
      const e = pe[k] ?? pe[k + 1];
      if (!e?.way_id) continue;
      let w = wayIndex.get(e.way_id);
      if (w === undefined) wayIndex.set(e.way_id, (w = ways.push(e.way_id) - 1));
      const cls = classifyValhalla(e.surface);
      for (let i = idx[k]; i < idx[k + 1]; i++) (segWay[i] = w), (valhalla[i] = cls);
    }
  }
  progress?.(chunks.length, chunks.length);
  const base = { segWay, ways, valhalla, at: new Date().toISOString().slice(0, 10) };
  try {
    const tags = await fetchWayTags(ways, fetchImpl, signal);
    return { ...base, segs: classesFrom(base, tags), from: 'tags' };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ...base, segs: classesFrom(base, null), from: 'estimated' };
  }
}

/** Retry the tag lookup for data that fell back to Valhalla's estimate (no new matching). */
export async function refineSurface(d: SurfaceData, fetchImpl: typeof fetch = fetch): Promise<SurfaceData> {
  const tags = await fetchWayTags(d.ways, fetchImpl);
  return { ...d, segs: classesFrom(d, tags), from: 'tags', at: new Date().toISOString().slice(0, 10) };
}

/** The classes for the route in use: a stretch a..b of the original, maybe reversed. */
export function viewSegs(segs: Uint8Array, v: { a: number; b: number; reversed: boolean }): Uint8Array {
  const s = segs.slice(v.a, v.b); // segments a..b-1
  return v.reversed ? s.reverse() : s;
}

export interface SurfaceShare {
  paved: number;
  unpaved: number;
  unknown: number; // metres
}

/** Metres of each class between points start and end (`dist` cumulative metres per point). */
export function surfaceShare(segs: Uint8Array, dist: Float64Array, start: number, end: number): SurfaceShare {
  const out: SurfaceShare = { paved: 0, unpaved: 0, unknown: 0 };
  for (let i = start; i < end && i < segs.length; i++) {
    const m = dist[i + 1] - dist[i];
    if (segs[i] === SURFACE.paved) out.paved += m;
    else if (segs[i] === SURFACE.unpaved) out.unpaved += m;
    else out.unknown += m;
  }
  return out;
}

/** Whole percentages that add up to 100 (largest remainder). */
export function percents(s: SurfaceShare): SurfaceShare {
  const total = s.paved + s.unpaved + s.unknown;
  if (!total) return { paved: 0, unpaved: 0, unknown: 0 };
  const keys = ['paved', 'unpaved', 'unknown'] as const;
  const raw = keys.map((k) => (s[k] / total) * 100);
  const floor = raw.map(Math.floor);
  let left = 100 - floor.reduce((a, b) => a + b, 0);
  raw
    .map((r, i) => [r - floor[i], i] as const)
    .sort((x, y) => y[0] - x[0])
    .forEach(([, i]) => left-- > 0 && floor[i]++);
  return { paved: floor[0], unpaved: floor[1], unknown: floor[2] };
}
