/**
 * The provider closes a live connection every 30-60 s and a fresh connection replays its ~60 s
 * buffer from the start. ffmpeg's `-reconnect` glues the responses together mid-packet, treats
 * the backwards jump as a discontinuity and re-bases it as new content: the last minute plays
 * again after every drop and audio/video drift 100-150 ms apart per reconnect.
 */

import { Readable } from 'node:stream';
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

const TS_PACKET = 188;
const SYNC = 0x47;
const PTS_WRAP = 2 ** 33;
const NEW_TIMELINE_TICKS = 20 * 60 * 90_000;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 12;
const MAX_INITIAL_RETRIES = 4;
const RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 5_000;

/** Bad credentials will not get better by asking again; a busy slot or a flaky edge will. */
function isPermanent(err: unknown): boolean {
  return err instanceof UpstreamError && (err.status === 401 || err.status === 403);
}

/** The slot we just released is still counted as open for a moment after the socket closes. */
function isBusySlot(err: unknown): boolean {
  return err instanceof UpstreamError && err.status === 555;
}

export interface LiveSourceOptions {
  userAgent: string;
  maxRedirects: number;
}

export function describeUpstreamStatus(status: number): string {
  if (status === 555) {
    return 'Your provider allows one stream at a time, and another one is already open.';
  }
  if (status === 666 || status === 888) {
    return 'This channel is not available from your provider right now.';
  }
  if (status === 401 || status === 403) {
    return 'Your provider rejected these credentials.';
  }
  if (status === 404) return 'Your provider no longer has this stream.';
  if (status >= 500) return `Your provider returned an error (${status}).`;
  return `Your provider refused the stream (${status}).`;
}

export class UpstreamError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(describeUpstreamStatus(status));
    this.status = status;
  }
}

interface Upstream {
  req: ClientRequest;
  res: IncomingMessage;
}

export function openUpstream(
  target: string,
  opts: LiveSourceOptions,
  extra: { range?: string; signal?: AbortSignal } = {},
): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    const attempt = (raw: string, redirectsLeft: number): void => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        reject(new Error('upstream returned an unusable url'));
        return;
      }
      const options: RequestOptions = {
        method: 'GET',
        headers: { 'user-agent': opts.userAgent, accept: '*/*', ...(extra.range ? { range: extra.range } : {}) },
        signal: extra.signal,
      };
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(url, options, (res) => {
        const status = res.statusCode ?? 502;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && typeof location === 'string') {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('too many redirects'));
            return;
          }
          attempt(new URL(location, url).toString(), redirectsLeft - 1);
          return;
        }
        if (status < 200 || status > 299) {
          res.resume();
          reject(new UpstreamError(status));
          return;
        }
        req.setTimeout(0);
        resolve({ req, res });
      });
      req.setTimeout(CONNECT_TIMEOUT_MS, () => req.destroy(new Error('upstream timeout')));
      req.on('error', reject);
      req.end();
    };
    attempt(target, opts.maxRedirects);
  });
}

type PayloadStart =
  | { kind: 'psi' }
  /** `ts` is the decode timestamp when present, else the presentation one: monotonic per PID. */
  | { kind: 'pes'; ts?: number };

function readPayloadStart(packet: Buffer): PayloadStart {
  const adaptation = (packet[3] & 0x30) >> 4;
  if (!(adaptation & 1)) return { kind: 'pes' };
  let offset = 4;
  if (adaptation & 2) offset += 1 + packet[4];
  if (offset + 3 > TS_PACKET) return { kind: 'pes' };
  if (packet[offset] !== 0 || packet[offset + 1] !== 0 || packet[offset + 2] !== 1) return { kind: 'psi' };
  // stream_id, packet length, flags, header length, then PTS and (optionally) DTS.
  if (offset + 14 > TS_PACKET) return { kind: 'pes' };
  const flags = packet[offset + 7];
  if ((flags & 0x80) === 0) return { kind: 'pes' };
  const withDts = (flags & 0x40) !== 0 && offset + 19 <= TS_PACKET;
  return { kind: 'pes', ts: readTimestamp(packet, offset + (withDts ? 14 : 9)) };
}

function readTimestamp(packet: Buffer, p: number): number {
  return (
    ((packet[p] >> 1) & 0x07) * 2 ** 30
    + packet[p + 1] * 2 ** 22
    + (packet[p + 2] >> 1) * 2 ** 15
    + packet[p + 3] * 2 ** 7
    + (packet[p + 4] >> 1)
  );
}

function tsDelta(ts: number, reference: number): number {
  let d = ts - reference;
  if (d > PTS_WRAP / 2) d -= PTS_WRAP;
  else if (d < -PTS_WRAP / 2) d += PTS_WRAP;
  return d;
}

interface PendingPes {
  packets: Buffer[];
  ts?: number;
}

type PidState =
  | { kind: 'psi' }
  | { kind: 'pes'; pastReplay: boolean; lastDeliveredTs?: number; pending: PendingPes };

export class LiveTsSource extends Readable {
  readonly #url: string;
  readonly #opts: LiveSourceOptions;
  #upstream: Upstream | null = null;
  #pending: Buffer = Buffer.alloc(0);
  #connected = false;
  #played = false;
  #failures = 0;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #failure: Error | undefined;

  readonly #abort = new AbortController();
  #running: Promise<void> = Promise.resolve();
  readonly #pids = new Map<number, PidState>();
  #replaying = false;
  #replayBytes = 0;
  #reconnects = 0;
  #dropped = 0;

  constructor(url: string, opts: LiveSourceOptions) {
    super({ highWaterMark: 1024 * 1024 });
    this.#url = url;
    this.#opts = opts;
  }

  /** Why the stream ended, when the provider refused it or the connection could not be re-made. */
  get failure(): Error | undefined {
    return this.#failure;
  }

  /** Diagnostics for logs: how often the provider dropped us and how much replay was discarded. */
  get stats(): { reconnects: number; droppedBytes: number } {
    return { reconnects: this.#reconnects, droppedBytes: this.#dropped };
  }

  override _read(): void {
    if (!this.#connected) {
      this.#connected = true;
      this.#running = this.#run();
      return;
    }
    this.#upstream?.res.resume();
    this.#armIdle();
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.#disarmIdle();
    this.#abort.abort();
    const req = this.#upstream?.req;
    const closed = !req || req.closed ? Promise.resolve() : new Promise<void>(resolve => req.once('close', resolve));
    req?.destroy();
    this.#upstream?.res.destroy();
    this.#upstream = null;
    void Promise.allSettled([closed, this.#running]).then(() => cb(err));
  }

  async #run(): Promise<void> {
    while (!this.destroyed) {
      let up: Upstream;
      try {
        up = await openUpstream(this.#url, this.#opts, { signal: this.#abort.signal });
      } catch (err) {
        if (this.destroyed) return;
        if (++this.#failures > this.#retryBudget(err)) {
          // End rather than destroy: destroy() would discard whatever the consumer has not read.
          this.#failure = err instanceof Error ? err : new Error(String(err));
          this.push(null);
          return;
        }
        await delay(Math.min(RECONNECT_DELAY_MS * 2 ** this.#failures, MAX_RECONNECT_DELAY_MS), undefined, { signal: this.#abort.signal }).catch(() => undefined);
        continue;
      }
      if (this.destroyed) {
        up.req.destroy();
        return;
      }
      this.#upstream = up;
      await this.#consume(up);
      this.#upstream = null;
      if (this.destroyed) return;
      this.#reconnects += 1;
      this.#beginReplay();
      await delay(RECONNECT_DELAY_MS, undefined, { signal: this.#abort.signal }).catch(() => undefined);
    }
  }

  #retryBudget(err: unknown): number {
    if (isPermanent(err)) return 0;
    if (this.#played) return MAX_CONSECUTIVE_FAILURES;
    if (err instanceof UpstreamError && !isBusySlot(err)) return 0;
    return MAX_INITIAL_RETRIES;
  }

  #consume(up: Upstream): Promise<void> {
    return new Promise((resolve) => {
      let synced = false;
      this.#armIdle();
      up.res.on('data', (chunk: Buffer) => {
        if (this.destroyed) return;
        this.#failures = 0;
        this.#played = true;
        this.#armIdle();
        let data: Buffer = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
        if (!synced) {
          const at = findSync(data);
          if (at < 0) {
            this.#pending = data.subarray(Math.max(0, data.length - TS_PACKET));
            return;
          }
          synced = true;
          data = data.subarray(at);
        }
        const whole = data.length - (data.length % TS_PACKET);
        this.#pending = data.subarray(whole);
        if (whole === 0) return;
        const out = this.#filter(data.subarray(0, whole));
        if (out.length && !this.push(out)) {
          up.res.pause();
          this.#disarmIdle();
        }
      });
      const done = (): void => {
        this.#disarmIdle();
        resolve();
      };
      up.res.once('end', done);
      up.res.once('error', done);
      up.res.once('close', done);
    });
  }

  #armIdle(): void {
    this.#disarmIdle();
    const up = this.#upstream;
    if (!up) return;
    this.#idle = setTimeout(() => up.req.destroy(new Error('upstream went quiet')), IDLE_TIMEOUT_MS);
  }

  #disarmIdle(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = undefined;
  }

  #beginReplay(): void {
    this.#pending = Buffer.alloc(0);
    this.#replaying = true;
    this.#replayBytes = 0;
    for (const state of this.#pids.values()) {
      if (state.kind !== 'pes') continue;
      state.pending = { packets: [] };
      state.pastReplay = false;
    }
  }

  #filter(data: Buffer): Buffer {
    const kept: Buffer[] = [];
    for (let i = 0; i < data.length; i += TS_PACKET) {
      this.#admit(data.subarray(i, i + TS_PACKET), kept);
    }
    if (this.#replaying) {
      this.#replayBytes += data.length;
      if (this.#replayBytes > MAX_REPLAY_BYTES) this.#endReplay();
    }
    return Buffer.concat(kept);
  }

  #admit(packet: Buffer, out: Buffer[]): void {
    if (packet[0] !== SYNC) return;
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    const starts = (packet[1] & 0x40) !== 0;
    let state = this.#pids.get(pid);

    if (!starts) {
      if (!state) this.#dropped += TS_PACKET;
      else if (state.kind === 'psi') out.push(packet);
      else if (state.pastReplay) state.pending.packets.push(packet);
      else this.#dropped += TS_PACKET;
      return;
    }

    const payload = readPayloadStart(packet);
    if (!state) {
      state = payload.kind === 'psi'
        ? { kind: 'psi' }
        : { kind: 'pes', pastReplay: true, pending: { packets: [] } };
      this.#pids.set(pid, state);
    }
    if (state.kind === 'psi') {
      out.push(packet);
      return;
    }

    const previous = state.pending;
    if (state.pastReplay) {
      out.push(...previous.packets);
      if (previous.ts !== undefined) state.lastDeliveredTs = previous.ts;
    } else {
      this.#dropped += previous.packets.length * TS_PACKET;
    }
    const ts = payload.kind === 'pes' ? payload.ts : undefined;
    state.pending = { packets: [], ts };

    if (this.#replaying && ts !== undefined) {
      const d = state.lastDeliveredTs === undefined ? 1 : tsDelta(ts, state.lastDeliveredTs);
      if (Math.abs(d) > NEW_TIMELINE_TICKS) this.#endReplay();
      else {
        state.pastReplay = d > 0;
        if (state.pastReplay) this.#settleReplay();
      }
    }
    if (state.pastReplay) state.pending.packets.push(packet);
    else this.#dropped += TS_PACKET;
  }

  #settleReplay(): void {
    for (const state of this.#pids.values()) {
      if (state.kind === 'pes' && !state.pastReplay) return;
    }
    this.#replaying = false;
  }

  #endReplay(): void {
    this.#replaying = false;
    for (const state of this.#pids.values()) {
      if (state.kind === 'pes') state.pastReplay = true;
    }
  }
}

function findSync(data: Buffer): number {
  const limit = data.length - TS_PACKET;
  for (let i = 0; i <= limit; i++) {
    if (data[i] === SYNC && data[i + TS_PACKET] === SYNC) return i;
  }
  return -1;
}
