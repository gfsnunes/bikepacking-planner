/**
 * One live connection to a shared trip. Encrypts outgoing Yjs updates (batched, so a drag sends a
 * few messages rather than hundreds), keeps them until the server acknowledges them and re-sends
 * after a reconnect, so edits made while offline are not lost while the page stays open.
 */
import * as Y from 'yjs';
import { LOCAL } from './binding';
import { decrypt, encrypt, importKey, type ShareKeys } from './crypto';
import { Frame, decodeTrack, encodeTrack, frame, unframe, type ServerControl } from './protocol';
import type { TrackPoint } from '../core/types';

// Set in .env.production once the sync Worker is deployed; local development uses `wrangler dev` on 8790.
// Empty means sharing is not available in this build.
export const SYNC_URL: string = import.meta.env.VITE_SYNC_URL ?? (import.meta.env.DEV ? 'http://localhost:8790' : '');
const BATCH_MS = 150;
const MAX_BACKOFF_MS = 30_000;

export type SyncStatus = 'connecting' | 'live' | 'offline' | 'gone';

export interface SyncEvents {
  /** Connection state, write permission and how many browsers have the trip open (incl. this one). */
  status(s: SyncStatus, info: { canWrite: boolean; peers: number }): void;
  /** A track arrived, tagged with the version the shared settings refer to. */
  track(points: TrackPoint[], version: string): void;
  /** Everything stored on the server has been received (after every (re)connect). */
  ready(): void;
  /** A write was refused or failed. */
  problem(code: string): void;
}

export class SyncClient {
  readonly doc = new Y.Doc();
  private keys: ShareKeys;
  private events: SyncEvents;
  private key: Promise<CryptoKey>;
  private ws: WebSocket | null = null;
  private outbox: Uint8Array<ArrayBuffer>[] = []; // encrypted frames sent or waiting, until acknowledged
  private inFlight = 0; // how many of `outbox` were sent on the current socket
  private batch: Uint8Array[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private backoff = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private ready = false;
  private canWrite = false;
  private peers = 1;
  private compacting = false;
  private chain: Promise<void> = Promise.resolve(); // keeps decryption in arrival order

  constructor(keys: ShareKeys, events: SyncEvents) {
    this.keys = keys;
    this.events = events;
    this.key = importKey(keys.key);
    this.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== LOCAL) return;
      this.batch.push(u);
      this.batchTimer ??= setTimeout(() => this.flushBatch(), BATCH_MS);
    });
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.batchTimer);
    this.ws?.close(1000, 'leave');
    this.ws = null;
    this.doc.destroy();
  }

  /** Upload a (new) track under `version`; it replaces the stored one. */
  async sendTrack(points: TrackPoint[], version: string) {
    const v = new TextEncoder().encode(version);
    const body = encodeTrack(points);
    const plain = new Uint8Array(1 + v.length + body.length);
    plain[0] = v.length;
    plain.set(v, 1);
    plain.set(body, 1 + v.length);
    this.enqueue(frame(Frame.Track, await encrypt(await this.key, plain)));
  }

  /** True while local edits are still waiting for the server. */
  get unsent() {
    return this.outbox.length > 0 || this.batch.length > 0;
  }

  private async flushBatch() {
    this.batchTimer = undefined;
    // While offline, keep merging into one batch rather than queueing hundreds of small messages.
    if (!this.batch.length || !this.ready) return;
    const merged = Y.mergeUpdates(this.batch) as Uint8Array<ArrayBuffer>;
    this.batch = [];
    this.enqueue(frame(Frame.Update, await encrypt(await this.key, merged)));
  }

  private enqueue(f: Uint8Array<ArrayBuffer>) {
    this.outbox.push(f);
    this.pump();
  }

  private pump() {
    if (!this.ready || !this.canWrite || this.ws?.readyState !== WebSocket.OPEN) return;
    while (this.inFlight < this.outbox.length) this.ws.send(this.outbox[this.inFlight++]);
  }

  private setStatus(s: SyncStatus) {
    this.events.status(s, { canWrite: this.canWrite, peers: this.peers });
  }

  private connect() {
    if (this.stopped) return;
    this.ready = false;
    this.inFlight = 0;
    this.setStatus('connecting');
    const ws = new WebSocket(`${SYNC_URL.replace(/^http/, 'ws')}/rooms/${this.keys.roomId}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', write: this.keys.writeToken }));
    ws.onmessage = (e) => {
      const data = e.data;
      this.chain = this.chain.then(() => this.receive(data)).catch(() => this.events.problem('decrypt'));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.setStatus('offline');
      this.retryTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };
  }

  private async receive(data: string | ArrayBuffer) {
    if (typeof data !== 'string') {
      const bytes = new Uint8Array(data);
      const f = unframe(bytes, bytes[0] === Frame.Update);
      const plain = await decrypt(await this.key, f.payload);
      if (f.type === Frame.Update) Y.applyUpdate(this.doc, plain, 'remote');
      else if (f.type === Frame.Track) {
        const n = plain[0];
        this.events.track(decodeTrack(plain.subarray(1 + n)), new TextDecoder().decode(plain.subarray(1, 1 + n)));
      }
      return;
    }
    const c = JSON.parse(data) as ServerControl;
    switch (c.t) {
      case 'ready':
        this.ready = true;
        this.canWrite = c.canWrite;
        this.peers = c.peers;
        this.backoff = 1000;
        this.events.ready();
        this.setStatus('live');
        this.pump(); // re-send anything not acknowledged before the connection dropped
        void this.flushBatch(); // edits made while offline
        break;
      case 'ack':
        this.outbox.shift();
        this.inFlight = Math.max(0, this.inFlight - 1);
        break;
      case 'peers':
        this.peers = c.n;
        this.setStatus('live');
        break;
      case 'compact':
        if (this.compacting || !this.canWrite) break;
        this.compacting = true;
        try {
          const state = Y.encodeStateAsUpdate(this.doc) as Uint8Array<ArrayBuffer>;
          this.enqueue(frame(Frame.Snapshot, await encrypt(await this.key, state), c.upTo));
        } finally {
          this.compacting = false;
        }
        break;
      case 'error':
        if (c.code === 'not-found') {
          this.stopped = true;
          this.setStatus('gone');
        } else if (c.code === 'read-only') {
          this.canWrite = false;
          this.outbox = [];
          this.inFlight = 0;
          this.setStatus('live');
        } else if (this.inFlight > 0 && (c.code === 'too-large' || c.code === 'bad-message')) {
          this.outbox.shift(); // the server refused this write instead of acknowledging it
          this.inFlight--;
        }
        this.events.problem(c.code);
        break;
      case 'deleted':
        this.stopped = true;
        this.setStatus('gone');
        break;
    }
  }
}
