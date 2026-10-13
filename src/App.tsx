import { useEffect, useRef, useState } from 'react';
import { fillElevation, needsElevation } from './core/elevation-fill';
import { download, exportCombined, exportPerDay, slug } from './core/export';
import { parseGpx } from './core/gpx';
import { restoreLastTrip, useStore } from './store';
import { DayStrip, Settings, TripSummary } from './ui/DayPanel';
import { ElevationProfile } from './ui/ElevationProfile';
import { MapView } from './ui/MapView';
import { WaypointEditor } from './ui/WaypointEditor';
import { WaypointManager } from './ui/WaypointManager';
import { About } from './ui/About';
import { Welcome } from './ui/Welcome';
import { WAYPOINT_FILE_ACCEPT, importWaypointsFromFile } from './ui/importFlow';

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
  const wpInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ele, setEle] = useState<EleState>({ kind: 'idle' });
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    restoreLastTrip();
  }, []);

  /** A GPX with a track or route opens as the route; anything else is a waypoint import. */
  async function openFile(file: File) {
    setError(null);
    const isGpx = /\.gpx$/i.test(file.name);
    const text = isGpx ? await file.text() : '';
    if (!isGpx || !/<(trkpt|rtept)[\s>]/.test(text)) {
      await importWaypointsFromFile(file);
      return;
    }
    try {
      const g = parseGpx(text);
      useStore.getState().loadTrack(g.name, g.points, g.waypoints);
      setEle({ kind: 'idle' });
    } catch (e) {
      setError(`${file.name}: ${(e as Error).message}`);
    }
  }

  async function loadSample() {
    const res = await fetch(`${import.meta.env.BASE_URL}sample.gpx`);
    await openFile(new File([await res.text()], 'sample.gpx'));
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
        <button onClick={() => fileInput.current?.click()}>{points.length ? 'Open another GPX' : 'Open GPX'}</button>
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
        <button onClick={() => wpInput.current?.click()}>Import waypoints</button>
        {points.length > 0 && (
          <>
            <button className={adding ? 'active' : ''} onClick={() => useStore.getState().setAddingWaypoint(!adding)}>
              {adding ? 'Click the map…' : 'Add waypoint'}
            </button>
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
                  Your routes and waypoints stay in this browser; nothing is uploaded. The map tile provider sees which areas you view,
                  and the optional elevation lookup sends a track's coordinates to Open-Meteo.
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
              <WaypointEditor />
              <Settings />
            </aside>
          )}
        </div>
        {points.length > 0 && (
          <>
            <ElevationProfile />
            <TripSummary />
            <DayStrip />
            <WaypointManager />
          </>
        )}
      </main>
    </div>
  );
}
