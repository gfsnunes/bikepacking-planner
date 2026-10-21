import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { nearestIndex } from '../core/geo';
import { cumulativeDist, indexAtKm, kmAt, ridingRange, ridingSource, tickStep } from '../core/trim';
import type { TrackPoint } from '../core/types';
import { useStore } from '../store';
import { BASEMAPS, boundsOf, savedBasemap } from './basemaps';

const line = (pts: TrackPoint[]) => ({
  type: 'Feature' as const,
  properties: {},
  geometry: { type: 'LineString' as const, coordinates: pts.map((p) => [p.lon, p.lat]) },
});

function endMarker(label: string, cls: string) {
  const el = document.createElement('div');
  el.className = `crop-marker ${cls}`;
  el.textContent = label;
  return el;
}

/**
 * "Crop route": pick the start and end on the original GPX track (in riding direction) with a
 * two-handle slider or by dragging S/E on a map. The original is kept, so a crop can be widened again.
 */
export function CropDialog() {
  const open = useStore((s) => s.cropOpen);
  const trackPoints = useStore((s) => s.points);
  const source = useStore((s) => s.source);
  const reversed = useStore((s) => s.view.reversed);
  // The original track in riding direction, and distance along it.
  const points = useMemo(() => ridingSource(source, reversed), [source, reversed]);
  const dist = useMemo(() => cumulativeDist(points), [points]);
  const dialog = useRef<HTMLDialogElement>(null);
  const mapBox = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markers = useRef<{ s: maplibregl.Marker; e: maplibregl.Marker } | null>(null);
  const dragging = useRef<'s' | 'e' | null>(null);
  const openedOn = useRef<TrackPoint[] | null>(null); // the route when the window opened
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  const [redraw, setRedraw] = useState(0); // map ready / drag ended: re-place the kept line and markers
  const n = points.length;
  const totalKm = n ? kmAt(dist, n - 1) : 0;
  // Content (and the map) only while open with a range that fits the current track.
  const showing = open && n >= 2 && b < n && b > a;

  // Open/close the native dialog from the store flag; start from the current crop.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      const { view, source: src } = useStore.getState();
      const [ra, rb] = src.length > 1 ? ridingRange(view, src.length) : [0, 0];
      setA(ra);
      setB(rb);
      openedOn.current = useStore.getState().points;
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  // The track changed while open (a collaborator in a shared trip cropped or reversed it): the range
  // no longer fits, so close rather than show a stale or empty window.
  useEffect(() => {
    if (useStore.getState().cropOpen && openedOn.current && trackPoints !== openedOn.current) useStore.getState().setCropOpen(false);
  }, [trackPoints]);

  // React's onClose/onCancel don't fire reliably for <dialog> (see Welcome), so listen natively.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const onClosed = () => useStore.getState().cropOpen && useStore.getState().setCropOpen(false);
    d.addEventListener('close', onClosed);
    d.addEventListener('cancel', onClosed);
    return () => {
      d.removeEventListener('close', onClosed);
      d.removeEventListener('cancel', onClosed);
    };
  }, []);

  // The overlay's own map, created once the dialog is open (so its box has a size).
  useEffect(() => {
    if (!showing || !mapBox.current) return;
    const map = new maplibregl.Map({
      container: mapBox.current,
      style: BASEMAPS[savedBasemap()].style,
      bounds: boundsOf(points),
      fitBoundsOptions: { padding: 40 },
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e8590c';
    map.on('load', () => {
      map.addSource('crop-full', { type: 'geojson', data: line(points) });
      map.addSource('crop-kept', { type: 'geojson', data: line(points) });
      map.addLayer({ id: 'crop-full', type: 'line', source: 'crop-full', paint: { 'line-color': '#8a8a8a', 'line-width': 4, 'line-opacity': 0.8 } });
      map.addLayer({ id: 'crop-kept', type: 'line', source: 'crop-kept', paint: { 'line-color': accent, 'line-width': 5 } });
      setRedraw((r) => r + 1);
    });

    const s = new maplibregl.Marker({ element: endMarker('S', 'start'), draggable: true }).setLngLat([points[0].lon, points[0].lat]).addTo(map);
    const e = new maplibregl.Marker({ element: endMarker('E', 'end'), draggable: true }).setLngLat([points[n - 1].lon, points[n - 1].lat]).addTo(map);
    markers.current = { s, e };
    // Dragging snaps to the nearest track point that keeps start before end.
    const onDrag = (which: 's' | 'e') => () => {
      dragging.current = which;
      const m = which === 's' ? s : e;
      const ll = m.getLngLat();
      if (which === 's') setA(nearestIndex(points, ll.lat, ll.lng, 0, Math.max(0, bRef.current - 1)).idx);
      else setB(nearestIndex(points, ll.lat, ll.lng, Math.min(n - 1, aRef.current + 1), n - 1).idx);
    };
    const onDragEnd = () => {
      dragging.current = null;
      setRedraw((r) => r + 1); // snap the marker back onto the track
    };
    s.on('drag', onDrag('s'));
    s.on('dragend', onDragEnd);
    e.on('drag', onDrag('e'));
    e.on('dragend', onDragEnd);
    return () => {
      markers.current = null;
      mapRef.current = null;
      map.remove();
    };
    // The track can't change while the dialog is open (it's modal), so `points` is left out on purpose.
  }, [showing, n]);

  // Latest range for the marker handlers above.
  const aRef = useRef(a);
  const bRef = useRef(b);
  aRef.current = a;
  bRef.current = b;

  // Keep the kept stretch and the markers in step with the range.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || n < 2 || b <= a || b >= n) return;
    (map.getSource('crop-kept') as GeoJSONSource | undefined)?.setData(line(points.slice(a, b + 1)));
    const m = markers.current;
    if (m && dragging.current !== 's') m.s.setLngLat([points[a].lon, points[a].lat]);
    if (m && dragging.current !== 'e') m.e.setLngLat([points[b].lon, points[b].lat]);
  }, [a, b, points, n, redraw]);

  /** Move a handle; pan the map when the point leaves the middle of the view, so a zoomed-in map follows. */
  function moveTo(which: 's' | 'e', km: number) {
    const idx = indexAtKm(dist, km);
    const next = which === 's' ? Math.min(idx, b - 1) : Math.max(idx, a + 1);
    if (which === 's') setA(Math.max(0, next));
    else setB(Math.min(n - 1, next));
    const map = mapRef.current;
    const p = points[next];
    if (!map || !p) return;
    const pt = map.project([p.lon, p.lat]);
    const { width, height } = map.getContainer().getBoundingClientRect();
    if (pt.x < width * 0.2 || pt.x > width * 0.8 || pt.y < height * 0.2 || pt.y > height * 0.8) map.easeTo({ center: [p.lon, p.lat], duration: 200 });
  }

  // Arrow keys step one track point (finer than the slider's own step can resolve); Page Up/Down 1 km.
  const keys = (which: 's' | 'e', km: number) => (ev: KeyboardEvent<HTMLInputElement>) => {
    const point = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[ev.key];
    const page = ev.key === 'PageUp' ? 1 : ev.key === 'PageDown' ? -1 : 0;
    if (!point && !page) return;
    ev.preventDefault();
    if (page) return moveTo(which, km + page);
    const i = (which === 's' ? a : b) + point!;
    if (which === 's' && i >= 0 && i < b) moveTo('s', kmAt(dist, i));
    if (which === 'e' && i > a && i < n) moveTo('e', kmAt(dist, i));
  };

  // Closed, or the range is from before the track changed (e.g. right after a crop): render the empty shell.
  if (!showing) return <dialog ref={dialog} className="about crop" />;

  const aKm = kmAt(dist, a);
  const bKm = kmAt(dist, b);
  const step = tickStep(totalKm);
  const ticks: number[] = [];
  for (let k = 0; k <= totalKm + 1e-9; k += step) ticks.push(k);
  const pct = (km: number) => (totalKm ? (km / totalKm) * 100 : 0);
  const ele = (i: number) => (points[i].ele != null ? ` · ${Math.round(points[i].ele!)} m` : '');
  const full = a === 0 && b === n - 1;
  const [ca, cb] = ridingRange(useStore.getState().view, n);
  const unchanged = a === ca && b === cb;

  return (
    <dialog ref={dialog} className="about crop">
      <h2>Crop route</h2>
      <p className="hint">
        This is the whole route from your GPX. Drag the handles below, or the <strong>S</strong> and <strong>E</strong> markers on the
        map, to set where the route starts and ends; you can widen it again any time. Zoom in for precise placement. Arrow keys move a
        handle one track point, Page Up/Down 1 km.
      </p>
      <div ref={mapBox} className="crop-map" />
      <div className="crop-slider" style={{ ['--a' as string]: `${pct(aKm)}%`, ['--b' as string]: `${pct(bKm)}%` }}>
        <div className="crop-track" />
        <input
          type="range"
          aria-label="Start of the route"
          min={0}
          max={totalKm}
          step={0.01}
          value={aKm}
          onChange={(ev) => moveTo('s', +ev.target.value)}
          onKeyDown={keys('s', aKm)}
        />
        <input
          type="range"
          aria-label="End of the route"
          min={0}
          max={totalKm}
          step={0.01}
          value={bKm}
          onChange={(ev) => moveTo('e', +ev.target.value)}
          onKeyDown={keys('e', bKm)}
        />
        <div className="crop-ticks" aria-hidden="true">
          {ticks.map((k) => (
            <span key={k} style={{ left: `${pct(k)}%` }}>
              {k}
            </span>
          ))}
        </div>
      </div>
      <p className="crop-readout">
        <span>
          <strong>Start</strong> km {aKm.toFixed(1)}
          {ele(a)}
        </span>
        <span>
          <strong>End</strong> km {bKm.toFixed(1)}
          {ele(b)}
        </span>
        <span>
          Keeps <strong>{(bKm - aKm).toFixed(1)} km</strong>
          {!full &&
            ` (cuts ${[a > 0 && `${aKm.toFixed(1)} km at the start`, b < n - 1 && `${(totalKm - bKm).toFixed(1)} km at the end`]
              .filter(Boolean)
              .join(' and ')})`}
        </span>
      </p>
      <div className="welcome-actions">
        <button
          className="primary"
          disabled={unchanged}
          onClick={() => {
            useStore.getState().cropTo(a, b);
            useStore.getState().setCropOpen(false);
          }}
        >
          Apply
        </button>
        <button
          disabled={full}
          onClick={() => {
            setA(0);
            setB(n - 1);
            const map = mapRef.current;
            map?.fitBounds(boundsOf(points), { padding: 40 });
          }}
        >
          Whole route
        </button>
        <button className="link" onClick={() => useStore.getState().setCropOpen(false)}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
