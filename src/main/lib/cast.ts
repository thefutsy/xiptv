import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { Bonjour, type Browser, type Service } from 'bonjour-service';
import type { CastDevice, CastPlayerState, CastStatus, ResolvedStream } from '@shared/types';


type NodeCallback<T> = (err: Error | null | undefined, result?: T) => void;

/** MEDIA_STATUS payload. Every field is optional: receivers omit what does not apply. */
interface CastMediaStatus {
  mediaSessionId?: number;
  playerState?: string;
  currentTime?: number;
  idleReason?: string;
  volume?: { level?: number; muted?: boolean };
  media?: {
    duration?: number | null;
    contentId?: string;
    metadata?: { title?: string };
  };
}

interface CastReceiverStatus {
  volume?: { level?: number; muted?: boolean };
  applications?: Array<{
    appId: string;
    sessionId: string;
    transportId: string;
    displayName?: string;
    statusText?: string;
  }>;
}

type CastSession = NonNullable<CastReceiverStatus['applications']>[number];

interface CastMedia {
  contentId: string;
  contentType: string;
  streamType: 'LIVE' | 'BUFFERED';
  metadata: {
    type: number;
    metadataType: number;
    title: string;
    images: Array<{ url: string }>;
  };
}

interface CastLoadOptions {
  autoplay: boolean;
  currentTime: number;
}

/** `DefaultMediaReceiver` instance. */
interface CastPlayer extends EventEmitter {
  /** Internal media controller; `currentSession` holds the last MEDIA_STATUS. */
  media?: { currentSession?: CastMediaStatus | null };
  getStatus(cb: NodeCallback<CastMediaStatus>): void;
  load(media: CastMedia, options: CastLoadOptions, cb: NodeCallback<CastMediaStatus>): void;
  play(cb: NodeCallback<CastMediaStatus>): void;
  pause(cb: NodeCallback<CastMediaStatus>): void;
  seek(currentTime: number, cb: NodeCallback<CastMediaStatus>): void;
  close(): void;
}

/** `DefaultMediaReceiver` constructor, passed opaquely to `launch`/`join`. */
interface CastApplication {
  APP_ID: string;
}

/** `Client` (a.k.a. PlatformSender) instance. */
interface CastClient extends EventEmitter {
  connect(options: { host: string; port: number } | string, cb: () => void): void;
  close(): void;
  launch(app: CastApplication, cb: NodeCallback<CastPlayer>): void;
  join(session: CastSession, app: CastApplication, cb: NodeCallback<CastPlayer>): void;
  getStatus(cb: NodeCallback<CastReceiverStatus>): void;
  getSessions(cb: NodeCallback<CastSession[]>): void;
  setVolume(volume: { level?: number; muted?: boolean }, cb: NodeCallback<{ level?: number; muted?: boolean }>): void;
  stop(app: CastPlayer, cb: NodeCallback<CastSession[]>): void;
}

interface Castv2Module {
  Client: new () => CastClient;
  DefaultMediaReceiver: CastApplication;
}

const requireCjs = createRequire(import.meta.url);
let castv2: Castv2Module | undefined;

/** Loaded lazily so a broken/missing native dep only breaks casting, not app startup. */
function castv2Module(): Castv2Module {
  if (!castv2) {
    castv2 = requireCjs('castv2-client') as Castv2Module;
  }
  return castv2;
}


const DEFAULT_SCAN_MS = 4_000;
const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 6_000;
/** LOAD makes the receiver fetch and buffer the URL before it replies. */
const LOAD_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;
const RECEIVER_POLL_EVERY = 5;
const MAX_POLL_FAILURES = 3;

const MEDIA_RECEIVER_APP_ID = 'CC1AD845';

function disconnectedStatus(error?: string): CastStatus {
  const status: CastStatus = {
    connected: false,
    state: 'IDLE',
    currentTime: 0,
    volume: 1,
    muted: false,
  };
  if (error !== undefined) status.error = error;
  return status;
}


/**
 * Promisify one castv2 callback call and bound it in time. The library never times out
 * on its own, and some calls (`play`/`pause`/`seek`) throw synchronously when no media
 * session exists yet, so the call itself is guarded too.
 */
function invoke<T>(
  label: string,
  timeoutMs: number,
  fn: (cb: NodeCallback<T>) => void,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`Chromecast ${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const done: NodeCallback<T> = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(result);
    };

    try {
      fn(done);
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function toPlayerState(playerState: string | undefined): CastPlayerState {
  switch (playerState) {
    case 'PLAYING':
      return 'PLAYING';
    case 'PAUSED':
      return 'PAUSED';
    case 'BUFFERING':
    case 'LOADING':
      return 'BUFFERING';
    default:
      return 'IDLE';
  }
}

function clampVolume(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.min(1, Math.max(0, level));
}

/** Prefer a routable IPv4 literal; `service.host` is a `.local` name a cast device may not resolve. */
function pickAddress(service: Service): string | undefined {
  const ipv4 = (service.addresses ?? []).find((addr) => /^\d+\.\d+\.\d+\.\d+$/.test(addr));
  return ipv4 ?? service.addresses?.[0] ?? service.host;
}

function toCastDevice(service: Service): CastDevice | undefined {
  const host = pickAddress(service);
  const port = service.port;
  if (!host || !port) return undefined;

  // TXT record keys are Chromecast conventions: `fn` friendly name, `md` model, `id` device uuid.
  const txt: Record<string, unknown> = (service.txt as Record<string, unknown> | undefined) ?? {};
  const fn = typeof txt.fn === 'string' ? txt.fn.trim() : '';
  const md = typeof txt.md === 'string' ? txt.md.trim() : '';
  const id = typeof txt.id === 'string' && txt.id.length > 0 ? txt.id : `${host}:${port}`;

  return {
    id,
    name: fn || service.name || host,
    host,
    port,
    ...(md ? { model: md } : {}),
  };
}


export interface CastManagerOptions {
  createClient?: () => CastClient;
}

type CastManagerEvents = {
  status: [CastStatus];
};

export class CastManager extends EventEmitter<CastManagerEvents> {
  private readonly createClient: () => CastClient;

  private bonjour?: Bonjour;
  private browser?: Browser;
  private readonly devices = new Map<string, CastDevice>();

  private client?: CastClient;
  private player?: CastPlayer;
  private device?: CastDevice;
  private pollTimer?: NodeJS.Timeout;
  private pollTicks = 0;
  private pollFailures = 0;
  private destroyed = false;
  private sessionLost?: Promise<never>;
  private loseSession?: (err: Error) => void;

  private current: CastStatus = disconnectedStatus();

  constructor(options: CastManagerOptions = {}) {
    super();
    this.createClient = options.createClient ?? (() => new (castv2Module().Client)());
  }


  async scan(timeoutMs = DEFAULT_SCAN_MS): Promise<CastDevice[]> {
    if (this.destroyed) return [];
    this.ensureBrowser();

    // Re-issue the PTR query so devices that missed (or ignored) the first one answer.
    try {
      this.browser?.update();
    } catch (err) {
      console.warn('[cast] mDNS query failed:', toError(err).message);
    }

    await delay(Math.max(0, timeoutMs));

    return this.knownDevices();
  }

  private ensureBrowser(): void {
    if (this.browser) return;

    // This callback only covers mdns.respond() failures. It does NOT cover the multicast-dns
    // emitter's own 'error' event, which is what fires when the UDP 5353 bind is refused
    // (EADDRINUSE when another mDNS responder holds the port, EACCES in a locked-down container).
    // Unhandled, that 'error' takes down the whole main process on the user's first cast scan.
    this.bonjour = new Bonjour(undefined, (err: unknown) => {
      console.warn('[cast] mDNS responder error:', toError(err).message);
    });

    // bonjour-service keeps the underlying multicast-dns instance on a TS-private field; it is
    // present at runtime and it is the only place the bind error can be caught.
    const mdns = (this.bonjour as unknown as { server?: { mdns?: NodeJS.EventEmitter } }).server?.mdns;
    mdns?.on('error', (err: unknown) => {
      console.warn('[cast] mDNS socket error, discovery unavailable:', toError(err).message);
      this.patch({ error: 'Device discovery is unavailable on this network.' });
    });

    const browser = this.bonjour.find({ type: 'googlecast' });
    browser.on('up', (service) => this.onServiceUp(service));
    browser.on('down', (service) => this.onServiceDown(service));
    browser.on('txt-update', (service) => this.onServiceUp(service));
    browser.on('srv-update', (service) => this.onServiceUp(service));
    this.browser = browser;
  }

  private onServiceUp(service: Service): void {
    const device = toCastDevice(service);
    if (device) this.devices.set(device.id, device);
  }

  private onServiceDown(service: Service): void {
    const device = toCastDevice(service);
    // Never drop the device we are actively casting to: a missed mDNS keep-alive is not
    // the same as a dead connection, and the socket is the real source of truth.
    if (device && device.id !== this.device?.id) this.devices.delete(device.id);
  }

  private knownDevices(): CastDevice[] {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }


  async connect(deviceId: string): Promise<CastStatus> {
    if (this.destroyed) throw new Error('Casting has been shut down.');

    let device = this.devices.get(deviceId);
    if (!device) {
      await this.scan(DEFAULT_SCAN_MS);
      device = this.devices.get(deviceId);
    }
    if (!device) throw new Error('That cast device is no longer on the network.');

    if (this.client) await this.disconnect();

    const client = this.createClient();
    this.client = client;
    this.device = device;

    // castv2 reports connect failures on the 'error' event, not through the callback, so
    // without this every failed connect would sit out the full 10s timeout. Racing each
    // request against it also means a device dying mid-LOAD fails in ms, not in 30s.
    this.sessionLost = new Promise<never>((_resolve, reject) => {
      this.loseSession = reject;
    });
    this.sessionLost.catch(() => undefined); // pre-attached: a lost race must not go unhandled

    // castv2 emits 'error' for socket errors AND for the heartbeat timeout that fires
    // ~15s after a device stops answering. An EventEmitter with no 'error' listener
    // throws, which would take down the main process, so attach before connecting.
    client.on('error', (err: unknown) => this.handleFailure(toError(err), client));
    client.on('close', () => this.handleFailure(new Error('Cast device closed the connection'), client));
    client.on('status', (status: CastReceiverStatus) => {
      if (this.client === client) this.applyReceiverStatus(status);
    });

    try {
      await this.request<void>('connect', CONNECT_TIMEOUT_MS, (cb) =>
        client.connect({ host: device.host, port: device.port }, () => cb(null)),
      );

      const player = await this.attachMediaReceiver(client);
      if (this.client !== client) throw new Error('Another cast connection replaced this one.');
      this.wirePlayer(client, player);

      this.patch({
        connected: true,
        device,
        state: 'IDLE',
        currentTime: 0,
        duration: undefined,
        title: undefined,
        error: undefined,
      });

      const receiverStatus = await this.request<CastReceiverStatus>('status', REQUEST_TIMEOUT_MS, (cb) =>
        client.getStatus(cb),
      ).catch(() => undefined);
      if (receiverStatus) this.applyReceiverStatus(receiverStatus);

      const mediaStatus = await this.request<CastMediaStatus>('media status', REQUEST_TIMEOUT_MS, (cb) =>
        player.getStatus(cb),
      ).catch(() => undefined);
      if (mediaStatus) this.applyMediaStatus(mediaStatus);

      this.startPolling();
      return this.status();
    } catch (err) {
      const error = toError(err);
      if (this.client === client) {
        this.teardown();
        this.replace(disconnectedStatus(error.message));
      }
      throw error;
    }
  }

  private request<T>(label: string, timeoutMs: number, fn: (cb: NodeCallback<T>) => void): Promise<T | undefined> {
    const call = invoke<T>(label, timeoutMs, fn);
    return this.sessionLost ? Promise.race([call, this.sessionLost]) : call;
  }

  private wirePlayer(client: CastClient, player: CastPlayer): void {
    player.on('status', (status: CastMediaStatus) => {
      if (this.player === player) this.applyMediaStatus(status);
    });
    player.on('error', (err: unknown) => this.handleFailure(toError(err), client));
    // The receiver app being stopped from the TV closes the application channel. The device is
    // still connected; only the app is gone, so keep `connected` and drop back to IDLE.
    player.on('close', () => {
      if (this.player === player) {
        this.player = undefined;
        this.patch({ state: 'IDLE', currentTime: 0, duration: undefined, title: undefined });
      }
    });
    this.player = player;
  }

  private async relaunchReceiver(client: CastClient): Promise<CastPlayer> {
    const player = await this.attachMediaReceiver(client);
    if (this.client !== client) throw new Error('Another cast connection replaced this one.');
    this.wirePlayer(client, player);
    return player;
  }

  private async attachMediaReceiver(client: CastClient): Promise<CastPlayer> {
    const app = castv2Module().DefaultMediaReceiver;

    const sessions = await this.request<CastSession[]>('sessions', REQUEST_TIMEOUT_MS, (cb) =>
      client.getSessions(cb),
    ).catch(() => undefined);

    const existing = sessions?.find((session) => session.appId === MEDIA_RECEIVER_APP_ID);
    if (existing) {
      const joined = await this.request<CastPlayer>('join', REQUEST_TIMEOUT_MS, (cb) =>
        client.join(existing, app, cb),
      );
      if (joined) return joined;
    }

    const launched = await this.request<CastPlayer>('launch', CONNECT_TIMEOUT_MS, (cb) =>
      client.launch(app, cb),
    );
    if (!launched) throw new Error('Chromecast did not return a media session');
    return launched;
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    const player = this.player;
    if (!client) {
      if (this.current.connected) this.replace(disconnectedStatus());
      return;
    }

    this.stopPolling();

    // Stop the receiver app rather than leaving it playing. The provider caps us at one
    // concurrent connection, so a Chromecast left streaming would block local playback.
    if (player) {
      await this.request<CastSession[]>('stop', REQUEST_TIMEOUT_MS, (cb) => client.stop(player, cb)).catch(
        (err: unknown) => console.warn('[cast] stop failed:', toError(err).message),
      );
    }

    this.teardown();
    this.replace(disconnectedStatus());
  }


  /**
   * Cast a resolved stream. `stream.url` is used verbatim and must be reachable *from the
   * Chromecast*, which is a separate box on the LAN, never `127.0.0.1`/`localhost`.
   *
   * The Default Media Receiver cannot demux Matroska (`container_extension` is `mkv` for ~99.8%
   * of this provider's movies) and cannot play a bare MPEG-TS; both land on IDLE/ERROR. Those
   * must come from the local remux proxy or as HLS from the local stream server.
   */
  async load(stream: ResolvedStream, startAt?: number): Promise<CastStatus> {
    const client = this.client;
    if (!client) throw new Error('Not connected to a cast device');
    const player = this.player ?? await this.relaunchReceiver(client);

    if (/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(stream.url)) {
      console.warn(
        `[cast] ${stream.url} is a loopback address; the cast device cannot reach it. ` +
          'Pass the LAN address of the local stream server instead.',
      );
    }

    const media: CastMedia = {
      contentId: stream.url,
      contentType: stream.mimeType,
      streamType: stream.kind === 'live' ? 'LIVE' : 'BUFFERED',
      metadata: {
        type: 0,
        metadataType: 0,
        title: stream.title,
        images: stream.image ? [{ url: stream.image }] : [],
      },
    };

    this.patch({
      title: stream.title,
      duration: stream.duration,
      currentTime: startAt ?? 0,
      state: 'BUFFERING',
      error: undefined,
    });

    let status: CastMediaStatus | undefined;
    try {
      status = await this.request<CastMediaStatus>('load', LOAD_TIMEOUT_MS, (cb) =>
        player.load(media, { autoplay: true, currentTime: startAt ?? 0 }, cb),
      );
    } catch (err) {
      const error = toError(err);
      if (this.current.connected) this.patch({ state: 'IDLE', error: error.message });
      throw error;
    }

    // Measured against a real receiver: the LOAD ack comes back with playerState IDLE and
    // currentTime 0 a beat before playback starts, so we drop an IDLE ack that carries no
    // idleReason. The broadcast that follows within ~1s carries the truth. An IDLE ack that *does*
    // carry a reason (ERROR) is real and must be applied.
    const uninformative = !status || (toPlayerState(status.playerState) === 'IDLE' && !status.idleReason);
    if (!uninformative) this.applyMediaStatus(status);

    this.pollFailures = 0;
    this.startPolling();
    return this.status();
  }

  async play(): Promise<void> {
    const player = await this.readyPlayer();
    const status = await this.request<CastMediaStatus>('play', REQUEST_TIMEOUT_MS, (cb) => player.play(cb));
    if (status) this.applyMediaStatus(status);
    else this.patch({ state: 'PLAYING' });
  }

  async pause(): Promise<void> {
    const player = await this.readyPlayer();
    const status = await this.request<CastMediaStatus>('pause', REQUEST_TIMEOUT_MS, (cb) => player.pause(cb));
    if (status) this.applyMediaStatus(status);
    else this.patch({ state: 'PAUSED' });
  }

  async seek(seconds: number): Promise<void> {
    if (!Number.isFinite(seconds)) throw new Error(`Invalid seek target: ${seconds}`);
    const target = Math.max(0, seconds);
    const player = await this.readyPlayer();
    const status = await this.request<CastMediaStatus>('seek', REQUEST_TIMEOUT_MS, (cb) =>
      player.seek(target, cb),
    );
    if (status) this.applyMediaStatus(status);
    else this.patch({ currentTime: target });
  }

  /** Device (receiver) volume, 0..1. Not just the current media session. */
  async setVolume(level: number): Promise<void> {
    const client = this.client;
    if (!client) throw new Error('Not connected to a cast device');
    const target = clampVolume(level);

    const volume = await this.request<{ level?: number; muted?: boolean }>('setVolume', REQUEST_TIMEOUT_MS, (cb) =>
      client.setVolume({ level: target }, cb),
    );

    this.patch({
      volume: typeof volume?.level === 'number' ? clampVolume(volume.level) : target,
      muted: typeof volume?.muted === 'boolean' ? volume.muted : this.current.muted,
    });
  }

  status(): CastStatus {
    return { ...this.current };
  }

  async shutdown(): Promise<void> {
    await this.disconnect().catch(() => undefined);
    this.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.teardown();
    this.current = disconnectedStatus();

    try {
      this.browser?.stop();
    } catch (err) {
      console.warn('[cast] browser stop failed:', toError(err).message);
    }
    try {
      this.bonjour?.destroy();
    } catch (err) {
      console.warn('[cast] bonjour destroy failed:', toError(err).message);
    }
    this.browser = undefined;
    this.bonjour = undefined;
    this.devices.clear();
    this.removeAllListeners();
  }


  /**
   * `play`/`pause`/`seek` need a `mediaSessionId`, which castv2 only learns from a status
   * message. It dereferences that id without a null check, throwing synchronously if we
   * are early. Fetch a status first when we joined a session and have not seen one yet.
   */
  private async readyPlayer(): Promise<CastPlayer> {
    const player = this.player;
    if (!this.client || !player) throw new Error('Not connected to a cast device');
    if (player.media?.currentSession) return player;

    const status = await this.request<CastMediaStatus>('media status', REQUEST_TIMEOUT_MS, (cb) =>
      player.getStatus(cb),
    );
    if (status) this.applyMediaStatus(status);
    if (!status?.mediaSessionId && !player.media?.currentSession) {
      throw new Error('Nothing is loaded on the cast device');
    }
    return player;
  }

  private applyMediaStatus(status: CastMediaStatus | undefined): void {
    if (!this.current.connected) return;

    if (!status) {
      this.patch({ state: 'IDLE', currentTime: 0 });
      return;
    }

    const duration =
      typeof status.media?.duration === 'number' && status.media.duration > 0
        ? status.media.duration
        : this.current.duration;
    const title = status.media?.metadata?.title ?? this.current.title;
    const state = toPlayerState(status.playerState);

    // A receiver that cannot fetch or demux the media does not fail the LOAD request; it
    // buffers, gives up, and lands on IDLE with idleReason ERROR. That is exactly what an
    // .mkv or an unreachable (loopback) URL looks like from here, so report it as an
    // error instead of a silent stop.
    const failed = state === 'IDLE' && status.idleReason === 'ERROR';

    this.patch({
      state,
      currentTime: typeof status.currentTime === 'number' ? status.currentTime : this.current.currentTime,
      duration,
      title,
      error: failed ? 'The cast device could not play this stream' : undefined,
    });
  }

  private applyReceiverStatus(status: CastReceiverStatus | undefined): void {
    if (!status || !this.current.connected) return;
    this.patch({
      volume: typeof status.volume?.level === 'number' ? clampVolume(status.volume.level) : this.current.volume,
      muted: typeof status.volume?.muted === 'boolean' ? status.volume.muted : this.current.muted,
    });
  }

  private patch(next: Partial<CastStatus>): void {
    this.replace({ ...this.current, ...next });
  }

  private replace(next: CastStatus): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.emit('status', { ...next });
  }


  private startPolling(): void {
    this.stopPolling();
    this.pollTicks = 0;
    const timer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
    timer.unref();
    this.pollTimer = timer;
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async poll(): Promise<void> {
    const client = this.client;
    if (!client || !this.current.connected) return;

    this.pollTicks += 1;
    try {
      const player = this.player;
      if (player) {
        const status = await this.request<CastMediaStatus>('media status', REQUEST_TIMEOUT_MS, (cb) =>
          player.getStatus(cb),
        );
        if (this.client === client) this.applyMediaStatus(status);
      }

      // Volume normally arrives on RECEIVER_STATUS broadcasts; this is the cheap backstop
      // for devices that only broadcast to the sender that made the change.
      if (!player || this.pollTicks % RECEIVER_POLL_EVERY === 0) {
        const receiver = await this.request<CastReceiverStatus>('status', REQUEST_TIMEOUT_MS, (cb) =>
          client.getStatus(cb),
        );
        if (this.client === client) this.applyReceiverStatus(receiver);
      }

      this.pollFailures = 0;
    } catch (err) {
      if (this.client !== client) return;
      this.pollFailures += 1;
      if (this.pollFailures >= MAX_POLL_FAILURES) {
        this.handleFailure(toError(err), client);
      }
    }
  }


  private handleFailure(err: Error, client: CastClient): void {
    if (this.client !== client) return;
    const wasConnected = this.current.connected;
    this.loseSession?.(err);
    this.teardown();
    this.replace(disconnectedStatus(err.message));
    if (wasConnected) console.warn('[cast] session lost:', err.message);
  }

  private teardown(): void {
    this.stopPolling();
    this.pollFailures = 0;
    this.loseSession?.(new Error('Cast session ended'));
    this.loseSession = undefined;
    this.sessionLost = undefined;

    const client = this.client;
    const player = this.player;
    this.client = undefined;
    this.player = undefined;
    this.device = undefined;

    if (player) {
      player.removeAllListeners();
      try {
        player.close();
      } catch {
      }
    }
    if (client) {
      client.removeAllListeners();
      // castv2-client's internal onerror lives on the low-level socket and survives this call; it
      // re-emits on the now listener-less sender, which would be an unhandled 'error' crash.
      client.on('error', () => undefined);
      // Guard: castv2's close() dereferences a socket it nulls out on 'close'.
      try {
        client.close();
      } catch {
      }
    }
  }
}

export default CastManager;
