/** Cropping and reversing a track, and converting between distance along it and point index. */
import { upperBound } from './geo';
import type { TrackPoint } from './types';

/** Keep points a..b (inclusive). */
export function cropTrack(points: TrackPoint[], a: number, b: number): TrackPoint[] {
  if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b < points.length && b - a >= 1)) {
    throw new Error(`Bad crop range ${a}..${b} for ${points.length} points`);
  }
  return points.slice(a, b + 1);
}

/**
 * Hand-placed day ends after cropping to a..b: those strictly inside the range, shifted to the new
 * indices. Pins are a prefix (days 1..k), so dropping the leading ones still leaves a prefix.
 */
export function cropPins(pinned: number[], a: number, b: number): number[] {
  return pinned.filter((p) => p > a && p < b).map((p) => p - a);
}

export const reverseTrack = (points: TrackPoint[]): TrackPoint[] => [...points].reverse();

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
