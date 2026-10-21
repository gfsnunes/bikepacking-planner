/**
 * Wire format between the app and the sync server (shared by both sides). Binary frames start with
 * a type byte; control messages are JSON text frames. Payloads are always ciphertext.
 *
 * Client → server: text `hello` first (with the write token if any), then
 *   UPDATE   [1][payload]              a Yjs update; stored and relayed (needs write)
 *   SNAPSHOT [2][u32 upTo][payload]    full state replacing updates up to seq `upTo` (needs write)
 *   TRACK    [3][payload]              the encoded track; replaces the stored one (needs write)
 * Server → client:
 *   UPDATE   [1][u32 seq][payload], TRACK [3][payload], and the control messages below.
 */

export const Frame = { Update: 1, Snapshot: 2, Track: 3 } as const;
export type Frame = (typeof Frame)[keyof typeof Frame];

export type ClientControl = { t: 'hello'; write?: string };

export type ServerControl =
  | { t: 'ready'; seq: number; canWrite: boolean; peers: number } // all stored data has been sent
  | { t: 'ack'; seq: number } // the sender's last UPDATE/SNAPSHOT/TRACK was stored
  | { t: 'peers'; n: number }
  | { t: 'compact'; upTo: number } // please send a SNAPSHOT covering updates up to `upTo`
  | { t: 'error'; code: 'not-found' | 'read-only' | 'too-large' | 'rate-limited' | 'bad-message' }
  | { t: 'deleted' };

export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_ROOM_BYTES = 25 * 1024 * 1024;
export const COMPACT_AFTER = 300; // stored updates before the server asks for a snapshot
export const RETENTION_MS = 90 * 24 * 3600 * 1000;

export function frame(type: Frame, payload: Uint8Array, seq?: number): Uint8Array<ArrayBuffer> {
  const head = seq === undefined ? 1 : 5;
  const out = new Uint8Array(head + payload.length);
  out[0] = type;
  if (seq !== undefined) new DataView(out.buffer).setUint32(1, seq);
  out.set(payload, head);
  return out;
}

/** Split a binary frame; `withSeq` for frames that carry a u32 after the type byte. */
export function unframe(data: Uint8Array, withSeq: boolean): { type: number; seq?: number; payload: Uint8Array<ArrayBuffer> } {
  if (data.length < (withSeq ? 5 : 1)) throw new Error('Short frame');
  const type = data[0];
  if (!withSeq) return { type, payload: data.slice(1) };
  const seq = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1);
  return { type, seq, payload: data.slice(5) };
}

/** Track points as Float64 triples (lat, lon, ele; NaN = no elevation), prefixed by the count. */
export function encodeTrack(points: { lat: number; lon: number; ele: number | null }[]): Uint8Array<ArrayBuffer> {
  const f = new Float64Array(1 + points.length * 3);
  f[0] = points.length;
  points.forEach((p, i) => {
    f[1 + i * 3] = p.lat;
    f[2 + i * 3] = p.lon;
    f[3 + i * 3] = p.ele ?? NaN;
  });
  return new Uint8Array(f.buffer);
}

export function decodeTrack(bytes: Uint8Array): { lat: number; lon: number; ele: number | null }[] {
  if (bytes.byteLength % 8) throw new Error('Bad track');
  const f = new Float64Array(bytes.slice().buffer);
  const n = f[0];
  if (!Number.isInteger(n) || n < 0 || f.length !== 1 + n * 3) throw new Error('Bad track');
  const pts = new Array(n);
  for (let i = 0; i < n; i++) {
    const ele = f[3 + i * 3];
    pts[i] = { lat: f[1 + i * 3], lon: f[2 + i * 3], ele: Number.isNaN(ele) ? null : ele };
  }
  return pts;
}
