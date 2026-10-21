/**
 * The shared-trip session: creates, joins and leaves shared trips and keeps the store and the
 * shared Yjs document in step. Only one shared trip is open at a time.
 */
import type { TrackPoint } from '../core/types';
import { useStore, type ShareState, type State } from '../store';
import { onRemote, readDoc, writeLocal, SETTING_KEYS, type SharedSlice } from './binding';
import { SYNC_URL, SyncClient } from './client';
import { formatLink, newKey, randomToken, sha256, type ShareKeys } from './crypto';

const SAVED_KEY = 'bikepacking-planner:share'; // keys of the open shared trip, so a reload reconnects

let client: SyncClient | null = null;
let stopRemote: (() => void) | null = null;
let stopLocal: (() => void) | null = null;
let applying = false; // the store is being updated from the shared document
let joined = false; // the shared state has been applied (or we created it)
let trackVersion = ''; // version of the track currently in the store
let latestTrack: { points: TrackPoint[]; version: string } | null = null;
let lastSlice: SharedSlice | null = null; // what the document last agreed with

const sliceOf = (s: State): SharedSlice => ({
  name: s.name,
  limits: s.limits,
  timeModel: s.timeModel,
  hike: s.hike,
  resupply: s.resupply,
  snap: s.snap,
  pinned: s.pinned,
  waypoints: s.waypoints,
  trackVersion,
});

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function save(keys: ShareKeys | null) {
  try {
    if (keys) localStorage.setItem(SAVED_KEY, JSON.stringify(keys));
    else localStorage.removeItem(SAVED_KEY);
  } catch {
    /* storage unavailable: a reload just won't reconnect */
  }
}

export function savedShare(): ShareKeys | null {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    return raw ? (JSON.parse(raw) as ShareKeys) : null;
  } catch {
    return null;
  }
}

export const shareLinks = (keys: ShareKeys) => {
  const base = `${location.origin}${location.pathname}`;
  return { edit: keys.writeToken ? formatLink(base, keys, true) : null, view: formatLink(base, keys, false) };
};

/** Apply the shared document (and track) to the store. */
function applyRemote() {
  if (!client) return;
  const s = useStore.getState();
  const shared = readDoc(client.doc, s.waypoints);
  if (!shared.trackVersion) return; // nothing shared yet
  const patch: Partial<SharedSlice> & { points?: TrackPoint[] } = {};
  if (shared.trackVersion !== trackVersion) {
    if (latestTrack?.version !== shared.trackVersion) return; // wait for the matching track
    patch.points = latestTrack.points;
  }
  for (const k of SETTING_KEYS) {
    if (k === 'trackVersion') continue;
    const v = shared[k];
    if (v !== undefined && !same(v, s[k])) (patch as Record<string, unknown>)[k] = v;
  }
  const wps = shared.waypoints ?? [];
  if (wps.length !== s.waypoints.length || wps.some((w, i) => w !== s.waypoints[i])) patch.waypoints = wps;
  joined = true;
  trackVersion = shared.trackVersion;
  applying = true;
  try {
    if (Object.keys(patch).length) useStore.getState().applyShared(patch);
  } finally {
    applying = false;
  }
  lastSlice = sliceOf(useStore.getState());
}

function start(keys: ShareKeys, create: boolean) {
  stop();
  joined = create;
  latestTrack = null;
  const c = new SyncClient(keys, {
    status: (status, info) => {
      useStore.getState().setShare({ keys, status, canWrite: info.canWrite, peers: info.peers });
      if (status === 'gone') {
        useStore.getState().setNotice({ text: 'This shared trip was deleted or has expired. You still have your copy here.', kind: 'error' });
        leaveShare();
      }
    },
    track: (points, version) => {
      latestTrack = { points, version };
      applyRemote();
    },
    ready: () => applyRemote(),
    problem: (code) => {
      const text: Record<string, string> = {
        'too-large': 'The shared trip is too large to save this change (limit 25 MB).',
        'rate-limited': 'Too many changes too quickly; reconnecting.',
        decrypt: 'Received data that could not be decrypted; check that the link is complete.',
      };
      if (text[code]) useStore.getState().setNotice({ text: text[code], kind: 'error' });
    },
  });
  client = c;
  stopRemote = onRemote(c.doc, () => queueMicrotask(applyRemote));
  stopLocal = useStore.subscribe((s, prev) => {
    if (applying || !joined || !s.share?.canWrite || client !== c) return;
    const changed = !lastSlice || s.points !== prev.points || s.waypoints !== lastSlice.waypoints || SETTING_KEYS.some((k) => k !== 'trackVersion' && s[k] !== lastSlice![k]);
    if (!changed) return; // most store changes are hover and other UI state
    if (s.points !== prev.points) {
      trackVersion = randomToken(8);
      void c.sendTrack(s.points, trackVersion);
    }
    const next = sliceOf(s);
    writeLocal(c.doc, lastSlice, next);
    lastSlice = next;
  });
  if (create) {
    trackVersion = randomToken(8);
    lastSlice = sliceOf(useStore.getState());
    void c.sendTrack(useStore.getState().points, trackVersion);
    writeLocal(c.doc, null, lastSlice);
  }
  useStore.getState().setShare({ keys, status: 'connecting', canWrite: create, peers: 1 });
  save(keys);
  c.start();
}

function stop() {
  stopRemote?.();
  stopLocal?.();
  client?.stop();
  stopRemote = stopLocal = client = null;
  lastSlice = null;
}

/** Upload the open trip as a new shared trip. */
export async function createShare(): Promise<ShareKeys> {
  const writeToken = randomToken();
  const key = await newKey();
  const res = await fetch(`${SYNC_URL}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ writeHash: await sha256(writeToken) }),
  });
  if (res.status === 429) throw new Error('Too many shared trips created from this connection today. Try again tomorrow.');
  if (!res.ok) throw new Error(`The sharing server answered ${res.status}.`);
  const { roomId } = (await res.json()) as { roomId: string };
  const keys = { roomId, key, writeToken };
  start(keys, true);
  return keys;
}

/** Open a shared trip from a link (or reconnect after a reload). */
export function joinShare(keys: ShareKeys) {
  trackVersion = '';
  start(keys, false);
}

/** Disconnect and keep a local copy. */
export function leaveShare() {
  stop();
  save(null);
  useStore.getState().setShare(null);
}

/** Delete the shared trip for everyone (needs the edit link). */
export async function deleteShare(keys: ShareKeys) {
  const res = await fetch(`${SYNC_URL}/rooms/${keys.roomId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${keys.writeToken}` } });
  if (!res.ok && res.status !== 404) throw new Error(`The sharing server answered ${res.status}.`);
  leaveShare();
}

export const hasUnsent = () => client?.unsent ?? false;
export type { ShareState };
