import type { ProjectedWaypoint } from './splitter';
import type { Day, DayStats, Profile } from './types';

/** `maxOffsetM`: waypoints farther than this from the track are left off the day (e.g. a big POI import). */
export function dayStats(p: Profile, d: Day, wps: ProjectedWaypoint[], maxOffsetM = 5000): DayStats {
  let minEle = Infinity;
  let maxEle = -Infinity;
  for (let i = d.start; i <= d.end; i++) {
    if (p.ele[i] < minEle) minEle = p.ele[i];
    if (p.ele[i] > maxEle) maxEle = p.ele[i];
  }
  // Steepest average grade over any 1 km stretch within the day.
  let steepest = 0;
  let j = d.start;
  for (let i = d.start; i <= d.end; i++) {
    while (j <= d.end && p.dist[j] - p.dist[i] < 1000) j++;
    if (j > d.end) break;
    const g = (p.ele[j] - p.ele[i]) / (p.dist[j] - p.dist[i]);
    if (g > steepest) steepest = g;
  }
  return {
    distKm: (p.dist[d.end] - p.dist[d.start]) / 1000,
    gainM: p.gain[d.end] - p.gain[d.start],
    lossM: p.loss[d.end] - p.loss[d.start],
    minEle,
    maxEle,
    hours: (p.time[d.end] - p.time[d.start]) / 3600,
    steepestPct: steepest * 100,
    hikeKm: (p.hikeDist[d.end] - p.hikeDist[d.start]) / 1000,
    hikeHours: (p.hikeTime[d.end] - p.hikeTime[d.start]) / 3600,
    waypoints: wps.filter((w) => w.idx > d.start && w.idx <= d.end && w.offsetM <= maxOffsetM),
  };
}
