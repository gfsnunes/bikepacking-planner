/**
 * Hike-a-bike: stretches too steep to ride with a loaded bike, found from the (smoothed) profile.
 *
 * Threshold background (read 2026-09-29): CyclingAbout's gradient-threshold method gives 10.7% for
 * 113 kg total at 200 W with stock gearing (14.6% with lower gearing), defined as the grade where
 * the lowest gear at 60 rpm reaches the slowest rideable speed (5.5 km/h).
 * https://www.cyclingabout.com/gradient-threshold-steepest-hill/
 */

export interface HikeSettings {
  enabled: boolean;
  thresholdPct: number; // sustained grade at or above which the bike is pushed
  walkKmh: number; // pushing pace
  windowM: number; // grade is measured over this distance, so short spikes don't count
  mergeGapM: number; // brief easings shorter than this don't split a push in two
}

export const DEFAULT_HIKE: HikeSettings = { enabled: true, thresholdPct: 12, walkKmh: 3, windowM: 100, mergeGapM: 60 };

// Quick presets (the app's own estimates, not sourced figures).
export const HIKE_PRESETS = [
  { label: 'Paved', pct: 15 },
  { label: 'Gravel', pct: 12 },
  { label: 'Rough trail', pct: 9 },
] as const;

/**
 * Rolling-resistance coefficients for the calculator. Paved: upper end of Wikipedia's 0.0022–0.0050
 * for production bicycle tyres (bikepacking tyres run lower pressure). Gravel: tarmac + 0.004, and
 * sand: tarmac + 0.028, per a cycling study's surface corrections; rough gravel: ~0.017 measured on
 * "cat 3" gravel. The last three come from search-result summaries (2026-09-29), not the primary papers.
 */
export const SURFACES = [
  { label: 'Paved', crr: 0.005 },
  { label: 'Gravel', crr: 0.009 },
  { label: 'Rough / loose gravel', crr: 0.017 },
  { label: 'Sand', crr: 0.033 },
] as const;

/**
 * Steepest grade (%) the rider can hold at their slowest rideable speed:
 * P = m·g·v·(grade + Crr), ignoring air drag (negligible at walking speeds). Clamped to 3–30%.
 */
export function thresholdFromRider(r: { powerW: number; massKg: number; minKmh: number; crr: number }): number {
  const v = r.minKmh / 3.6;
  if (!(r.powerW > 0 && r.massKg > 0 && v > 0)) return DEFAULT_HIKE.thresholdPct;
  const pct = (r.powerW / (r.massKg * 9.81 * v) - r.crr) * 100;
  return Math.min(30, Math.max(3, pct));
}

/** Per-point mask: 1 where the track is part of a hike-a-bike stretch. */
export function detectHike(dist: Float64Array, ele: Float64Array, s: HikeSettings): Uint8Array {
  const n = dist.length;
  const mask = new Uint8Array(n);
  if (!s.enabled || n < 2) return mask;
  const t = s.thresholdPct / 100;
  const half = s.windowM / 2;

  // A point is marked when the grade over the window centred on it (±half, widened outwards to the
  // nearest points) reaches the threshold. Centring means flat ground next to a pitch is never
  // marked; the pitch loses a few metres at each end instead.
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    while (a + 1 <= i && dist[a + 1] <= dist[i] - half) a++;
    if (b < i) b = i;
    while (b < n - 1 && dist[b] < dist[i] + half) b++;
    const d = dist[b] - dist[a];
    if (d > 0 && (ele[b] - ele[a]) / d >= t) mask[i] = 1;
  }

  // Fill short unmarked gaps between two marked stretches.
  let lastOn = -1;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    if (lastOn >= 0 && i - lastOn > 1 && dist[i] - dist[lastOn] < s.mergeGapM) mask.fill(1, lastOn + 1, i);
    lastOn = i;
  }
  return mask;
}

/** Segment (i-1 → i) is hike-a-bike when both ends are marked. */
export const isHikeSegment = (mask: Uint8Array, i: number) => i > 0 && mask[i - 1] === 1 && mask[i] === 1;

/** Contiguous hike-a-bike stretches as [start, end] point indices (end inclusive). */
export function hikeRuns(mask: Uint8Array): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i] === 1;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      if (i - 1 > start) runs.push([start, i - 1]);
      start = -1;
    }
  }
  return runs;
}
