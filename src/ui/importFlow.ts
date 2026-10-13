import { importWaypointFile, mergeWaypoints } from '../core/waypoint-import';
import { useStore } from '../store';

export const WAYPOINT_FILE_ACCEPT = '.gpx,.kml,.kmz,.geojson,.json,.csv,.tsv,.txt';

/** Import a waypoint file into the current trip, skipping duplicates, and report the result. */
export async function importWaypointsFromFile(file: File): Promise<void> {
  const s = useStore.getState();
  try {
    const r = await importWaypointFile(file);
    const { added, duplicates } = mergeWaypoints(s.waypoints, r.waypoints);
    s.addWaypoints(added);
    const extra = [
      duplicates && `${duplicates} duplicate${duplicates === 1 ? '' : 's'}`,
      r.skipped && `${r.skipped} unreadable ${r.skipped === 1 ? 'entry' : 'entries'}`,
    ].filter(Boolean);
    const noTrack = s.points.length ? '' : ' Open a track to see how far they are from the route.';
    s.setNotice({
      kind: added.length ? 'info' : 'error',
      text:
        `Imported ${added.length} waypoint${added.length === 1 ? '' : 's'} from ${file.name}` +
        (extra.length ? ` (${extra.join(', ')} skipped).` : '.') +
        noTrack,
    });
  } catch (e) {
    s.setNotice({ kind: 'error', text: `${file.name}: ${(e as Error).message}` });
  }
}
