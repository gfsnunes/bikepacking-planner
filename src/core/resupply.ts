/**
 * Resupply planning, "like fuel": a supply lasts a fixed range from the last refill, and the plan
 * picks the LAST qualifying stop passed before it runs out (fewest stops, never past the limit).
 *
 *  - Food: range in days of the plan. Position along the route is measured in plan days, so 2.5 =
 *    halfway (by riding time) through day 3.
 *  - Water: range in riding hours = bottle capacity (L) / consumption (L/h), using the time model.
 *
 * You start full at the start of the route. Where no qualifying stop is within range, the stretch
 * is reported as a gap, and planning carries on from the next stop after it.
 */
import type { ProjectedWaypoint } from './splitter';
import type { Day, Profile, WaypointType } from './types';

export interface ResupplySettings {
  food: { enabled: boolean; days: number; types: WaypointType[] };
  water: { enabled: boolean; capacityL: number; litresPerHour: number; types: WaypointType[] };
  maxDetourKm: number; // a stop counts only if it's within this distance of the track
}

export const DEFAULT_RESUPPLY: ResupplySettings = {
  food: { enabled: false, days: 2, types: ['shop'] },
  // 0.75 L/h is the app's starting estimate, not a sourced recommendation; users should set their own.
  water: { enabled: false, capacityL: 3, litresPerHour: 0.75, types: ['water', 'shop', 'cafe', 'food'] },
  maxDetourKm: 2,
};

export interface Stop {
  waypointId: string;
  name: string;
  idx: number; // track point
  pos: number; // on the plan axis (days or hours)
}

export interface Gap {
  fromIdx: number; // last refill
  toIdx: number; // where the supply would run out (or the next stop / the finish)
}

export interface ResupplyPlan {
  stops: Stop[];
  gaps: Gap[];
}

/** Position of each track point in plan days: day k starts at k, fraction by riding time within the day. */
export function dayAxis(p: Profile, days: Day[]): Float64Array {
  const axis = new Float64Array(p.dist.length);
  days.forEach((d, k) => {
    const t0 = p.time[d.start];
    const span = p.time[d.end] - t0 || 1;
    for (let i = d.start; i <= d.end; i++) axis[i] = k + (p.time[i] - t0) / span;
  });
  return axis;
}

/** Position of each track point in riding hours from the start. */
export const hourAxis = (p: Profile) => Float64Array.from(p.time, (s) => s / 3600);

/**
 * Greedy "fuel" plan along a non-decreasing axis.
 * `candidates` must already be filtered to qualifying waypoints (type and detour).
 */
export function planRange(axis: Float64Array, range: number, candidates: ProjectedWaypoint[]): ResupplyPlan {
  const end = axis[axis.length - 1];
  const cands = candidates
    .map((w) => ({ w, pos: axis[w.idx] }))
    .sort((a, b) => a.pos - b.pos || a.w.offsetM - b.w.offsetM);
  const stops: Stop[] = [];
  const gaps: Gap[] = [];
  if (!(range > 0)) return { stops, gaps };

  let cur = 0; // axis position of the last refill (start full)
  let curIdx = 0;
  let c = 0; // first candidate after cur
  const EPS = 1e-9;
  while (end - cur > range + EPS) {
    while (c < cands.length && cands[c].pos <= cur + EPS) c++;
    // latest candidate within range
    let pick = -1;
    for (let j = c; j < cands.length && cands[j].pos <= cur + range + EPS; j++) pick = j;
    if (pick >= 0) {
      const { w, pos } = cands[pick];
      stops.push({ waypointId: w.id, name: w.name, idx: w.idx, pos });
      cur = pos;
      curIdx = w.idx;
      c = pick + 1;
      continue;
    }
    // Gap: nothing in range. Report it up to the next stop (or the finish) and continue from there.
    const next = c < cands.length ? cands[c] : null;
    gaps.push({ fromIdx: curIdx, toIdx: next ? next.w.idx : axis.length - 1 });
    if (!next) break;
    stops.push({ waypointId: next.w.id, name: next.w.name, idx: next.w.idx, pos: next.pos });
    cur = next.pos;
    curIdx = next.w.idx;
    c++;
  }
  return { stops, gaps };
}

const qualifying = (wps: ProjectedWaypoint[], types: WaypointType[], maxDetourKm: number) =>
  wps.filter((w) => types.includes(w.type) && w.offsetM <= maxDetourKm * 1000);

export function planFood(p: Profile, days: Day[], wps: ProjectedWaypoint[], s: ResupplySettings): ResupplyPlan | null {
  if (!s.food.enabled || !days.length) return null;
  return planRange(dayAxis(p, days), s.food.days, qualifying(wps, s.food.types, s.maxDetourKm));
}

/** Riding hours one fill of water lasts. */
export const waterRangeHours = (w: ResupplySettings['water']) => (w.litresPerHour > 0 ? w.capacityL / w.litresPerHour : 0);

export function planWater(p: Profile, wps: ProjectedWaypoint[], s: ResupplySettings): ResupplyPlan | null {
  if (!s.water.enabled) return null;
  return planRange(hourAxis(p), waterRangeHours(s.water), qualifying(wps, s.water.types, s.maxDetourKm));
}
