/**
 * HTTP for guide downloads, and a hedged parallel ranged reader for the big ones.
 *
 * The public guides are static files whose per-connection speed is random: one connection runs
 * at 1-2 MB/s, the next crawls at 13 KB/s for minutes. Read as a single stream a large one takes
 * twenty minutes or more. Reading it as ranged chunks over several connections, and re-requesting
 * any chunk that turns out slow, lands almost every chunk on a fast path.
 *
 * The provider's own feed is never read this way; see `FeedSpec.single` in epg.ts.
 */

import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

import { redactUrl } from './redact.js';

export const SOCKET_IDLE_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
/** Some panels reject unknown clients outright; present as a plain browser. */
const USER_AGENT = 'Mozilla/5.0 (compatible; xiptv/1.0)';

/** Files smaller than this are read as one stream; the setup cost of ranges is not worth it. */
export const RANGED_MIN_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const IN_FLIGHT = 6;
/** Completed chunks held ahead of the one being emitted. Bounds memory with IN_FLIGHT. */
const MAX_AHEAD = IN_FLIGHT;
/** A chunk running longer than this at under MIN_RATE is abandoned and requested afresh. */
const HEDGE_AFTER_MS = 5_000;
const MIN_RATE_BPS = 100 * 1024;
const STALL_MS = 15_000;
const WATCH_INTERVAL_MS = 1_000;
const MAX_RETRIES_PER_CHUNK = 8;
const MAX_RETRIES_TOTAL = 200;
/** Statuses that will not change on a retry, and that panels count as failed logins. */
const REFUSED = new Set([401, 403, 407, 429]);

export interface Validators {
  etag?: string;
  lastModified?: string;
}

export function requestOnce(
  url: string,
  idleTimeoutMs: number,
  extraHeaders: Record<string, string>,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`The EPG address is not a valid URL: ${redactUrl(url)}`));
      return;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.get(
      target,
      {
        headers: {
          'Accept-Encoding': 'gzip, deflate, br',
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          ...extraHeaders,
        },
      },
      resolve,
    );
    req.setTimeout(idleTimeoutMs, () => {
      req.destroy(new Error(`The EPG server sent no data for ${idleTimeoutMs} ms: ${redactUrl(url)}`));
    });
    req.on('error', reject);
  });
}

function validatorHeaders(validators: Validators): Record<string, string> {
  const headers: Record<string, string> = {};
  if (validators.etag !== undefined) headers['If-None-Match'] = validators.etag;
  if (validators.lastModified !== undefined) headers['If-Modified-Since'] = validators.lastModified;
  return headers;
}

/**
 * Follows redirects and resolves with a 200, or a 304 when validators were sent and the
 * document is unchanged. `finalUrl` is where the body actually came from.
 */
export async function httpGet(
  url: string,
  idleTimeoutMs: number,
  validators: Validators = {},
  extraHeaders: Record<string, string> = {},
): Promise<{ res: http.IncomingMessage; finalUrl: string }> {
  const headers = { ...validatorHeaders(validators), ...extraHeaders };
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requestOnce(current, idleTimeoutMs, headers);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status === 304) {
      res.resume();
      return { res, finalUrl: current };
    }
    if (status >= 300 && status < 400 && typeof location === 'string' && location.length > 0) {
      res.resume(); // drain so the socket can be reused / closed cleanly
      current = new URL(location, current).toString();
      continue;
    }
    if (status !== 200 && status !== 206) {
      res.resume();
      throw new Error(`EPG server returned HTTP ${status} for ${redactUrl(current)}`);
    }
    return { res, finalUrl: current };
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) fetching EPG from ${redactUrl(url)}`);
}

export function headerString(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

const CONTENT_RANGE_RE = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i;

function parseContentRange(v: string | undefined): { start: number; end: number; total: number } | undefined {
  if (v === undefined) return undefined;
  const m = CONTENT_RANGE_RE.exec(v.trim());
  if (m === null) return undefined;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = Number(m[3]);
  return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(total) && end >= start
    ? { start, end, total }
    : undefined;
}

export type Probe =
  /** The document has not changed since the validators were issued. */
  | { kind: 'unchanged' }
  /** Ranges are honoured and the file is big enough to be worth them. */
  | { kind: 'ranged'; url: string; total: number; etag?: string; lastModified?: string }
  /** Read this response as a single stream; the server ignored the range or the file is small. */
  | { kind: 'stream'; res: http.IncomingMessage };

/** One plain request, for a feed that must never be read in parallel. */
export async function single(url: string, idleTimeoutMs: number, validators: Validators): Promise<Probe> {
  const { res } = await httpGet(url, idleTimeoutMs, validators);
  return res.statusCode === 304 ? { kind: 'unchanged' } : { kind: 'stream', res };
}

/**
 * One request for the first byte, to learn whether the server honours ranges, how big the file
 * is, and its ETag. A server that ignores the range answers 200 with the whole body, which is
 * then the single-stream download already under way.
 */
export async function probe(url: string, idleTimeoutMs: number, validators: Validators): Promise<Probe> {
  const { res, finalUrl } = await httpGet(url, idleTimeoutMs, validators, { Range: 'bytes=0-0' });
  if (res.statusCode === 304) return { kind: 'unchanged' };
  if (res.statusCode !== 206) return { kind: 'stream', res };

  const range = parseContentRange(headerString(res.headers['content-range']));
  res.resume();
  if (range === undefined || range.total < RANGED_MIN_BYTES) {
    const full = await httpGet(finalUrl, idleTimeoutMs);
    return { kind: 'stream', res: full.res };
  }
  const out: Probe = { kind: 'ranged', url: finalUrl, total: range.total };
  const etag = headerString(res.headers.etag);
  if (etag !== undefined) out.etag = etag;
  const lastModified = headerString(res.headers['last-modified']);
  if (lastModified !== undefined) out.lastModified = lastModified;
  return out;
}

/** Thrown when a chunk comes back from a different version of the file than the probe saw. */
export class FileChangedError extends Error {
  constructor() {
    super('The EPG file changed while it was being downloaded');
    this.name = 'FileChangedError';
  }
}

export interface RangedStats {
  bytes: number;
  total: number;
  /** Chunk requests abandoned for being slow or stalled, then re-requested. */
  hedged: number;
  /** Chunk requests that failed outright (network error, bad status) and were re-requested. */
  failed: number;
}

interface Task {
  index: number;
  req?: http.ClientRequest;
  res?: http.IncomingMessage;
  parts: Buffer[];
  received: number;
  startedAt: number;
  lastDataAt: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads `[0, total)` in CHUNK_BYTES ranges over up to IN_FLIGHT connections and emits them in
 * order as one byte stream. A watchdog abandons any chunk that is slow or stalled and requests it
 * again on a fresh connection. Completed chunks waiting behind a slow one are capped at
 * MAX_AHEAD, so memory stays around (IN_FLIGHT + MAX_AHEAD) x CHUNK_BYTES.
 */
export function rangedStream(
  target: { url: string; total: number; etag?: string },
  idleTimeoutMs: number,
): { stream: Readable; stats: RangedStats } {
  const chunkCount = Math.ceil(target.total / CHUNK_BYTES);
  const stats: RangedStats = { bytes: 0, total: target.total, hedged: 0, failed: 0 };
  const done = new Map<number, Buffer>();
  const active = new Map<number, Task>();
  const retries = new Map<number, number>();
  let nextToStart = 0;
  let nextToEmit = 0;
  let finished = false;
  let wantMore = false;
  let watchdog: NodeJS.Timeout | undefined;

  const stream = new Readable({
    highWaterMark: CHUNK_BYTES,
    read() {
      wantMore = true;
      drain();
      schedule();
    },
  });

  function fail(err: Error): void {
    if (finished) return;
    finished = true;
    if (watchdog !== undefined) clearInterval(watchdog);
    for (const task of active.values()) abort(task);
    active.clear();
    done.clear();
    stream.destroy(err);
  }

  function abort(task: Task): void {
    task.res?.removeAllListeners('data');
    task.res?.removeAllListeners('end');
    task.res?.removeAllListeners('error');
    task.res?.on('error', () => undefined);
    task.req?.removeAllListeners('error');
    task.req?.on('error', () => undefined);
    task.req?.destroy();
    task.res?.destroy();
    task.parts = [];
  }

  function drain(): void {
    while (wantMore && !finished) {
      const buf = done.get(nextToEmit);
      if (buf === undefined) break;
      done.delete(nextToEmit);
      nextToEmit++;
      wantMore = stream.push(buf);
    }
    if (!finished && nextToEmit >= chunkCount) {
      finished = true;
      if (watchdog !== undefined) clearInterval(watchdog);
      stream.push(null);
    }
  }

  function schedule(): void {
    if (finished) return;
    while (
      active.size < IN_FLIGHT
      && nextToStart < chunkCount
      && nextToStart - nextToEmit < IN_FLIGHT + MAX_AHEAD
    ) {
      start(nextToStart++);
    }
    if (watchdog === undefined && active.size > 0) watchdog = setInterval(watch, WATCH_INTERVAL_MS);
  }

  function retry(task: Task, reason: 'hedged' | 'failed', err?: Error): void {
    abort(task);
    active.delete(task.index);
    const n = (retries.get(task.index) ?? 0) + 1;
    retries.set(task.index, n);
    stats[reason]++;
    if (n > MAX_RETRIES_PER_CHUNK || stats.hedged + stats.failed > MAX_RETRIES_TOTAL) {
      fail(new Error(
        `Gave up on chunk ${task.index + 1} of ${chunkCount} after ${n} attempts`
        + (err !== undefined ? `: ${err.message}` : ''),
      ));
      return;
    }
    // Requeue just this chunk; the scheduler is otherwise monotonic.
    void delay(reason === 'failed' ? 500 : 0).then(() => {
      if (!finished) start(task.index);
    });
  }

  function start(index: number): void {
    const from = index * CHUNK_BYTES;
    const to = Math.min(target.total, from + CHUNK_BYTES) - 1;
    const task: Task = { index, parts: [], received: 0, startedAt: Date.now(), lastDataAt: Date.now() };
    active.set(index, task);

    let url: URL;
    try {
      url = new URL(target.url);
    } catch (err) {
      retry(task, 'failed', err as Error);
      return;
    }
    const headers: Record<string, string> = {
      Range: `bytes=${from}-${to}`,
      'Accept-Encoding': 'identity',
      'User-Agent': USER_AGENT,
      Accept: '*/*',
    };
    if (target.etag !== undefined) headers['If-Range'] = target.etag;
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.get(url, { headers }, (res) => {
      if (task !== active.get(index)) {
        res.resume();
        return;
      }
      task.res = res;
      const status = res.statusCode ?? 0;
      if (status === 200) {
        // `If-Range` did not match: the file was regenerated under us.
        res.resume();
        fail(new FileChangedError());
        return;
      }
      if (REFUSED.has(status)) {
        // Asking again is what gets an account locked out.
        res.resume();
        fail(new Error(`EPG server refused range ${from}-${to} with HTTP ${status}`));
        return;
      }
      const range = parseContentRange(headerString(res.headers['content-range']));
      if (status !== 206 || range === undefined || range.start !== from || range.end !== to) {
        retry(task, 'failed', new Error(`HTTP ${status} for range ${from}-${to}`));
        return;
      }
      if (target.etag !== undefined && headerString(res.headers.etag) !== target.etag) {
        res.resume();
        fail(new FileChangedError());
        return;
      }
      res.on('data', (c: Buffer) => {
        task.parts.push(c);
        task.received += c.length;
        task.lastDataAt = Date.now();
      });
      res.on('end', () => {
        if (task !== active.get(index)) return;
        const expected = to - from + 1;
        if (task.received !== expected) {
          retry(task, 'failed', new Error(`range ${from}-${to} returned ${task.received} of ${expected} bytes`));
          return;
        }
        active.delete(index);
        done.set(index, Buffer.concat(task.parts));
        task.parts = [];
        stats.bytes += expected;
        drain();
        schedule();
      });
      res.on('error', (err: Error) => {
        if (task === active.get(index)) retry(task, 'failed', err);
      });
    });
    task.req = req;
    req.setTimeout(idleTimeoutMs, () => {
      req.destroy(new Error(`no data for ${idleTimeoutMs} ms`));
    });
    req.on('error', (err: Error) => {
      if (task === active.get(index)) retry(task, 'failed', err);
    });
  }

  function watch(): void {
    if (finished) return;
    const now = Date.now();
    for (const task of [...active.values()]) {
      const elapsed = now - task.startedAt;
      if (elapsed < HEDGE_AFTER_MS) continue;
      const stalled = now - task.lastDataAt > STALL_MS;
      const rate = task.received / (elapsed / 1000);
      if (stalled || rate < MIN_RATE_BPS) retry(task, 'hedged');
    }
    if (active.size === 0 && watchdog !== undefined) {
      clearInterval(watchdog);
      watchdog = undefined;
    }
  }

  stream.on('close', () => {
    if (!finished) fail(new Error('EPG download cancelled'));
  });

  return { stream, stats };
}
