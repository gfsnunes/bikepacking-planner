import JSZip from 'jszip';
import { toGpx, type GpxWpt } from './gpx';
import type { Day, TrackPoint, Waypoint } from './types';

const SYM: Record<Waypoint['type'], string> = {
  camp: 'Campground',
  lodging: 'Lodging',
  water: 'Drinking Water',
  food: 'Restaurant',
  cafe: 'Restaurant',
  shop: 'Shopping Center',
  bike: 'Bike Trail',
  town: 'City (Small)',
  viewpoint: 'Scenic Area',
  summit: 'Summit',
  train: 'Ground Transportation',
  ferry: 'Anchor',
  danger: 'Danger Area',
  other: 'Flag, Blue',
};

const toWpt = (w: Waypoint): GpxWpt => ({ lat: w.lat, lon: w.lon, name: w.name, sym: SYM[w.type] });

/** Waypoints added from the OpenStreetMap library have ids starting with "osm-". */
const hasOsm = (wps: { id: string }[]) => wps.some((w) => w.id.startsWith('osm-'));

const slug = (s: string) => s.normalize('NFC').replace(/[^\p{L}\p{N}-]+/gu, '_').replace(/^_+|_+$/g, '') || 'route';

/** One GPX: full track, the user's waypoints and a waypoint at each day end. */
export function exportCombined(name: string, pts: TrackPoint[], days: Day[], wps: Waypoint[]): string {
  const ends: GpxWpt[] = days.slice(0, -1).map((d, i) => ({
    lat: pts[d.end].lat,
    lon: pts[d.end].lon,
    name: `End of day ${i + 1}${d.snappedTo ? ` (${d.snappedTo})` : ''}`,
    sym: 'Flag, Red',
  }));
  return toGpx(name, pts, [...wps.map(toWpt), ...ends], { osmData: hasOsm(wps) });
}

/** A ZIP with one GPX per day, each carrying the waypoints that fall within it. */
export async function exportPerDay(
  name: string,
  pts: TrackPoint[],
  days: Day[],
  wpsPerDay: Waypoint[][],
): Promise<Blob> {
  const zip = new JSZip();
  const pad = String(days.length).length;
  days.forEach((d, i) => {
    const n = String(i + 1).padStart(pad, '0');
    const title = `${name} - Day ${i + 1}`;
    const dayWps = wpsPerDay[i];
    zip.file(`${slug(name)}_day${n}.gpx`, toGpx(title, pts.slice(d.start, d.end + 1), dayWps.map(toWpt), { osmData: hasOsm(dayWps) }));
  });
  return zip.generateAsync({ type: 'blob' });
}

export function download(filename: string, data: Blob | string, type = 'application/gpx+xml') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export { slug };
