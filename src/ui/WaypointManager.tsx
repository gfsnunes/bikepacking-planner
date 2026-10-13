import { useEffect, useMemo, useRef, useState } from 'react';
import { WAYPOINT_TYPES, type Day, type WaypointType } from '../core/types';
import { useStore } from '../store';
import { WAYPOINT_STYLE, dayColor } from './colors';
import { Icon } from './DayPanel';
import { WAYPOINT_FILE_ACCEPT, importWaypointsFromFile } from './importFlow';

const ROW = 34; // px, fixed so the list can be virtualised
const VIEW = 360; // px, height of the scroll area
type SortKey = 'km' | 'off' | 'name' | 'type' | 'day';

interface Row {
  id: string;
  name: string;
  type: WaypointType;
  km: number | null;
  offKm: number | null;
  day: number | null;
}

/** Day index containing track point idx (binary search over day ends). */
function dayOf(days: Day[], idx: number): number | null {
  let lo = 0;
  let hi = days.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (days[mid].end < idx) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const fmtOff = (km: number | null) => (km == null ? '–' : km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);

export function WaypointManager() {
  const waypoints = useStore((s) => s.waypoints);
  const projected = useStore((s) => s.projected);
  const days = useStore((s) => s.days);
  const profile = useStore((s) => s.profile);
  const hoverWaypoint = useStore((s) => s.hoverWaypoint);
  const lastDeleted = useStore((s) => s.lastDeleted);
  const managerDay = useStore((s) => s.managerDay);
  const cardRangeKm = useStore((s) => s.cardRangeKm);
  const { updateWaypoint, removeWaypoints, undoDelete, setHoverWaypoint, focusWaypoint } = useStore.getState();

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<WaypointType | ''>('');
  const [nearOnly, setNearOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'km', dir: 1 });
  const [farKm, setFarKm] = useState(2);
  const [scrollTop, setScrollTop] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const pointerInside = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // All waypoints with their position along the route (projection comes from the store).
  const all: Row[] = useMemo(() => {
    const proj = new Map(projected.map((p) => [p.id, p]));
    return waypoints.map((w) => {
      const p = proj.get(w.id);
      return {
        id: w.id,
        name: w.name,
        type: w.type,
        km: p && profile ? profile.dist[p.idx] / 1000 : null,
        offKm: p ? p.offsetM / 1000 : null,
        day: p ? dayOf(days, p.idx) : null,
      };
    });
  }, [waypoints, projected, days, profile]);

  const typeCounts = useMemo(() => {
    const c = new Map<WaypointType, number>();
    for (const r of all) c.set(r.type, (c.get(r.type) ?? 0) + 1);
    return c;
  }, [all]);

  const filterActive = search.trim() !== '' || typeFilter !== '' || nearOnly;
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = all.filter(
      (r) =>
        (!q || r.name.toLowerCase().includes(q)) &&
        (!typeFilter || r.type === typeFilter) &&
        (!nearOnly || (r.offKm != null && r.offKm <= cardRangeKm)),
    );
    const val = (r: Row): string | number => {
      switch (sort.key) {
        case 'name':
          return r.name.toLowerCase();
        case 'type':
          return WAYPOINT_STYLE[r.type].label;
        case 'off':
          return r.offKm ?? Infinity;
        case 'day':
          return r.day ?? Infinity;
        default:
          return r.km ?? Infinity;
      }
    };
    return out.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [all, search, typeFilter, nearOnly, cardRangeKm, sort]);

  const farIds = useMemo(() => all.filter((r) => r.offKm != null && r.offKm > farKm).map((r) => r.id), [all, farKm]);

  // Keep the row for a waypoint hovered on the map in view (scrolls the list only, never the page).
  useEffect(() => {
    if (!hoverWaypoint || pointerInside.current || !list.current) return;
    const i = rows.findIndex((r) => r.id === hoverWaypoint);
    if (i < 0) return;
    const el = list.current;
    if (i * ROW < el.scrollTop) el.scrollTop = i * ROW;
    else if ((i + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (i + 1) * ROW - el.clientHeight;
  }, [hoverWaypoint, rows]);

  // "+N more" on a day card: show that day's waypoints.
  useEffect(() => {
    if (!managerDay || !list.current) return;
    const i = rows.findIndex((r) => r.day === managerDay.k);
    if (i >= 0) list.current.scrollTop = i * ROW;
    section.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [managerDay]); // only when a new request arrives

  const bulkDelete = (ids: string[], what: string) => {
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} waypoint${ids.length === 1 ? '' : 's'} (${what})? You can undo this.`)) return;
    removeWaypoints(ids);
  };

  const header = (key: SortKey, label: string, cls = '') => (
    <button
      className={`th ${cls} ${sort.key === key ? 'sorted' : ''}`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }))}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
    >
      {label}
      {sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </button>
  );

  const first = Math.max(0, Math.floor(scrollTop / ROW) - 5);
  const last = Math.min(rows.length, first + Math.ceil(VIEW / ROW) + 10);

  return (
    <section className="wp-manager" ref={section}>
      <div className="wpm-head">
        <h2>
          Waypoints <span className="count">({waypoints.length})</span>
        </h2>
        <input
          ref={fileInput}
          type="file"
          accept={WAYPOINT_FILE_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importWaypointsFromFile(f);
            e.target.value = '';
          }}
        />
        <button onClick={() => fileInput.current?.click()}>Import waypoints</button>
        {lastDeleted && (
          <button className="undo" onClick={undoDelete}>
            Undo delete ({lastDeleted.length})
          </button>
        )}
      </div>

      <div className="wpm-tools">
        <input className="search" placeholder="Search names" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as WaypointType | '')}>
          <option value="">All types</option>
          {WAYPOINT_TYPES.filter((t) => typeCounts.get(t)).map((t) => (
            <option key={t} value={t}>
              {WAYPOINT_STYLE[t].label} ({typeCounts.get(t)})
            </option>
          ))}
        </select>
        <label className="near" title="Day cards list waypoints up to this distance from the track">
          Day cards show waypoints within
          <input
            type="number"
            min={0.5}
            max={50}
            step={0.5}
            value={cardRangeKm}
            onChange={(e) => useStore.getState().setCardRange(Math.max(0.5, Number(e.target.value) || 0.5))}
          />
          km
        </label>
        <label className="near">
          <input type="checkbox" checked={nearOnly} onChange={(e) => setNearOnly(e.target.checked)} />
          List only those
        </label>
      </div>

      <div className="wpm-bulk">
        <span>Delete all farther than</span>
        <input type="number" min={0} step={0.5} value={farKm} onChange={(e) => setFarKm(Math.max(0, Number(e.target.value) || 0))} />
        <span>km from the track</span>
        <button className="danger" disabled={!farIds.length} onClick={() => bulkDelete(farIds, `farther than ${farKm} km from the track`)}>
          Delete {farIds.length} of {all.length}
        </button>
        {filterActive && rows.length > 0 && (
          <button className="danger" onClick={() => bulkDelete(rows.map((r) => r.id), 'matching the current filter')}>
            Delete {rows.length} shown
          </button>
        )}
        {waypoints.length > 0 && (
          <button className="danger subtle" onClick={() => bulkDelete(waypoints.map((w) => w.id), 'all waypoints')}>
            Delete all
          </button>
        )}
      </div>

      {waypoints.length === 0 ? (
        <p className="hint">No waypoints yet. Import a GPX, KML/KMZ, GeoJSON or CSV file, or use “Add waypoint” and click the map.</p>
      ) : (
        <div className="wpm-table">
          <div className="wpm-row wpm-header">
            {header('type', 'Type')}
            {header('name', 'Name')}
            {header('km', 'Km', 'num')}
            {header('off', 'Off route', 'num')}
            {header('day', 'Day', 'num')}
            <span />
          </div>
          <div
            className="wpm-list"
            ref={list}
            style={{ height: Math.min(VIEW, Math.max(ROW, rows.length * ROW)) }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            onMouseEnter={() => (pointerInside.current = true)}
            onMouseLeave={() => {
              pointerInside.current = false;
              setHoverWaypoint(null);
            }}
          >
            <div style={{ height: rows.length * ROW, position: 'relative' }}>
              {rows.slice(first, last).map((r, j) => (
                <div
                  key={r.id}
                  className={`wpm-row ${r.id === hoverWaypoint ? 'hovered' : ''}`}
                  style={{ top: (first + j) * ROW }}
                  onMouseEnter={() => setHoverWaypoint(r.id)}
                >
                  <span className="wpm-type">
                    <span className="wpm-icon" style={{ background: WAYPOINT_STYLE[r.type].color }}>
                      <Icon type={r.type} size={12} />
                    </span>
                    <select aria-label="Type" value={r.type} onChange={(e) => updateWaypoint(r.id, { type: e.target.value as WaypointType })}>
                      {WAYPOINT_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {WAYPOINT_STYLE[t].label}
                        </option>
                      ))}
                    </select>
                  </span>
                  <input aria-label="Name" className="wpm-name" value={r.name} onChange={(e) => updateWaypoint(r.id, { name: e.target.value })} />
                  <span className="num">{r.km == null ? '–' : r.km.toFixed(1)}</span>
                  <span className={`num ${r.offKm != null && r.offKm > farKm ? 'far' : ''}`}>{fmtOff(r.offKm)}</span>
                  <span className="num">{r.day == null ? '–' : <b style={{ color: dayColor(r.day) }}>{r.day + 1}</b>}</span>
                  <span className="wpm-actions">
                    <button title="Show on map" aria-label="Show on map" onClick={() => focusWaypoint(r.id)}>
                      ⌖
                    </button>
                    <button title="Delete" aria-label="Delete" className="danger" onClick={() => removeWaypoints([r.id])}>
                      ×
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
          {rows.length === 0 && <p className="hint">No waypoints match the filter.</p>}
        </div>
      )}
    </section>
  );
}
