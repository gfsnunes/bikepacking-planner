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

/** The latest matching waypoint between s and e, within radius (searching backwards only). */
function snapTarget(p: Profile, s: number, e: number, wps: ProjectedWaypoint[], snap: SnapSettings) {
  const minDist = p.dist[e] - snap.radiusKm * 1000;
  let best: ProjectedWaypoint | undefined;
  for (const w of wps) {
    if (w.idx <= s || w.idx > e) continue;
    if (p.dist[w.idx] < minDist || w.offsetM > MAX_SNAP_OFFSET_M) continue;
    if (!snap.types.includes(w.type)) continue;
    if (!best || w.idx > best.idx) best = w;
  }
  return best;
}

/**
 * Split the track into days. `pinned` holds the end indices of the first days, placed by hand.
 * Those are kept; the rest of the track is split automatically, each day ending at the first
 * point where any active limit would be exceeded (optionally pulled back to a waypoint).
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
