import { get, set } from 'idb-keyval';
import { create } from 'zustand';
import { guessType } from './core/gpx';
import { DEFAULT_HIKE, type HikeSettings } from './core/hike';
import { DEFAULT_RESUPPLY, planFood, planWater, type ResupplyPlan, type ResupplySettings } from './core/resupply';
import type { Runs } from './core/viewport';
import type { ShareKeys } from './sync/crypto';
import type { SyncStatus } from './sync/client';
import { DEFAULT_TIME_MODEL, buildProfile } from './core/metrics';
import { pinsAfterDrag, projectWaypoints, splitDays, type ProjectedWaypoint, type ProjectionCache } from './core/splitter';
import { dayStats } from './core/stats';
import { cropPins, cropTrack, reverseTrack } from './core/trim';
import { sanitizeWaypoint, safeType, type Day, type DayStats, type Limits, type Profile, type SnapSettings, type TimeModel, type TrackPoint, type Waypoint } from './core/types';

interface Inputs {
  name: string;
  points: TrackPoint[];
  waypoints: Waypoint[];
  limits: Limits;
  timeModel: TimeModel;
  hike: HikeSettings;
  resupply: ResupplySettings;
  snap: SnapSettings;
  pinned: number[];
  cardRangeKm: number; // day cards list waypoints within this distance of the track
}

interface Derived {
  profile: Profile | null;
  projected: ProjectedWaypoint[];
  days: Day[];
  stats: DayStats[];
  foodPlan: ResupplyPlan | null;
  waterPlan: ResupplyPlan | null;
}

export interface ShareState {
  keys: ShareKeys;
  status: SyncStatus;
  canWrite: boolean; // false for a view-only link, and while (re)joining
  peers: number; // browsers with the trip open, this one included
}

interface Ui {
  hover: number | null; // hovered track point index
  hoverSource: 'map' | 'profile' | null;
  hoverDay: number | null; // day card under the pointer
  hoverWaypoint: string | null; // waypoint under the pointer (map marker or chip)
  selection: [number, number] | null; // profile range being measured (while the pointer is down)
  visibleRuns: Runs | null; // track stretches inside the map view; null = all of it
  selectedWaypoint: string | null;
  addingWaypoint: boolean;
  focusDay: { k: number; nonce: number } | null;
  selectedDay: number | null; // day card clicked: stays emphasised until the map, the card or another card is clicked
  focusPoint: { lat: number; lon: number; nonce: number } | null; // map should fly here
  managerDay: { k: number; nonce: number } | null; // waypoint manager should scroll to this day
  lastDeleted: Waypoint[] | null; // for undo
  notice: { text: string; kind: 'info' | 'error' } | null;
  libraryOpen: boolean; // OpenStreetMap waypoint library dialog
  share: ShareState | null; // the open shared trip, if any
  shareOpen: boolean; // Save & share dialog
  cropOpen: boolean; // Crop route dialog
  lastTrack: { points: TrackPoint[]; pinned: number[]; label: 'crop' | 'reverse' } | null; // for Undo (memory only)
}

interface Actions {
  loadTrack(name: string, points: TrackPoint[], waypoints: Waypoint[]): void;
  replacePoints(points: TrackPoint[]): void;
  setLimits(l: Partial<Limits>): void;
  setTimeModel(t: Partial<TimeModel>): void;
  setHike(h: Partial<HikeSettings>): void;
  setResupply(r: { food?: Partial<ResupplySettings['food']>; water?: Partial<ResupplySettings['water']>; maxDetourKm?: number }): void;
  setSnap(s: Partial<SnapSettings>): void;
  setCardRange(km: number): void;
  dragEnd(k: number, idx: number): void;
  unpinFrom(k: number): void;
  clearPins(): void;
  addWaypoint(w: Waypoint): void;
  updateWaypoint(id: string, w: Partial<Waypoint>): void;
  removeWaypoint(id: string): void;
  removeWaypoints(ids: Iterable<string>): void;
  undoDelete(): void;
  addWaypoints(list: Waypoint[]): void;
  focusWaypoint(id: string): void;
  showDayInManager(k: number): void;
  setNotice(n: Ui['notice']): void;
  setLibraryOpen(open: boolean): void;
  setHover(idx: number | null, source: 'map' | 'profile' | null): void;
  setHoverDay(k: number | null): void;
  setHoverWaypoint(id: string | null): void;
  setSelection(sel: [number, number] | null): void;
  setVisibleRuns(runs: Runs | null): void;
  selectWaypoint(id: string | null): void;
  setAddingWaypoint(on: boolean): void;
  focus(k: number): void;
  toggleDay(k: number): void;
  clearSelectedDay(): void;
  /** Changes that came from the shared trip (bypasses the read-only guard). */
  applyShared(patch: Partial<Inputs>): void;
  setShare(s: ShareState | null): void;
  setShareOpen(open: boolean): void;
  setCropOpen(open: boolean): void;
  cropTo(a: number, b: number): void;
  reverseRoute(): void;
  undoTrackEdit(): void;
}

export type State = Inputs & Derived & Ui & Actions;

const DEFAULT_INPUTS: Omit<Inputs, 'name' | 'points' | 'waypoints'> = {
  limits: { maxKm: 100, maxGainM: null, maxHours: null },
  timeModel: DEFAULT_TIME_MODEL,
  hike: DEFAULT_HIKE,
  resupply: DEFAULT_RESUPPLY,
  snap: { enabled: true, radiusKm: 10, types: ['camp', 'lodging', 'town'] },
  pinned: [],
  cardRangeKm: 5,
};

// Spatial index + per-waypoint projections, reused while the track and positions are unchanged.
const projectionCache: ProjectionCache = { byId: new Map() };

function derive(s: Inputs, prev?: Derived, rebuildProfile = true): Derived {
  if (!s.points.length) return { profile: null, projected: [], days: [], stats: [], foodPlan: null, waterPlan: null };
  const profile = rebuildProfile || !prev?.profile ? buildProfile(s.points, { timeModel: s.timeModel, hike: s.hike }) : prev.profile;
  const projected = projectWaypoints(s.points, s.waypoints, projectionCache);
  const days = splitDays(profile, s.limits, s.pinned, projected, s.snap);
  const stats = days.map((d) => dayStats(profile, d, projected, s.cardRangeKm * 1000));
  const foodPlan = planFood(profile, days, projected, s.resupply);
  const waterPlan = planWater(profile, projected, s.resupply);
  return { profile, projected, days, stats, foodPlan, waterPlan };
}

export const useStore = create<State>()((setState, getState) => {
  const update = (patch: Partial<Inputs>, rebuildProfile = false, remote = false) => {
    // A view-only shared trip: only per-viewer settings may change here.
    if (!remote && getState().share && !getState().share!.canWrite) {
      if (!('cardRangeKm' in patch)) return;
      patch = { cardRangeKm: patch.cardRangeKm };
    }
    const next = { ...getState(), ...patch };
    setState({ ...patch, ...derive(next, getState(), rebuildProfile) });
    const { selectedDay, days } = getState();
    if (selectedDay != null && selectedDay >= days.length) setState({ selectedDay: null });
  };

  return {
    name: '',
    points: [],
    waypoints: [],
    ...DEFAULT_INPUTS,
    profile: null,
    projected: [],
    days: [],
    stats: [],
    foodPlan: null,
    waterPlan: null,
    hover: null,
    hoverSource: null,
    hoverDay: null,
    hoverWaypoint: null,
    selection: null,
    visibleRuns: null,
    selectedWaypoint: null,
    addingWaypoint: false,
    focusDay: null,
    selectedDay: null,
    focusPoint: null,
    managerDay: null,
    lastDeleted: null,
    notice: null,
    libraryOpen: false,
    share: null,
    shareOpen: false,
    cropOpen: false,
    lastTrack: null,

    loadTrack: (name, points, waypoints) => {
      setState({ selectedDay: null, lastTrack: null });
      update({ name, points, waypoints: waypoints.map(sanitizeWaypoint), pinned: [] }, true);
    },
    replacePoints: (points) => update({ points }, true),
    setLimits: (l) => update({ limits: { ...getState().limits, ...l } }),
    setTimeModel: (t) => update({ timeModel: { ...getState().timeModel, ...t } }, true),
    setHike: (h) => update({ hike: { ...getState().hike, ...h } }, true),
    setResupply: (r) => {
      const cur = getState().resupply;
      update({
        resupply: {
          food: { ...cur.food, ...r.food },
          water: { ...cur.water, ...r.water },
          maxDetourKm: r.maxDetourKm ?? cur.maxDetourKm,
        },
      });
    },
    setSnap: (sn) => update({ snap: { ...getState().snap, ...sn } }),
    setCardRange: (cardRangeKm) => update({ cardRangeKm }),
    dragEnd: (k, idx) => {
      const { days, pinned } = getState();
      update({ pinned: pinsAfterDrag(days, pinned, k, idx) });
    },
    unpinFrom: (k) => update({ pinned: getState().pinned.slice(0, k) }),
    clearPins: () => update({ pinned: [] }),
    addWaypoint: (w) => {
      update({ waypoints: [...getState().waypoints, sanitizeWaypoint(w)] });
      setState({ selectedWaypoint: w.id });
    },
    updateWaypoint: (id, w) =>
      update({
        waypoints: getState().waypoints.map((x) => {
          if (x.id !== id) return x;
          const next = { ...x, ...w };
          if (w.type) (next.type = safeType(w.type)), (next.typeLocked = true); // picked by hand
          else if (w.name != null && !x.typeLocked) {
            const guess = guessType(w.name);
            if (guess !== 'other') next.type = guess; // an unrecognised name keeps the current type
          }
          return next;
        }),
      }),
    removeWaypoint: (id) => getState().removeWaypoints([id]),
    removeWaypoints: (ids) => {
      const gone = new Set(ids);
      const { waypoints, selectedWaypoint, hoverWaypoint } = getState();
      const removed = waypoints.filter((x) => gone.has(x.id));
      if (!removed.length) return;
      update({ waypoints: waypoints.filter((x) => !gone.has(x.id)) });
      setState({
        lastDeleted: removed,
        selectedWaypoint: selectedWaypoint && gone.has(selectedWaypoint) ? null : selectedWaypoint,
        hoverWaypoint: hoverWaypoint && gone.has(hoverWaypoint) ? null : hoverWaypoint,
      });
    },
    undoDelete: () => {
      const { lastDeleted, waypoints } = getState();
      if (!lastDeleted) return;
      const present = new Set(waypoints.map((w) => w.id));
      update({ waypoints: [...waypoints, ...lastDeleted.filter((w) => !present.has(w.id))] });
      setState({ lastDeleted: null });
    },
    addWaypoints: (list) => update({ waypoints: [...getState().waypoints, ...list.map(sanitizeWaypoint)] }),
    focusWaypoint: (id) => {
      const w = getState().waypoints.find((x) => x.id === id);
      if (w) setState({ focusPoint: { lat: w.lat, lon: w.lon, nonce: Date.now() }, hoverWaypoint: id });
    },
    showDayInManager: (k) => setState({ managerDay: { k, nonce: Date.now() } }),
    setNotice: (notice) => setState({ notice }),
    setLibraryOpen: (libraryOpen) => setState({ libraryOpen }),
    setHover: (hover, hoverSource) => setState({ hover, hoverSource }),
    setHoverDay: (hoverDay) => setState({ hoverDay }),
    setHoverWaypoint: (hoverWaypoint) => setState({ hoverWaypoint }),
    setSelection: (selection) => setState({ selection }),
    setVisibleRuns: (visibleRuns) => setState({ visibleRuns }),
    selectWaypoint: (selectedWaypoint) => setState({ selectedWaypoint }),
    setAddingWaypoint: (addingWaypoint) => setState({ addingWaypoint }),
    focus: (k) => setState({ focusDay: { k, nonce: Date.now() } }),
    toggleDay: (k) =>
      setState(getState().selectedDay === k ? { selectedDay: null } : { selectedDay: k, focusDay: { k, nonce: Date.now() } }),
    clearSelectedDay: () => setState({ selectedDay: null }),
    applyShared: (patch) => update(patch, 'points' in patch || 'timeModel' in patch || 'hike' in patch, true),
    setShare: (share) => setState({ share }),
    setShareOpen: (shareOpen) => setState({ shareOpen }),
    setCropOpen: (cropOpen) => setState({ cropOpen }),
    cropTo: (a, b) => {
      const { points, pinned } = getState();
      update({ points: cropTrack(points, a, b), pinned: cropPins(pinned, a, b) }, true);
      if (getState().points === points) return; // refused (view-only link)
      setState({ lastTrack: { points, pinned, label: 'crop' }, selectedDay: null, selection: null, hover: null });
    },
    reverseRoute: () => {
      const { points, pinned } = getState();
      update({ points: reverseTrack(points), pinned: [] }, true);
      if (getState().points === points) return;
      setState({ lastTrack: { points, pinned, label: 'reverse' }, selectedDay: null, selection: null, hover: null });
      if (pinned.length) setState({ notice: { text: 'Route reversed. Day ends you placed by hand were reset.', kind: 'info' } });
    },
    undoTrackEdit: () => {
      const last = getState().lastTrack;
      if (!last) return;
      const before = getState().points;
      update({ points: last.points, pinned: last.pinned }, true);
      if (getState().points !== before) setState({ lastTrack: null, selectedDay: null, selection: null, hover: null });
    },
  };
});

// ---- Persistence: the last trip is autosaved to IndexedDB (per browser only). ----
const KEY = 'bikepacking-planner:last-trip';
// Settings written synchronously on page close, because an IndexedDB write started while the page
// unloads does not complete. Applied on top of the IndexedDB copy if it belongs to the same track.
const PENDING_KEY = 'bikepacking-planner:pending';
type Pending = Pick<Inputs, 'limits' | 'timeModel' | 'hike' | 'resupply' | 'snap' | 'pinned' | 'cardRangeKm'> & Partial<Pick<Inputs, 'waypoints'>> & { track: string };
const trackId = (name: string, points: TrackPoint[]) => `${name}|${points.length}`;

let restoring: Promise<void> | undefined;
/** Restore the last trip once per page load (React StrictMode runs effects twice in development). */
export function restoreLastTrip() {
  return (restoring ??= doRestore());
}

async function doRestore() {
  try {
    let saved = (await get(KEY)) as Inputs | undefined;
    if (!saved?.points?.length) return;
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      localStorage.removeItem(PENDING_KEY);
      const pending = raw ? (JSON.parse(raw) as Pending) : null;
      if (pending && pending.track === trackId(saved.name, saved.points)) {
        const { track: _track, ...settings } = pending;
        saved = { ...saved, ...settings };
      }
    } catch {
      /* no pending settings */
    }
    const s = useStore.getState();
    // Merge with defaults so trips saved by older versions pick up new settings.
    const inputs: Inputs = {
      ...DEFAULT_INPUTS,
      ...saved,
      timeModel: { ...DEFAULT_INPUTS.timeModel, ...saved.timeModel },
      hike: { ...DEFAULT_INPUTS.hike, ...saved.hike },
      resupply: {
        food: { ...DEFAULT_RESUPPLY.food, ...saved.resupply?.food },
        water: { ...DEFAULT_RESUPPLY.water, ...saved.resupply?.water },
        maxDetourKm: saved.resupply?.maxDetourKm ?? DEFAULT_RESUPPLY.maxDetourKm,
      },
      snap: { ...DEFAULT_INPUTS.snap, ...saved.snap },
    };
    inputs.waypoints = (inputs.waypoints ?? []).map(sanitizeWaypoint);
    inputs.snap.types = inputs.snap.types.map(safeType);
    useStore.setState({ ...inputs, ...derive(inputs, s, true) });
  } catch {
    /* storage unavailable: start empty */
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let version = 0; // bumped on every change
let savedVersion = 0; // last version confirmed written to IndexedDB
function save() {
  timer = undefined;
  const v = version;
  const { name, points, waypoints, limits, timeModel, hike, resupply, snap, pinned, cardRangeKm } = useStore.getState();
  set(KEY, { name, points, waypoints, limits, timeModel, hike, resupply, snap, pinned, cardRangeKm })
    .then(() => {
      savedVersion = Math.max(savedVersion, v);
      if (savedVersion !== version) return;
      try {
        localStorage.removeItem(PENDING_KEY); // IndexedDB is now current
      } catch {
        /* storage unavailable */
      }
    })
    .catch(() => {});
}
useStore.subscribe((s, prev) => {
  if (!s.points.length) return;
  const changed = (['name', 'points', 'waypoints', 'limits', 'timeModel', 'hike', 'resupply', 'snap', 'pinned', 'cardRangeKm'] as const).some(
    (k) => s[k] !== prev[k],
  );
  if (!changed) return;
  version++;
  clearTimeout(timer);
  timer = setTimeout(save, 500);
});
// Don't lose a change made just before the tab is closed or reloaded: either still waiting for the
// debounce, or written but not yet confirmed.
const flush = () => {
  if (savedVersion === version) return;
  if (timer !== undefined) (clearTimeout(timer), save());
  try {
    const { name, points, waypoints, limits, timeModel, hike, resupply, snap, pinned, cardRangeKm } = useStore.getState();
    const pending: Pending = { track: trackId(name, points), waypoints, limits, timeModel, hike, resupply, snap, pinned, cardRangeKm };
    let json = JSON.stringify(pending);
    // Keep well inside the ~5 MB localStorage quota; a huge waypoint list is left to IndexedDB.
    if (json.length > 2_000_000) {
      const { waypoints: _omit, ...rest } = pending;
      json = JSON.stringify(rest);
    }
    localStorage.setItem(PENDING_KEY, json);
  } catch {
    /* storage unavailable */
  }
};
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
