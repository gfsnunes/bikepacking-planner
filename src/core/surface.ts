/**
 * Road surface along the route: on road (paved), off road (unpaved) or unknown, per track segment.
 * Looked up from the basemap's vector tiles (see tile-surface.ts); stored per segment of the
 * original track so crops and reversal follow.
 */

export const SURFACE = { unknown: 0, paved: 1, unpaved: 2 } as const;
export type SurfaceClass = (typeof SURFACE)[keyof typeof SURFACE];

export interface SurfaceData {
  /** Class per segment of the original track (segment i runs from point i to i+1). */
  segs: Uint8Array;
  from: 'tiles'; // OpenFreeMap / OpenMapTiles vector tiles
  at: string; // ISO date of the lookup
}

/** A stored lookup is usable for a track of n points (older versions stored other kinds). */
export const validSurface = (d: SurfaceData | null | undefined, n: number): d is SurfaceData =>
  !!d && d.from === 'tiles' && d.segs instanceof Uint8Array && d.segs.length === n - 1;

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
