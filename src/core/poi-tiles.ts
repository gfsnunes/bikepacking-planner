/**
 * Pre-built waypoint library: OpenStreetMap places cut into 1°×1° tiles, published as static files
 * on a separate Cloudflare Pages site (see data-pipeline/ and .github/workflows/poi-tiles.yml).
 *
 * Shared by the build pipeline (writes tiles) and the app (reads them), so the format and the
 * category rules live in one place.
 *
 * Layout under the data site's /v1/:
 *   meta.json                 { built, osmDate?, regions: [{ name, bbox }], tiles: ["61_16", ...] }
 *   tiles/<lat>_<lon>.json     { items: [[id, lat, lon, name, type, category], ...] }
 * where <lat>_<lon> is the floor of the cell's south-west corner, e.g. 61_16 covers 61–62°N, 16–17°E.
 */
import { LIBRARY_CATEGORIES, parseElements, type LibraryItem } from './osm-library';
import type { WaypointType } from './types';

export const TILE_VERSION = 'v1';

export interface TileMeta {
  built: string; // ISO date the pipeline ran
  regions: { name: string; bbox: [number, number, number, number] }[]; // [west, south, east, north]
  tiles: string[]; // cells that have at least one place
}

export type TileRow = [id: string, lat: number, lon: number, name: string, type: WaypointType, category: string];

export const cellKey = (lat: number, lon: number) => `${Math.floor(lat)}_${Math.floor(lon)}`;

// ---------- pipeline side ----------

/** osmium tags-filter expressions for every library category (derived, so they can't drift). */
export function osmiumFilters(): string[] {
  const byKey = new Map<string, Set<string>>();
  for (const c of LIBRARY_CATEGORIES) {
    for (const q of c.query) {
      const set = byKey.get(q.key) ?? new Set<string>();
      q.values.forEach((v) => set.add(v));
      byKey.set(q.key, set);
    }
  }
  return [...byKey].map(([key, vals]) => `nwr/${key}=${[...vals].sort().join(',')}`);
}

/** A feature from `osmium export -f geojsonseq` with attributes { type: true, id: true }. */
interface OsmiumFeature {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, string | number> & { '@type'?: string; '@id'?: number };
}

/** Bounding-box centre of any (multi)polygon/point coordinates, like Overpass's `out center`. */
function centre(coords: unknown): { lat: number; lon: number } | null {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [lon, lat] = c as number[];
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(coords);
  return Number.isFinite(w) ? { lat: (s + n) / 2, lon: (w + e) / 2 } : null;
}

/** Turn osmium features into library items using the app's own classification. */
export function featuresToItems(features: OsmiumFeature[]): LibraryItem[] {
  const elements = features.flatMap((f) => {
    const p = f.properties;
    const osmType = p['@type'];
    const id = p['@id'];
    if ((osmType !== 'node' && osmType !== 'way' && osmType !== 'relation') || typeof id !== 'number') return [];
    const c = f.geometry.type === 'Point' ? null : centre(f.geometry.coordinates);
    const [lon, lat] = f.geometry.type === 'Point' ? (f.geometry.coordinates as number[]) : [c?.lon, c?.lat];
    if (lat == null || lon == null) return [];
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(p)) if (!k.startsWith('@')) tags[k] = String(v);
    return [{ type: osmType as 'node' | 'way' | 'relation', id, lat, lon, tags }];
  });
  return parseElements(
    elements,
    LIBRARY_CATEGORIES.map((c) => c.id),
  );
}

/** Group items into tiles (deduplicated by id: neighbouring country extracts overlap at borders). */
export function toTiles(items: LibraryItem[]): Map<string, TileRow[]> {
  const seen = new Set<string>();
  const tiles = new Map<string, TileRow[]>();
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    const key = cellKey(it.lat, it.lon);
    const rows = tiles.get(key) ?? [];
    rows.push([it.id, +it.lat.toFixed(5), +it.lon.toFixed(5), it.name, it.type, it.category]);
    tiles.set(key, rows);
  }
  return tiles;
}

// ---------- app side ----------

/** Cells within radiusM of any of the points (points should be a simplified route line). */
export function cellsAlong(points: { lat: number; lon: number }[], radiusM: number): string[] {
  const keys = new Set<string>();
  // Densify long segments so no cell between two far-apart points is skipped.
  const dense: { lat: number; lon: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    dense.push(a);
    const b = points[i + 1];
    if (!b) break;
    const steps = Math.ceil(Math.max(Math.abs(b.lat - a.lat), Math.abs(b.lon - a.lon)) / 0.25);
    for (let s = 1; s < steps; s++) dense.push({ lat: a.lat + ((b.lat - a.lat) * s) / steps, lon: a.lon + ((b.lon - a.lon) * s) / steps });
  }
  for (const p of dense) {
    const dLat = radiusM / 111_000;
    const dLon = radiusM / (111_000 * Math.max(0.1, Math.cos((p.lat * Math.PI) / 180)));
    for (let la = Math.floor(p.lat - dLat); la <= Math.floor(p.lat + dLat); la++)
      for (let lo = Math.floor(p.lon - dLon); lo <= Math.floor(p.lon + dLon); lo++) keys.add(`${la}_${lo}`);
  }
  return [...keys];
}

/** True when every point lies inside one of the regions the tiles were built from. */
export function covered(points: { lat: number; lon: number }[], meta: TileMeta): boolean {
  return points.every((p) => meta.regions.some(({ bbox: [w, s, e, n] }) => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n));
}

export const rowToItem = ([id, lat, lon, name, type, category]: TileRow): LibraryItem => ({ id, lat, lon, name, type, category });
