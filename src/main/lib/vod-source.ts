/**
 * Chromium's media loader hangs up on a slow response and asks again from where it stopped, every
 * two or three seconds. Proxied straight through, each of those requests closed the provider
 * connection and opened a new one, which takes about two seconds to send its first byte, so a film
 * on a slow edge stopped and started or never got going at all. The proxy also paused the provider
 * whenever Chromium's own buffer was full, which threw away the fast spells that would have covered
 * the slow ones.
 *
 * So a film is read over one provider connection into a temp file, as fast as the provider will
 * send it, and the player is answered from that file. The connection only moves when the player
 * asks for bytes well away from where it is downloading, which is a seek.
 */

import { open, type FileHandle } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { UpstreamError, openUpstream, type LiveSourceOptions } from './live-source.js';

const READ_CHUNK_BYTES = 256 * 1024;
/** Waiting for the download to get there beats reconnecting, which costs ~2 s before the first byte. */
const SEEK_REACH_BYTES = 2 * 1024 * 1024;
/** About a quarter of an hour of a typical 1080p film. Bounds how far a paused film downloads. */
const MAX_AHEAD_BYTES = 256 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 20_000;
const MAX_FAILURES = 4;
const RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 5_000;

/** A busy slot or a flaky edge gets better on a second try; a refusal will not. */
function retryable(err: unknown): boolean {
  return !(err instanceof UpstreamError) || err.status === 555;
}

interface Upstream {
  /** The next byte this connection will write. */
  pos: number;
  abort: AbortController;
  /** Set while the download is parked for being too far ahead of the player. */
  resume?: () => void;
}

interface Span {
  start: number;
  end: number;
}

export class VodSource {
  readonly #url: string;
  readonly #opts: LiveSourceOptions;
  readonly #file: Promise<FileHandle>;
  #size: number | undefined;
  /** False once the provider has answered a range request with the whole file. */
  #seekable = true;
  /** Downloaded bytes, as sorted spans that neither overlap nor touch. */
  readonly #have: Span[] = [];
  #upstream: Upstream | null = null;
  #failures = 0;
  #failure: Error | undefined;
  #playerPos = 0;
  #newestReader = 0;
  readonly #waiters = new Set<() => void>();

  constructor(url: string, path: string, opts: LiveSourceOptions) {
    this.#url = url;
    this.#opts = opts;
    this.#file = open(path, 'w+');
    this.#file.catch((err: unknown) => this.#fail(err));
  }

  /** Known once the first read has returned. */
  get size(): number | undefined {
    return this.#size;
  }

  get failure(): Error | undefined {
    return this.#failure;
  }

  /**
   * One request from the player. Only the newest may move the connection: Chromium can leave an
   * older request open behind a seek, and two readers steering it would pull it back and forth.
   */
  reader(signal: AbortSignal): (offset: number) => Promise<Buffer> {
    const id = ++this.#newestReader;
    return (offset) => this.#read(offset, signal, id === this.#newestReader);
  }

  async destroy(): Promise<void> {
    this.#fail(new Error('The stream was stopped.'));
    await this.#file.then((fh) => fh.close()).catch(() => undefined);
  }

  /** Up to READ_CHUNK_BYTES from `offset`, waiting for the download if need be. Empty at the end. */
  async #read(offset: number, signal: AbortSignal, leading: boolean): Promise<Buffer> {
    for (;;) {
      signal.throwIfAborted();
      if (this.#failure) throw this.#failure;
      if (this.#size !== undefined && offset >= this.#size) return Buffer.alloc(0);
      if (leading) this.#steer(offset);
      const available = this.#availableAt(offset);
      if (available > 0) {
        const buf = Buffer.allocUnsafe(Math.min(available, READ_CHUNK_BYTES));
        const { bytesRead } = await (await this.#file).read(buf, 0, buf.length, offset);
        return buf.subarray(0, bytesRead);
      }
      await this.#changed(signal);
    }
  }

  /** Points the download at what the player needs next, and lets it carry on once it has caught up. */
  #steer(offset: number): void {
    this.#playerPos = offset;
    const frontier = offset + this.#availableAt(offset);
    if (this.#size !== undefined && frontier >= this.#size) return;
    const up = this.#upstream;
    if (up && this.#reaches(frontier)) {
      if (up.resume && up.pos - offset <= MAX_AHEAD_BYTES) {
        const resume = up.resume;
        up.resume = undefined;
        resume();
      }
      return;
    }
    // Idle or parked, pick up where the player's data ends. Busy elsewhere, only move once it is
    // about to run out.
    const ahead = frontier - offset;
    const busy = up !== null && !up.resume;
    if (busy ? ahead <= SEEK_REACH_BYTES : ahead <= MAX_AHEAD_BYTES) this.#moveTo(frontier);
  }

  #reaches(offset: number): boolean {
    const up = this.#upstream;
    if (!up) return false;
    // A provider that ignores ranges can only be read from the start, so moving would just loop.
    if (!this.#seekable) return true;
    return offset >= up.pos && offset - up.pos <= SEEK_REACH_BYTES;
  }

  #moveTo(offset: number): void {
    this.#stop();
    const up: Upstream = { pos: this.#seekable ? offset : 0, abort: new AbortController() };
    this.#upstream = up;
    void this.#connect(up);
  }

  #stop(): void {
    const up = this.#upstream;
    this.#upstream = null;
    up?.abort.abort();
  }

  async #connect(up: Upstream): Promise<void> {
    while (this.#upstream === up) {
      let received = 0;
      let error: unknown;
      try {
        const { req, res } = await openUpstream(this.#url, this.#opts, {
          range: `bytes=${up.pos}-`,
          signal: up.abort.signal,
        });
        req.removeAllListeners('timeout');
        req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error('upstream went quiet')));
        received = await this.#download(res, up);
      } catch (err) {
        error = err;
      }
      if (this.#upstream !== up) return;
      // Parked and then dropped for being idle: the player's next read picks it back up.
      if (up.resume || (this.#size !== undefined && up.pos >= this.#size)) break;
      if (received > 0) this.#failures = 0;
      else if (!retryable(error) || ++this.#failures > MAX_FAILURES) {
        this.#fail(error ?? new Error('The provider closed the connection without sending anything.'));
        return;
      }
      await delay(Math.min(RECONNECT_DELAY_MS * 2 ** this.#failures, MAX_RECONNECT_DELAY_MS));
    }
    if (this.#upstream === up) {
      this.#upstream = null;
      this.#wake();
    }
  }

  /** Writes one response into the file and resolves with how much it wrote, once it has ended. */
  #download(res: IncomingMessage, up: Upstream): Promise<number> {
    this.#adopt(res, up);
    return new Promise((resolve) => {
      let received = 0;
      let next = up.pos;
      let writing: Promise<void> = Promise.resolve();
      up.abort.signal.addEventListener('abort', () => res.destroy(), { once: true });
      res.on('error', () => undefined);
      res.on('data', (chunk: Buffer) => {
        res.pause();
        // Claimed on arrival, not when the previous write lands: one socket read can deliver
        // several chunks before the pause takes, and they would all land on the same offset.
        const at = next;
        next += chunk.length;
        writing = writing
          .then(() => this.#file)
          .then((fh) => fh.write(chunk, 0, chunk.length, at))
          .then(() => {
            up.pos = at + chunk.length;
            received += chunk.length;
            this.#markHave(at, up.pos);
            this.#wake();
            if (up.pos - this.#playerPos > MAX_AHEAD_BYTES) up.resume = () => res.resume();
            else res.resume();
          }, (err: unknown) => this.#fail(err));
      });
      res.once('close', () => void writing.then(() => resolve(received)));
    });
  }

  /** Learns the file size, and where this response really starts, from its headers. */
  #adopt(res: IncomingMessage, up: Upstream): void {
    const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(res.headers['content-range'] ?? '');
    if (res.statusCode === 206 && range) {
      up.pos = Number(range[1]);
      this.#size = Number(range[2]);
      return;
    }
    // A 200 is the whole file, whatever range was asked for.
    if (up.pos > 0) this.#seekable = false;
    up.pos = 0;
    const length = Number(res.headers['content-length']);
    if (!(length > 0)) {
      res.destroy();
      throw new Error('The provider did not say how big this film is.');
    }
    this.#size = length;
  }

  #availableAt(offset: number): number {
    for (const span of this.#have) {
      if (span.start <= offset && offset < span.end) return span.end - offset;
    }
    return 0;
  }

  #markHave(start: number, end: number): void {
    let i = 0;
    while (i < this.#have.length && this.#have[i].end < start) i++;
    const merged = { start, end };
    while (i < this.#have.length && this.#have[i].start <= end) {
      merged.start = Math.min(merged.start, this.#have[i].start);
      merged.end = Math.max(merged.end, this.#have[i].end);
      this.#have.splice(i, 1);
    }
    this.#have.splice(i, 0, merged);
  }

  #changed(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        signal.removeEventListener('abort', done);
        this.#waiters.delete(done);
        resolve();
      };
      this.#waiters.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  #wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const done of waiters) done();
  }

  #fail(err: unknown): void {
    this.#failure ??= err instanceof Error ? err : new Error(String(err));
    this.#stop();
    this.#wake();
  }
}
