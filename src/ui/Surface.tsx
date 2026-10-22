import { useState } from 'react';
import { lookupSurface, percents, refineSurface, surfaceShare, type SurfaceShare } from '../core/surface';
import { useStore } from '../store';

const TIP = 'On road = paved (asphalt, concrete, paving stones…). Off road = unpaved (gravel, dirt, grass…). Unknown = the road has no surface tag in OpenStreetMap, or the route left the mapped roads.';

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

type Busy = { kind: 'idle' } | { kind: 'matching'; done: number; total: number } | { kind: 'tags' } | { kind: 'error'; msg: string };

/** Trip summary entry: the lookup button, progress, and the whole route's split once known. */
export function SurfaceSummary() {
  const surface = useStore((s) => s.surface);
  const segs = useStore((s) => s.surfaceSegs);
  const dist = useStore((s) => s.profile?.dist);
  const [busy, setBusy] = useState<Busy>({ kind: 'idle' });

  async function lookUp() {
    setBusy({ kind: 'matching', done: 0, total: 1 });
    try {
      const { source } = useStore.getState();
      const d = await lookupSurface(source, { progress: (done, total) => setBusy({ kind: 'matching', done, total }) });
      // The route may have been replaced while waiting.
      if (useStore.getState().source === source) useStore.getState().setSurface(d);
      setBusy({ kind: 'idle' });
    } catch (e) {
      setBusy({ kind: 'error', msg: (e as Error).message === 'Failed to fetch' ? 'the matching server could not be reached' : (e as Error).message });
    }
  }

  async function refine() {
    if (!surface) return;
    setBusy({ kind: 'tags' });
    try {
      const d = await refineSurface(surface);
      if (useStore.getState().surface === surface) useStore.getState().setSurface(d);
      setBusy({ kind: 'idle' });
    } catch {
      setBusy({ kind: 'error', msg: 'OpenStreetMap (Overpass) is busy; still showing estimates' });
    }
  }

  const status =
    busy.kind === 'matching' ? (
      <span className="hint">
        Matching the route to roads… {busy.done}/{busy.total}
      </span>
    ) : busy.kind === 'tags' ? (
      <span className="hint">Fetching road tags…</span>
    ) : busy.kind === 'error' ? (
      <span className="error-text">Failed: {busy.msg}.</span>
    ) : null;

  if (!surface || !segs || !dist) {
    return (
      <div className="surface-summary">
        <dt>Road surface</dt>
        <dd>
          {busy.kind === 'idle' || busy.kind === 'error' ? (
            <button className="small" onClick={lookUp} title="Sends this route's coordinates to the FOSSGIS Valhalla server and road ids to OpenStreetMap's Overpass API">
              Look up
            </button>
          ) : null}{' '}
          {status}
        </dd>
      </div>
    );
  }
  return (
    <div className="surface-summary">
      <dt>
        Road surface
        {surface.from === 'estimated' && (
          <>
            {' '}
            <span className="badge" title="OpenStreetMap's road tags couldn't be fetched, so these come from the matcher, which counts untagged roads as paved.">
              estimated
            </span>
          </>
        )}
      </dt>
      <dd>
        <SurfaceBar share={surfaceShare(segs, dist, 0, segs.length)} compact />
        {surface.from === 'estimated' && busy.kind !== 'tags' && (
          <button className="link small" onClick={refine}>
            Get exact tags
          </button>
        )}
        {status}
      </dd>
    </div>
  );
}
