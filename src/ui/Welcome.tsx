import { useEffect, useRef } from 'react';

const SEEN_KEY = 'bikepacking-planner:welcome-seen';

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false; // storage blocked: show it, it just won't be remembered
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* storage unavailable */
  }
}

/**
 * Quick guide: opens by itself on a browser's first visit, and from the "Quick guide" link in the
 * header any time after that.
 */
export function Welcome({ onSample, onOpenGpx }: { onSample: () => void; onOpenGpx: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    // Native listeners: React's onClose doesn't fire for <dialog> here, and Escape only raises
    // 'cancel' (no 'close') in some browsers, so listen for both.
    d.addEventListener('close', markSeen);
    d.addEventListener('cancel', markSeen);
    if (!seen()) d.showModal();
    return () => {
      d.removeEventListener('close', markSeen);
      d.removeEventListener('cancel', markSeen);
    };
  }, []);

  const close = (then?: () => void) => {
    markSeen();
    dialog.current?.close();
    then?.();
  };

  return (
    <>
      <button className="link about-link" onClick={() => dialog.current?.showModal()}>
        Quick guide
      </button>
      <dialog
        ref={dialog}
        className="about welcome"
        aria-labelledby="welcome-title"
        onClick={(e) => e.target === dialog.current && close()}
      >
        <h2 id="welcome-title">Welcome to Bikepacking Day Planner</h2>
        <p>Plan a multi-day ride in a few minutes:</p>
        <ol className="steps">
          <li>
            <strong>Open a GPX route</strong>, or try the sample route. Drag-and-drop onto the page works too.
          </li>
          <li>
            <strong>Set your daily limits</strong> in the <em>Daily limits</em> panel: distance, climbing or riding time. Each day ends at whichever limit
            comes first.
          </li>
          <li>
            <strong>Fine-tune the days</strong> by dragging the numbered day-end markers on the map or the elevation profile.
          </li>
          <li>
            <strong>Add waypoints</strong>: click <em>Add waypoint</em> and then the map, or <em>Import waypoints</em> from a GPX, KML,
            GeoJSON or CSV file (shelters, water, shops…).
          </li>
          <li>
            <strong>Export</strong> the plan as one GPX, or one file per day, for your GPS or phone.
          </li>
        </ol>
        <p className="hint">
          Tip: hover the profile for slope, and press-and-drag on it to measure a stretch. Your routes stay in this browser; see{' '}
          <em>About &amp; privacy</em>.
        </p>
        <div className="welcome-actions">
          <button className="primary" onClick={() => close(onSample)}>
            Try a sample route
          </button>
          <button onClick={() => close(onOpenGpx)}>Open my GPX</button>
          <button className="link" onClick={() => close()}>
            Close
          </button>
        </div>
      </dialog>
    </>
  );
}
