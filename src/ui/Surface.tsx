import { useEffect, useState } from 'react';
import { percents, surfaceShare, type SurfaceShare } from '../core/surface';
import { lookupTileSurface } from '../core/tile-surface';
import { useStore } from '../store';
import { decodeTransportation } from './decodeTile';

const TIP =
  'From OpenStreetMap surface tags (via the map tiles). On road = paved (asphalt, concrete, paving stones…). Off road = unpaved (gravel, dirt, grass…). Unknown = the road has no surface tag, or no mapped road was found within 25 m.';

/** Stacked bar plus "On road 72% · Off road 21% · Unknown 7%". */
export function SurfaceBar({ share, compact = false }: { share: SurfaceShare; compact?: boolean }) {
  const p = percents(share);
  return (
    <div className={`surface ${compact ? 'compact' : ''}`} title={TIP}>
      <div className="surface-bar" aria-hidden="true">
        <span className="paved" style={{ width: `${p.paved}%` }} />
        <span className="unpaved" style={{ width: `${p.unpaved}%` }} />
        <span className="unknown" style={{ width: `${p.unknown}%` }} />
      </div>
      <div className="surface-text">
        <span className="paved">On road {p.paved}%</span> · <span className="unpaved">Off road {p.unpaved}%</span> ·{' '}
        <span className="unknown">Unknown {p.unknown}%</span>
      </div>
    </div>
  );
}

type Busy = { kind: 'idle' } | { kind: 'loading'; done: number; total: number } | { kind: 'error'; msg: string };

let running: unknown = null; // the track being looked up (StrictMode runs effects twice)

/**
 * Trip summary entry. Looks the surfaces up by itself whenever the route has none yet: it only
 * downloads map tiles (as viewing the map does), so nothing about the route leaves the browser.
 */
export function SurfaceSummary() {
  const surface = useStore((s) => s.surface);
  const source = useStore((s) => s.source);
  const segs = useStore((s) => s.surfaceSegs);
  const dist = useStore((s) => s.profile?.dist);
  const [busy, setBusy] = useState<Busy>({ kind: 'idle' });

  async function lookUp() {
    const track = useStore.getState().source;
    if (track.length < 2 || running === track) return;
    running = track;
    setBusy({ kind: 'loading', done: 0, total: 1 });
    try {
      const d = await lookupTileSurface(track, decodeTransportation, { progress: (done, total) => setBusy({ kind: 'loading', done, total }) });
      // The route may have been replaced while waiting.
      if (useStore.getState().source === track) useStore.getState().setSurface(d);
      setBusy({ kind: 'idle' });
    } catch (e) {
      setBusy({ kind: 'error', msg: (e as Error).message === 'Failed to fetch' ? 'the map tiles could not be loaded' : (e as Error).message });
    } finally {
      if (running === track) running = null;
    }
  }

  useEffect(() => {
    if (!surface && source.length > 1) void lookUp();
  }, [surface, source]);

  if (surface && segs && dist) {
    return (
      <div className="surface-summary">
        <dt>Road surface</dt>
        <dd>
          <SurfaceBar share={surfaceShare(segs, dist, 0, segs.length)} compact />
        </dd>
      </div>
    );
  }
  return (
    <div className="surface-summary">
      <dt>Road surface</dt>
      <dd>
        {busy.kind === 'loading' && (
          <span className="hint">
            Reading map tiles… {busy.done}/{busy.total}
          </span>
        )}
        {busy.kind === 'error' && (
          <span className="error-text">
            Failed: {busy.msg}.{' '}
            <button className="link small" onClick={() => void lookUp()}>
              Try again
            </button>
          </span>
        )}
      </dd>
    </div>
  );
}
