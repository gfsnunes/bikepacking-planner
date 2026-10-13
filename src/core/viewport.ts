export interface Bounds {
  w: number;
  s: number;
  e: number;
  n: number;
}

export type Runs = [number, number][];

/**
 * Stretches of the track inside the map view, as [start, end] point indices. Each run is widened by
 * one point on each side so a segment crossing the map edge stays lit up to the edge.
 * Returns null when the whole track is in view (nothing to grey out).
 */
export function visibleRuns(points: { lat: number; lon: number }[], b: Bounds): Runs | null {
  const n = points.length;
  const runs: Runs = [];
  let start = -1;
  let all = true;
  for (let i = 0; i <= n; i++) {
    const p = points[i];
    const inside = i < n && p.lat >= b.s && p.lat <= b.n && p.lon >= b.w && p.lon <= b.e;
    if (i < n && !inside) all = false;
    if (inside && start < 0) start = i;
    else if (!inside && start >= 0) {
      const a = Math.max(0, start - 1);
      const e = Math.min(n - 1, i);
      // Merge with the previous run when the one-point widening makes them touch.
      const prev = runs[runs.length - 1];
      if (prev && a <= prev[1]) prev[1] = e;
      else runs.push([a, e]);
      start = -1;
    }
  }
  return all ? null : runs;
}

export const sameRuns = (a: Runs | null, b: Runs | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((r, i) => r[0] === b[i][0] && r[1] === b[i][1]));
