import { WAYPOINT_TYPES } from '../core/types';
import { useStore } from '../store';
import { WAYPOINT_STYLE } from './colors';
import { Icon } from './DayPanel';

export function WaypointEditor() {
  const id = useStore((s) => s.selectedWaypoint);
  const w = useStore((s) => s.waypoints.find((x) => x.id === s.selectedWaypoint));
  const offset = useStore((s) => s.projected.find((x) => x.id === s.selectedWaypoint)?.offsetM);
  const { updateWaypoint, removeWaypoint, selectWaypoint } = useStore.getState();
  if (!id || !w) return null;

  return (
    <section className="card wp-editor">
      <div className="card-head">
        <h2>Waypoint</h2>
        <button className="link" onClick={() => selectWaypoint(null)}>
          Close
        </button>
      </div>
      <label className="row">
        Name
        <input autoFocus value={w.name} onChange={(e) => updateWaypoint(id, { name: e.target.value })} />
      </label>
      <div className="chips">
        {WAYPOINT_TYPES.map((t) => (
          <label key={t} className="chip">
            <input type="radio" name="wptype" checked={w.type === t} onChange={() => updateWaypoint(id, { type: t })} />
            <Icon type={t} />
            {WAYPOINT_STYLE[t].label}
          </label>
        ))}
      </div>
      <p className="hint">
        {w.typeLocked ? 'Type set by hand.' : 'Type follows the name; pick one to fix it.'}{' '}
        {offset != null && `${offset < 1000 ? `${Math.round(offset)} m` : `${(offset / 1000).toFixed(1)} km`} from the track.`} Drag the pin
        to move it.
      </p>
      <button className="danger" onClick={() => removeWaypoint(id)}>
        Delete waypoint
      </button>
    </section>
  );
}
