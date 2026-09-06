import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import type { ResolvedStream } from '@shared/types';

/**
 * The provider allows exactly ONE concurrent connection, and a leaked mpegts.js player keeps its
 * socket open. The next channel the user picks then fails with a provider-side rejection that
 * looks like a dead stream.
 */

export interface AttachOptions {
  startAt?: number;
  onError?: (message: string) => void;
  onRecovering?: () => void;
  onUnsupported?: () => void;
}

interface Attachment {
  video: HTMLVideoElement;
  teardown: () => void;
}

let current: Attachment | null = null;

const COPY = {
  network: 'The provider closed the connection before any video arrived.',
  refused: 'The provider refused this stream. It may be offline, or another device may be using the account.',
  codec: 'This stream uses a video format this player cannot decode.',
  generic: 'The stream stopped responding.',
} as const;

function mpegtsCopy(detail: string): string {
  const d = detail.toLowerCase();
  if (d.includes('statuscode') || d.includes('status_code')) return COPY.refused;
  if (d.includes('codec') || d.includes('format') || d.includes('mse')) return COPY.codec;
  if (d.includes('timeout') || d.includes('eof') || d.includes('exception')) return COPY.network;
  return COPY.generic;
}

function reportUnsupported(opts: AttachOptions): void {
  if (opts.onUnsupported) opts.onUnsupported();
  else opts.onError?.(COPY.codec);
}

function isDecodeFailure(video: HTMLVideoElement): boolean {
  const code = video.error?.code;
  return code === MediaError.MEDIA_ERR_DECODE || code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
}

function describeMediaError(video: HTMLVideoElement): string {
  switch (video.error?.code) {
    case MediaError.MEDIA_ERR_NETWORK: return COPY.network;
    case MediaError.MEDIA_ERR_DECODE:
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: return COPY.codec;
    default: return COPY.generic;
  }
}

function withTime(url: string, seconds: number): string {
  const t = Math.max(0, Math.round(seconds));
  const stripped = url.replace(/([?&])t=\d+(&|$)/, (_m, lead: string, tail: string) => (tail ? lead : ''))
    .replace(/[?&]$/, '');
  if (!t) return stripped;
  return `${stripped}${stripped.includes('?') ? '&' : '?'}t=${t}`;
}

export function detach(): void {
  const a = current;
  current = null;
  if (!a) return;
  try {
    a.teardown();
  } catch {
    void 0;
  }
}

function attachNative(video: HTMLVideoElement, url: string, opts: AttachOptions): Attachment {
  video.src = url;
  video.load();

  const onError = (): void => {
    if (isDecodeFailure(video)) {
      reportUnsupported(opts);
      return;
    }
    opts.onError?.(describeMediaError(video));
  };
  video.addEventListener('error', onError);

  return {
    video,
    teardown: () => {
      video.removeEventListener('error', onError);
      video.pause();
      video.removeAttribute('src');
      // Only load() on an empty source aborts the in-flight request.
      video.load();
    },
  };
}

function attachHls(video: HTMLVideoElement, stream: ResolvedStream, opts: AttachOptions): Attachment {
  if (!Hls.isSupported()) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) return attachNative(video, stream.url, opts);
    reportUnsupported(opts);
    return { video, teardown: () => undefined };
  }

  const live = stream.kind === 'live';
  const hls = new Hls({
    lowLatencyMode: live,
    backBufferLength: live ? 30 : 90,
    maxBufferLength: live ? 12 : 60,
    liveSyncDurationCount: 3,
    enableWorker: true,
    fragLoadingMaxRetry: 4,
    manifestLoadingMaxRetry: 3,
  });

  let recovered = 0;
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recovered < 2) {
      recovered++;
      opts.onRecovering?.();
      hls.startLoad();
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recovered < 2) {
      recovered++;
      opts.onRecovering?.();
      hls.recoverMediaError();
      return;
    }
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      opts.onError?.(COPY.refused);
      return;
    }
    reportUnsupported(opts);
  });

  hls.attachMedia(video);
  hls.loadSource(stream.url);

  return {
    video,
    teardown: () => {
      hls.destroy();
      video.removeAttribute('src');
      video.load();
    },
  };
}

/**
 * A live connection opens with the provider replaying its buffer, so tens of seconds of video land
 * in a couple of seconds and the play head starts that far behind the edge. Stepping forward while
 * that burst is still arriving just seeks again on the next chunk, so wait until the buffer stops
 * outrunning the wall clock and then step once.
 */
const LIVE_SAMPLE_MS = 500;
const LIVE_SETTLED_SAMPLES = 2;
/** Buffer growing more than this much faster than real time means the replay is still draining. */
const LIVE_BURST_RATIO = 1.5;
const LIVE_MAX_LATENCY = 6;
const LIVE_CEILING_LATENCY = 60;
const LIVE_TARGET_LATENCY = 2;
const LIVE_STEP_COOLDOWN_MS = 5_000;

function liveEdgeGuard(video: HTMLVideoElement): () => void {
  let lastEnd = 0;
  let lastAt = Date.now();
  let settled = 0;
  let steppedAt = 0;

  const timer = setInterval(() => {
    const ranges = video.buffered;
    if (!ranges.length || video.paused || video.seeking) return;

    const last = ranges.length - 1;
    const end = ranges.end(last);
    const now = Date.now();
    const grew = end - lastEnd;
    const wall = (now - lastAt) / 1000;
    lastEnd = end;
    lastAt = now;

    const latency = end - video.currentTime;
    settled = grew > wall * LIVE_BURST_RATIO ? 0 : settled + 1;

    const drained = settled >= LIVE_SETTLED_SAMPLES && latency > LIVE_MAX_LATENCY;
    // Everything ahead of the play head is held in the source buffer, and Chromium's quota error
    // suspends mpegts.js's transmuxer for good on a live stream. Step early rather than ride out a
    // replay long enough to overflow it.
    if (!drained && latency <= LIVE_CEILING_LATENCY) return;
    if (now - steppedAt < LIVE_STEP_COOLDOWN_MS) return;

    // Land inside the range: mpegts.js reads a seek outside the buffered ranges as an unbuffered
    // seek and flushes the source buffer to serve it.
    const start = ranges.start(last);
    const target = Math.min(end - 0.1, Math.max(start + 0.1, end - LIVE_TARGET_LATENCY));
    if (target <= start || target <= video.currentTime) return;
    steppedAt = now;
    video.currentTime = target;
  }, LIVE_SAMPLE_MS);

  return () => clearInterval(timer);
}

function attachMpegts(video: HTMLVideoElement, stream: ResolvedStream, opts: AttachOptions): Attachment {
  if (!mpegts.isSupported()) {
    reportUnsupported(opts);
    return { video, teardown: () => undefined };
  }

  const player = mpegts.createPlayer(
    { type: 'mpegts', isLive: true, url: stream.url },
    {
      enableWorker: true,
      enableStashBuffer: false,
      stashInitialSize: 128,
      isLive: true,
      // Chasing off: see liveEdgeGuard. mpegts.js corrects latency by assigning currentTime on
      // every buffer update, and the provider's replay burst keeps it above any threshold for the
      // whole burst, so it fires hundreds of times before the first frame settles.
      liveBufferLatencyChasing: false,
      lazyLoad: false,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 60,
      autoCleanupMinBackwardDuration: 30,
      fixAudioTimestampGap: true,
      reuseRedirectedURL: true,
    },
  );

  let reloads = 0;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;

  const onError = (type: string, detail: string): void => {
    if (type === mpegts.ErrorTypes.NETWORK_ERROR && reloads < 1) {
      reloads++;
      opts.onRecovering?.();
      reloadTimer = setTimeout(() => {
        try {
          player.unload();
          player.load();
          void player.play();
        } catch {
          opts.onError?.(COPY.network);
        }
      }, 1200);
      return;
    }
    const why = mpegtsCopy(detail);
    // MEASURED: an HEVC channel reaches here as MEDIA_ERROR / 'MediaMSEError', thrown by
    // addSourceBuffer('video/mp4;codecs=hvc1...'). mpegts.js demuxes H.265, Chromium has no
    // decoder to hand it to.
    if (why === COPY.codec) {
      reportUnsupported(opts);
      return;
    }
    opts.onError?.(why);
  };

  player.on(mpegts.Events.ERROR, onError);
  player.attachMediaElement(video);
  player.load();
  void Promise.resolve(player.play()).catch(() => undefined);

  const stopGuard = liveEdgeGuard(video);

  return {
    video,
    teardown: () => {
      stopGuard();
      if (reloadTimer) clearTimeout(reloadTimer);
      player.off(mpegts.Events.ERROR, onError);
      try {
        player.pause();
        player.unload();
        player.detachMediaElement();
      } finally {
        player.destroy();
      }
    },
  };
}

export async function attachStream(
  video: HTMLVideoElement,
  stream: ResolvedStream,
  opts: AttachOptions = {},
): Promise<void> {
  detach();

  const startAt = Math.max(0, opts.startAt ?? 0);
  let attachment: Attachment;

  switch (stream.engine) {
    case 'mpegts':
      attachment = attachMpegts(video, stream, opts);
      break;
    case 'hls':
      attachment = attachHls(video, stream, opts);
      break;
    case 'remux':
    case 'transcode':
      attachment = attachNative(video, withTime(stream.url, startAt), opts);
      break;
    default:
      attachment = attachNative(video, stream.url, opts);
      break;
  }

  current = attachment;

  if (startAt > 0 && !isPiped(stream) && stream.kind !== 'live') {
    const seek = (): void => {
      if (video.currentTime < startAt - 1) video.currentTime = startAt;
    };
    video.addEventListener('loadedmetadata', seek, { once: true });
  }

  await video.play().catch(() => undefined);
}

export interface MediaClock {
  positionOf(elementTime: number): number;
}

export function mediaClock(stream: ResolvedStream, startAt: number): MediaClock {
  const base = isPiped(stream) ? Math.max(0, startAt) : 0;
  return { positionOf: (elementTime) => base + (Number.isFinite(elementTime) ? elementTime : 0) };
}

/** ffmpeg pipes cannot be ranged: seeking means reloading with `?t=` and offsetting the clock. */
export function isPiped(stream: ResolvedStream): boolean {
  return stream.engine === 'remux' || stream.engine === 'transcode';
}

export function seekTo(video: HTMLVideoElement, stream: ResolvedStream, seconds: number): MediaClock {
  const target = Math.max(0, seconds);

  if (!isPiped(stream)) {
    video.currentTime = target;
  } else {
    const resume = !video.paused;
    video.src = withTime(stream.url, target);
    video.load();
    if (resume) void video.play().catch(() => undefined);
  }
  return mediaClock(stream, target);
}

export function bufferedEnd(video: HTMLVideoElement): number {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t + 0.25 && video.buffered.end(i) >= t) return video.buffered.end(i);
  }
  return t;
}
