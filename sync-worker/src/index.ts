/**
 * bikepacking-sync: relays and stores shared trips. Everything a trip contains arrives encrypted by
 * the browser (src/sync/crypto.ts); this server never sees a key, only ciphertext, a room id and a
 * SHA-256 hash of the write token.
 *
 *   POST   /rooms            { writeHash } → { roomId }       create a shared trip (rate-limited per IP)
 *   GET    /rooms/:id/ws     WebSocket (protocol in src/sync/protocol.ts)
 *   DELETE /rooms/:id        Authorization: Bearer <write token>
 *
 * A trip is deleted 90 days after its last write (an alarm reset on every write).
 */
import { DurableObject } from 'cloudflare:workers';
import { randomToken, sha256 } from '../../src/sync/crypto';
import {
  COMPACT_AFTER,
  Frame,
  MAX_MESSAGE_BYTES,
  MAX_ROOM_BYTES,
  RETENTION_MS,
  frame,
  unframe,
  type ClientControl,
  type ServerControl,
} from '../../src/sync/protocol';

const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const CREATES_PER_DAY = 20;
const TRACK_CHUNK = 1_900_000; // SQLite rows are capped at 2 MB
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 200; // messages per connection per window

type Bindings = Omit<Env, 'ROOMS' | 'LIMITER'> & {
  ROOMS: DurableObjectNamespace<TripRoom>;
  LIMITER: DurableObjectNamespace<Limiter>;
  RETENTION_MS?: string; // shorter retention for tests
  IP_SALT?: string; // secret, so stored hashes can't be matched to IPs
};

const json = (body: unknown, status: number, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export default {
  async fetch(req: Request, env: Bindings): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') ?? '';
    const allowed = env.ALLOWED_ORIGINS.split(',').includes(origin);
    const cors: Record<string, string> = allowed
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, DELETE',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          Vary: 'Origin',
        }
      : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    // Only the app may use this server (browsers always send Origin on these requests).
    if (!allowed) return new Response('Forbidden', { status: 403 });

    if (url.pathname === '/rooms' && req.method === 'POST') {
      const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
      const limiter = env.LIMITER.get(env.LIMITER.idFromName(await sha256(`${env.IP_SALT ?? ''}|${ip}`)));
      if (!(await limiter.take(CREATES_PER_DAY))) return json({ error: 'rate-limited' }, 429, cors);
      let body: { writeHash?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: 'bad-request' }, 400, cors);
      }
      if (typeof body.writeHash !== 'string' || !HASH.test(body.writeHash)) return json({ error: 'bad-request' }, 400, cors);
      const roomId = randomToken();
      await env.ROOMS.get(env.ROOMS.idFromName(roomId)).create(body.writeHash, Number(env.RETENTION_MS) || RETENTION_MS);
      return json({ roomId }, 201, cors);
    }

    const m = url.pathname.match(/^\/rooms\/([^/]+)(\/ws)?$/);
    if (!m || !ROOM_ID.test(m[1])) return new Response('Not found', { status: 404, headers: cors });
    const room = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    if (m[2]) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      return room.fetch(req);
    }
    if (req.method === 'DELETE') {
      const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
      return (await room.destroy(token)) ? new Response(null, { status: 204, headers: cors }) : json({ error: 'forbidden' }, 403, cors);
    }
    return new Response('Not found', { status: 404, headers: cors });
  },
} satisfies ExportedHandler<Bindings>;

interface Attachment {
  hello: boolean;
  canWrite: boolean;
  win: number; // start of the rate window
  n: number; // messages in it
}

export class TripRoom extends DurableObject<Bindings> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.schema();
  }

  private schema() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS track (part INTEGER PRIMARY KEY, data BLOB NOT NULL);`);
  }

  private meta(k: string): string | undefined {
    return this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v;
  }

  private bytesStored(): number {
    const r = this.sql
      .exec<{ n: number }>('SELECT (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM updates) + (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM track) AS n')
      .one();
    return r.n;
  }

  private async touch() {
    const retention = Number(this.meta('retention')) || RETENTION_MS;
    await this.ctx.storage.setAlarm(Date.now() + retention);
  }

  async create(writeHash: string, retentionMs: number) {
    if (this.meta('writeHash')) throw new Error('Room exists');
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?), (?, ?)', 'writeHash', writeHash, 'retention', String(retentionMs));
    await this.touch();
  }

  async destroy(token: string): Promise<boolean> {
    const hash = this.meta('writeHash');
    if (!hash || !token || (await sha256(token)) !== hash) return false;
    await this.wipe();
    return true;
  }

  private async wipe() {
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, { t: 'deleted' });
      ws.close(4410, 'deleted');
    }
    await this.ctx.storage.deleteAll(); // also clears the alarm (compatibility date ≥ 2026-02-24)
    this.schema(); // the object may stay loaded: later requests must find empty tables, not none
  }

  async alarm() {
    await this.wipe();
  }

  async fetch(): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server); // hibernatable: an idle room costs nothing while sockets stay open
    server.serializeAttachment({ hello: false, canWrite: false, win: Date.now(), n: 0 } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket, msg: ServerControl | Uint8Array) {
    try {
      ws.send(msg instanceof Uint8Array ? msg : JSON.stringify(msg));
    } catch {
      /* socket already closing */
    }
  }

  private broadcast(msg: ServerControl | Uint8Array, except?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except && (ws.deserializeAttachment() as Attachment).hello) this.send(ws, msg);
    }
  }

  private peers = () => this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Attachment).hello).length;

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    const att = ws.deserializeAttachment() as Attachment;
    const now = Date.now();
    if (now - att.win > RATE_WINDOW_MS) (att.win = now), (att.n = 0);
    if (++att.n > RATE_MAX) {
      this.send(ws, { t: 'error', code: 'rate-limited' });
      ws.close(4429, 'rate-limited');
      return;
    }
    ws.serializeAttachment(att);

    if (typeof msg === 'string') {
      let c: ClientControl;
      try {
        c = JSON.parse(msg);
      } catch {
        return this.send(ws, { t: 'error', code: 'bad-message' });
      }
      if (c.t !== 'hello' || att.hello) return this.send(ws, { t: 'error', code: 'bad-message' });
      const hash = this.meta('writeHash');
      if (!hash) {
        this.send(ws, { t: 'error', code: 'not-found' });
        ws.close(4404, 'not-found');
        return;
      }
      att.hello = true;
      att.canWrite = typeof c.write === 'string' && (await sha256(c.write)) === hash;
      ws.serializeAttachment(att);
      // Send everything stored, then `ready`.
      const parts = this.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM track ORDER BY part').toArray();
      if (parts.length) {
        const total = parts.reduce((a, p) => a + p.data.byteLength, 0);
        const track = new Uint8Array(total);
        let o = 0;
        for (const p of parts) track.set(new Uint8Array(p.data), o), (o += p.data.byteLength);
        this.send(ws, frame(Frame.Track, track));
      }
      let seq = 0;
      for (const r of this.sql.exec<{ seq: number; data: ArrayBuffer }>('SELECT seq, data FROM updates ORDER BY seq')) {
        this.send(ws, frame(Frame.Update, new Uint8Array(r.data), r.seq));
        seq = r.seq;
      }
      const peers = this.peers();
      this.send(ws, { t: 'ready', seq, canWrite: att.canWrite, peers });
      this.broadcast({ t: 'peers', n: peers }, ws);
      return;
    }

    const data = new Uint8Array(msg);
    if (!att.hello || !data.length) return this.send(ws, { t: 'error', code: 'bad-message' });
    if (!att.canWrite) return this.send(ws, { t: 'error', code: 'read-only' });
    if (data.length > MAX_MESSAGE_BYTES) return this.send(ws, { t: 'error', code: 'too-large' });

    try {
      if (data[0] === Frame.Update) {
        const { payload } = unframe(data, false);
        if (this.bytesStored() + payload.length > MAX_ROOM_BYTES) return this.send(ws, { t: 'error', code: 'too-large' });
        const seq = this.sql.exec<{ seq: number }>('INSERT INTO updates (data) VALUES (?) RETURNING seq', payload.buffer).one().seq;
        this.send(ws, { t: 'ack', seq });
        this.broadcast(frame(Frame.Update, payload, seq), ws);
        const n = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM updates').one().n;
        if (n > COMPACT_AFTER) this.send(ws, { t: 'compact', upTo: seq });
      } else if (data[0] === Frame.Snapshot) {
        const { seq: upTo, payload } = unframe(data, true);
        const max = this.sql.exec<{ m: number | null }>('SELECT MAX(seq) AS m FROM updates').one().m ?? 0;
        if (!upTo || upTo > max) return this.send(ws, { t: 'error', code: 'bad-message' });
        this.ctx.storage.transactionSync(() => {
          this.sql.exec('DELETE FROM updates WHERE seq <= ?', upTo);
          this.sql.exec('INSERT INTO updates (seq, data) VALUES (?, ?)', upTo, payload.buffer);
        });
        this.send(ws, { t: 'ack', seq: upTo });
      } else if (data[0] === Frame.Track) {
        const { payload } = unframe(data, false);
        const old = this.sql.exec<{ n: number }>('SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM track').one().n;
        if (this.bytesStored() - old + payload.length > MAX_ROOM_BYTES) return this.send(ws, { t: 'error', code: 'too-large' });
        this.ctx.storage.transactionSync(() => {
          this.sql.exec('DELETE FROM track');
          for (let i = 0, part = 0; i < payload.length; i += TRACK_CHUNK, part++) {
            this.sql.exec('INSERT INTO track (part, data) VALUES (?, ?)', part, payload.slice(i, i + TRACK_CHUNK).buffer);
          }
        });
        this.send(ws, { t: 'ack', seq: 0 });
        this.broadcast(data, ws);
      } else {
        return this.send(ws, { t: 'error', code: 'bad-message' });
      }
    } catch {
      return this.send(ws, { t: 'error', code: 'bad-message' });
    }
    await this.touch();
  }

  async webSocketClose(ws: WebSocket) {
    const n = this.ctx.getWebSockets().filter((s) => s !== ws && (s.deserializeAttachment() as Attachment).hello).length;
    this.broadcast({ t: 'peers', n }, ws);
  }
}

/** Counts room creations per (salted, hashed) IP per UTC day; forgets itself after a day. */
export class Limiter extends DurableObject<Bindings> {
  async take(max: number): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const s = (await this.ctx.storage.get<{ day: string; n: number }>('c')) ?? { day, n: 0 };
    if (s.day !== day) (s.day = day), (s.n = 0);
    if (s.n >= max) return false;
    s.n++;
    await this.ctx.storage.put('c', s);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 24 * 3600 * 1000);
    return true;
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
