import { upperBound } from './geo';
import type { Profile } from './types';

const SLOPE_WINDOW_M = 100;

export interface PointInfo {
  km: number;
  ele: number;
  slopePct: number;
  hike: boolean;
}

export interface RangeInfo {
  km: number;
  gainM: number;
  lossM: number;
  netM: number;
  avgSlopePct: number;
  maxSlopePct: number;
  hikeKm: number;
}

/** Last index with dist <= value (searching from lo). */
const lastAtOrBefore = (dist: Float64Array, value: number, lo = 0) => Math.max(lo, upperBound(dist, value, lo) - 1);

/** Grade (%) between two indices, 0 if they are at the same distance. */
function grade(p: Profile, a: number, b: number): number {
  const d = p.dist[b] - p.dist[a];
  return d > 0 ? ((p.ele[b] - p.ele[a]) / d) * 100 : 0;
}

/**
 * Distance, elevation and local slope at a track point. The slope window spans at least 50 m each
 * side, widened outwards to the nearest points so sparse tracks still get a neighbour on each side.
 */
export function pointInfo(p: Profile, idx: number): PointInfo {
  const d = p.dist[idx];
  const half = SLOPE_WINDOW_M / 2;
  const last = p.dist.length - 1;
  const a = Math.min(idx, lastAtOrBefore(p.dist, d - half)); // last point at or before d - half
  const b = Math.max(idx, Math.min(last, upperBound(p.dist, d + half - 1e-9, idx))); // first at or after d + half
  return { km: d / 1000, ele: p.ele[idx], slopePct: grade(p, a, b), hike: p.hike[idx] === 1 };
}

/** Stats for the stretch between two indices, in either order. */
export function rangeInfo(p: Profile, i: number, j: number): RangeInfo {
  const a = Math.min(i, j);
  const b = Math.max(i, j);
  const distM = p.dist[b] - p.dist[a];
  const netM = p.ele[b] - p.ele[a];

  // Steepest 100 m stretch inside the range (whole range if it is shorter).
  let maxSlopePct = distM > 0 ? grade(p, a, b) : 0;
  if (distM > SLOPE_WINDOW_M) {
    maxSlopePct = -Infinity;
    let k = a;
    for (let s = a; s <= b; s++) {
      while (k <= b && p.dist[k] - p.dist[s] < SLOPE_WINDOW_M) k++;
      if (k > b) break;
      maxSlopePct = Math.max(maxSlopePct, grade(p, s, k));
    }
  }

  return {
    km: distM / 1000,
    gainM: p.gain[b] - p.gain[a],
    lossM: p.loss[b] - p.loss[a],
    netM,
    avgSlopePct: distM > 0 ? (netM / distM) * 100 : 0,
    maxSlopePct,
    hikeKm: (p.hikeDist[b] - p.hikeDist[a]) / 1000,
  };
}

const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;

export function formatPoint(i: PointInfo, hasElevation: boolean): string {
  const km = `${i.km.toFixed(1)} km`;
  if (!hasElevation) return km;
  return `${km} · ${Math.round(i.ele)} m · ${signed(i.slopePct)}${i.hike ? ' · hike-a-bike' : ''}`;
}

export function formatRange(r: RangeInfo, hasElevation: boolean): string {
  const km = `${r.km.toFixed(1)} km`;
  if (!hasElevation) return km;
  const hike = r.hikeKm > 0 ? ` · hike ${r.hikeKm.toFixed(1)} km` : '';
  return `${km} · ↑ ${Math.round(r.gainM)} m · ↓ ${Math.round(r.lossM)} m · avg ${signed(r.avgSlopePct)} · max ${signed(r.maxSlopePct)}${hike}`;
}
