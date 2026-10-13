import type { Day, DayStats } from './types';

/**
 * One-line, rule-based description of a day's ride. Deterministic: the same numbers always give
 * the same sentence.
 */
export function describeDay(s: DayStats, day: Day, avgKm: number, hasElevation: boolean): string {
  const parts: string[] = [];
  const perKm = s.distKm > 0 ? s.gainM / s.distKm : 0;

  let label: string;
  if (!hasElevation) label = 'Riding day';
  else if (s.lossM > 2 * s.gainM && s.lossM > 300) label = 'Mostly downhill';
  else if (perKm >= 20) label = s.gainM > 1500 ? 'Epic climb day' : 'Mountain day';
  else if (perKm >= 12) label = 'Hilly';
  else if (perKm >= 5) label = 'Rolling';
  else label = 'Flat and fast';
  parts.push(label);

  if (hasElevation && s.steepestPct > 8) parts.push('with a steep wall');
  if (s.hikeKm > 0.5) parts.push(parts.length > 1 ? 'and hike-a-bike' : 'with hike-a-bike');

  let sentence = parts.join(' ');
  if (avgKm > 0 && s.distKm > 1.3 * avgKm) sentence = `Long haul. ${sentence}`;
  else if (avgKm > 0 && s.distKm < 0.6 * avgKm) sentence = `Short day. ${sentence}`;

  if (day.snappedTo) sentence += `, ending at ${day.snappedTo}`;
  else if (day.reason === 'finish') sentence += ', to the finish';
  return `${sentence}.`;
}
