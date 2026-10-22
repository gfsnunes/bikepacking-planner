/**
 * Road surface from the basemap's own vector tiles (OpenFreeMap, OpenMapTiles schema): the
 * `transportation` layer carries `surface` = paved | unpaved, taken from the OpenStreetMap
 * surface tag (absent when the road has none). Each stretch of the route is matched to the
 * nearest road line in the zoom-14 tiles, preferring lines running the same way.
 *
 * OpenFreeMap (read 2026-10-22): no request limits or keys; downloads of at most 3,000 tiles /
 * 50 MB with at most four parallel requests. Schema: https://openmaptiles.org/schema/
 */
import { SURFACE, type SurfaceClass, type SurfaceData } from './surface';
import type { TrackPoint } from './types';

export const ZOOM = 14;
export const MAX_TILES = 3000;
const MATCH_M = 25; // a road further than this from the route doesn't count
const HEADING_PENALTY_M = 15; // added for a road crossing the route rather than following it
const EARTH_M = 40_075_016.686;
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);

/** A road line from a tile, in world tile units at ZOOM (x, y as floats: tile index + fraction). */
export interface RoadLine {
  cls: SurfaceClass;
  pts: Float64Array; // x0, y0, x1, y1, …
}

export const tileXY = (lat: number, lon: number) => {
  const n = 2 ** ZOOM;
  const x = ((lon + 180) / 360) * n;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return { x, y };
};

/** Metres per world tile unit at a latitude. */
const metresPerUnit = (lat: number) => (EARTH_M * Math.cos((lat * Math.PI) / 180)) / 2 ** ZOOM;

/** Class of a road from its OpenMapTiles properties. */
export function roadClass(p: { class?: unknown; surface?: unknown }): SurfaceClass {
  if (p.surface === 'paved') return SURFACE.paved;
  if (p.surface === 'unpaved') return SURFACE.unpaved;
  // Untagged major roads are paved almost without exception in Europe.
  if (typeof p.class === 'string' && MAJOR.has(p.class.replace(/_construction$/, ''))) return SURFACE.paved;
  return SURFACE.unknown;
}

/** Tiles to fetch: every tile within MATCH_M of the route. Keys "x/y". */
export function tilesAlong(points: TrackPoint[]): string[] {
  const keys = new Set<string>();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const { x, y } = tileXY(p.lat, p.lon);
    const r = MATCH_M / metresPerUnit(p.lat);
    for (const tx of [Math.floor(x - r), Math.floor(x + r)])
      for (const ty of [Math.floor(y - r), Math.floor(y + r)]) keys.add(`${tx}/${ty}`);
    // Long gaps between points: add the tiles in between.
    const q = points[i + 1];
    if (q) {
      const b = tileXY(q.lat, q.lon);
      const steps = Math.ceil(Math.max(Math.abs(b.x - x), Math.abs(b.y - y)) * 4);
      for (let s = 1; s < steps; s++) keys.add(`${Math.floor(x + ((b.x - x) * s) / steps)}/${Math.floor(y + ((b.y - y) * s) / steps)}`);
    }
  }
  return [...keys];
}

/** Squared distance from (px, py) to segment a-b, and the segment's direction. */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return { d2: ex * ex + ey * ey, dx, dy };
}

/**
 * Class per route segment (i → i+1), matching each segment's midpoint to the nearest road line
 * within MATCH_M, with a penalty for lines crossing at a wide angle (junctions, bridges).
 */
export function classifySegments(points: TrackPoint[], lines: Map<string, RoadLine[]>): Uint8Array {
  const out = new Uint8Array(Math.max(0, points.length - 1));
  for (let i = 0; i < out.length; i++) {
    const a = tileXY(points[i].lat, points[i].lon);
    const b = tileXY(points[i + 1].lat, points[i + 1].lon);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const rdx = b.x - a.x;
    const rdy = b.y - a.y;
    const rlen = Math.hypot(rdx, rdy);
    const mpu = metresPerUnit((points[i].lat + points[i + 1].lat) / 2);
    const r = MATCH_M / mpu;
    let best = Infinity;
    let cls: SurfaceClass = SURFACE.unknown;
    const seen = new Set<string>();
    for (const tx of [Math.floor(mx - r), Math.floor(mx + r)])
      for (const ty of [Math.floor(my - r), Math.floor(my + r)]) {
        const key = `${tx}/${ty}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const line of lines.get(key) ?? []) {
          const p = line.pts;
          for (let k = 0; k + 3 < p.length; k += 2) {
            // Quick reject on the segment's bounding box.
            if (Math.min(p[k], p[k + 2]) > mx + r || Math.max(p[k], p[k + 2]) < mx - r) continue;
            if (Math.min(p[k + 1], p[k + 3]) > my + r || Math.max(p[k + 1], p[k + 3]) < my - r) continue;
            const s = segDist2(mx, my, p[k], p[k + 1], p[k + 2], p[k + 3]);
            const dM = Math.sqrt(s.d2) * mpu;
            if (dM > MATCH_M) continue;
            const slen = Math.hypot(s.dx, s.dy);
            // |cos| of the angle between route and road: 1 = same line, 0 = crossing.
            const cos = rlen && slen ? Math.abs(rdx * s.dx + rdy * s.dy) / (rlen * slen) : 1;
            const score = dM + (1 - cos) * HEADING_PENALTY_M;
            if (score < best) (best = score), (cls = line.cls);
          }
        }
      }
    out[i] = cls;
  }
  return out;
}

/** Road lines from a decoded tile's transportation layer (any decoder with this shape works). */
export interface DecodedLayer {
  length: number;
  extent: number;
  feature(i: number): { type: number; properties: Record<string, unknown>; loadGeometry(): { x: number; y: number }[][] };
}

export function linesFromLayer(layer: DecodedLayer | undefined, tx: number, ty: number): RoadLine[] {
  if (!layer) return [];
  const out: RoadLine[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 2) continue; // lines only
    if (f.properties.class === 'ferry') continue;
    const cls = roadClass(f.properties);
    for (const ring of f.loadGeometry()) {
      const pts = new Float64Array(ring.length * 2);
      ring.forEach((pt, j) => {
        pts[j * 2] = tx + pt.x / layer.extent;
        pts[j * 2 + 1] = ty + pt.y / layer.extent;
      });
      out.push({ cls, pts });
    }
  }
  return out;
}

/** Run `task` over `items` with at most `limit` at a time (OpenFreeMap allows four). */
export async function pooled<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await task(items[i]);
      }
    }),
  );
  return out;
}

const TILEJSON = 'https://tiles.openfreemap.org/planet';

/** Decode a tile's transportation layer into road lines (the decoder is passed in to keep this module light for tests). */
export type DecodeTile = (bytes: Uint8Array) => DecodedLayer | undefined;

/**
 * Look up the surface of every segment of a track from OpenFreeMap's zoom-14 tiles.
 * `progress(done, total)` counts tiles.
 */
export async function lookupTileSurface(
  points: TrackPoint[],
  decode: DecodeTile,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; progress?: (done: number, total: number) => void } = {},
): Promise<SurfaceData> {
  const { fetchImpl = fetch, signal, progress } = opts;
  const keys = tilesAlong(points);
  if (keys.length > MAX_TILES) throw new Error(`the route needs ${keys.length} map tiles; the tile provider allows ${MAX_TILES} at a time`);
  const tj = (await (await fetchImpl(TILEJSON, { signal })).json()) as { tiles: string[] };
  const template = tj.tiles[0];
  const lines = new Map<string, RoadLine[]>();
  let done = 0;
  progress?.(0, keys.length);
  await pooled(keys, 4, async (key) => {
    const [x, y] = key.split('/').map(Number);
    const res = await fetchImpl(template.replace('{z}', String(ZOOM)).replace('{x}', String(x)).replace('{y}', String(y)), { signal });
    // A missing tile (open sea) simply has no roads.
    if (res.ok) lines.set(key, linesFromLayer(decode(new Uint8Array(await res.arrayBuffer())), x, y));
    else if (res.status !== 404 && res.status !== 204) throw new Error(`map tiles answered ${res.status}`);
    progress?.(++done, keys.length);
  });
  return { segs: classifySegments(points, lines), from: 'tiles', at: new Date().toISOString().slice(0, 10) };
}
