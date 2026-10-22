import { describe, expect, it } from 'vitest';
import { interpolate, sampleIndices } from './elevation-fill';
import { describeDay } from './describe';
import { pointInfo, rangeInfo } from './pointinfo';
import { DEFAULT_HIKE, detectHike, hikeRuns, thresholdFromRider } from './hike';
import { visibleRuns } from './viewport';
import { TrackIndex, nearestIndex } from './geo';
import { DEFAULT_TIME_MODEL, buildProfile } from './metrics';
import { dragRange, pinsAfterDrag, projectWaypoints, splitDays } from './splitter';
import { dayStats } from './stats';
import type { Limits, TrackPoint } from './types';

const KM_PER_DEG = 111.195;
/** Straight north-bound track, one point every stepM, elevation from a function of km. */
function track(km: number, eleAt: (km: number) => number | null = () => 100, stepM = 100): TrackPoint[] {
  const n = Math.round((km * 1000) / stepM);
  return Array.from({ length: n + 1 }, (_, i) => {
    const k = (i * stepM) / 1000;
    return { lat: 50 + k / KM_PER_DEG, lon: 10, ele: eleAt(k) };
  });
}
const noLimits: Limits = { maxKm: null, maxGainM: null, maxHours: null };

describe('metrics', () => {
  it('measures distance', () => {
    const p = buildProfile(track(350));
    expect(p.dist[p.dist.length - 1] / 1000).toBeCloseTo(350, 0);
  });

  it('ignores noise below the hysteresis threshold', () => {
    const noisy = track(20, (k) => 100 + (Math.round(k * 10) % 2 ? 1.5 : -1.5));
    const p = buildProfile(noisy, { smoothM: 0, hysteresisM: 4 });
    expect(p.gain[p.gain.length - 1]).toBe(0);
  });

  it('counts a real climb', () => {
    const p = buildProfile(track(10, (k) => 100 + k * 50), { smoothM: 0 }); // +500 m
    expect(p.gain[p.gain.length - 1]).toBeGreaterThan(490);
    expect(p.gain[p.gain.length - 1]).toBeLessThanOrEqual(500);
  });

  it('interpolates missing elevation and flags a track without any', () => {
    const pts = track(1, (k) => (k === 0 ? 0 : k === 1 ? 100 : null));
    const p = buildProfile(pts, { smoothM: 0 });
    expect(p.hasElevation).toBe(true);
    expect(p.ele[5]).toBeCloseTo(50, 0);
    expect(buildProfile(track(1, () => null)).hasElevation).toBe(false);
  });

  it('makes climbing slower than flat', () => {
    const flat = buildProfile(track(10));
    const hill = buildProfile(track(10, (k) => k * 60));
    expect(hill.time[hill.time.length - 1]).toBeGreaterThan(flat.time[flat.time.length - 1]);
  });
});

describe('splitter', () => {
  it('splits 350 km flat at 100 km/day into 4 days', () => {
    const p = buildProfile(track(350));
    const days = splitDays(p, { ...noLimits, maxKm: 100 }, []);
    expect(days).toHaveLength(4);
    days.slice(0, 3).forEach((d) => expect((p.dist[d.end] - p.dist[d.start]) / 1000).toBeCloseTo(100, 0));
    expect(days[3].end).toBe(p.dist.length - 1);
    // Days are contiguous
    days.slice(1).forEach((d, i) => expect(d.start).toBe(days[i].end));
  });

  it('ends a day at whichever limit is hit first', () => {
    // 10 m of climbing per km: 1000 m gain is reached at 100 km, before a 150 km limit
    const p = buildProfile(track(300, (k) => k * 10), { smoothM: 0 });
    const days = splitDays(p, { ...noLimits, maxKm: 150, maxGainM: 1000 }, []);
    const s = dayStats(p, days[0], []);
    expect(s.gainM).toBeLessThanOrEqual(1000);
    expect(s.distKm).toBeLessThan(101);
    expect(s.distKm).toBeGreaterThan(99);
  });

  it('splits on riding time', () => {
    const p = buildProfile(track(200));
    const days = splitDays(p, { ...noLimits, maxHours: 5 }, []); // 18 km/h -> 90 km
    expect(dayStats(p, days[0], []).distKm).toBeCloseTo(90, 0);
  });

  it('returns a single day without limits', () => {
    const p = buildProfile(track(50));
    expect(splitDays(p, noLimits, [])).toHaveLength(1);
  });

  it('keeps pinned ends and re-splits only after them', () => {
    const p = buildProfile(track(350));
    const days = splitDays(p, { ...noLimits, maxKm: 100 }, []);
    const pins = pinsAfterDrag(days, [], 1, 1200); // drag day 2's end to 120 km
    expect(pins).toEqual([days[0].end, 1200]);
    const next = splitDays(p, { ...noLimits, maxKm: 100 }, pins);
    expect(next[0].end).toBe(days[0].end);
    expect(next[1].end).toBe(1200);
    expect(next[1].pinned).toBe(true);
    expect((p.dist[next[2].end] - p.dist[next[2].start]) / 1000).toBeCloseTo(100, 0);
  });

  it('limits dragging to between neighbouring ends', () => {
    const p = buildProfile(track(350));
    const days = splitDays(p, { ...noLimits, maxKm: 100 }, []);
    expect(dragRange(days, 1)).toEqual([days[1].start + 1, days[2].end - 1]);
  });

  it('snaps to the camp nearest the limit point, back or ahead', () => {
    const pts = track(300);
    const p = buildProfile(pts);
    const camp = (id: string, i: number) => ({ id, name: `Camp ${id}`, type: 'camp' as const, lat: pts[i].lat, lon: 10 });
    const limits = { ...noLimits, maxKm: 100 };
    const snap = { enabled: true, radiusKm: 5, aheadKm: 2, types: ['camp' as const] };
    const end0 = splitDays(p, limits, [])[0].end; // the plain limit point, about 100 km
    // A camp 4 km back and one just past the limit: the one ahead is nearer and wins.
    let days = splitDays(p, limits, [], projectWaypoints(pts, [camp('A', end0 - 40), camp('B', end0 + 1)]), snap);
    expect(days[0]).toMatchObject({ end: end0 + 1, snappedTo: 'Camp B', reason: 'waypoint', limitReason: 'distance' });
    expect(days[1].start).toBe(end0 + 1);
    // Beyond the look-ahead (3 km past): falls back to the camp behind.
    days = splitDays(p, limits, [], projectWaypoints(pts, [camp('A', end0 - 40), camp('C', end0 + 30)]), snap);
    expect(days[0].snappedTo).toBe('Camp A');
    // Look-ahead 0 never goes over the limit.
    days = splitDays(p, limits, [], projectWaypoints(pts, [camp('A', end0 - 40), camp('B', end0 + 1)]), { ...snap, aheadKm: 0 });
    expect(days[0].snappedTo).toBe('Camp A');
    // Equal distances: the one before wins.
    days = splitDays(p, limits, [], projectWaypoints(pts, [camp('A', end0 - 5), camp('B', end0 + 5)]), snap);
    expect(days[0].snappedTo).toBe('Camp A');
    // Other waypoint types and camps outside both windows are ignored.
    const shop = { id: 's', name: 'Shop', type: 'food' as const, lat: pts[end0].lat, lon: 10 };
    days = splitDays(p, limits, [], projectWaypoints(pts, [shop, camp('D', end0 - 80)]), snap);
    expect(days[0]).toMatchObject({ end: end0, reason: 'distance' });
  });
});

describe('elevation fill helpers', () => {
  it('samples and interpolates', () => {
    const p = buildProfile(track(1));
    const idx = sampleIndices(p.dist, 250);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(p.dist.length - 1);
    const full = interpolate(
      p.dist,
      idx,
      idx.map((i) => p.dist[i] / 10),
    );
    full.forEach((e, i) => expect(e).toBeCloseTo(p.dist[i] / 10, 5));
  });
});

describe('end reasons', () => {
  it('records which limit ended each day', () => {
    const p = buildProfile(track(300, (k) => k * 10), { smoothM: 0 });
    expect(splitDays(p, { ...noLimits, maxKm: 150, maxGainM: 1000 }, [])[0].reason).toBe('climbing');
    expect(splitDays(p, { ...noLimits, maxKm: 50, maxGainM: 1000 }, [])[0].reason).toBe('distance');
    expect(splitDays(p, { ...noLimits, maxHours: 1 }, [])[0].reason).toBe('time');
  });

  it('marks the last day finish, pinned days manual, snapped days waypoint', () => {
    const pts = track(300);
    const p = buildProfile(pts);
    const wps = projectWaypoints(pts, [{ id: 'a', name: 'Camp A', type: 'camp', lat: pts[960].lat, lon: 10 }]);
    const snap = { enabled: true, radiusKm: 5, types: ['camp' as const] };
    const days = splitDays(p, { ...noLimits, maxKm: 100 }, [], wps, snap);
    expect(days[0]).toMatchObject({ reason: 'waypoint', limitReason: 'distance', snappedTo: 'Camp A' });
    expect(days[days.length - 1].reason).toBe('finish');
    expect(splitDays(p, { ...noLimits, maxKm: 100 }, [500])[0].reason).toBe('manual');
    expect(splitDays(p, noLimits, [])[0].reason).toBe('finish');
  });
});

describe('time model modes', () => {
  it('average mode ignores climbing', () => {
    const tm = { ...DEFAULT_TIME_MODEL, mode: 'average' as const, avgKmh: 15 };
    const hill = buildProfile(track(90, (k) => k * 30), { timeModel: tm });
    expect(hill.time[hill.time.length - 1] / 3600).toBeCloseTo(6, 1);
  });
});

describe('describeDay', () => {
  const day = { start: 0, end: 1, pinned: false, reason: 'distance' as const };
  const s = (distKm: number, gainM: number, lossM = 0, steepestPct = 3) => ({
    distKm, gainM, lossM, steepestPct, minEle: 0, maxEle: 0, hours: 0, hikeKm: 0, hikeHours: 0, waypoints: [],
  });
  it('labels by climbing density', () => {
    expect(describeDay(s(100, 200), day, 100, true)).toBe('Flat and fast.');
    expect(describeDay(s(100, 800), day, 100, true)).toBe('Rolling.');
    expect(describeDay(s(100, 1500), day, 100, true)).toBe('Hilly.');
    expect(describeDay(s(60, 1300), day, 60, true)).toBe('Mountain day.');
    expect(describeDay(s(80, 2000), day, 80, true)).toBe('Epic climb day.');
    expect(describeDay(s(80, 200, 900), day, 80, true)).toBe('Mostly downhill.');
  });
  it('adds modifiers and the end point', () => {
    expect(describeDay(s(80, 2000, 0, 11), { ...day, snappedTo: 'Lake camp' }, 80, true)).toBe(
      'Epic climb day with a steep wall, ending at Lake camp.',
    );
    expect(describeDay(s(150, 200), day, 100, true)).toBe('Long haul. Flat and fast.');
    expect(describeDay(s(40, 100), { ...day, reason: 'finish' }, 100, true)).toBe('Short day. Flat and fast, to the finish.');
    expect(describeDay(s(100, 0), day, 100, false)).toBe('Riding day.');
  });
});

describe('pointInfo / rangeInfo', () => {
  it('reads the local slope of a constant ramp', () => {
    const p = buildProfile(track(5, (k) => k * 50), { smoothM: 0 }); // 5%
    for (const i of [0, 10, 25, 50]) expect(pointInfo(p, i).slopePct).toBeCloseTo(5, 1);
    expect(pointInfo(p, 25).km).toBeCloseTo(2.5, 2);
    expect(pointInfo(p, 25).ele).toBeCloseTo(125, 0);
  });

  it('sums a climb then a descent, in either drag direction', () => {
    // up 400 m over 10 km, then down 100 m over 5 km
    const p = buildProfile(track(15, (k) => (k <= 10 ? k * 40 : 400 - (k - 10) * 20)), { smoothM: 0 });
    const last = p.dist.length - 1;
    for (const r of [rangeInfo(p, 0, last), rangeInfo(p, last, 0)]) {
      expect(r.km).toBeCloseTo(15, 1);
      expect(r.gainM).toBeCloseTo(400, -1);
      expect(r.lossM).toBeCloseTo(100, -1);
      expect(r.netM).toBeCloseTo(300, 0);
      expect(r.avgSlopePct).toBeCloseTo(2, 1);
      expect(r.maxSlopePct).toBeCloseTo(4, 1);
    }
    expect(rangeInfo(p, 5, 5).km).toBe(0);
  });
});

describe('hike-a-bike', () => {
  const hike = DEFAULT_HIKE; // 12%, 3 km/h, 100 m window, 60 m merge gap
  // Elevation from a list of [lengthKm, gradePct] pieces, 10 m point spacing.
  const pieces = (spec: [number, number][]) => {
    const ends: { km: number; ele: number; g: number }[] = [];
    let km = 0;
    let ele = 100;
    for (const [len, g] of spec) ends.push({ km: (km += len), ele: (ele += len * 10 * g), g });
    return (k: number) => {
      let base = 100;
      let start = 0;
      for (const e of ends) {
        if (k <= e.km + 1e-9) return base + (k - start) * 10 * e.g;
        base = e.ele;
        start = e.km;
      }
      return base;
    };
  };
  const totalKm = (spec: [number, number][]) => spec.reduce((a, [l]) => a + l, 0);
  const profileOf = (spec: [number, number][], opts = {}) =>
    buildProfile(track(totalKm(spec), pieces(spec), 10), { smoothM: 0, hike, ...opts });
  const hikeKm = (p: ReturnType<typeof buildProfile>) => p.hikeDist[p.hikeDist.length - 1] / 1000;

  it('finds about 1 km on a 1 km 20% climb', () => {
    const p = profileOf([[2, 0], [1, 20], [2, 0]]);
    expect(hikeKm(p)).toBeGreaterThan(0.95);
    expect(hikeKm(p)).toBeLessThanOrEqual(1.0);
    expect(hikeRuns(p.hike)).toHaveLength(1);
  });

  it('ignores a 30 m spike', () => {
    expect(hikeKm(profileOf([[2, 0], [0.03, 25], [2, 0]]))).toBe(0);
  });

  it('merges pitches 30 m apart, keeps 80 m apart separate', () => {
    expect(hikeRuns(profileOf([[1, 0], [0.3, 20], [0.03, 0], [0.3, 20], [1, 0]]).hike)).toHaveLength(1);
    expect(hikeRuns(profileOf([[1, 0], [0.3, 20], [0.08, 0], [0.3, 20], [1, 0]]).hike)).toHaveLength(2);
  });

  it('never marks descents or anything when disabled', () => {
    expect(hikeKm(profileOf([[1, 0], [1, -20], [1, 0]]))).toBe(0);
    const dist = Float64Array.from([0, 100, 200]);
    expect([...detectHike(dist, Float64Array.from([0, 30, 60]), { ...hike, enabled: false })]).toEqual([0, 0, 0]);
  });

  it('times hike-a-bike at walking pace and splits time-limited days earlier', () => {
    const spec: [number, number][] = [[10, 0], [3, 15], [10, 0]];
    const on = profileOf(spec);
    const off = profileOf(spec, { hike: { ...hike, enabled: false } });
    const hikeH = on.hikeTime[on.hikeTime.length - 1] / 3600;
    expect(hikeH).toBeCloseTo(hikeKm(on) / 3, 5);
    expect(on.time[on.time.length - 1]).toBeGreaterThan(off.time[off.time.length - 1]);
    // Average-speed mode ignores climbing, so pushing makes a clear difference: at 15 km/h a 1.5 h
    // day covers 22.5 km without hike-a-bike, but only 10 km + 2.5 km pushed with it.
    const tm = { ...DEFAULT_TIME_MODEL, mode: 'average' as const, avgKmh: 15 };
    const avgOn = profileOf(spec, { timeModel: tm });
    const avgOff = profileOf(spec, { timeModel: tm, hike: { ...hike, enabled: false } });
    const lim = { ...noLimits, maxHours: 1.5 };
    const endKm = (p: ReturnType<typeof buildProfile>) => p.dist[splitDays(p, lim, [])[0].end] / 1000;
    expect(endKm(avgOff)).toBeCloseTo(22.5, 0);
    expect(endKm(avgOn)).toBeCloseTo(12.5, 0);
  });

  it('never makes a stretch faster than the riding estimate', () => {
    // At 20% the terrain model already predicts ~2.8 km/h, slower than 3 km/h walking.
    for (const g of [15, 20, 25]) {
      const spec: [number, number][] = [[2, 0], [1, g], [2, 0]];
      const on = profileOf(spec);
      const off = profileOf(spec, { hike: { ...hike, enabled: false } });
      expect(on.time[on.time.length - 1]).toBeGreaterThanOrEqual(off.time[off.time.length - 1] - 1e-6);
    }
  });

  it('day totals add up to the trip total', () => {
    const p = profileOf([[20, 0], [1, 18], [30, 2], [0.5, 22], [20, 0]]);
    const days = splitDays(p, { ...noLimits, maxKm: 25 }, []);
    const sum = days.reduce((a, d) => a + dayStats(p, d, []).hikeKm, 0);
    expect(sum).toBeCloseTo(hikeKm(p), 6);
    expect(sum).toBeGreaterThan(1.3);
  });

  it('calculator reproduces the CyclingAbout example', () => {
    // 200 W, 113 kg, 5.5 km/h slowest speed: article gives 10.7% on road.
    expect(thresholdFromRider({ powerW: 200, massKg: 113, minKmh: 5.5, crr: 0.01 })).toBeCloseTo(10.8, 1);
    expect(thresholdFromRider({ powerW: 0, massKg: 113, minKmh: 5.5, crr: 0.01 })).toBe(12);
  });
});

describe('visibleRuns', () => {
  // Points along the equator at lon 0..9
  const pts = Array.from({ length: 10 }, (_, i) => ({ lat: 0, lon: i }));
  const box = (w: number, e: number) => ({ w, e, s: -1, n: 1 });

  it('is null when everything is in view and empty when nothing is', () => {
    expect(visibleRuns(pts, box(-1, 10))).toBeNull();
    expect(visibleRuns(pts, box(20, 30))).toEqual([]);
  });

  it('widens a run by one point on each side', () => {
    expect(visibleRuns(pts, box(3.5, 5.5))).toEqual([[3, 6]]);
    expect(visibleRuns(pts, box(-1, 1.5))).toEqual([[0, 2]]);
  });

  it('finds separate stretches when the track leaves and re-enters the view', () => {
    // out-and-back: 0..9 then 9..0
    const oab = [...pts, ...[...pts].reverse()];
    expect(visibleRuns(oab, box(-0.5, 1.5))).toEqual([
      [0, 2],
      [17, 19],
    ]);
  });
});

describe('TrackIndex', () => {
  it('matches a brute-force nearest search', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    // A wiggly 2 000-point track, including a doubled-back stretch.
    const pts = Array.from({ length: 2000 }, (_, i) => ({
      lat: 61 + Math.sin(i / 150) * 0.4 + rnd() * 0.01,
      lon: 16 + (i < 1200 ? i : 2400 - i) / 1000 + rnd() * 0.01,
    }));
    const index = new TrackIndex(pts);
    for (let q = 0; q < 2000; q++) {
      // Queries inside and well outside the track's bounding box.
      const lat = 60 + rnd() * 3;
      const lon = 15 + rnd() * 3.5;
      const a = index.nearest(lat, lon);
      const b = nearestIndex(pts, lat, lon);
      expect(a.offsetM).toBeCloseTo(b.offsetM, 6);
    }
  });
});

describe('day card waypoints', () => {
  it('lists off-route waypoints on the right day, within the card range', () => {
    const pts = track(300); // north-bound along lon 10
    const east3km = 3 / (KM_PER_DEG * Math.cos((61 * Math.PI) / 180)); // ~3 km east
    const wps = projectWaypoints(pts, [
      { id: 'a', name: 'Shelter A', type: 'camp', lat: pts[500].lat, lon: 10 + east3km }, // day 1, 3 km off
      { id: 'b', name: 'Shelter B', type: 'camp', lat: pts[1500].lat, lon: 10 + east3km }, // day 2
      { id: 'c', name: 'Shelter C', type: 'camp', lat: pts[2500].lat, lon: 10 + east3km }, // day 3
      { id: 'd', name: 'Far away', type: 'camp', lat: pts[2500].lat, lon: 10.5 }, // ~27 km off
    ]);
    const p = buildProfile(pts);
    const days = splitDays(p, { ...noLimits, maxKm: 100 }, [], wps);
    const names = (maxM: number) => days.slice(0, 3).map((d) => dayStats(p, d, wps, maxM).waypoints.map((w) => w.name));
    expect(names(5000)).toEqual([['Shelter A'], ['Shelter B'], ['Shelter C']]);
    expect(names(1000)).toEqual([[], [], []]);
    expect(dayStats(p, days[1], wps, 5000).waypoints[0].offsetM).toBeGreaterThan(2500);
  });
});
