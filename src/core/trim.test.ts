import { describe, expect, it } from 'vitest';
import { cropPins, cropTrack, indexAtKm, kmAt, reverseTrack, tickStep } from './trim';

const pts = Array.from({ length: 11 }, (_, i) => ({ lat: 61 + i * 0.01, lon: 16, ele: i * 10 }));
const dist = Float64Array.from({ length: 11 }, (_, i) => i * 1000); // a point every km

describe('trim', () => {
  it('crops inclusively and rejects bad ranges', () => {
    expect(cropTrack(pts, 2, 5).map((p) => p.ele)).toEqual([20, 30, 40, 50]);
    expect(cropTrack(pts, 0, 10)).toHaveLength(11);
    expect(cropTrack(pts, 9, 10)).toHaveLength(2);
    expect(() => cropTrack(pts, 5, 5)).toThrow();
    expect(() => cropTrack(pts, -1, 4)).toThrow();
    expect(() => cropTrack(pts, 3, 11)).toThrow();
  });

  it('keeps hand-placed ends inside the range at the same spots', () => {
    // Pins at 3, 6, 9; crop to 4..8: only 6 survives, now index 2 (still pts[6]).
    const kept = cropPins([3, 6, 9], 4, 8);
    expect(kept).toEqual([2]);
    expect(cropTrack(pts, 4, 8)[kept[0]]).toBe(pts[6]);
    expect(cropPins([3, 6], 0, 10)).toEqual([3, 6]);
    expect(cropPins([3], 3, 10)).toEqual([]); // a pin on the new start is no longer a day end
  });

  it('reverses without touching the original, and twice gives it back', () => {
    const r = reverseTrack(pts);
    expect(r[0]).toBe(pts[10]);
    expect(pts[0].ele).toBe(0);
    expect(reverseTrack(r)).toEqual(pts);
  });

  it('maps distance to the nearest point and back', () => {
    expect(indexAtKm(dist, 0)).toBe(0);
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
