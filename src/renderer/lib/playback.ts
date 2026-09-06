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
      liveBufferLatencyChasing: true,
      liveBufferLatencyChasingOnPaused: false,
      liveBufferLatencyMaxLatency: 3.0,
      liveBufferLatencyMinRemain: 0.4,
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

  return {
    video,
    teardown: () => {
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
