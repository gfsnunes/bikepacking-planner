const R = 6371008.8;
const rad = Math.PI / 180;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Nearest track point to (lat, lon), searching only indices in [from, to]. */
export function nearestIndex(
  pts: { lat: number; lon: number }[],
  lat: number,
  lon: number,
  from = 0,
  to = pts.length - 1,
): { idx: number; offsetM: number } {
  const k = Math.cos(lat * rad);
  const lo = Math.max(0, from);
  const hi = Math.min(to, pts.length - 1);
  let best = lo;
  let bestD = Infinity;
  for (let i = lo; i <= hi; i++) {
    const dx = (pts[i].lon - lon) * k;
    const dy = pts[i].lat - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { idx: best, offsetM: haversine(lat, lon, pts[best].lat, pts[best].lon) };
}

/**
 * Grid over the track's bounding box for fast nearest-point lookups (thousands of waypoints).
 * Distances use the same equirectangular metric as nearestIndex, so results match it exactly.
 */
export class TrackIndex {
  private readonly x0: number;
  private readonly y0: number;
  private readonly cell: number;
  private readonly w: number;
  private readonly h: number;
  private readonly cells: number[][];
  private readonly pts: { lat: number; lon: number }[];

  constructor(pts: { lat: number; lon: number }[]) {
    this.pts = pts;
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of pts) {
      minX = Math.min(minX, p.lon);
      maxX = Math.max(maxX, p.lon);
      minY = Math.min(minY, p.lat);
      maxY = Math.max(maxY, p.lat);
    }
    const GRID = 128;
    this.cell = Math.max((maxX - minX) / GRID, (maxY - minY) / GRID, 0.002);
    this.x0 = minX;
    this.y0 = minY;
    this.w = Math.floor((maxX - minX) / this.cell) + 1;
    this.h = Math.floor((maxY - minY) / this.cell) + 1;
    this.cells = Array.from({ length: this.w * this.h }, () => []);
    pts.forEach((p, i) => this.cells[this.cellOf(p.lon, p.lat)].push(i));
  }

  private cx = (lon: number) => Math.min(this.w - 1, Math.max(0, Math.floor((lon - this.x0) / this.cell)));
  private cy = (lat: number) => Math.min(this.h - 1, Math.max(0, Math.floor((lat - this.y0) / this.cell)));
  private cellOf = (lon: number, lat: number) => this.cy(lat) * this.w + this.cx(lon);

  nearest(lat: number, lon: number): { idx: number; offsetM: number } {
    const k = Math.cos(lat * rad);
    const cx = this.cx(lon);
    const cy = this.cy(lat);
    let best = 0;
    let bestD = Infinity; // squared, in scaled degrees
    for (let r = 0; ; r++) {
      const [x1, x2, y1, y2] = [cx - r, cx + r, cy - r, cy + r];
      for (let y = Math.max(0, y1); y <= Math.min(this.h - 1, y2); y++) {
        const edgeRow = y === y1 || y === y2;
        for (let x = Math.max(0, x1); x <= Math.min(this.w - 1, x2); x++) {
          if (!edgeRow && x !== x1 && x !== x2) continue; // only the ring, not its inside
          for (const i of this.cells[y * this.w + x]) {
            const dx = (this.pts[i].lon - lon) * k;
            const dy = this.pts[i].lat - lat;
            const d = dx * dx + dy * dy;
            if (d < bestD) (bestD = d), (best = i);
          }
        }
      }
      // Lower bound on the distance to any cell not yet searched (the grid outside this square).
      let bound = Infinity;
      if (x2 < this.w - 1) bound = Math.min(bound, Math.max(0, this.x0 + (x2 + 1) * this.cell - lon) * k);
      if (x1 > 0) bound = Math.min(bound, Math.max(0, lon - (this.x0 + x1 * this.cell)) * k);
      if (y2 < this.h - 1) bound = Math.min(bound, Math.max(0, this.y0 + (y2 + 1) * this.cell - lat));
      if (y1 > 0) bound = Math.min(bound, Math.max(0, lat - (this.y0 + y1 * this.cell)));
      if (bound === Infinity || bestD <= bound * bound) break;
    }
    return { idx: best, offsetM: haversine(lat, lon, this.pts[best].lat, this.pts[best].lon) };
  }
}

/** First index i >= lo in a non-decreasing array with arr[i] > value, or arr.length. */
export function upperBound(arr: Float64Array, value: number, lo = 0): number {
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] > value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
