import { describe, expect, it } from 'vitest';
import { DEFAULT_RESUPPLY, dayAxis, planFood, planRange, planWater, waterRangeHours } from './resupply';
import { buildProfile } from './metrics';
import { projectWaypoints, splitDays } from './splitter';
import type { TrackPoint, Waypoint } from './types';

// Axis 0..10 over 1001 points (0.01 per point).
const axis = Float64Array.from({ length: 1001 }, (_, i) => i / 100);
const at = (pos: number, id = `w${pos}`, offsetM = 100) => ({
  id,
  name: id,
  type: 'shop' as const,
  lat: 0,
  lon: 0,
  idx: Math.round(pos * 100),
  offsetM,
});

describe('resupply: range planning', () => {
  it('picks the last stop before the supply runs out, and reports gaps', () => {
    const plan = planRange(axis, 2, [at(1.5), at(1.9), at(3.5), at(4.0), at(7.0)]);
    expect(plan.stops.map((s) => s.pos)).toEqual([1.9, 3.5, 4.0, 7.0]);
    // From 4.0 nothing until 7.0 (3 > 2): gap 4.0 -> 7.0. From 7.0 nothing before the finish at 10: gap to the end.
    expect(plan.gaps).toEqual([
      { fromIdx: 400, toIdx: 700 },
      { fromIdx: 700, toIdx: 1000 },
    ]);
  });

  it('needs no stop when the whole route fits in one range', () => {
    expect(planRange(axis, 12, [at(5)])).toEqual({ stops: [], gaps: [] });
  });

  it('never exceeds the range between consecutive stops when stops exist', () => {
    const cands = Array.from({ length: 40 }, (_, i) => at(0.25 * (i + 1)));
    const { stops, gaps } = planRange(axis, 1.6, cands);
    expect(gaps).toEqual([]);
    const pos = [0, ...stops.map((s) => s.pos), 10];
    for (let i = 1; i < pos.length; i++) expect(pos[i] - pos[i - 1]).toBeLessThanOrEqual(1.6 + 1e-9);
  });

  it('reports a gap from the start when the first stop is out of range', () => {
    const plan = planRange(axis, 2, [at(3)]);
    expect(plan.gaps[0]).toEqual({ fromIdx: 0, toIdx: 300 });
  });
});

describe('resupply: food in plan days, water in riding hours', () => {
  const KM = 111.195;
  // 290 km: 3 days (100 / 100 / 90). A 300 km route would add a tiny 4th day from rounding.
  const pts: TrackPoint[] = Array.from({ length: 2901 }, (_, i) => ({ lat: 61 + i / 10 / KM, lon: 16, ele: 100 }));
  const p = buildProfile(pts);
  const days = splitDays(p, { maxKm: 100, maxGainM: null, maxHours: null }, []);
  const shop = (km: number, offLon = 0): Waypoint => ({ id: `s${km}`, name: `Shop ${km}`, type: 'shop', lat: 61 + km / KM, lon: 16 + offLon });

  it('measures the plan in days', () => {
    expect(days).toHaveLength(3);
    const ax = dayAxis(p, days);
    expect(ax[0]).toBe(0);
    expect(ax[days[0].end]).toBeCloseTo(1, 6);
    expect(ax[1500]).toBeCloseTo(1.5, 1);
  });

  it('food every 2 days picks the last store before day 2 ends, ignoring stores too far off route', () => {
    const wps = projectWaypoints(pts, [shop(60), shop(150), shop(190), shop(195, 0.1) /* ~5 km east */]);
    const s = { ...DEFAULT_RESUPPLY, food: { ...DEFAULT_RESUPPLY.food, enabled: true, days: 2 } };
    const plan = planFood(p, days, wps, s)!;
    expect(plan.stops.map((x) => x.name)).toEqual(['Shop 190']);
    expect(plan.gaps).toEqual([]);
  });

  it('water range is capacity / consumption in riding hours', () => {
    expect(waterRangeHours({ ...DEFAULT_RESUPPLY.water, capacityL: 3, litresPerHour: 0.75 })).toBe(4);
    // Flat 290 km at the default 18 km/h = 16.1 h; with 4 h of water and stops every 50 km (2.8 h), every
    // leg between refills must be at most 4 h.
    const wps = projectWaypoints(
      pts,
      [50, 100, 150, 200, 250].map((km) => ({ ...shop(km), id: `w${km}`, name: `Water ${km}`, type: 'water' as const })),
    );
    const s = { ...DEFAULT_RESUPPLY, water: { ...DEFAULT_RESUPPLY.water, enabled: true } };
    const plan = planWater(p, wps, s)!;
    expect(plan.gaps).toEqual([]);
    const hours = [0, ...plan.stops.map((x) => x.pos), p.time[p.time.length - 1] / 3600];
    for (let i = 1; i < hours.length; i++) expect(hours[i] - hours[i - 1]).toBeLessThanOrEqual(4 + 1e-9);
    expect(plan.stops.map((x) => x.name)).toEqual(['Water 50', 'Water 100', 'Water 150', 'Water 200', 'Water 250']);
  });

  it('does nothing when switched off', () => {
    expect(planFood(p, days, [], DEFAULT_RESUPPLY)).toBeNull();
    expect(planWater(p, [], DEFAULT_RESUPPLY)).toBeNull();
  });
});
