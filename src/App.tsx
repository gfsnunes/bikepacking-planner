import { useEffect, useRef, useState } from 'react';
import { fillElevation, needsElevation } from './core/elevation-fill';
import { download, exportCombined, exportPerDay, slug } from './core/export';
import { parseGpx } from './core/gpx';
import { restoreLastTrip, useStore } from './store';
import { parseLink } from './sync/crypto';
import { joinShare, leaveShare, savedShare } from './sync/session';
import { ShareButton, ShareDialog } from './ui/ShareDialog';
import { DayStrip, Settings, TripSummary } from './ui/DayPanel';
import { ElevationProfile } from './ui/ElevationProfile';
import { MapView } from './ui/MapView';
import { WaypointEditor } from './ui/WaypointEditor';
import { WaypointManager } from './ui/WaypointManager';
import { About } from './ui/About';
import { Welcome } from './ui/Welcome';
import { LibraryDialog } from './ui/LibraryDialog';
import { WAYPOINT_FILE_ACCEPT, importWaypointsFromFile } from './ui/importFlow';

// Set once the visitor has opened a route of their own; hides the "Open GPX" pointer for good.
const GPX_OPENED_KEY = 'bikepacking-planner:gpx-opened';
function gpxOpenedBefore(): boolean {
  try {
    return localStorage.getItem(GPX_OPENED_KEY) === '1';
  } catch {
    return false;
  }
}

let shareStarted = false; // StrictMode runs effects twice in development

/** Open a shared trip from the link in the address bar, or reconnect to the one open before a reload. */
async function startShare() {
  if (shareStarted) return;
  shareStarted = true;
  await restoreLastTrip();
  const link = parseLink(location.hash);
  const saved = savedShare();
  if (!link) {
    if (saved) joinShare(saved);
    return;
  }
  // Take the secrets out of the address bar (screenshots, screen sharing); the dialog still shows the links.
  history.replaceState(null, '', location.pathname + location.search);
  const sameTrip = saved?.roomId === link.roomId;
  const hasOther = useStore.getState().points.length > 0 && !sameTrip;
  if (hasOther && !confirm('Open the shared trip? It replaces the trip open here. Export that one first if you want to keep it.')) {
    if (saved) joinShare(saved);
    return;
  }
  joinShare(sameTrip && !link.writeToken && saved?.writeToken ? saved : link);
}

type EleState =
  | { kind: 'idle' }
  | { kind: 'loading'; done: number; total: number; waitS?: number }
  | { kind: 'error'; msg: string };

export default function App() {
  const name = useStore((s) => s.name);
  const points = useStore((s) => s.points);
  const hasEle = useStore((s) => s.profile?.hasElevation ?? false);
  const adding = useStore((s) => s.addingWaypoint);
  const notice = useStore((s) => s.notice);
  const readOnly = useStore((s) => !!s.share && !s.share.canWrite);
  const wpInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ele, setEle] = useState<EleState>({ kind: 'idle' });
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [gpxOpened, setGpxOpened] = useState(gpxOpenedBefore);

  useEffect(() => {
    void startShare();
  }, []);

  /** A GPX with a track or route opens as the route; anything else is a waypoint import. */
  async function openFile(file: File, isSample = false) {
    setError(null);
    const isGpx = /\.gpx$/i.test(file.name);
    const text = isGpx ? await file.text() : '';
    if (!isGpx || !/<(trkpt|rtept)[\s>]/.test(text)) {
      await importWaypointsFromFile(file);
      return;
    }
    try {
      const g = parseGpx(text);
      if (useStore.getState().share) {
        leaveShare();
        useStore.getState().setNotice({ text: 'You left the shared trip to open this route. The shared trip stays online.', kind: 'info' });
      }
      useStore.getState().loadTrack(g.name, g.points, g.waypoints);
      setEle({ kind: 'idle' });
      if (!isSample && !gpxOpened) {
        setGpxOpened(true);
        try {
          localStorage.setItem(GPX_OPENED_KEY, '1');
        } catch {
          /* storage unavailable: the pointer just comes back next visit */
        }
      }
    } catch (e) {
      setError(`${file.name}: ${(e as Error).message}`);
    }
  }

  async function loadSample() {
    const res = await fetch(`${import.meta.env.BASE_URL}sample.gpx`);
    await openFile(new File([await res.text()], 'sample.gpx'), true);
  }

  async function fetchElevation() {
    setEle({ kind: 'loading', done: 0, total: 1 });
    try {
      const filled = await fillElevation(useStore.getState().points, (done, total, waitS) =>
        setEle({ kind: 'loading', done, total, waitS }),
      );
      useStore.getState().replacePoints(filled);
      setEle({ kind: 'idle' });
    } catch (e) {
      setEle({ kind: 'error', msg: (e as Error).message });
    }
  }

  async function exportZip() {
    const s = useStore.getState();
    const blob = await exportPerDay(s.name, s.points, s.days, s.stats.map((x) => x.waypoints));
    download(`${slug(s.name)}_days.zip`, blob);
  }

  function exportOne() {
    const s = useStore.getState();
    download(`${slug(s.name)}_planned.gpx`, exportCombined(s.name, s.points, s.days, s.waypoints));
  }

  const missingEle = points.length > 0 && needsElevation(points);

  return (
    <div
      className={`app ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files[0];
        if (f) openFile(f);
      }}
    >
      <header>
        <h1>Bikepacking Day Planner</h1>
        {name && <span className="route-name">{name}</span>}
        <Welcome onSample={loadSample} onOpenGpx={() => fileInput.current?.click()} />
        <About />
        <div className="spacer" />
        <input
          ref={fileInput}
          type="file"
          accept=".gpx,application/gpx+xml"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) openFile(f);
            e.target.value = '';
          }}
        />
        <span className="gpx-btn-wrap">
          <button onClick={() => fileInput.current?.click()}>{points.length ? 'Open another GPX' : 'Open GPX'}</button>
          {!gpxOpened && (
            <span className="gpx-hint" aria-hidden="true">
              <svg className="gpx-hint-arrow" viewBox="0 0 24 24" width="26" height="26">
                <path d="M12 21V4M5 10l7-7 7 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="gpx-hint-text">Start here: open your GPX route</span>
            </span>
          )}
        </span>
        <input
          ref={wpInput}
          type="file"
          accept={WAYPOINT_FILE_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importWaypointsFromFile(f);
            e.target.value = '';
          }}
        />
        {!readOnly && <button onClick={() => wpInput.current?.click()}>Import waypoints</button>}
        {points.length > 0 && !readOnly && <button onClick={() => useStore.getState().setLibraryOpen(true)}>Waypoint library</button>}
        {points.length > 0 && (
          <>
            {!readOnly && (
              <button className={adding ? 'active' : ''} onClick={() => useStore.getState().setAddingWaypoint(!adding)}>
                {adding ? 'Click the map…' : 'Add waypoint'}
              </button>
            )}
            <ShareButton />
            <button onClick={exportOne}>Export GPX</button>
            <button onClick={exportZip}>Export per day (.zip)</button>
          </>
        )}
      </header>

      {notice && (
        <div className={`banner ${notice.kind === 'error' ? 'error' : 'ok'}`} onClick={() => useStore.getState().setNotice(null)}>
          {notice.text} <span className="hint">(click to dismiss)</span>
        </div>
      )}
      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {missingEle && ele.kind !== 'loading' && (
        <div className="banner">
          This track has {hasEle ? 'incomplete' : 'no'} elevation data.{' '}
          <button onClick={fetchElevation}>Look up elevation</button>
          <span className="hint"> Sends this track's coordinates to Open-Meteo (Copernicus 90 m terrain model).</span>
          {ele.kind === 'error' && <span className="error-text"> Failed: {ele.msg}</span>}
        </div>
      )}
      {ele.kind === 'loading' && (
        <div className="banner">
          Looking up elevation… {ele.done}/{ele.total} points
          {ele.waitS != null && ` (elevation service is rate-limiting, retrying in ${ele.waitS} s)`}
        </div>
      )}

      <main className={points.length ? 'has-track' : ''}>
        <div className="top">
          <div className="views">
            <MapView />
            {!points.length && (
              <div className="empty">
                <p>
                  <strong>Drop a GPX file here</strong> or use <em>Open GPX</em>.
                </p>
                <p className="hint privacy">
                  Your routes and waypoints stay in this browser unless you share a trip, and shared trips are end-to-end encrypted.
                  The map tile provider sees which areas you view, and the optional elevation lookup sends a track's coordinates to
                  Open-Meteo.
                </p>
                <p>
                  <button className="sample" onClick={loadSample}>
                    Try a sample route
                  </button>
                </p>
              </div>
            )}
          </div>
          {points.length > 0 && (
            <aside>
              <fieldset className="plain" disabled={readOnly}>
                <WaypointEditor />
                <Settings />
              </fieldset>
            </aside>
          )}
        </div>
        {points.length > 0 && (
          <>
            <ElevationProfile />
            <TripSummary />
            <DayStrip />
            <fieldset className="plain" disabled={readOnly}>
              <WaypointManager />
            </fieldset>
          </>
        )}
      </main>
      <LibraryDialog />
      <ShareDialog />
    </div>
  );
}
