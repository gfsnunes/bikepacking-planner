/**
 * End-to-end encryption for shared trips. The AES-GCM key and the write token live only in the
 * link's fragment (after `#`), which browsers never send to a server; the sync server stores and
 * relays ciphertext it cannot read, and keeps only a SHA-256 hash of the write token.
 */

export interface ShareKeys {
  roomId: string; // chosen by the server, 128 bits
  key: string; // AES-GCM 256 raw key, base64url
  writeToken?: string; // 128 bits, base64url; absent in a view-only link
}

const IV_BYTES = 12;
const B64URL = /^[A-Za-z0-9_-]+$/;

export function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const randomToken = (bytes = 16) => toB64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function newKey(): Promise<string> {
  const k = (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])) as CryptoKey;
  return toB64url(new Uint8Array((await crypto.subtle.exportKey('raw', k)) as ArrayBuffer));
}

export function importKey(key: string): Promise<CryptoKey> {
  const raw = fromB64url(key);
  if (raw.length !== 32) throw new Error('Bad key length');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** IV (12 bytes) followed by the ciphertext and tag. */
export async function encrypt(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv);
  out.set(ct, IV_BYTES);
  return out;
}

/** Throws if the data was tampered with or encrypted under another key. */
export async function decrypt(key: CryptoKey, blob: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (blob.length <= IV_BYTES) throw new Error('Ciphertext too short');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, IV_BYTES) }, key, blob.subarray(IV_BYTES));
  return new Uint8Array(pt);
}

export async function sha256(s: string): Promise<string> {
  return toB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

export function formatLink(base: string, k: ShareKeys, withWrite: boolean): string {
  const parts = [`trip=${k.roomId}`, `k=${k.key}`];
  if (withWrite && k.writeToken) parts.push(`w=${k.writeToken}`);
  return `${base.replace(/#.*$/, '')}#${parts.join('&')}`;
}

/** Parse a `#trip=…&k=…[&w=…]` fragment; null when it isn't a (well-formed) share link. */
export function parseLink(hash: string): ShareKeys | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const roomId = q.get('trip');
  const key = q.get('k');
  const writeToken = q.get('w') ?? undefined;
  const ok = (s: string | null | undefined, len: number) => !!s && s.length === len && B64URL.test(s);
  if (!ok(roomId, 22) || !ok(key, 43)) return null;
  if (writeToken !== undefined && !ok(writeToken, 22)) return null;
  return { roomId: roomId!, key: key!, writeToken };
}
