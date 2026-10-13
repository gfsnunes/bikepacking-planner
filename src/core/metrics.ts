import { haversine } from './geo';
import { detectHike, isHikeSegment, type HikeSettings } from './hike';
import type { Profile, TimeModel, TrackPoint } from './types';

export const DEFAULT_TIME_MODEL: TimeModel = { mode: 'terrain', avgKmh: 15, flatKmh: 18, climbMh: 600, maxKmh: 35 };

export function cumulativeDistance(points: { lat: number; lon: number }[]): Float64Array {
  const dist = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++)
    dist[i] = dist[i - 1] + haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  return dist;
}

/** Fill missing elevations by linear interpolation over distance. Returns null if there is none at all. */
function fillGaps(raw: (number | null)[], dist: Float64Array): Float64Array | null {
  const known: number[] = [];
  raw.forEach((v, i) => v != null && known.push(i));
  if (!known.length) return null;
  const out = new Float64Array(raw.length);
  let k = 0;
  for (let i = 0; i < raw.length; i++) {
    while (k < known.length - 1 && known[k + 1] <= i) k++;
    const a = known[k];
    const b = known[Math.min(k + 1, known.length - 1)];
    if (i <= known[0]) out[i] = raw[known[0]]!;
    else if (a === b || i === a || dist[b] === dist[a]) out[i] = raw[a]!;
    else out[i] = raw[a]! + ((raw[b]! - raw[a]!) * (dist[i] - dist[a])) / (dist[b] - dist[a]);
  }
  return out;
}

/** Moving average over a distance window of ±halfWindowM. */
function smooth(ele: Float64Array, dist: Float64Array, halfWindowM: number): Float64Array {
  const n = ele.length;
  const out = new Float64Array(n);
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    while (hi < n && dist[hi] <= dist[i] + halfWindowM) sum += ele[hi++];
    while (dist[lo] < dist[i] - halfWindowM) sum -= ele[lo++];
    out[i] = sum / (hi - lo);
  }
  return out;
}

export interface ProfileOptions {
  smoothM?: number; // half-window for elevation smoothing
  hysteresisM?: number; // minimum change before gain/loss is counted
  timeModel?: TimeModel;
  hike?: HikeSettings; // off when omitted
}

export function buildProfile(points: TrackPoint[], opts: ProfileOptions = {}): Profile {
  const { smoothM = 50, hysteresisM = 4, timeModel = DEFAULT_TIME_MODEL, hike: hikeSettings } = opts;
  const n = points.length;
  const dist = cumulativeDistance(points);
  const filled = fillGaps(
    points.map((p) => p.ele),
    dist,
  );
  const hasElevation = filled != null;
  const ele = filled ? (smoothM > 0 ? smooth(filled, dist, smoothM) : filled) : new Float64Array(n);

  // Gain/loss with hysteresis: only counted once elevation has moved hysteresisM from the last reference.
  const gain = new Float64Array(n);
  const loss = new Float64Array(n);
  let ref = ele[0];
  for (let i = 1; i < n; i++) {
    gain[i] = gain[i - 1];
    loss[i] = loss[i - 1];
    const d = ele[i] - ref;
    if (d >= hysteresisM) {
      gain[i] += d;
      ref = ele[i];
    } else if (d <= -hysteresisM) {
      loss[i] -= d;
      ref = ele[i];
    }
  }

  const hike = hasElevation && hikeSettings ? detectHike(dist, ele, hikeSettings) : new Uint8Array(n);
  const hikeDist = new Float64Array(n);
  const hikeTime = new Float64Array(n);

  // Riding time. 'average': fixed moving speed. 'terrain': flat speed plus a climbing cost;
  // descents earn half the cost back, capped at maxKmh.
  const flat = timeModel.flatKmh / 3.6;
  const fast = timeModel.maxKmh / 3.6;
  const avg = timeModel.avgKmh / 3.6;
  const rideTime = (d: number, dh: number) => {
    if (timeModel.mode === 'average') return d / avg;
    const t = d / flat;
    if (dh > 0) return t + (dh / timeModel.climbMh) * 3600;
    return Math.max(d / fast, t + (dh / timeModel.climbMh) * 1800);
  };
  // Hike-a-bike segments: walking pace, but never faster than the riding estimate (on very steep
  // ground the terrain model can already be slower than walking pace).
  const walk = (hikeSettings?.walkKmh || 3) / 3.6;
  const time = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const d = dist[i] - dist[i - 1];
    const ride = rideTime(d, ele[i] - ele[i - 1]);
    hikeDist[i] = hikeDist[i - 1];
    hikeTime[i] = hikeTime[i - 1];
    if (isHikeSegment(hike, i)) {
      const t = Math.max(d / walk, ride);
      time[i] = time[i - 1] + t;
      hikeDist[i] += d;
      hikeTime[i] += t;
    } else time[i] = time[i - 1] + ride;
  }

  return { dist, ele, gain, loss, time, hasElevation, hike, hikeDist, hikeTime };
}
