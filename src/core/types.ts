export interface TrackPoint {
  lat: number;
  lon: number;
  ele: number | null;
}

export const WAYPOINT_TYPES = [
  'camp',
  'lodging',
  'water',
  'food',
  'cafe',
  'shop',
  'bike',
  'town',
  'viewpoint',
  'summit',
  'train',
  'ferry',
  'danger',
  'other',
] as const;
export type WaypointType = (typeof WAYPOINT_TYPES)[number];

const TYPE_SET = new Set<string>(WAYPOINT_TYPES);
/** Any value that isn't a known waypoint type (e.g. from a hand-edited or corrupted saved trip) becomes 'other'. */
export const safeType = (t: unknown): WaypointType => (typeof t === 'string' && TYPE_SET.has(t) ? (t as WaypointType) : 'other');

/** A waypoint with a valid type and a string name; other fields are kept as they are. */
export const sanitizeWaypoint = <W extends Waypoint>(w: W): W => ({ ...w, type: safeType(w.type), name: String(w.name ?? '') });

export interface Waypoint {
  id: string;
  lat: number;
  lon: number;
  name: string;
  type: WaypointType;
  typeLocked?: boolean; // set when the user picked the type by hand; stops re-guessing on rename
}

/** Per-point cumulative arrays. Distance in m, elevation in m, time in s. */
export interface Profile {
  dist: Float64Array;
  ele: Float64Array;
  gain: Float64Array;
  loss: Float64Array;
  time: Float64Array;
  hasElevation: boolean;
  hike: Uint8Array; // per point: 1 on hike-a-bike stretches
  hikeDist: Float64Array; // cumulative metres of hike-a-bike
  hikeTime: Float64Array; // cumulative seconds spent on hike-a-bike
}

export interface Limits {
  maxKm: number | null;
  maxGainM: number | null;
  maxHours: number | null;
}

export interface TimeModel {
  mode: 'terrain' | 'average';
  avgKmh: number; // 'average' mode: fixed moving speed, climbing ignored
  flatKmh: number; // 'terrain' mode from here down
  climbMh: number; // vertical metres per hour charged as extra time
  maxKmh: number; // cap on descent speed
}

export interface SnapSettings {
  enabled: boolean;
  radiusKm: number;
  types: WaypointType[];
}

export type LimitReason = 'distance' | 'climbing' | 'time';
export type EndReason = LimitReason | 'waypoint' | 'manual' | 'finish';

export interface Day {
  start: number; // track point index
  end: number; // track point index (inclusive)
  pinned: boolean;
  reason: EndReason;
  limitReason?: LimitReason; // for 'waypoint': the limit the end was pulled back from
  snappedTo?: string;
}

export interface DayStats {
  distKm: number;
  gainM: number;
  lossM: number;
  minEle: number;
  maxEle: number;
  hours: number;
  steepestPct: number;
  hikeKm: number;
  hikeHours: number;
  waypoints: (Waypoint & { offsetM: number })[]; // in this day, sorted along the route
}
