import { cumulativeDistance } from './metrics';
import type { TrackPoint } from './types';

// Open-Meteo elevation API (Copernicus GLO-90 DEM). Free endpoint is for non-commercial use;
// commercial use needs an API key and the customer- prefixed host. Max 100 coordinates per request.
// Free limits are 600 calls/min, 5 000/h, 10 000/day per client; each coordinate appears to count
// as a call, so sampling is kept sparse and a 429 waits out the minute before retrying.
const ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
const BATCH = 100;
const MIN_SPACING_M = 200;
const MAX_SAMPLES = 1500;
const RETRY_WAIT_S = 61;
const MAX_RETRIES = 5;

/** True when elevation is missing for a meaningful share of points or is flat everywhere. */
export function needsElevation(points: TrackPoint[]): boolean {
  let missing = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.ele == null) missing++;
    else {
      min = Math.min(min, p.ele);
      max = Math.max(max, p.ele);
    }
  }
  return missing / points.length > 0.1 || max - min < 1;
}

/** Indices of points spaced at least spacingM apart along the track (first and last always included). */
export function sampleIndices(dist: Float64Array, spacingM: number): number[] {
  const out = [0];
  for (let i = 1; i < dist.length - 1; i++) if (dist[i] - dist[out[out.length - 1]] >= spacingM) out.push(i);
  out.push(dist.length - 1);
  return out;
}

/** Interpolate sampled elevations back onto every point, by distance. */
export function interpolate(dist: Float64Array, idx: number[], ele: number[]): number[] {
  const out = new Array<number>(dist.length);
  let k = 0;
  for (let i = 0; i < dist.length; i++) {
    while (k < idx.length - 2 && idx[k + 1] <= i) k++;
    const a = idx[k];
    const b = idx[k + 1] ?? a;
    const t = dist[b] === dist[a] ? 0 : Math.min(1, Math.max(0, (dist[i] - dist[a]) / (dist[b] - dist[a])));
    out[i] = ele[k] + ((ele[k + 1] ?? ele[k]) - ele[k]) * t;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fillElevation(
  points: TrackPoint[],
  onProgress?: (done: number, total: number, waitS?: number) => void,
): Promise<TrackPoint[]> {
  const dist = cumulativeDistance(points);
  const spacing = Math.max(MIN_SPACING_M, dist[dist.length - 1] / MAX_SAMPLES);
  const idx = sampleIndices(dist, spacing);
  const ele: number[] = [];
  for (let b = 0; b < idx.length; b += BATCH) {
    const chunk = idx.slice(b, b + BATCH);
    const lat = chunk.map((i) => points[i].lat.toFixed(5)).join(',');
    const lon = chunk.map((i) => points[i].lon.toFixed(5)).join(',');
    let res = await fetch(`${ENDPOINT}?latitude=${lat}&longitude=${lon}`);
    for (let retry = 0; res.status === 429 && retry < MAX_RETRIES; retry++) {
      for (let w = RETRY_WAIT_S; w > 0; w--) {
        onProgress?.(b, idx.length, w);
        await sleep(1000);
      }
      res = await fetch(`${ENDPOINT}?latitude=${lat}&longitude=${lon}`);
    }
    if (!res.ok) throw new Error(`Elevation service returned ${res.status}`);
    const json = (await res.json()) as { elevation?: number[] };
    if (!json.elevation || json.elevation.length !== chunk.length) throw new Error('Unexpected elevation response');
    ele.push(...json.elevation);
    onProgress?.(Math.min(b + BATCH, idx.length), idx.length);
  }
  const full = interpolate(dist, idx, ele);
  return points.map((p, i) => ({ ...p, ele: full[i] }));
}
