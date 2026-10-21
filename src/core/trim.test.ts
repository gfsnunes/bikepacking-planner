import { describe, expect, it } from 'vitest';
import {
  carryPins,
  cumulativeDist,
  fullView,
  indexAtKm,
  isFullView,
  kmAt,
  reverseTrack,
  ridingRange,
  ridingSource,
  tickStep,
  validView,
  viewFromRiding,
  viewPoints,
} from './trim';

const src = Array.from({ length: 11 }, (_, i) => ({ lat: 61 + i * 0.01, lon: 16, ele: i * 10 }));
const dist = Float64Array.from({ length: 11 }, (_, i) => i * 1000); // a point every km

describe('trim', () => {
  it('views a stretch of the original, keeping the same point objects', () => {
    const v = { a: 2, b: 5, reversed: false };
    expect(viewPoints(src, v).map((p) => p.ele)).toEqual([20, 30, 40, 50]);
    expect(viewPoints(src, v)[0]).toBe(src[2]);
    expect(viewPoints(src, { ...v, reversed: true }).map((p) => p.ele)).toEqual([50, 40, 30, 20]);
    expect(viewPoints(src, fullView(11))).toEqual(src);
    expect(isFullView(fullView(11), 11)).toBe(true);
    expect(isFullView(v, 11)).toBe(false);
  });

  it('can always widen back to the full original after several crops', () => {
    let v = viewFromRiding(2, 9, 11, false);
    v = viewFromRiding(4, 6, 11, v.reversed); // a second, tighter crop
    expect(viewPoints(src, v)).toHaveLength(3);
    v = viewFromRiding(0, 10, 11, v.reversed);
    expect(viewPoints(src, v)).toEqual(src);
  });

  it('maps ranges picked on the riding-direction original, reversed or not', () => {
    expect(ridingSource(src, true)[0]).toBe(src[10]);
    const v = viewFromRiding(1, 3, 11, true); // the first three km of the reversed route
    expect(v).toEqual({ a: 7, b: 9, reversed: true });
    expect(viewPoints(src, v).map((p) => p.ele)).toEqual([90, 80, 70]);
    expect(ridingRange(v, 11)).toEqual([1, 3]);
    expect(ridingRange({ a: 2, b: 5, reversed: false }, 11)).toEqual([2, 5]);
  });

  it('validates stored views', () => {
    expect(validView({ a: 0, b: 10, reversed: false }, 11)).toBe(true);
    expect(validView({ a: 3, b: 3, reversed: false }, 11)).toBe(false);
    expect(validView({ a: 0, b: 11, reversed: false }, 11)).toBe(false);
    expect(validView(undefined, 11)).toBe(false);
  });

  it('keeps hand-placed ends at the same points, dropping those cut off', () => {
    const from = viewPoints(src, fullView(11));
    const to = viewPoints(src, { a: 4, b: 8, reversed: false });
    expect(carryPins([3, 6, 9], from, to)).toEqual([2]); // only src[6] is inside
    expect(to[2]).toBe(src[6]);
    expect(carryPins([3, 6], from, from)).toEqual([3, 6]);
    expect(carryPins([4], from, to)).toEqual([]); // on the new start: no longer a day end
  });

  it('reverses without touching the original, and twice gives it back', () => {
    const r = reverseTrack(src);
    expect(r[0]).toBe(src[10]);
    expect(src[0].ele).toBe(0);
    expect(reverseTrack(r)).toEqual(src);
  });

  it('measures and maps distance to the nearest point and back', () => {
    const d = cumulativeDist(src);
    expect(d[0]).toBe(0);
    expect(d[10] / 1000).toBeCloseTo(11.1, 0); // 0.1° of latitude ≈ 11.1 km
    expect(indexAtKm(dist, 3.4)).toBe(3);
    expect(indexAtKm(dist, 3.6)).toBe(4);
    expect(indexAtKm(dist, 99)).toBe(10);
    expect(indexAtKm(dist, -1)).toBe(0);
    for (let i = 0; i <= 10; i++) expect(indexAtKm(dist, kmAt(dist, i))).toBe(i);
  });

  it('picks round tick steps', () => {
    expect(tickStep(200)).toBe(20);
    expect(tickStep(340)).toBe(50);
    expect(tickStep(8)).toBe(1);
    expect(tickStep(2500)).toBe(250);
  });
});
