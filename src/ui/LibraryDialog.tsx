import { useEffect, useMemo, useRef, useState } from 'react';
import { LIBRARY_CATEGORIES, OverpassBusyError, searchLibrary, type LibraryItem } from '../core/osm-library';
import { projectWaypoints } from '../core/splitter';
import { mergeWaypoints } from '../core/waypoint-import';
import { useStore } from '../store';
import { WAYPOINT_STYLE } from './colors';
import { Icon } from './DayPanel';

const RADII = [1, 2, 3, 5, 10];
const DEFAULT_CATEGORIES = ['shelter', 'camp', 'water', 'grocery'];

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; items: (LibraryItem & { km: number; offKm: number })[] };

const fmtOff = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);

/** "Waypoint library": OpenStreetMap places along the route, sorted by distance along it. */
export function LibraryDialog() {
  const open = useStore((s) => s.libraryOpen);
  const points = useStore((s) => s.points);
  const profile = useStore((s) => s.profile);
  const waypoints = useStore((s) => s.waypoints);
  const dialog = useRef<HTMLDialogElement>(null);
  const abort = useRef<AbortController | null>(null);

  const [radiusKm, setRadiusKm] = useState(3);
  const [cats, setCats] = useState<string[]>(DEFAULT_CATEGORIES);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [show, setShow] = useState<string | null>(null); // category filter for the list

  // Open/close the native dialog from the store flag (two buttons open it).
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Escape / outside-click closes the native dialog; keep the store flag in sync. React's
  // onCancel/onClose don't fire reliably for <dialog> (see Welcome), so listen natively.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const onClosed = () => {
      abort.current?.abort();
      if (useStore.getState().libraryOpen) useStore.getState().setLibraryOpen(false);
    };
    d.addEventListener('close', onClosed);
    d.addEventListener('cancel', onClosed);
    return () => {
      d.removeEventListener('close', onClosed);
      d.removeEventListener('cancel', onClosed);
    };
  }, []);

  // A new route invalidates the previous results.
  useEffect(() => setStatus({ kind: 'idle' }), [points]);

  const close = () => {
    abort.current?.abort();
    useStore.getState().setLibraryOpen(false);
  };

  const have = useMemo(() => new Set(waypoints.map((w) => w.id)), [waypoints]);

  async function search() {
    if (!points.length || !profile || !cats.length) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setStatus({ kind: 'loading' });
    try {
      const radiusM = radiusKm * 1000;
      const found = await searchLibrary(points, radiusM, cats, ctrl.signal);
      // Position along the route; drop anything outside the radius from the real (unsimplified) track.
      const items = projectWaypoints(points, found)
        .filter((w) => w.offsetM <= radiusM)
        .map((w) => ({ ...w, km: profile.dist[w.idx] / 1000, offKm: w.offsetM / 1000 }));
      setStatus({ kind: 'done', items });
      setPicked(new Set(items.filter((i) => !have.has(i.id)).map((i) => i.id)));
      setShow(null);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setStatus({
        kind: 'error',
        message:
          e instanceof OverpassBusyError
            ? 'OpenStreetMap’s free query server is busy right now. Please try again in a minute.'
            : `Couldn’t load places: ${(e as Error).message}`,
      });
    }
  }

  function addPicked() {
    if (status.kind !== 'done') return;
    const chosen = status.items.filter((i) => picked.has(i.id));
    const s = useStore.getState();
    const { added, duplicates } = mergeWaypoints(
      s.waypoints,
      chosen.map(({ id, lat, lon, name, type }) => ({ id, lat, lon, name, type })),
    );
    s.addWaypoints(added);
    s.setNotice({
      kind: 'info',
      text: `Added ${added.length} place${added.length === 1 ? '' : 's'} from OpenStreetMap${
        duplicates ? ` (${duplicates} skipped: already in your trip or mapped twice in OpenStreetMap)` : ''
      }.`,
    });
    close();
  }

  const items = status.kind === 'done' ? status.items : [];
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const i of items) c.set(i.category, (c.get(i.category) ?? 0) + 1);
    return c;
  }, [items]);
  const visible = show ? items.filter((i) => i.category === show) : items;
  const selectable = visible.filter((i) => !have.has(i.id));
  const allVisiblePicked = selectable.length > 0 && selectable.every((i) => picked.has(i.id));

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <dialog
      ref={dialog}
      className="about library"
      aria-labelledby="library-title"
      onClick={(e) => e.target === dialog.current && close()}
    >
      <h2 id="library-title">Waypoint library</h2>
      <p className="hint">Places from OpenStreetMap along your route, in the order you reach them.</p>

      {!points.length ? (
        <p>Open a route first: the library looks for places along it.</p>
      ) : (
        <>
          <fieldset className="lib-cats">
            <legend>What to look for</legend>
            {LIBRARY_CATEGORIES.map((c) => (
              <label key={c.id} className="chip">
                <input
                  type="checkbox"
                  checked={cats.includes(c.id)}
                  onChange={(e) => setCats((cs) => (e.target.checked ? [...cs, c.id] : cs.filter((x) => x !== c.id)))}
                />
                <Icon type={c.type} />
                {c.label}
              </label>
            ))}
          </fieldset>
          <div className="lib-search">
            <label>
              Within{' '}
              <select value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))}>
                {RADII.map((r) => (
                  <option key={r} value={r}>
                    {r} km
                  </option>
                ))}
              </select>{' '}
              of the route
            </label>
            <button className="primary" disabled={!cats.length || status.kind === 'loading'} onClick={search}>
              {status.kind === 'loading' ? 'Searching…' : 'Search along route'}
            </button>
          </div>

          {status.kind === 'loading' && <p className="hint">Asking OpenStreetMap. Long routes can take up to a minute.</p>}
          {status.kind === 'error' && <p className="error-text">{status.message}</p>}

          {status.kind === 'done' && (
            <>
              <div className="lib-summary">
                <button className={`chip ${show === null ? 'active' : ''}`} onClick={() => setShow(null)}>
                  All ({items.length})
                </button>
                {cats.map((id) => {
                  const c = LIBRARY_CATEGORIES.find((x) => x.id === id)!;
                  return (
                    <button key={id} className={`chip ${show === id ? 'active' : ''}`} onClick={() => setShow(id)}>
                      <Icon type={c.type} /> {c.label} ({counts.get(id) ?? 0})
                    </button>
                  );
                })}
              </div>
              {items.length === 0 ? (
                <p>Nothing found within {radiusKm} km. Try a wider distance.</p>
              ) : (
                <>
                  <label className="lib-all">
                    <input
                      type="checkbox"
                      checked={allVisiblePicked}
                      onChange={(e) =>
                        setPicked((p) => {
                          const n = new Set(p);
                          for (const i of selectable) {
                            if (e.target.checked) n.add(i.id);
                            else n.delete(i.id);
                          }
                          return n;
                        })
                      }
                    />
                    Select all shown
                  </label>
                  <ul className="lib-list">
                    {visible.map((i) => {
                      const added = have.has(i.id);
                      return (
                        <li key={i.id} className={added ? 'added' : ''}>
                          <label>
                            <input type="checkbox" disabled={added} checked={added || picked.has(i.id)} onChange={() => toggle(i.id)} />
                            <span className="wpm-icon" style={{ background: WAYPOINT_STYLE[i.type].color }}>
                              <Icon type={i.type} size={12} />
                            </span>
                            <span className="lib-name">{i.name}</span>
                            <span className="num">km {i.km.toFixed(0)}</span>
                            <span className="num muted">{fmtOff(i.offKm)} off</span>
                            {added && <span className="tag">in trip</span>}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      )}

      <p className="hint lib-credit">
        Data © OpenStreetMap contributors, available under the Open Database License (ODbL). Searched via the public Overpass API.
      </p>
      <div className="welcome-actions">
        {status.kind === 'done' && (
          <button className="primary" disabled={!picked.size} onClick={addPicked}>
            Add {picked.size} to my waypoints
          </button>
        )}
        <button className="link" onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}
