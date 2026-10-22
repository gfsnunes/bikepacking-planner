import { TrackIndex, nearestIndex, upperBound } from './geo';
import type { Day, LimitReason, Limits, Profile, SnapSettings, TrackPoint, Waypoint } from './types';

export interface ProjectedWaypoint extends Waypoint {
  idx: number; // nearest track point
  offsetM: number; // distance from the track
}

/**
 * Waypoints with their nearest track point, sorted along the track. Pass the same `cache` object
 * between calls to reuse the spatial index and each waypoint's projection while the track and the
 * waypoint's position are unchanged (names and types can change freely).
 */
export interface ProjectionCache {
  points?: TrackPoint[];
  index?: TrackIndex;
  byId: Map<string, { lat: number; lon: number; idx: number; offsetM: number }>;
}

export function projectWaypoints<W extends Waypoint>(
  points: TrackPoint[],
  wps: W[],
  cache?: ProjectionCache,
): (W & { idx: number; offsetM: number })[] {
  if (!points.length) return [];
  let near: (lat: number, lon: number) => { idx: number; offsetM: number };
  if (cache) {
    if (cache.points !== points) {
      cache.points = points;
      cache.index = new TrackIndex(points);
      cache.byId.clear();
    }
    const index = cache.index!;
    near = (lat, lon) => index.nearest(lat, lon);
  } else near = (lat, lon) => nearestIndex(points, lat, lon);

  return wps
    .map((w) => {
      const hit = cache?.byId.get(w.id);
      if (hit && hit.lat === w.lat && hit.lon === w.lon) return { ...w, idx: hit.idx, offsetM: hit.offsetM };
      const p = near(w.lat, w.lon);
      cache?.byId.set(w.id, { lat: w.lat, lon: w.lon, ...p });
      return { ...w, ...p };
    })
    .sort((a, b) => a.idx - b.idx);
}

export const MAX_SNAP_OFFSET_M = 1000;

export function hasActiveLimit(p: Profile, limits: Limits): boolean {
  return !!(limits.maxKm || (limits.maxGainM && p.hasElevation) || limits.maxHours);
}

/**
 * Last index reachable from s without exceeding any active limit (always at least s+1), and which
 * limit stopped it. reason is null when the track ends before any limit is reached.
 */
export function greedyEnd(p: Profile, s: number, limits: Limits): { end: number; reason: LimitReason | null } {
  const last = p.dist.length - 1;
  let first = last + 1; // first index that breaks a limit
  let reason: LimitReason | null = null;
  const check = (arr: Float64Array, max: number, r: LimitReason) => {
    const i = upperBound(arr, arr[s] + max, s);
    if (i < first) (first = i), (reason = r);
  };
  if (limits.maxKm) check(p.dist, limits.maxKm * 1000, 'distance');
  if (limits.maxGainM && p.hasElevation) check(p.gain, limits.maxGainM, 'climbing');
  if (limits.maxHours) check(p.time, limits.maxHours * 3600, 'time');
  if (first > last) return { end: last, reason: null };
  return { end: Math.max(s + 1, first - 1), reason };
}

export const DEFAULT_SNAP_AHEAD_KM = 2;

/**
 * The matching waypoint nearest to the limit point e (by distance along the track): up to
 * `radiusKm` before it or `aheadKm` past it. A tie goes to the one before, which keeps the day
 * within its limit.
 */
function snapTarget(p: Profile, s: number, e: number, wps: ProjectedWaypoint[], snap: SnapSettings) {
  const at = p.dist[e];
  const back = snap.radiusKm * 1000;
  const ahead = (snap.aheadKm ?? DEFAULT_SNAP_AHEAD_KM) * 1000;
  let best: ProjectedWaypoint | undefined;
  let bestGap = Infinity;
  for (const w of wps) {
    if (w.idx <= s || w.offsetM > MAX_SNAP_OFFSET_M || !snap.types.includes(w.type)) continue;
    const d = p.dist[w.idx] - at; // < 0 before the limit point, > 0 past it
    if (d < -back || d > ahead) continue;
    const gap = Math.abs(d) + (d > 0 ? 1e-6 : 0);
    if (gap < bestGap) (best = w), (bestGap = gap);
  }
  return best;
}

/**
 * Split the track into days. `pinned` holds the end indices of the first days, placed by hand.
 * Those are kept; the rest of the track is split automatically, each day ending at the first
 * point where any active limit would be exceeded (optionally moved to a nearby waypoint).
 */
export function splitDays(
  p: Profile,
  limits: Limits,
  pinned: number[],
  wps: ProjectedWaypoint[] = [],
  snap?: SnapSettings,
): Day[] {
  const last = p.dist.length - 1;
  const days: Day[] = [];
  let s = 0;
  for (const e of pinned) {
    if (e <= s || e >= last) break;
    days.push({ start: s, end: e, pinned: true, reason: 'manual' });
    s = e;
  }
  const active = hasActiveLimit(p, limits);
  while (s < last && days.length < 1000) {
    const g = active ? greedyEnd(p, s, limits) : { end: last, reason: null };
    const day: Day = { start: s, end: g.end, pinned: false, reason: g.reason ?? 'finish' };
    if (g.reason && snap?.enabled) {
      const w = snapTarget(p, s, g.end, wps, snap);
      if (w) Object.assign(day, { end: w.idx, reason: 'waypoint', limitReason: g.reason, snappedTo: w.name });
    }
    days.push(day);
    s = day.end;
  }
  return days;
}

/** New pin list after the user drags day k's end to idx: every earlier day end is frozen where it is. */
export function pinsAfterDrag(days: Day[], pinned: number[], k: number, idx: number): number[] {
  const next = days.map((d) => d.end).slice(0, Math.max(k + 1, pinned.length));
  next[k] = idx;
  return next;
}

/** Allowed index range for dragging day k's end: strictly between the neighbouring ends. */
export function dragRange(days: Day[], k: number): [number, number] {
  return [days[k].start + 1, days[k + 1] ? days[k + 1].end - 1 : days[k].end];
}
