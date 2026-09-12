/**
 * Chromium has no Matroska demuxer, so `<video src="...mkv">` fails outright; the streams are
 * H.264 + AAC, exactly what MP4 carries, so a stream copy into fragmented MP4 is enough.
 *
 * HARD CONSTRAINT: the provider allows max_connections = 1. Exactly one upstream stream may be open
 * at a time, so every start path first kills the previous ffmpeg (or aborts the previous proxy) and
 * waits for it to actually exit.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import type { MediaKind, PlaybackEngine } from '@shared/types';

import { transcodeLadder, type TranscodeProfile } from './encoders.js';

import { LiveTsSource, UpstreamError, describeUpstreamStatus } from './live-source.js';
import { redactText } from './redact.js';
import { VodSource } from './vod-source.js';
import { HlsProxy } from './hls-proxy.js';
import { parseInputInventory, subtitleOutputArgs, imageSubtitleFilter, type InputInventory } from './media-tracks.js';
import { chooseTracks, parsePlaybackPreferences, SubtitleStreamParser, type PlaybackPreferences, type TrackRequest, type TrackState, type CueEvent, type MediaTrack } from '../../shared/tracks';


/** The provider serves happily to VLC; some edges 403 unknown agents. */
const USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';
const FIRST_BYTE_TIMEOUT_MS = 30_000;
const HLS_READY_TIMEOUT_MS = 45_000;
const HLS_IDLE_TIMEOUT_MS = 60_000;
const PROXY_IDLE_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_ENTRIES = 200;
const STDERR_LIMIT = 4_000;

const SEGMENT_NAME = /^[A-Za-z0-9._-]+\.(?:ts|m4s|m3u8)$/;
/** `.invalid` is reserved by RFC 2606: guaranteed never to resolve, on-line or off. */
const PROBE_URL = 'http://xiptv-ffmpeg-probe.invalid/';
const FFMPEG_PROBE_TIMEOUT_MS = 6_000;
const KILL_WAIT_TIMEOUT_MS = 10_000;


const liveProcesses = new Set<ChildProcess>();
const liveTempDirs = new Set<string>();
let exitHookInstalled = false;
let signalHooksInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  installSignalHooks();
  // 'exit' handlers must be synchronous. SIGKILL and rmSync both are.
  process.on('exit', sweepLiveProcesses);
}

function sweepLiveProcesses(): void {
  for (const proc of liveProcesses) {
    try {
      proc.kill('SIGKILL');
    } catch {}
  }
  for (const dir of liveTempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

/** Node does not run 'exit' handlers for a default-handled SIGTERM/SIGINT/SIGHUP. */
function installSignalHooks(): void {
  if (signalHooksInstalled) return;
  signalHooksInstalled = true;
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      sweepLiveProcesses();
      process.kill(process.pid, signal);
    });
  }
}

function terminate(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.kill('SIGTERM');
  } catch {
    return;
  }
  // A client that walked away leaves stdout paused mid-backpressure, which blocks ffmpeg in write()
  // and stops the pipe from ever closing. Drop it so ffmpeg takes EPIPE and really goes away.
  proc.stdout?.destroy();
  const hardKill = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {}
  }, 1_500);
  hardKill.unref();
  proc.once('exit', () => clearTimeout(hardKill));
}


let ffmpegPath: string | null = null;

/**
 * The hardware-capable build vendored by scripts/fetch-ffmpeg.mjs, if this platform has one.
 * Preferred over ffmpeg-static because that build has no hardware encoders at all and cannot demux
 * MPEG-TS. See the module header on scripts/fetch-ffmpeg.mjs.
 */
function vendoredFfmpeg(): string | null {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'ffmpeg', exe) : undefined,
    join(process.cwd(), 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`, exe),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveFfmpegPath(): string {
  if (ffmpegPath) return ffmpegPath;
  ffmpegPath = vendoredFfmpeg();
  if (ffmpegPath) return ffmpegPath;
  const bundled: string | null = ffmpegStatic;
  if (bundled) {
    const unpacked = bundled.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
    if (existsSync(unpacked)) ffmpegPath = unpacked;
    else if (existsSync(bundled)) ffmpegPath = bundled;
  }
  ffmpegPath ??= 'ffmpeg';
  return ffmpegPath;
}

let ffmpegProbe: Promise<void> | null = null;
const crashedAtRuntime = new Set<string>();

function noteFfmpegCrash(bin: string): void {
  if (crashedAtRuntime.has(bin)) return;
  crashedAtRuntime.add(bin);
  ffmpegProbe = null;
}

/**
 * A bundled static ffmpeg can be unusable in two independent ways, and we have hit both with
 * ffmpeg-static 7.0.2 (johnvansickle):
 *
 * 1. HOSTNAMES. glibc resolves names through dlopen-ed NSS modules. On a host whose
 *    /etc/nsswitch.conf lists a module the static build cannot load (`mdns4_minimal` is the usual
 *    culprit) ffmpeg segfaults the moment it has to resolve a name.
 *
 * 2. THE MPEG-TS DEMUXER. The same build segfaults reading *any* MPEG-TS input, whether H.264 or
 *    HEVC, local file or network. mp4, mkv and stdin all read fine. The build *muxes* TS
 *    correctly, so the probe writes a short clip with the binary and reads it back with it.
 */
function ensureUsableFfmpeg(): Promise<void> {
  ffmpegProbe ??= (async () => {
    const bundled = resolveFfmpegPath();
    if (bundled === 'ffmpeg') return;
    if (await isUsableFfmpeg(bundled)) return;
    if (await isUsableFfmpeg('ffmpeg')) ffmpegPath = 'ffmpeg';
  })();
  return ffmpegProbe;
}

async function isUsableFfmpeg(bin: string): Promise<boolean> {
  if (crashedAtRuntime.has(bin)) return false;
  if ((await resolvesHostnamesWithoutCrashing(bin)) === 'failed') return false;
  if ((await demuxesMpegTsWithoutCrashing(bin)) === 'failed') return false;
  return true;
}

type ProbeResult = 'ok' | 'failed' | 'untestable';

interface ProbeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function runProbe(bin: string, args: string[]): Promise<ProbeExit> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: Timer | undefined;
    const settle = (exit: ProbeExit): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(exit);
    };
    let proc: ChildProcess;
    try {
      proc = spawn(bin, args, { stdio: 'ignore' });
    } catch {
      resolve({ code: null, signal: 'SIGKILL' });
      return;
    }
    timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      settle({ code: null, signal: 'SIGKILL' });
    }, FFMPEG_PROBE_TIMEOUT_MS);
    timer.unref();
    proc.once('error', () => settle({ code: null, signal: 'SIGKILL' }));
    proc.once('close', (code, signal) => settle({ code, signal }));
  });
}

async function resolvesHostnamesWithoutCrashing(bin: string): Promise<ProbeResult> {
  // A healthy ffmpeg reports "Failed to resolve hostname" and exits non-zero but normally; a broken
  // static build never gets that far and dies on a signal. So only the signal is meaningful here.
  const { signal } = await runProbe(bin, ['-hide_banner', '-loglevel', 'quiet', '-i', PROBE_URL, '-f', 'null', '-']);
  return signal === null ? 'ok' : 'failed';
}

async function demuxesMpegTsWithoutCrashing(bin: string): Promise<ProbeResult> {
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), 'xiptv-tsprobe-'));
  } catch {
    return 'untestable';
  }
  const sample = join(dir, 'probe.ts');
  try {
    const wrote = await runProbe(bin, [
      '-hide_banner', '-loglevel', 'quiet',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-t', '0.4',
      '-f', 'mpegts', '-y', sample,
    ]);
    if (wrote.code !== 0 || wrote.signal !== null) return 'failed';
    const read = await runProbe(bin, [
      '-hide_banner', '-loglevel', 'quiet',
      '-f', 'mpegts', '-i', sample, '-c', 'copy', '-f', 'null', '-',
    ]);
    return read.code === 0 && read.signal === null ? 'ok' : 'failed';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


export interface RegisterOptions {
  forceTranscode?: boolean;
  directUrl: string;
  kind: MediaKind;
  container?: string;
  title: string;
  durationSecs?: number;
}

export interface RegisteredStream {
  token: string;
  remuxUrl: string;
  transcodeUrl: string;
  hlsUrl: string;
  directProxyUrl: string;
}

function normaliseContainer(container?: string): string {
  if (!container) return '';
  let value = container.trim().toLowerCase();
  const query = value.indexOf('?');
  if (query !== -1) value = value.slice(0, query);
  const dot = value.lastIndexOf('.');
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (dot > slash) value = value.slice(dot + 1);
  else if (slash !== -1) value = value.slice(slash + 1);
  return value.replace(/[^a-z0-9]/g, '');
}

const NATIVE_CONTAINERS = new Set(['mp4', 'm4v', 'webm']);
const MPEGTS_CONTAINERS = new Set(['ts', 'mpegts', 'm2ts', 'mts', 'trp']);

function isMpegTsContainer(container?: string): boolean {
  return MPEGTS_CONTAINERS.has(normaliseContainer(container));
}

export function pickPlaybackEngine(kind: MediaKind, container?: string): PlaybackEngine {
  const ext = normaliseContainer(container);
  if (ext === 'm3u8' || ext === 'm3u') return 'hls';
  if (kind === 'live') return 'mpegts';
  if (NATIVE_CONTAINERS.has(ext)) return 'native';
  // mkv, avi, mov, ts, or unknown: Chromium cannot demux it, so go through the remux proxy.
  return 'remux';
}

const MIME_BY_CONTAINER: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  mpegts: 'video/mp2t',
  m2ts: 'video/mp2t',
  m3u8: 'application/vnd.apple.mpegurl',
  m3u: 'application/vnd.apple.mpegurl',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
};

export function mimeForContainer(container?: string): string {
  return MIME_BY_CONTAINER[normaliseContainer(container)] ?? 'video/mp4';
}


/**
 * Chromium refuses the *stream*, not a track: an H.264 video with AC-3 audio is rejected on the
 * audio alone. Learned from ffmpeg's own stderr rather than probed, because the provider allows one
 * connection at a time and a probe pass would have to open a whole extra one before playback.
 */
interface InputTracks {
  /** Demuxer name, e.g. `mpegts`. Decides whether copied AAC needs the ADTS->ASC filter. */
  format?: string;
  video?: { codec: string; profile?: string };
  audio?: { codec?: string; profile?: string };
}

const LEARNED_LIMIT = 200;

/** ffmpeg's `Duration: 01:52:33.12` line names the whole input even when started with `-ss`. */
function parseDuration(text: string): number | undefined {
  const m = /Duration: (\d+):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(text);
  if (!m) return undefined;
  const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4] ?? '0'}`);
  return secs > 0 ? secs : undefined;
}

/**
 * Chromium's `isTypeSupported` answers yes for H.264 High 10 and the 4:2:2/4:4:4 profiles, then
 * fails to decode some of them for real, so those are re-encoded rather than copied.
 */
function canCopyVideo(track: InputTracks['video']): boolean {
  if (track?.codec !== 'h264') return false;
  return !/10|422|444/.test(track.profile ?? '');
}

/** AAC is the one audio codec Chromium takes that IPTV actually ships. */
function canCopyAudio(track: InputTracks['audio']): boolean {
  return track?.codec === 'aac';
}

interface StreamEntry {
  forceTranscode?: boolean;
  trackGeneration?: number;
  cancelled?: boolean;
  inventory?: InputInventory;
  trackError?: string;
  audioId?: string;
  subtitleId?: string;
  captionDelay?: number;
  token: string;
  directUrl: string;
  kind: MediaKind;
  container?: string;
  title: string;
  durationSecs?: number;
}

/**
 * Live MPEG-TS over http goes through LiveTsSource instead of ffmpeg's own client, which replays
 * the provider's buffer after every drop. Anything else, VOD included, stays on ffmpeg.
 */
function isLivePassthrough(entry: StreamEntry): boolean {
  return entry.kind === 'live' && isMpegTsContainer(entry.container) && /^https?:/i.test(entry.directUrl);
}

/** A film or episode Chromium plays as-is, which is read ahead through VodSource. */
function isVodFile(entry: StreamEntry): boolean {
  return entry.kind !== 'live'
    && NATIVE_CONTAINERS.has(normaliseContainer(entry.container))
    && /^https?:/i.test(entry.directUrl);
}

interface ActiveBase {
  token: string;
  generation: number;
  proc: ChildProcess;
  offset: number;
  exited: Promise<void>;
  stderr: () => string;
}

type Timer = ReturnType<typeof setTimeout>;

type TranscodeAttempt =
  | { status: 'streaming' }
  | { status: 'abandoned' }
  | { status: 'failed'; why: string };

type ActiveStream =
  | (ActiveBase & { mode: 'remux' })
  | (ActiveBase & { mode: 'transcode' })
  | (ActiveBase & { mode: 'hls'; dir: string; idleTimer: Timer });

export class StreamServer {
  #server: Server | null = null;
  #port = 0;
  readonly #entries = new Map<string, StreamEntry>();
  #active: ActiveStream | null = null;
  #generation = 0;
  #probe: { token: string; proc: ChildProcess } | null = null;
  #hlsProxy: { token: string; generation?: number; proxy: HlsProxy } | null = null;
  onCues?: (event: CueEvent) => void;
  onTracks?: (state: TrackState) => void;
  #activeProxy: ClientRequest | null = null;
  #directToken?: string;
  #activeSource: LiveTsSource | null = null;
  #vod: { token: string; source: VodSource; dir: string } | null = null;
  #gate: Promise<unknown> = Promise.resolve();
  #cachedLan: string | null = null;
  #lastError: string | undefined;
  readonly #learned = new Map<string, InputTracks>();


  async start(): Promise<{ port: number; lanUrl: string }> {
    if (this.#server && this.#port) {
      return { port: this.#port, lanUrl: `http://${this.lanAddress}:${this.#port}` };
    }
    installExitHook();
    void ensureUsableFfmpeg();

    const server = createServer((req, res) => {
      this.#handle(req, res).catch((err: unknown) => {
        respondError(res, 500, err instanceof Error ? err.message : 'internal error');
      });
    });
    // Long-lived media responses must never be cut by a server-side idle timer.
    server.timeout = 0;
    server.keepAliveTimeout = 30_000;
    server.headersTimeout = 60_000;

    const port = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      // Bound on 0.0.0.0 so a Chromecast on the LAN can reach /hls.
      server.listen(0, '0.0.0.0', () => {
        server.removeListener('error', onError);
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('stream server bound to a non-TCP address'));
          return;
        }
        resolve(address.port);
      });
    });

    this.#server = server;
    this.#port = port;
    return { port, lanUrl: `http://${this.lanAddress}:${port}` };
  }

  async stop(): Promise<void> {
    await this.#serialize(() => this.#killActive());
    await this.#abortProxy();
    const server = this.#server;
    this.#server = null;
    this.#port = 0;
    this.#entries.clear();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // close() waits for open sockets; media responses are long-lived, so cut them loose.
      server.closeAllConnections();
    });
  }


  register(opts: RegisterOptions): RegisteredStream {
    this.#lastError = undefined;
    if (!this.#server || !this.#port) {
      throw new Error('StreamServer.register() called before start()');
    }
    const token = randomBytes(16).toString('hex');
    this.#entries.set(token, {
      token,
      forceTranscode: opts.forceTranscode,
      directUrl: opts.directUrl,
      kind: opts.kind,
      container: opts.container,
      title: opts.title,
      durationSecs: opts.durationSecs,
    });
    this.#pruneEntries();

    // The renderer talks to loopback; only the Chromecast needs a routable LAN address.
    const local = `http://127.0.0.1:${this.#port}`;
    const lan = `http://${this.lanAddress}:${this.#port}`;
    return {
      token,
      remuxUrl: `${local}/remux/${token}`,
      transcodeUrl: `${local}/transcode/${token}`,
      hlsUrl: `${lan}/hls/${token}/index.m3u8`,
      directProxyUrl: `${local}/direct/${token}`,
    };
  }

  #pruneEntries(): void {
    if (this.#entries.size <= MAX_ENTRIES) return;
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= MAX_ENTRIES) break;
      if (key === this.#active?.token) continue;
      this.#entries.delete(key);
    }
  }


  async stopStream(): Promise<void> {
    if (this.#probe) terminate(this.#probe.proc);
    await this.#serialize(() => this.#killActive());
  }

  async cancelTracks(token: string, generation: number): Promise<void> {
    const entry = this.#entries.get(token);
    if (!entry || entry.trackGeneration !== generation) return;
    entry.cancelled = true;
    if (this.#probe?.token === token) terminate(this.#probe.proc);
    if (this.#active?.token === token) terminate(this.#active.proc);
    await this.#serialize(async () => {
      if (entry.trackGeneration !== generation || !entry.cancelled) return;
      if (this.#active?.token === token || this.#vod?.token === token || this.#hlsProxy?.token === token || this.#directToken === token) await this.#killActive();
    });
  }

  async prepareTracks(req: TrackRequest, prefs: PlaybackPreferences): Promise<{ state: TrackState; url: string; engine: PlaybackEngine; localHls: boolean; duration?: number }> {
    const entry = this.#entries.get(req.sessionId);
    if (!entry || !Number.isSafeInteger(req.generation) || req.generation <= (entry.trackGeneration ?? -1)) throw new Error('Expired playback session');
    entry.trackGeneration = req.generation;
    entry.cancelled = false;
    if (this.#probe) terminate(this.#probe.proc);
    if (this.#active) terminate(this.#active.proc);
    return this.#serialize(async () => {
      if (entry.trackGeneration !== req.generation || entry.cancelled) throw new Error('Expired playback session');
      await this.#killActive();
      const providerHls = pickPlaybackEngine(entry.kind, entry.container) === 'hls' && !entry.forceTranscode;
      if (!providerHls && (!entry.inventory || req.retry)) {
        this.onTracks?.({ sessionId: entry.token, generation: req.generation, tracks: [], status: 'discovering' });
        await ensureUsableFfmpeg();
        if (entry.trackGeneration !== req.generation || entry.cancelled) throw new Error('Expired playback session');
        const input = ffmpegInput(entry, 0);
        const { proc, exited } = spawnFfmpeg([...input.options, '-probesize', '5M', '-analyzeduration', '3000000', ...input.input], { stdout: 'ignore', stdin: input.stdin });
        this.#probe = { token: entry.token, proc };
        let header = '';
        proc.stderr?.on('data', chunk => { if (header.length < 131072) header += String(chunk); });
        const drained = new Promise<void>(resolve => proc.once('close', resolve));
        const timeout = setTimeout(() => terminate(proc), 8000);
        await exited;
        await drained;
        clearTimeout(timeout);
        if (this.#probe?.proc === proc) this.#probe = null;
        if (entry.trackGeneration !== req.generation || entry.cancelled) throw new Error('Expired playback session');
        const inventory = parseInputInventory(header);
        if (inventory.video || inventory.tracks.length) {
          entry.inventory = inventory;
          entry.durationSecs ??= inventory.duration;
          entry.trackError = undefined;
        } else entry.trackError = 'Track information unavailable';
      }
      const tracks = entry.inventory?.tracks ?? [];
      const requestedPreferences = parsePlaybackPreferences({ ...prefs, audioLanguage: req.audioLanguage ?? prefs.audioLanguage, captionLanguage: req.subtitleLanguage ?? prefs.captionLanguage, captionMode: req.subtitleLanguage ? 'on' : prefs.captionMode });
      const defaults = chooseTracks(tracks, requestedPreferences);
      const audioId = req.audioId ?? defaults.audioId;
      const subtitleId = req.subtitleId === null ? undefined : req.subtitleId ?? defaults.subtitleId;
      for (const [id, kind] of [[audioId, 'audio'], [subtitleId, 'subtitle']] as const) {
        if (id && !tracks.some(t => t.id === id && t.kind === kind && t.supported)) throw new Error('That track is not available');
      }
      entry.audioId = audioId;
      entry.subtitleId = subtitleId;
      entry.captionDelay = Number.isFinite(req.captionDelay) ? Math.max(-10, Math.min(10, req.captionDelay)) : 0;
      const selectedAudio = tracks.find(t => t.id === audioId);
      const defaultAudio = tracks.find(t => t.kind === 'audio');
      let engine = pickPlaybackEngine(entry.kind, entry.container);
      const localHls = engine === 'mpegts';
      if (localHls) engine = 'hls';
      else if (!providerHls && (engine !== 'native' || subtitleId || selectedAudio?.id !== defaultAudio?.id || (selectedAudio && !canCopyAudio(selectedAudio)))) {
        engine = this.#copyPlan(entry).video && this.#copyPlan(entry).audio && !this.#subtitle(entry)?.image ? 'remux' : 'transcode';
      }
      if (entry.forceTranscode && !localHls) engine = 'transcode';
      const route = providerHls ? 'manifest/0' : localHls ? 'hls/index.m3u8' : engine === 'remux' || engine === 'transcode' ? engine : 'direct';
      const url = `http://127.0.0.1:${this.#port}/session/${entry.token}/${req.generation}/${route}`;
      const state: TrackState = { sessionId: entry.token, generation: req.generation, tracks, audioId, subtitleId, status: entry.trackError ? 'error' : 'ready', error: entry.trackError };
      this.onTracks?.(state);
      return { state, url, engine, localHls, duration: entry.durationSecs };
    });
  }

  #subtitle(entry: StreamEntry): MediaTrack | undefined { return entry.inventory?.tracks.find(t => t.id === entry.subtitleId); }
  #validEntry(entry: StreamEntry): boolean { return entry.trackGeneration === undefined || (!this.#entries.get(entry.token)?.cancelled && this.#entries.get(entry.token)?.trackGeneration === entry.trackGeneration); }
  #audioMap(entry: StreamEntry): string { const t = entry.inventory?.tracks.find(t => t.id === entry.audioId); return t ? `0:${t.index}` : '0:a:0?'; }
  #wireCues(entry: StreamEntry, proc: ChildProcess): void {
    const pipe = proc.stdio[3];
    if (!pipe || !('setEncoding' in pipe)) return;
    const parser = new SubtitleStreamParser();
    this.onCues?.({ sessionId: entry.token, generation: entry.trackGeneration ?? 0, cues: [], reset: true });
    const emit = (cues: CueEvent['cues']) => {
      if (cues.length && this.#validEntry(entry)) this.onCues?.({ sessionId: entry.token, generation: entry.trackGeneration ?? 0, cues });
    };
    pipe.setEncoding('utf8');
    pipe.on('data', (chunk: string) => emit(parser.push(chunk)));
    pipe.on('end', () => emit(parser.push('', true)));
    pipe.on('error', () => undefined);
  }

  #killIfActive(generation: number): void {
    void this.#serialize(async () => {
      if (this.#active?.generation === generation) await this.#killActive();
    });
  }

  lastError(): string | undefined {
    return this.#lastError;
  }

  /** Full length of the stream being served, from the provider or from ffmpeg's input header. */
  streamDuration(): number | undefined {
    const active = this.#active;
    return active ? this.#entries.get(active.token)?.durationSecs : undefined;
  }

  #learnDuration(entry: StreamEntry, proc: ChildProcess): void {
    const stderr = proc.stderr;
    if (entry.durationSecs !== undefined || !stderr) return;
    let header = '';
    const onData = (chunk: string): void => {
      header += chunk;
      const secs = parseDuration(header);
      if (secs !== undefined) {
        stderr.off('data', onData);
        entry.durationSecs = secs;
      } else if (header.length > 8192) {
        stderr.off('data', onData);
      }
    };
    stderr.on('data', onData);
  }

  get lanAddress(): string {
    if (this.#cachedLan) return this.#cachedLan;
    this.#cachedLan = detectLanAddress();
    return this.#cachedLan;
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#gate.then(fn, fn);
    this.#gate = run.catch(() => undefined);
    return run;
  }

  #clearWhenExited(active: ActiveStream): void {
    void active.exited.then(() => {
      if (this.#active?.generation !== active.generation) return;
      if (active.mode !== 'hls') this.#active = null;
    });
  }

  async #killActive(): Promise<void> {
    // A /direct passthrough consumes the provider's single allowed connection just as an ffmpeg
    // does, so releasing the slot has to cover both.
    await this.#abortProxy();
    const active = this.#active;
    this.#active = null;
    if (!active) return;
    if (active.mode === 'hls') clearTimeout(active.idleTimer);
    terminate(active.proc);
    // The provider will not hand out a second connection until this one is really gone.
    await Promise.race([active.exited, delay(KILL_WAIT_TIMEOUT_MS)]);
    if (active.mode === 'hls') {
      liveTempDirs.delete(active.dir);
      rmSync(active.dir, { recursive: true, force: true });
    }
  }

  async #abortProxy(): Promise<void> {
    const hls = this.#hlsProxy;
    this.#hlsProxy = null;
    if (hls) await hls.proxy.close();
    const proxy = this.#activeProxy;
    this.#activeProxy = null;
    if (proxy) { const closed = proxy.closed ? Promise.resolve() : new Promise<void>(resolve => proxy.once('close', resolve)); proxy.destroy(); await closed; }
    this.#directToken = undefined;
    const source = this.#activeSource;
    this.#activeSource = null;
    if (source) { const closed = source.closed ? Promise.resolve() : new Promise<void>(resolve => source.once('close', resolve)); source.destroy(); await closed; }
    const vod = this.#vod;
    this.#vod = null;
    if (vod) {
      await vod.source.destroy().then(() => {
        liveTempDirs.delete(vod.dir);
        rmSync(vod.dir, { recursive: true, force: true });
      });
    }
  }


  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respondError(res, 405, 'method not allowed');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) {
      respondError(res, 404, 'not found');
      return;
    }

    let [route, token, ...rest] = parts;
    let requestedGeneration: number | undefined;
    if (route === 'session') {
      requestedGeneration = Number(rest.shift());
      route = rest.shift() ?? '';
    }
    // Tokens are 128-bit random hex handed out by register(); an unknown one gets nothing, so a
    // stray LAN device cannot enumerate what the user is watching.
    const stored = token ? this.#entries.get(token) : undefined;
    const entry = stored ? requestedGeneration === undefined ? { ...stored, trackGeneration: undefined, cancelled: false, audioId: undefined, subtitleId: undefined } : { ...stored } : undefined;
    if (!entry) {
      respondError(res, 404, 'unknown stream token');
      return;
    }

    if (requestedGeneration !== undefined && (requestedGeneration !== entry.trackGeneration || entry.cancelled)) { respondError(res, 410, 'expired session'); return; }

    const seek = parseSeek(url.searchParams.get('t'));

    switch (route) {
      case 'manifest': {
        const proxy = await this.#serialize(async () => {
          if (!this.#validEntry(entry)) return null;
          if (this.#hlsProxy?.token === entry.token && this.#hlsProxy.generation === entry.trackGeneration) return this.#hlsProxy.proxy;
          await this.#killActive();
          const proxy = new HlsProxy(entry.directUrl, `/session/${entry.token}/${entry.trackGeneration}/manifest`);
          this.#hlsProxy = { token: entry.token, generation: entry.trackGeneration, proxy };
          return proxy;
        });
        if (proxy) await proxy.serve(rest[0] ?? '0', req, res); else respondError(res, 410, 'expired session');
        return;
      }
      case 'remux':
        await this.#serveRemux(entry, seek, req, res);
        return;
      case 'transcode':
        await this.#serveTranscode(entry, seek, req, res);
        return;
      case 'hls':
        await this.#serveHls(entry, seek, rest, req, res);
        return;
      case 'direct':
        await this.#serveDirect(entry, req, res);
        return;
      default:
        respondError(res, 404, 'not found');
    }
  }


  async #serveRemux(
    entry: StreamEntry,
    seek: number,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method === 'HEAD') {
      res.writeHead(200, remuxHeaders()).end();
      return;
    }

    await ensureUsableFfmpeg();
    const active = await this.#serialize(async () => {
      if (!this.#validEntry(entry)) return null;
      await this.#killActive();
      if (res.destroyed) return null;
      return this.#spawnRemux(entry, seek);
    });
    if (!active) return;

    const { proc } = active;
    const stdout = proc.stdout;
    if (!stdout) {
      respondError(res, 500, 'ffmpeg produced no stdout');
      return;
    }

    let headersSent = false;
    const firstByteTimer = setTimeout(() => {
      if (headersSent) return;
      respondError(res, 504, 'upstream produced no data');
      this.#killIfActive(active.generation);
    }, FIRST_BYTE_TIMEOUT_MS);

    stdout.on('data', (chunk: Buffer) => {
      // The first-byte timeout may already have answered 504; writing a second set of headers
      // throws synchronously inside this listener and takes the main process down.
      if (res.writableEnded || res.destroyed) return;
      if (!headersSent) {
        if (res.headersSent) return;
        headersSent = true;
        clearTimeout(firstByteTimer);
        res.writeHead(200, remuxHeaders());
      }
      if (!res.write(chunk)) stdout.pause();
    });
    res.on('drain', () => stdout.resume());
    stdout.on('end', () => {
      if (headersSent && !res.writableEnded) res.end();
    });

    proc.once('close', () => {
      clearTimeout(firstByteTimer);
      if (!headersSent) {
        respondError(res, 502, `ffmpeg failed: ${active.stderr().slice(-500) || 'no output'}`);
        return;
      }
      if (!res.writableEnded) res.end();
    });

    res.on('close', () => {
      clearTimeout(firstByteTimer);
      this.#killIfActive(active.generation);
    });
  }

  /**
   * A rung that dies before its first byte is a driver that lied about what it supports, so demote
   * and retry.
   */
  async #serveTranscode(
    entry: StreamEntry,
    seek: number,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method === 'HEAD') {
      res.writeHead(200, remuxHeaders()).end();
      return;
    }

    await ensureUsableFfmpeg();
    const ladder = await transcodeLadder(resolveFfmpegPath());
    const failures: string[] = [];

    // When the video track is being copied the encoder is never invoked, so every rung would build
    // the exact same command; walking them would just retry an identical failure six times.
    const compatible = this.#subtitle(entry)?.image ? ladder.filter(p => !p.inputArgs.includes('-hwaccel_output_format') && !p.videoArgs.includes('-vf')) : ladder;
    const rungs = this.#copyPlan(entry).video ? compatible.slice(0, 1) : compatible;

    for (const profile of rungs) {
      if (res.destroyed) return;
      const attempt = await this.#attemptTranscode(entry, seek, profile, res);
      if (attempt.status === 'streaming') {
        console.log(`[stream] transcoding via ${profile.label}`);
        return;
      }
      if (attempt.status === 'abandoned') return;
      console.warn(`[stream] encoder ${profile.id} failed: ${attempt.why}`);
      failures.push(`${profile.id}: ${attempt.why}`);
    }

    if (!res.headersSent) {
      respondError(res, 502, `no usable encoder. ${failures.join('; ') || 'ladder empty'}`);
    }
  }

  async #attemptTranscode(
    entry: StreamEntry,
    seek: number,
    profile: TranscodeProfile,
    res: ServerResponse,
  ): Promise<TranscodeAttempt> {
    const active = await this.#serialize(async () => {
      if (!this.#validEntry(entry)) return null;
      await this.#killActive();
      if (res.destroyed) return null;
      return this.#spawnTranscode(entry, seek, profile);
    });
    if (!active) return { status: 'abandoned' };

    const stdout = active.proc.stdout;
    if (!stdout) {
      this.#killIfActive(active.generation);
      return { status: 'failed', why: 'ffmpeg produced no stdout' };
    }

    return await new Promise<TranscodeAttempt>((resolve) => {
      let settled = false;
      let headersSent = false;

      const onDrain = (): void => {
        stdout.resume();
      };
      const onClientClose = (): void => {
        clearTimeout(firstByteTimer);
        this.#killIfActive(active.generation);
        settle({ status: 'abandoned' });
      };
      const cleanup = (): void => {
        res.off('drain', onDrain);
        res.off('close', onClientClose);
      };
      const settle = (attempt: TranscodeAttempt): void => {
        if (settled) return;
        settled = true;
        if (attempt.status !== 'streaming') cleanup();
        resolve(attempt);
      };

      const firstByteTimer = setTimeout(() => {
        if (headersSent) return;
        this.#killIfActive(active.generation);
        settle({ status: 'failed', why: 'produced no data' });
      }, FIRST_BYTE_TIMEOUT_MS);

      stdout.on('data', (chunk: Buffer) => {
        if (res.writableEnded || res.destroyed) return;
        if (!headersSent) {
          if (res.headersSent) return;
          headersSent = true;
          clearTimeout(firstByteTimer);
          res.writeHead(200, remuxHeaders());
          settle({ status: 'streaming' });
        }
        if (!res.write(chunk)) stdout.pause();
      });
      res.on('drain', onDrain);
      stdout.on('end', () => {
        if (headersSent && !res.writableEnded) res.end();
      });

      active.proc.once('close', () => {
        clearTimeout(firstByteTimer);
        if (!headersSent) {
          settle({ status: 'failed', why: active.stderr().slice(-200).trim() || 'exited silently' });
          return;
        }
        if (!res.writableEnded) res.end();
      });

      res.on('close', onClientClose);
    });
  }

  #copyPlan(entry: StreamEntry): { video: boolean; audio: boolean; format?: string } {
    const tracks = entry.inventory ? { video: entry.inventory.video, audio: entry.inventory.tracks.find(t => t.id === entry.audioId), format: entry.inventory.format } : this.#learned.get(entry.directUrl);
    return {
      video: !entry.forceTranscode && !this.#subtitle(entry)?.image && canCopyVideo(tracks?.video),
      audio: canCopyAudio(tracks?.audio),
      format: tracks?.format,
    };
  }

  #learnTracks(url: string, proc: ChildProcess): void {
    let header = '';
    proc.stderr?.on('data', (chunk: string) => {
      if (header.length > 131072) return;
      header += chunk;
      const inventory = parseInputInventory(header);
      if (inventory.video) {
        this.#learned.set(url, { video: inventory.video, audio: inventory.tracks.find(t => t.kind === 'audio'), format: inventory.format });
        if (this.#learned.size > LEARNED_LIMIT) this.#learned.delete(this.#learned.keys().next().value!);
      }
    });
  }

  #spawnTranscode(entry: StreamEntry, seek: number, profile: TranscodeProfile): ActiveStream {
    const plan = this.#copyPlan(entry);
    // Copying video means no decode either, so the hardware decode flags come off with it.
    const videoArgs = plan.video ? ['-c:v', 'copy'] : [...profile.videoArgs];
    const bitmap = this.#subtitle(entry)?.image ? this.#subtitle(entry) : undefined;
    const inputArgs = plan.video || bitmap ? [] : profile.inputArgs;
    const audioArgs = plan.audio
      ? [
          '-c:a',
          'copy',
          // Keyed off the demuxer ffmpeg reported rather than the URL extension.
          ...(plan.format === 'mpegts' ? ['-bsf:a', 'aac_adtstoasc'] : []),
        ]
      : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'];

    const input = ffmpegInput(entry, seek);
    const args = [
      ...input.options,
      // Under ffmpeg's default 5 MB / 5 s stream analysis this dominates startup. Deliberately NOT
      // paired with `-fflags +nobuffer -flags low_delay`, which starts mid-GOP and pays for it with
      // duplicated frames and "Could not find ref" decode errors.
      '-probesize',
      '1M',
      '-analyzeduration',
      '1000000',
      ...inputArgs,
      ...input.input,
      ...(bitmap ? ['-filter_complex', imageSubtitleFilter(bitmap, entry.captionDelay ?? 0), '-map', '[v]'] : ['-map', '0:v:0']),
      '-map',
      this.#audioMap(entry),
      ...videoArgs,
      ...audioArgs,
      '-dn',
      '-sn',
      '-map_chapters',
      '-1',
      // A live TS with jittery timestamps can otherwise stall the muxer waiting to interleave.
      '-max_muxing_queue_size',
      '1024',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1',
      ...subtitleOutputArgs(this.#subtitle(entry)),
    ];

    const { proc, exited, stderr } = spawnFfmpeg(args, { stdout: 'pipe', stdin: input.stdin, subtitles: !!this.#subtitle(entry) && !this.#subtitle(entry)?.image });
    this.#learnTracks(entry.directUrl, proc);
    this.#learnDuration(entry, proc);
    this.#wireCues(entry, proc);
    const active: ActiveStream = {
      mode: 'transcode',
      token: entry.token,
      generation: ++this.#generation,
      proc,
      offset: seek,
      exited,
      stderr,
    };
    this.#active = active;
    this.#clearWhenExited(active);
    return active;
  }

  #spawnRemux(entry: StreamEntry, seek: number): ActiveStream {
    const input = ffmpegInput(entry, seek);
    const args = [
      ...input.options,
      ...input.input,
      '-map',
      '0:v:0',
      // Trailing `?` keeps audio-less streams from failing outright.
      '-map',
      this.#audioMap(entry),
      '-c',
      'copy',
      // Copying ADTS AAC out of MPEG-TS into MP4 aborts with "Malformed AAC bitstream detected";
      // this converter strips the ADTS headers. Gated on the container because the filter *errors*
      // on non-AAC audio, and mkv VOD on this provider is frequently AC-3.
      ...(isMpegTsContainer(entry.container) ? ['-bsf:a', 'aac_adtstoasc'] : []),
      // Without -dn -sn a bin_data stream and the mkv subrip tracks leak into the MP4 and break
      // playback. -map_chapters -1 is needed for the same reason: the mov muxer would turn the
      // mkv's chapter list into a `text` track that also shows up as bin_data.
      '-dn',
      '-sn',
      '-map_chapters',
      '-1',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1',
      ...subtitleOutputArgs(this.#subtitle(entry)),
    ];
    const { proc, exited, stderr } = spawnFfmpeg(args, { stdout: 'pipe', stdin: input.stdin, subtitles: !!this.#subtitle(entry) && !this.#subtitle(entry)?.image });
    this.#learnDuration(entry, proc);
    this.#wireCues(entry, proc);
    const active: ActiveStream = {
      mode: 'remux',
      token: entry.token,
      generation: ++this.#generation,
      proc,
      offset: seek,
      exited,
      stderr,
    };
    this.#active = active;
    this.#clearWhenExited(active);
    return active;
  }


  async #serveHls(
    entry: StreamEntry,
    seek: number,
    rest: string[],
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const name = rest.length === 1 ? rest[0] : undefined;
    if (!name || !SEGMENT_NAME.test(name) || name.includes('..')) {
      respondError(res, 404, 'not found');
      return;
    }

    if (name.endsWith('.m3u8')) {
      await this.#servePlaylist(entry, seek, res);
      return;
    }

    const active = this.#active;
    if (!active || active.mode !== 'hls' || active.token !== entry.token) {
      respondError(res, 404, 'no active hls session');
      return;
    }
    this.#touchHlsIdle(active);

    const file = join(active.dir, name);
    if (!existsSync(file)) {
      respondError(res, 404, 'segment expired');
      return;
    }
    const size = statSync(file).size;
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  async #servePlaylist(entry: StreamEntry, seek: number, res: ServerResponse): Promise<void> {
    await ensureUsableFfmpeg();
    const ladder = await transcodeLadder(resolveFfmpegPath());
    const compatible = ladder.filter(p => !p.inputArgs.includes('-hwaccel_output_format') && !p.videoArgs.includes('-vf'));
    const profiles = this.#copyPlan(entry).video ? compatible.slice(0, 1) : compatible;
    const active = await this.#serialize(async () => {
      if (!this.#validEntry(entry) || res.destroyed) return null;
      const current = this.#active;
      if (current?.mode === 'hls' && current.token === entry.token && current.offset === seek) return current;
      const failures: string[] = [];
      for (const profile of profiles) {
        await this.#killActive();
        if (!this.#validEntry(entry) || res.destroyed) return null;
        const attempt = this.#spawnHls(entry, seek, profile);
        if (attempt.mode !== 'hls') return null;
        if (await waitForPlaylist(join(attempt.dir, 'index.m3u8'), attempt)) return attempt;
        failures.push(`${profile.label}: ${attempt.stderr().slice(-200)}`);
      }
      await this.#killActive();
      throw new Error(`HLS did not start. ${failures.join('; ')}`);
    });
    if (!active || active.mode !== 'hls') { respondError(res, 410, 'expired session'); return; }
    this.#touchHlsIdle(active);
    const body = await readFile(join(active.dir, 'index.m3u8'));
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': String(body.byteLength), 'Cache-Control': 'no-store' });
    res.end(body);
  }

  #spawnHls(entry: StreamEntry, seek: number, profile: TranscodeProfile): ActiveStream {
    const dir = mkdtempSync(join(tmpdir(), 'xiptv-hls-'));
    liveTempDirs.add(dir);

    const input = ffmpegInput(entry, seek);
    const plan = this.#copyPlan(entry);
    const bitmap = this.#subtitle(entry)?.image ? this.#subtitle(entry) : undefined;
    const args = [
      ...input.options,
      // VOD would otherwise be muxed at disk speed and the sliding window would delete segments
      // before the receiver ever asked for them. Live input already arrives in real time.
      ...(entry.kind === 'live' ? [] : ['-re']),
      ...input.input,
      ...(bitmap ? ['-filter_complex', imageSubtitleFilter(bitmap, entry.captionDelay ?? 0), '-map', '[v]'] : ['-map', '0:v:0']),
      '-map', this.#audioMap(entry),
      ...(plan.video ? ['-c:v', 'copy'] : profile.videoArgs),
      ...(plan.audio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']),
      '-dn',
      '-sn',
      '-map_chapters',
      '-1',
      '-muxdelay', '0',
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_list_size',
      '8',
      '-hls_delete_threshold',
      '4',
      '-hls_flags',
      'delete_segments+omit_endlist+independent_segments',
      '-hls_segment_type',
      'mpegts',
      '-hls_allow_cache',
      '0',
      // Relative names + cwd=dir: an absolute -hls_segment_filename would be written verbatim into
      // the playlist, and the receiver would then request a filesystem path over HTTP.
      '-hls_segment_filename',
      'seg%05d.ts',
      'index.m3u8',
      ...subtitleOutputArgs(this.#subtitle(entry)),
    ];

    const { proc, exited, stderr } = spawnFfmpeg(args, { stdout: 'ignore', stdin: input.stdin, cwd: dir, subtitles: !!this.#subtitle(entry) && !this.#subtitle(entry)?.image });
    this.#wireCues(entry, proc);
    const generation = ++this.#generation;
    const idleTimer = setTimeout(() => this.#killIfActive(generation), HLS_IDLE_TIMEOUT_MS);
    const active: ActiveStream = {
      mode: 'hls',
      token: entry.token,
      generation,
      proc,
      offset: seek,
      exited,
      stderr,
      dir,
      idleTimer,
    };
    this.#active = active;
    this.#clearWhenExited(active);
    return active;
  }

  /** A Chromecast that stops fetching has gone away; do not hold the connection slot forever. */
  #touchHlsIdle(active: ActiveStream & { mode: 'hls' }): void {
    active.idleTimer.refresh();
  }


  async #serveDirect(entry: StreamEntry, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && isVodFile(entry)) {
      await this.#serveVod(entry, req, res);
      return;
    }
    await this.#serialize(async () => {
      if (!this.#validEntry(entry)) return;
      await this.#killActive();
      this.#directToken = entry.token;
    });
    if (res.destroyed || !this.#validEntry(entry)) return;

    const isHead = req.method === 'HEAD';
    const clientRange = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    if (!isHead && !clientRange && isLivePassthrough(entry)) {
      this.#serveLiveDirect(entry, res);
      return;
    }
    // The provider answers a real HEAD with `520` and a 16-byte error body, so always ask
    // upstream with GET, and satisfy a client HEAD from a one-byte range request instead.
    const upstreamRange = clientRange ?? (isHead ? 'bytes=0-0' : undefined);

    const forward = (target: string, redirectsLeft: number): void => {
      if (res.destroyed || !this.#validEntry(entry)) return;
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        respondError(res, 502, 'upstream returned an unusable url');
        return;
      }
      const isTls = url.protocol === 'https:';
      const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: '*/*' };
      if (upstreamRange) headers.range = upstreamRange;

      const options: RequestOptions = { method: 'GET', headers };
      const send = isTls ? httpsRequest : httpRequest;
      const upstream = send(url, options, (up) => {
        const status = up.statusCode ?? 502;
        const location = up.headers.location;
        // The provider always 302s to a token-signed URL on a different host.
        if (status >= 300 && status < 400 && typeof location === 'string') {
          up.resume();
          if (redirectsLeft <= 0) {
            respondError(res, 502, 'too many redirects');
            return;
          }
          forward(new URL(location, url).toString(), redirectsLeft - 1);
          return;
        }

        // This provider signals a dead or unavailable channel with a NON-STANDARD
        // status and an HTML body. 888 and 666 on two different dead channels in the same
        // category, 555 when the single connection slot is already taken, 520 on a real HEAD.
        // Passed through verbatim these reach the renderer as an opaque "code = 888" and the
        // player just sits on a black frame, so translate them into something a person can read.
        if (status < 200 || status > 299) {
          up.resume();
          const why = describeUpstreamStatus(status);
          this.#lastError = why;
          respondError(res, 502, why);
          return;
        }

        const contentRange = headerValue(up.headers['content-range']);
        const contentLength = headerValue(up.headers['content-length']);
        const acceptRanges = headerValue(up.headers['accept-ranges']);

        const out: Record<string, string> = {
          'Content-Type': headerValue(up.headers['content-type']) ?? mimeForContainer(entry.container),
          'Cache-Control': 'no-store',
        };
        // The provider sends `Accept-Ranges: 0-973920368`, a byte range where the unit
        // belongs. Chromium reads anything but `bytes` as "no range support" and stops offering
        // seeking, so normalise it whenever the server has proved it honours ranges.
        if (status === 206 || (acceptRanges !== undefined && acceptRanges !== 'none')) {
          out['Accept-Ranges'] = 'bytes';
        } else if (acceptRanges === 'none') {
          out['Accept-Ranges'] = 'none';
        }

        if (isHead) {
          const total = totalSizeFrom(contentRange) ?? (status === 200 ? contentLength : undefined);
          if (total) out['Content-Length'] = total;
          up.destroy();
          res.writeHead(status === 206 ? 200 : status, out).end();
          return;
        }

        if (contentRange) out['Content-Range'] = contentRange;
        if (contentLength) out['Content-Length'] = contentLength;
        res.writeHead(status, out);
        up.pipe(res);
        up.on('error', () => res.destroy());
      });

      this.#activeProxy = upstream;
      // Guard the connect/first-byte phase only. Once bytes flow, pipe() backpressure means a
      // paused player (or Chromium's multibuffer sitting on a full preload buffer) legitimately
      // produces zero socket activity, and tearing down there truncates a healthy movie.
      upstream.setTimeout(PROXY_IDLE_TIMEOUT_MS, () => upstream.destroy(new Error('upstream timeout')));
      upstream.once('data', () => upstream.setTimeout(0));
      upstream.on('error', (err: Error) => {
        if (this.#activeProxy === upstream) this.#activeProxy = null;
        respondError(res, 502, `upstream error: ${err.message}`);
      });
      upstream.on('close', () => {
        if (this.#activeProxy === upstream) this.#activeProxy = null;
      });
      res.on('close', () => upstream.destroy());
      upstream.end();
    };

    forward(entry.directUrl, MAX_REDIRECTS);
  }

  /** Every range request for the same film shares one provider connection; see vod-source.ts. */
  async #serveVod(entry: StreamEntry, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const source = await this.#serialize(async () => {
      // A failed source is replaced, so the player's Retry really does try again.
      if (this.#vod?.token === entry.token && !this.#vod.source.failure) return this.#vod.source;
      if (!this.#validEntry(entry)) return null;
      await this.#killActive();
      if (res.destroyed) return null;
      const dir = mkdtempSync(join(tmpdir(), 'xiptv-vod-'));
      liveTempDirs.add(dir);
      const created = new VodSource(entry.directUrl, join(dir, 'film'), {
        userAgent: USER_AGENT,
        maxRedirects: MAX_REDIRECTS,
      });
      this.#vod = { token: entry.token, source: created, dir };
      return created;
    });
    if (!source) return;

    const cancel = new AbortController();
    res.on('close', () => cancel.abort());
    const read = source.reader(cancel.signal);
    const range = parseByteRange(req.headers.range);
    const start = range?.start ?? 0;

    try {
      let chunk = await read(start);
      const size = source.size!;
      if (start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      const end = Math.min(range?.end ?? size - 1, size - 1);
      const headers: Record<string, string> = {
        'Content-Type': mimeForContainer(entry.container),
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(range ? 206 : 200, headers);

      let pos = start;
      while (chunk.length) {
        const part = chunk.subarray(0, end + 1 - pos);
        pos += part.length;
        if (!res.write(part)) await once(res, 'drain', { signal: cancel.signal });
        if (pos > end) break;
        chunk = await read(pos);
      }
      res.end();
    } catch (err) {
      if (cancel.signal.aborted) return;
      if (err instanceof UpstreamError) this.#lastError = err.message;
      respondError(res, 502, err instanceof Error ? err.message : 'upstream error');
    }
  }

  #serveLiveDirect(entry: StreamEntry, res: ServerResponse): void {
    const source = new LiveTsSource(entry.directUrl, { userAgent: USER_AGENT, maxRedirects: MAX_REDIRECTS });
    this.#activeSource = source;
    let headersSent = false;

    source.on('data', (chunk: Buffer) => {
      if (res.writableEnded || res.destroyed) return;
      if (!headersSent) {
        headersSent = true;
        res.writeHead(200, {
          'Content-Type': mimeForContainer(entry.container),
          'Cache-Control': 'no-store',
          'Accept-Ranges': 'none',
        });
      }
      if (!res.write(chunk)) source.pause();
    });
    res.on('drain', () => source.resume());
    source.on('end', () => {
      const why = source.failure;
      if (why instanceof UpstreamError) this.#lastError = why.message;
      if (why && !headersSent) respondError(res, 502, `upstream error: ${why.message}`);
      else if (!res.writableEnded) res.end();
    });
    source.on('close', () => {
      if (this.#activeSource === source) this.#activeSource = null;
      if (!res.writableEnded) res.end();
    });
    res.on('close', () => {
      source.destroy();
      const { reconnects, droppedBytes } = source.stats;
      if (reconnects) console.log(`[stream] live passthrough: ${reconnects} reconnects, ${droppedBytes} replayed bytes dropped`);
    });
  }
}


function baseInputArgs(seek: number, transport: 'http' | 'pipe' = 'http'): string[] {
  return [
    '-hide_banner',
    // `info` (not `error`) so ffmpeg prints its input stream table, which is where #learnTracks
    // reads the real codecs from. `-nostats` drops the per-second progress line that would
    // otherwise scroll the useful part out of the bounded stderr tail.
    '-nostats',
    '-loglevel',
    'info',
    // http-only options: ffmpeg rejects them outright on a pipe input.
    ...(transport === 'http'
      ? [
          '-user_agent',
          USER_AGENT,
          // The CDN drops long connections occasionally; reconnecting beats ending the movie.
          '-reconnect',
          '1',
          '-reconnect_streamed',
          '1',
          '-reconnect_delay_max',
          '5',
        ]
      : []),
    // Input seek (before -i) so ffmpeg issues a Range request instead of decoding to the offset.
    ...(seek > 0 ? ['-ss', seek.toFixed(3)] : []),
  ];
}

interface FfmpegInput {
  options: string[];
  input: string[];
  stdin?: LiveTsSource;
}

// A seek needs ffmpeg's own http client to issue the Range request, so `-ss` rules the pipe out.
function ffmpegInput(entry: StreamEntry, seek: number): FfmpegInput {
  if (seek > 0 || !isLivePassthrough(entry)) {
    return { options: baseInputArgs(seek), input: ['-i', entry.directUrl] };
  }
  const stdin = new LiveTsSource(entry.directUrl, { userAgent: USER_AGENT, maxRedirects: MAX_REDIRECTS });
  return { options: [...baseInputArgs(0, 'pipe'), '-f', 'mpegts'], input: ['-i', 'pipe:0'], stdin };
}

interface SpawnedFfmpeg {
  proc: ChildProcess;
  exited: Promise<void>;
  /** Redacted: ffmpeg echoes its input URL, and a VOD input is `/movie/<user>/<pass>/<id>.mkv`. */
  stderr: () => string;
}

interface SpawnOptions {
  subtitles?: boolean;
  stdout: 'pipe' | 'ignore';
  stdin?: LiveTsSource;
  cwd?: string;
}

function spawnFfmpeg(args: string[], options: SpawnOptions): SpawnedFfmpeg {
  installExitHook();
  const bin = resolveFfmpegPath();
  const proc = spawn(bin, args, {
    stdio: [options.stdin ? 'pipe' : 'ignore', options.stdout, 'pipe', options.subtitles ? 'pipe' : 'ignore'],
    cwd: options.cwd,
  });
  liveProcesses.add(proc);

  let tail = '';
  const source = options.stdin;
  if (source && proc.stdin) {
    // ffmpeg closing its end (exit, or a fatal input error) must release the upstream socket at
    // once: it is the provider's single connection slot.
    proc.stdin.on('error', () => source.destroy());
    proc.stdin.on('close', () => source.destroy());
    source.on('end', () => {
      const why = source.failure;
      if (why) tail = (tail + `\nupstream: ${why.message}`).slice(-STDERR_LIMIT);
    });
    source.pipe(proc.stdin);
  }

  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_LIMIT);
  });

  const exited = new Promise<void>((resolve) => {
    const done = (): void => {
      liveProcesses.delete(proc);
      resolve();
    };
    // 'exit', not 'close': 'close' additionally waits for the stdio pipes to drain, and a client
    // that stopped reading leaves stdout paused indefinitely. What callers need to know is that the
    // process is gone, and with it the provider connection slot it held.
    proc.once('exit', async (code, signal) => {
      tail = `${tail}\n[ffmpeg exited code=${code} signal=${signal}]`.slice(-STDERR_LIMIT);
      // Same static-NSS crash the startup probe looks for, hit at runtime instead.
      if (signal === 'SIGSEGV') noteFfmpegCrash(bin);
      if (source) { const closed = source.closed ? Promise.resolve() : new Promise<void>(resolve => source.once('close', resolve)); source.destroy(); await closed; }
      done();
    });
    proc.once('error', (err: Error) => {
      tail = (tail + `\nspawn failed: ${err.message}`).slice(-STDERR_LIMIT);
      done();
    });
  });

  // Scrub on read rather than per chunk: a URL split across two stderr writes would slip past a
  // per-chunk filter, and every caller of stderr() is building a message somebody will see.
  return { proc, exited, stderr: () => redactText(tail) };
}

function remuxHeaders(): Record<string, string> {
  return {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    // The response is a pipe, not a file: seeking happens by restarting ffmpeg with ?t=.
    'Accept-Ranges': 'none',
    Connection: 'close',
  };
}

async function waitForPlaylist(path: string, active: ActiveStream): Promise<boolean> {
  const deadline = Date.now() + HLS_READY_TIMEOUT_MS;
  let processExited = false;
  void active.exited.then(() => {
    processExited = true;
  });

  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const text = await readFile(path, 'utf8').catch(() => '');
      if (/^seg\d+\.ts$/m.test(text)) return true;
    }
    if (processExited) return false;
    await delay(200);
  }
  return false;
}

function parseSeek(raw: string | null): number {
  if (raw === null) return 0;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/** Just `bytes=a-` and `bytes=a-b`, which is all Chromium sends. Anything else is served whole. */
function parseByteRange(header: string | undefined): { start: number; end?: number } | undefined {
  const m = header ? /^bytes=(\d+)-(\d*)$/.exec(header.trim()) : null;
  if (!m) return undefined;
  return { start: Number(m[1]), end: m[2] ? Number(m[2]) : undefined };
}

function totalSizeFrom(contentRange: string | undefined): string | undefined {
  return contentRange?.match(/\/(\d+)\s*$/)?.[1];
}

function headerValue(raw: string | string[] | undefined): string | undefined {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

function setCors(res: ServerResponse): void {
  // hls.js and mpegts.js fetch over XHR, so the loopback origin needs explicit CORS.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

function respondError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from(message, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.byteLength),
  });
  res.end(body);
}

function isPrivateIPv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = octets;
  if (a === undefined || b === undefined) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

function detectLanAddress(): string {
  const candidates: string[] = [];
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    if (!infos) continue;
    for (const info of infos) {
      if (info.family !== 'IPv4' || info.internal) continue;
      // Skip docker/virtual bridges: a Chromecast is not on them.
      if (/^(docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|zt)/i.test(name)) continue;
      candidates.push(info.address);
    }
  }
  return candidates.find(isPrivateIPv4) ?? candidates[0] ?? '127.0.0.1';
}
