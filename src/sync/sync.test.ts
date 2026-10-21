import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DEFAULT_HIKE } from '../core/hike';
import { DEFAULT_TIME_MODEL } from '../core/metrics';
import { DEFAULT_RESUPPLY } from '../core/resupply';
import type { Waypoint } from '../core/types';
import { LOCAL, onRemote, readDoc, writeLocal, type SharedSlice } from './binding';
import { decrypt, encrypt, formatLink, importKey, newKey, parseLink, randomToken, sha256 } from './crypto';
import { Frame, decodeTrack, encodeTrack, frame, unframe } from './protocol';

const wp = (id: string, name = id): Waypoint => ({ id, lat: 61, lon: 16, name, type: 'camp' });
const slice = (over: Partial<SharedSlice> = {}): SharedSlice => ({
  name: 'Trip',
  limits: { maxKm: 100, maxGainM: null, maxHours: null },
  timeModel: DEFAULT_TIME_MODEL,
  hike: DEFAULT_HIKE,
  resupply: DEFAULT_RESUPPLY,
  snap: { enabled: true, radiusKm: 10, types: ['camp'] },
  pinned: [],
  waypoints: [],
  trackVersion: 'v1',
  ...over,
});

/** Two documents joined by an in-memory relay, like two browsers through the server. */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'relay' && Y.applyUpdate(b, u, 'relay'));
  b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'relay' && Y.applyUpdate(a, u, 'relay'));
  return { a, b };
}

describe('share crypto', () => {
  it('round-trips and rejects tampering or the wrong key', async () => {
    const key = await importKey(await newKey());
    const data = new TextEncoder().encode('Bollnäs camp 61.35,16.39');
    const ct = await encrypt(key, data);
    expect(new TextDecoder().decode(await decrypt(key, ct))).toBe('Bollnäs camp 61.35,16.39');
    expect(new TextDecoder().decode(ct)).not.toContain('Bollnäs');
    const bad = ct.slice();
    bad[bad.length - 1] ^= 1;
    await expect(decrypt(key, bad)).rejects.toThrow();
    await expect(decrypt(await importKey(await newKey()), ct)).rejects.toThrow();
  });

  it('formats and parses edit and view links', async () => {
    const k = { roomId: randomToken(), key: await newKey(), writeToken: randomToken() };
    const edit = formatLink('https://x.dev/?a=1#old', k, true);
    const view = formatLink('https://x.dev/', k, false);
    expect(edit.startsWith('https://x.dev/?a=1#trip=')).toBe(true);
    expect(parseLink(new URL(edit).hash)).toEqual(k);
    expect(parseLink(new URL(view).hash)).toEqual({ ...k, writeToken: undefined });
    expect(parseLink('#trip=short&k=x')).toBeNull();
    expect(parseLink('')).toBeNull();
    expect(await sha256('a')).toBe(await sha256('a'));
    expect(await sha256('a')).not.toBe(await sha256('b'));
  });
});

describe('protocol', () => {
  it('frames with and without a sequence number', () => {
    const p = new Uint8Array([9, 8, 7]);
    expect(unframe(frame(Frame.Update, p, 70000), true)).toEqual({ type: 1, seq: 70000, payload: p });
    expect(unframe(frame(Frame.Track, p), false)).toEqual({ type: 3, payload: p });
  });

  it('encodes a track, keeping missing elevations', () => {
    const pts = [
      { lat: 61.3, lon: 16.4, ele: 120.5 },
      { lat: 61.31, lon: 16.41, ele: null },
    ];
    expect(decodeTrack(encodeTrack(pts))).toEqual(pts);
    expect(() => decodeTrack(new Uint8Array(12))).toThrow();
  });
});

describe('binding', () => {
  it('syncs settings and waypoints between two documents', () => {
    const { a, b } = pair();
    const s1 = slice({ waypoints: [wp('w1'), wp('w2')] });
    writeLocal(a, null, s1);
    expect(readDoc(b)).toMatchObject({ name: 'Trip', limits: s1.limits, trackVersion: 'v1' });
    expect(readDoc(b).waypoints!.map((w) => w.id)).toEqual(['w1', 'w2']);

    const s2 = { ...s1, limits: { ...s1.limits, maxKm: 80 }, waypoints: [s1.waypoints[0]] };
    writeLocal(a, s1, s2);
    expect(readDoc(b).limits!.maxKm).toBe(80);
    expect(readDoc(b).waypoints!.map((w) => w.id)).toEqual(['w1']);
  });

  it('merges concurrent edits to different waypoints', () => {
    const { a, b } = pair();
    const base = slice({ waypoints: [wp('w1'), wp('w2')] });
    writeLocal(a, null, base);
    // Disconnected edits: a renames w1, b moves w2 and adds w3.
    const offA = new Y.Doc();
    const offB = new Y.Doc();
    Y.applyUpdate(offA, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(offB, Y.encodeStateAsUpdate(b));
    writeLocal(offA, base, { ...base, waypoints: [{ ...base.waypoints[0], name: 'Lake camp' }, base.waypoints[1]] });
    writeLocal(offB, base, { ...base, waypoints: [base.waypoints[0], { ...base.waypoints[1], lat: 62 }, wp('w3')] });
    Y.applyUpdate(offA, Y.encodeStateAsUpdate(offB));
    Y.applyUpdate(offB, Y.encodeStateAsUpdate(offA));
    for (const d of [offA, offB]) {
      const w = readDoc(d).waypoints!;
      expect(w.map((x) => [x.id, x.name, x.lat])).toEqual([
        ['w1', 'Lake camp', 61],
        ['w2', 'w2', 62],
        ['w3', 'w3', 61],
      ]);
    }
  });

  it('keeps the local waypoint order and reports only remote changes', () => {
    const { a, b } = pair();
    const s = slice({ waypoints: [wp('w1'), wp('w2'), wp('w3')] });
    let remoteA = 0;
    let remoteB = 0;
    onRemote(a, () => remoteA++);
    onRemote(b, () => remoteB++);
    writeLocal(a, null, s);
    expect([remoteA, remoteB]).toEqual([0, 1]);
    const local = [wp('w3'), wp('w1'), wp('w2')];
    expect(readDoc(b, local).waypoints!.map((w) => w.id)).toEqual(['w3', 'w1', 'w2']);
    expect(LOCAL.toString()).toBe('Symbol(local)');
  });

  it('writes nothing when nothing shared changed', () => {
    const d = new Y.Doc();
    const s = slice();
    writeLocal(d, null, s);
    let n = 0;
    d.on('update', () => n++);
    writeLocal(d, s, { ...s });
    expect(n).toBe(0);
  });
});
