/**
 * Cropping and reversing without losing the original: the loaded GPX track (`source`) is kept, and
 * the route in use is a view of it (a stretch a..b, optionally reversed). Also converts between
 * distance along a track and point index.
 */
import { haversine, upperBound } from './geo';
import type { TrackPoint } from './types';

/** The stretch a..b (inclusive indices into the original track) in use, and its direction. */
export interface TrackView {
  a: number;
  b: number;
  reversed: boolean;
}

export const fullView = (n: number, reversed = false): TrackView => ({ a: 0, b: Math.max(0, n - 1), reversed });

export const isFullView = (v: TrackView, n: number) => v.a === 0 && v.b === n - 1;

/** A view is usable on a track of n points. */
export const validView = (v: TrackView | undefined, n: number): v is TrackView =>
  !!v && Number.isInteger(v.a) && Number.isInteger(v.b) && v.a >= 0 && v.b < n && v.b - v.a >= 1 && typeof v.reversed === 'boolean';

/** The route points for a view; the same point objects as in `source`. */
export function viewPoints(source: TrackPoint[], v: TrackView): TrackPoint[] {
  const s = source.slice(v.a, v.b + 1);
  return v.reversed ? s.reverse() : s;
}

export const reverseTrack = (points: TrackPoint[]): TrackPoint[] => [...points].reverse();

/** The original track in riding direction: what the crop window shows. */
export const ridingSource = (source: TrackPoint[], reversed: boolean) => (reversed ? reverseTrack(source) : source);

/** A view from a range picked on the riding-direction original (indices ra..rb of `ridingSource`). */
export function viewFromRiding(ra: number, rb: number, n: number, reversed: boolean): TrackView {
  return reversed ? { a: n - 1 - rb, b: n - 1 - ra, reversed } : { a: ra, b: rb, reversed };
}

/** Inverse of viewFromRiding: where a view's ends sit on the riding-direction original. */
export function ridingRange(v: TrackView, n: number): [number, number] {
  return v.reversed ? [n - 1 - v.b, n - 1 - v.a] : [v.a, v.b];
}

/**
 * Hand-placed day ends carried from one point list to another by point identity (crops keep the
 * point objects), so each stays at the same spot. Ends no longer strictly inside the route are
 * dropped; the rest stay in order, so they remain a valid prefix of days.
 */
export function carryPins(pinned: number[], from: TrackPoint[], to: TrackPoint[]): number[] {
  const at = new Map(to.map((p, i) => [p, i]));
  const out: number[] = [];
  for (const i of pinned) {
    const j = at.get(from[i]);
    if (j === undefined || j <= 0 || j >= to.length - 1 || j <= (out.at(-1) ?? 0)) continue;
    out.push(j);
  }
  return out;
}

/** Cumulative distance along a track, in metres. */
export function cumulativeDist(points: { lat: number; lon: number }[]): Float64Array {
  const d = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) d[i] = d[i - 1] + haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  return d;
}

/** Index of the track point nearest to `km` along the track (`dist` in metres, cumulative). */
export function indexAtKm(dist: Float64Array, km: number): number {
  const m = km * 1000;
  const i = upperBound(dist, m); // first point beyond m
  if (i <= 0) return 0;
  if (i >= dist.length) return dist.length - 1;
  return m - dist[i - 1] <= dist[i] - m ? i - 1 : i;
}

export const kmAt = (dist: Float64Array, i: number) => dist[i] / 1000;

/** A round tick step giving roughly 6–10 ticks over `totalKm`. */
export function tickStep(totalKm: number): number {
  for (const s of [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]) if (totalKm / s <= 10) return s;
  return 2000;
}
