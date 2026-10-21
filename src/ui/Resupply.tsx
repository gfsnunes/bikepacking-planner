import type { ResupplyPlan, Stop } from '../core/resupply';
import { waterRangeHours } from '../core/resupply';
import type { Day, WaypointType } from '../core/types';
import { useStore } from '../store';
import { fmtH } from './colors';
import { Icon } from './DayPanel';

const FOOD_SOURCES: { label: string; types: WaypointType[] }[] = [
  { label: 'Grocery stores', types: ['shop'] },
  { label: 'Cafés & restaurants', types: ['cafe', 'food'] },
];
const WATER_ALSO: WaypointType[] = ['shop', 'cafe', 'food'];

function Num(props: { label: string; unit: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="row">
      {props.label}
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Math.min(props.max, Math.max(props.min, Number(e.target.value) || props.min)))}
      />
      <span className="unit">{props.unit}</span>
    </label>
  );
}

/** Settings: how often to buy food, water carried and drunk, how far off route a stop may be. */
export function ResupplySection() {
  const r = useStore((s) => s.resupply);
  const totalHours = useStore((s) => (s.profile ? s.profile.time[s.profile.time.length - 1] / 3600 : 0));
  const { setResupply, setLibraryOpen } = useStore.getState();
  const rangeH = waterRangeHours(r.water);
  const waterAlso = WATER_ALSO.every((t) => r.water.types.includes(t));

  return (
    <details>
      <summary>Resupply &amp; water</summary>
      <p className="hint">
        Plans stops from the waypoints in your trip: the last one you pass before you run out. Add shops and water points from the{' '}
        <button className="link" onClick={() => setLibraryOpen(true)}>
          Waypoint library
        </button>
        .
      </p>

      <label className="row">
        <input type="checkbox" checked={r.food.enabled} onChange={(e) => setResupply({ food: { enabled: e.target.checked } })} />
        <strong>Food</strong>
      </label>
      <Num label="Buy food at least every" unit="days" value={r.food.days} min={0.5} max={14} step={0.5} onChange={(v) => setResupply({ food: { days: v } })} />
      <div className="chips">
        {FOOD_SOURCES.map((src) => {
          const on = src.types.every((t) => r.food.types.includes(t));
          return (
            <label key={src.label} className="chip">
              <input
                type="checkbox"
                checked={on}
                onChange={(e) =>
                  setResupply({
                    food: {
                      types: e.target.checked ? [...new Set([...r.food.types, ...src.types])] : r.food.types.filter((t) => !src.types.includes(t)),
                    },
                  })
                }
              />
              <Icon type={src.types[0]} />
              {src.label}
            </label>
          );
        })}
      </div>

      <label className="row water-head">
        <input type="checkbox" checked={r.water.enabled} onChange={(e) => setResupply({ water: { enabled: e.target.checked } })} />
        <strong>Water</strong>
      </label>
      <Num label="Water you carry" unit="L" value={r.water.capacityL} min={0.5} max={20} step={0.25} onChange={(v) => setResupply({ water: { capacityL: v } })} />
      <Num label="You drink about" unit="L/h" value={r.water.litresPerHour} min={0.1} max={3} step={0.05} onChange={(v) => setResupply({ water: { litresPerHour: v } })} />
      <label className="row">
        <input
          type="checkbox"
          checked={waterAlso}
          onChange={(e) =>
            setResupply({ water: { types: e.target.checked ? ['water', ...WATER_ALSO] : ['water'] } })
          }
        />
        Also refill at shops, cafés &amp; restaurants
      </label>
      <p className="calc">
        One fill lasts <strong>{fmtH(rangeH)}</strong> of riding.
        {totalHours > 0 && (
          <>
            {' '}
            For the whole route (riding time {fmtH(totalHours)}) that's about <strong>{(totalHours * r.water.litresPerHour).toFixed(1)} L</strong>.
          </>
        )}
      </p>
      <p className="hint">
        How much you drink varies a lot with heat, effort and person; set your own rate. Many people find drinking more than about 1 L per hour
        uncomfortable, and over 1.2 L/h counts as a very high sweat rate. Riding time comes from your time-estimate settings.
      </p>

      <Num label="A stop counts if it's within" unit="km" value={r.maxDetourKm} min={0.1} max={10} step={0.5} onChange={(v) => setResupply({ maxDetourKm: v })} />
    </details>
  );
}

const inDay = (d: Day, k: number, idx: number) => idx <= d.end && (idx > d.start || (k === 0 && idx >= d.start));
const overlaps = (d: Day, from: number, to: number) => from < d.end && to > d.start;

function StopList({ stops, kind }: { stops: Stop[]; kind: 'food' | 'water' }) {
  const profile = useStore((s) => s.profile);
  if (!profile || !stops.length) return null;
  const shown = stops.slice(0, 3);
  return (
    <div className={`resupply-line ${kind}`}>
      <Icon type={kind === 'food' ? 'shop' : 'water'} size={11} />
      <span>
        {kind === 'food' ? 'Buy food: ' : `Water ×${stops.length}: `}
        {shown.map((s, i) => (
          <span key={s.waypointId}>
            {i > 0 && ', '}
            <button
              className="link"
              onClick={(e) => {
                e.stopPropagation();
                useStore.getState().focusWaypoint(s.waypointId);
              }}
            >
              {s.name}
            </button>{' '}
            <span className="muted">km {(profile.dist[s.idx] / 1000).toFixed(0)}</span>
          </span>
        ))}
        {stops.length > shown.length && <span className="muted"> +{stops.length - shown.length}</span>}
      </span>
    </div>
  );
}

function GapWarnings({ plan, d, label }: { plan: ResupplyPlan; d: Day; label: string }) {
  const profile = useStore((s) => s.profile);
  if (!profile) return null;
  const gaps = plan.gaps.filter((g) => overlaps(d, g.fromIdx, g.toIdx));
  return (
    <>
      {gaps.map((g, i) => (
        <div key={i} className="resupply-gap">
          No {label} within reach: km {(profile.dist[g.fromIdx] / 1000).toFixed(0)}–{(profile.dist[g.toIdx] / 1000).toFixed(0)}
        </div>
      ))}
    </>
  );
}

/** Resupply lines on a day card. */
export function DayResupply({ d, k, hours }: { d: Day; k: number; hours: number }) {
  const food = useStore((s) => s.foodPlan);
  const water = useStore((s) => s.waterPlan);
  const lph = useStore((s) => s.resupply.water.litresPerHour);
  if (!food && !water) return null;
  return (
    <div className="day-resupply">
      {food && <StopList kind="food" stops={food.stops.filter((s) => inDay(d, k, s.idx))} />}
      {food && <GapWarnings plan={food} d={d} label="food stop" />}
      {water && <StopList kind="water" stops={water.stops.filter((s) => inDay(d, k, s.idx))} />}
      {water && <GapWarnings plan={water} d={d} label="water" />}
      {water && <div className="day-sub">Drink about {(hours * lph).toFixed(1)} L today</div>}
    </div>
  );
}

/** Items for the trip summary bar. */
export function ResupplySummary() {
  const food = useStore((s) => s.foodPlan);
  const water = useStore((s) => s.waterPlan);
  if (!food && !water) return null;
  const gaps = (food?.gaps.length ?? 0) + (water?.gaps.length ?? 0);
  return (
    <>
      {food && (
        <div>
          <dt>Food stops</dt>
          <dd>{food.stops.length}</dd>
        </div>
      )}
      {water && (
        <div>
          <dt>Water refills</dt>
          <dd>{water.stops.length}</dd>
        </div>
      )}
      {gaps > 0 && (
        <div className="hike">
          <dt>Resupply gaps</dt>
          <dd>{gaps}</dd>
        </div>
      )}
    </>
  );
}

