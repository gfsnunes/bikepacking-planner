import { useEffect, useRef, useState } from 'react';
import { describeDay } from '../core/describe';
import { HIKE_PRESETS, SURFACES, thresholdFromRider } from '../core/hike';
import { WAYPOINT_TYPES, type Day, type LimitReason } from '../core/types';
import { useStore } from '../store';
import { WAYPOINT_STYLE, dayColor, fmtH, fmtKm, fmtM } from './colors';
import { iconSvg } from './icons';
import { DayResupply, ResupplySection, ResupplySummary } from './Resupply';

function Icon({ type, size = 12 }: { type: keyof typeof WAYPOINT_STYLE; size?: number }) {
  // Static SVG markup generated from the Lucide icon set, not user input.
  return <span className="icon" dangerouslySetInnerHTML={{ __html: iconSvg(type, size) }} />;
}

function LimitInput(props: {
  label: string;
  unit: string;
  value: number | null;
  step: number;
  fallback: number;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const on = props.value != null && props.value > 0;
  return (
    <label className={`limit ${props.disabled ? 'disabled' : ''}`} title={props.hint}>
      <input
        type="checkbox"
        checked={on}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked ? props.fallback : null)}
      />
      <span className="limit-label">{props.label}</span>
      <input
        type="number"
        min={0}
        step={props.step}
        value={on ? props.value! : ''}
        placeholder="off"
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
      <span className="unit">{props.unit}</span>
    </label>
  );
}

function NumberRow(props: { label: string; unit: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="row">
      {props.label}
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Math.max(props.min, Number(e.target.value) || props.min))}
      />
      <span className="unit">{props.unit}</span>
    </label>
  );
}

export function Settings() {
  const limits = useStore((s) => s.limits);
  const tm = useStore((s) => s.timeModel);
  const snap = useStore((s) => s.snap);
  const hasEle = useStore((s) => s.profile?.hasElevation ?? true);
  const { setLimits, setTimeModel, setSnap } = useStore.getState();

  return (
    <section className="card settings">
      <h2>Daily limits</h2>
      <p className="hint">A day ends at whichever limit is reached first.</p>
      <LimitInput label="Distance" unit="km" step={5} fallback={100} value={limits.maxKm} onChange={(v) => setLimits({ maxKm: v })} />
      <LimitInput
        label="Climbing"
        unit="m"
        step={100}
        fallback={1500}
        value={limits.maxGainM}
        onChange={(v) => setLimits({ maxGainM: v })}
        disabled={!hasEle}
        hint={hasEle ? undefined : 'This track has no elevation data'}
      />
      <LimitInput label="Riding time" unit="h" step={0.5} fallback={6} value={limits.maxHours} onChange={(v) => setLimits({ maxHours: v })} />

      <details open>
        <summary>Time estimate</summary>
        <div className="segmented" role="radiogroup" aria-label="Time model">
          <button role="radio" aria-checked={tm.mode === 'average'} className={tm.mode === 'average' ? 'active' : ''} onClick={() => setTimeModel({ mode: 'average' })}>
            Average speed
          </button>
          <button role="radio" aria-checked={tm.mode === 'terrain'} className={tm.mode === 'terrain' ? 'active' : ''} onClick={() => setTimeModel({ mode: 'terrain' })}>
            Terrain model
          </button>
        </div>
        {tm.mode === 'average' ? (
          <>
            <NumberRow label="Average moving speed" unit="km/h" value={tm.avgKmh} min={3} max={40} step={0.5} onChange={(v) => setTimeModel({ avgKmh: v })} />
            <p className="hint">Time = distance ÷ your average moving speed. Climbing is ignored. Stops are not included.</p>
          </>
        ) : (
          <>
            <NumberRow label="Flat speed" unit="km/h" value={tm.flatKmh} min={5} max={40} step={1} onChange={(v) => setTimeModel({ flatKmh: v })} />
            <NumberRow label="Climbing rate" unit="m/h" value={tm.climbMh} min={100} max={2000} step={50} onChange={(v) => setTimeModel({ climbMh: v })} />
            <NumberRow label="Max descent speed" unit="km/h" value={tm.maxKmh} min={10} max={80} step={1} onChange={(v) => setTimeModel({ maxKmh: v })} />
            <p className="hint">
              Flat riding time plus {Math.round(6000 / tm.climbMh)} min per 100 m climbed; descents give some time back. Stops are not
              included.
            </p>
          </>
        )}
      </details>

      <HikeSection />

      <ResupplySection />

      <details>
        <summary>Snap day ends to waypoints</summary>
        <label className="row">
          <input type="checkbox" checked={snap.enabled} onChange={(e) => setSnap({ enabled: e.target.checked })} />
          Pull an automatic day end back to a waypoint
        </label>
        <NumberRow label="Look back up to" unit="km" value={snap.radiusKm} min={0} max={50} step={1} onChange={(v) => setSnap({ radiusKm: v })} />
        <div className="chips">
          {WAYPOINT_TYPES.map((t) => (
            <label key={t} className="chip">
              <input
                type="checkbox"
                checked={snap.types.includes(t)}
                onChange={(e) => setSnap({ types: e.target.checked ? [...snap.types, t] : snap.types.filter((x) => x !== t) })}
              />
              <Icon type={t} />
              {WAYPOINT_STYLE[t].label}
            </label>
          ))}
        </div>
        <p className="hint">Only waypoints within 1 km of the track count. Snapping never makes a day longer.</p>
      </details>
    </section>
  );
}

function HikeSection() {
  const hike = useStore((s) => s.hike);
  const hasEle = useStore((s) => s.profile?.hasElevation ?? true);
  const { setHike } = useStore.getState();
  const [rider, setRider] = useState({ powerW: 200, massKg: 110, minKmh: 5.5, surface: 1 });
  const calc = thresholdFromRider({ ...rider, crr: SURFACES[rider.surface].crr });

  return (
    <details>
      <summary>Hike-a-bike</summary>
      <label className="row">
        <input type="checkbox" checked={hike.enabled} onChange={(e) => setHike({ enabled: e.target.checked })} />
        Mark stretches too steep to ride loaded
      </label>
      {!hasEle && <p className="hint">This track has no elevation data, so nothing can be detected.</p>}
      <NumberRow label="Push when steeper than" unit="%" value={hike.thresholdPct} min={3} max={30} step={0.5} onChange={(v) => setHike({ thresholdPct: v })} />
      <div className="segmented presets">
        {HIKE_PRESETS.map((p) => (
          <button key={p.label} className={hike.thresholdPct === p.pct ? 'active' : ''} onClick={() => setHike({ thresholdPct: p.pct })}>
            {p.label} {p.pct}%
          </button>
        ))}
      </div>
      <NumberRow label="Walking pace" unit="km/h" value={hike.walkKmh} min={0.5} max={8} step={0.5} onChange={(v) => setHike({ walkKmh: v })} />
      <p className="hint">
        Grade is measured over {hike.windowM} m, so short ramps don't count. Pushed stretches are timed at walking pace. Presets are rough
        estimates; elevation looked up from the 90 m terrain model smooths short walls.
      </p>
      <details className="nested">
        <summary>Calculate from rider</summary>
        <NumberRow label="Power you can hold" unit="W" value={rider.powerW} min={50} max={600} step={10} onChange={(v) => setRider({ ...rider, powerW: v })} />
        <NumberRow label="Bike + rider + luggage" unit="kg" value={rider.massKg} min={40} max={250} step={1} onChange={(v) => setRider({ ...rider, massKg: v })} />
        <NumberRow label="Slowest speed (lowest gear, 60 rpm)" unit="km/h" value={rider.minKmh} min={2} max={15} step={0.1} onChange={(v) => setRider({ ...rider, minKmh: v })} />
        <label className="row">
          Surface
          <select value={rider.surface} onChange={(e) => setRider({ ...rider, surface: Number(e.target.value) })}>
            {SURFACES.map((sf, i) => (
              <option key={sf.label} value={i}>
                {sf.label}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <strong>{calc.toFixed(1)}%</strong>
          <button className="use-calc" onClick={() => setHike({ thresholdPct: Math.round(calc * 2) / 2, enabled: true })}>
            Use this threshold
          </button>
        </div>
        <p className="hint">Steepest grade your power holds at your slowest speed: power ÷ (weight × g × speed) − rolling resistance.</p>
      </details>
    </details>
  );
}

const LIMIT_LABEL: Record<LimitReason, string> = { distance: 'distance', climbing: 'climbing', time: 'time' };

function ReasonBadge({ day, k }: { day: Day; k: number }) {
  switch (day.reason) {
    case 'distance':
    case 'climbing':
    case 'time':
      return <span className={`badge reason-${day.reason}`}>{LIMIT_LABEL[day.reason]} limit</span>;
    case 'waypoint':
      return (
        <span className="badge reason-waypoint" title={`${LIMIT_LABEL[day.limitReason!]} limit, pulled back to ${day.snappedTo}`}>
          {LIMIT_LABEL[day.limitReason!]} limit → {day.snappedTo}
        </span>
      );
    case 'manual':
      return (
        <button
          className="badge reason-manual"
          title="Placed by hand. Click to go back to automatic from this day on."
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().unpinFrom(k);
          }}
        >
          placed by hand ×
        </button>
      );
    case 'finish':
      return <span className="badge reason-finish">finish</span>;
  }
}

/** The day containing track point idx (a day owns (start, end]; day 0 also owns point 0). */
function dayAt(days: Day[], idx: number | null) {
  if (idx == null) return null;
  const k = days.findIndex((d) => idx <= d.end);
  return k < 0 ? null : k;
}

export function TripSummary() {
  const days = useStore((s) => s.days);
  const stats = useStore((s) => s.stats);
  const pinned = useStore((s) => s.pinned);
  const hasEle = useStore((s) => s.profile?.hasElevation ?? true);
  if (!stats.length) return null;

  const total = stats.reduce(
    (a, s) => ({
      km: a.km + s.distKm,
      up: a.up + s.gainM,
      down: a.down + s.lossM,
      h: a.h + s.hours,
      hikeKm: a.hikeKm + s.hikeKm,
      hikeH: a.hikeH + s.hikeHours,
    }),
    { km: 0, up: 0, down: 0, h: 0, hikeKm: 0, hikeH: 0 },
  );
  const longest = stats.reduce((b, s, k) => (s.distKm > stats[b].distKm ? k : b), 0);
  const hardest = stats.reduce((b, s, k) => (s.gainM > stats[b].gainM ? k : b), 0);

  return (
    <section className="summary">
      <div className="days-count">
        <strong>{days.length}</strong> {days.length === 1 ? 'day' : 'days'}
      </div>
      <dl>
        <div>
          <dt>Distance</dt>
          <dd>{fmtKm(total.km)}</dd>
        </div>
        {hasEle && (
          <>
            <div>
              <dt>Climbing</dt>
              <dd>{fmtM(total.up)}</dd>
            </div>
            <div>
              <dt>Descent</dt>
              <dd>{fmtM(total.down)}</dd>
            </div>
          </>
        )}
        <div>
          <dt>Riding time</dt>
          <dd>{fmtH(total.h)}</dd>
        </div>
        {total.hikeKm > 0 && (
          <div className="hike">
            <dt>Hike-a-bike</dt>
            <dd>
              {fmtKm(total.hikeKm)} · {fmtH(total.hikeH)}
            </dd>
          </div>
        )}
        <ResupplySummary />
        <div>
          <dt>Average day</dt>
          <dd>
            {fmtKm(total.km / days.length)}
            {hasEle && ` · ${fmtM(total.up / days.length)}`}
          </dd>
        </div>
        <div>
          <dt>Longest</dt>
          <dd>
            Day {longest + 1} · {fmtKm(stats[longest].distKm)}
          </dd>
        </div>
        {hasEle && (
          <div>
            <dt>Most climbing</dt>
            <dd>
              Day {hardest + 1} · {fmtM(stats[hardest].gainM)}
            </dd>
          </div>
        )}
      </dl>
      {pinned.length > 0 && (
        <button className="link" onClick={() => useStore.getState().clearPins()}>
          Reset to automatic
        </button>
      )}
    </section>
  );
}

const MAX_CHIPS = 10;

export function DayStrip() {
  const days = useStore((s) => s.days);
  const stats = useStore((s) => s.stats);
  const hasEle = useStore((s) => s.profile?.hasElevation ?? true);
  const hoverDay = useStore((s) => s.hoverDay);
  const hoverWaypoint = useStore((s) => s.hoverWaypoint);
  const mapHoverDay = useStore((s) => (s.hoverSource ? dayAt(s.days, s.hover) : null));
  const strip = useRef<HTMLOListElement>(null);
  const { focus, setHoverDay, setHoverWaypoint, selectWaypoint } = useStore.getState();

  const avgKm = stats.reduce((a, s) => a + s.distKm, 0) / Math.max(1, stats.length);
  const active = hoverDay ?? mapHoverDay;

  // Bring the card or chip for what's hovered on the map / profile into view.
  useEffect(() => {
    if (hoverDay != null) return; // the pointer is already on the strip
    const el = hoverWaypoint
      ? strip.current?.querySelector(`[data-wp="${CSS.escape(hoverWaypoint)}"]`)
      : mapHoverDay != null
        ? strip.current?.children[mapHoverDay]
        : null;
    // Scroll the strip sideways only. scrollIntoView would also scroll the page vertically to the
    // strip on every hover over the map or profile.
    const s = strip.current;
    if (!el || !s) return;
    const r = el.getBoundingClientRect();
    const box = s.getBoundingClientRect();
    const dx = r.left < box.left ? r.left - box.left - 16 : r.right > box.right ? r.right - box.right + 16 : 0;
    if (dx) s.scrollBy({ left: dx, behavior: 'smooth' });
  }, [hoverWaypoint, mapHoverDay, hoverDay]);

  return (
    <ol className="day-strip" ref={strip} onMouseLeave={() => setHoverDay(null)}>
      {days.map((d, k) => {
        const s = stats[k];
        return (
          <li
            key={k}
            className={`day ${k === active ? 'active' : ''}`}
            style={{ borderTopColor: dayColor(k) }}
            onMouseEnter={() => setHoverDay(k)}
            onClick={() => focus(k)}
          >
            <div className="day-title">
              <strong style={{ color: dayColor(k) }}>Day {k + 1}</strong>
              <ReasonBadge day={d} k={k} />
            </div>
            <p className="describe">{describeDay(s, d, avgKm, hasEle)}</p>
            <div className="day-stats">
              <span>{fmtKm(s.distKm)}</span>
              {hasEle && <span>↑ {fmtM(s.gainM)}</span>}
              {hasEle && <span>↓ {fmtM(s.lossM)}</span>}
              <span>{fmtH(s.hours)}</span>
            </div>
            {hasEle && (
              <div className="day-sub">
                {fmtM(s.minEle)} – {fmtM(s.maxEle)} · steepest km {s.steepestPct.toFixed(1)}%
              </div>
            )}
            {s.hikeKm > 0 && (
              <div className="day-hike">
                Hike-a-bike {fmtKm(s.hikeKm)} · {fmtH(s.hikeHours)}
              </div>
            )}
            <DayResupply d={d} k={k} hours={s.hours} />
            {s.waypoints.length > 0 && (
              <div className="day-wps">
                {s.waypoints.slice(0, MAX_CHIPS).map((w) => (
                  <button
                    key={w.id}
                    data-wp={w.id}
                    className={`wp-chip ${w.id === hoverWaypoint ? 'hovered' : ''}`}
                    style={{ background: WAYPOINT_STYLE[w.type].color }}
                    onMouseEnter={() => setHoverWaypoint(w.id)}
                    onMouseLeave={() => setHoverWaypoint(null)}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectWaypoint(w.id);
                    }}
                  >
                    <Icon type={w.type} size={11} />
                    {w.name}
                    {w.offsetM >= 200 && <span className="off"> · {fmtKm(w.offsetM / 1000)}</span>}
                  </button>
                ))}
                {s.waypoints.length > MAX_CHIPS && (
                  <button
                    className="link more-wps"
                    onClick={(e) => {
                      e.stopPropagation();
                      useStore.getState().showDayInManager(k);
                    }}
                  >
                    +{s.waypoints.length - MAX_CHIPS} more
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export { Icon };
