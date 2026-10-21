/**
 * Maps the shareable part of a trip onto a Yjs document and back. Settings are one map entry per
 * group and waypoints one entry per id, so concurrent edits merge per setting group and per
 * waypoint (last writer wins within an entry). The track itself travels separately (protocol.ts).
 */
import * as Y from 'yjs';
import type { HikeSettings } from '../core/hike';
import type { ResupplySettings } from '../core/resupply';
import type { Limits, SnapSettings, TimeModel, Waypoint } from '../core/types';
import { sanitizeWaypoint } from '../core/types';

export interface SharedSlice {
  name: string;
  limits: Limits;
  timeModel: TimeModel;
  hike: HikeSettings;
  resupply: ResupplySettings;
  snap: SnapSettings;
  pinned: number[];
  waypoints: Waypoint[];
  trackVersion: string; // changes whenever the track itself is replaced
}

export const SETTING_KEYS = ['name', 'limits', 'timeModel', 'hike', 'resupply', 'snap', 'pinned', 'trackVersion'] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

/** Transaction origin for changes made in this browser; remote changes arrive with other origins. */
export const LOCAL = Symbol('local');

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
// Sanitised copies of waypoint entries, so unchanged waypoints keep their identity between reads.
const clean = new WeakMap<object, Waypoint>();
const settingsOf = (doc: Y.Doc) => doc.getMap<unknown>('settings');
const waypointsOf = (doc: Y.Doc) => doc.getMap<Waypoint>('waypoints');

/** Write what changed between `prev` and `next` (compared by reference, as the store replaces what it changes). */
export function writeLocal(doc: Y.Doc, prev: SharedSlice | null, next: SharedSlice) {
  doc.transact(() => {
    const settings = settingsOf(doc);
    for (const k of SETTING_KEYS) if (!prev || prev[k] !== next[k]) settings.set(k, plain(next[k]));
    if (prev?.waypoints === next.waypoints) return;
    const map = waypointsOf(doc);
    const before = new Map((prev?.waypoints ?? []).map((w) => [w.id, w]));
    const ids = new Set<string>();
    for (const w of next.waypoints) {
      ids.add(w.id);
      if (before.get(w.id) !== w || !map.has(w.id)) map.set(w.id, plain(w));
    }
    for (const id of [...map.keys()]) if (!ids.has(id)) map.delete(id);
  }, LOCAL);
}

/**
 * Read the shared state. Waypoints keep the order of `order` (the local list) where they exist,
 * new ones are appended, so a remote edit doesn't reshuffle the local list.
 */
export function readDoc(doc: Y.Doc, order: Waypoint[] = []): Partial<SharedSlice> {
  const settings = settingsOf(doc);
  const out: Partial<SharedSlice> = {};
  for (const k of SETTING_KEYS) {
    const v = settings.get(k);
    if (v !== undefined) (out as Record<SettingKey, unknown>)[k] = v;
  }
  const map = waypointsOf(doc);
  const list: Waypoint[] = [];
  const seen = new Set<string>();
  for (const w of order) {
    const x = map.get(w.id);
    if (x) (list.push(x), seen.add(w.id));
  }
  for (const [id, x] of map) if (!seen.has(id)) list.push(x);
  out.waypoints = list.map((w) => {
    let c = clean.get(w);
    if (!c) clean.set(w, (c = sanitizeWaypoint(w)));
    return c;
  });
  return out;
}

/** Call `cb` after every change that didn't come from this browser. Returns an unsubscribe function. */
export function onRemote(doc: Y.Doc, cb: () => void): () => void {
  const h = (_u: Uint8Array, origin: unknown) => {
    if (origin !== LOCAL) cb();
  };
  doc.on('update', h);
  return () => doc.off('update', h);
}
