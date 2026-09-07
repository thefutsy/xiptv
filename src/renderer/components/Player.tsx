import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Captions, Check, ChevronLeft, Maximize, Minimize, PictureInPicture2,
  RotateCcw, RotateCw, SkipBack, SkipForward, TriangleAlert, Volume1, Volume2, VolumeX,
} from 'lucide-react';
import type { Episode, EpgProgramme, NowNext, ResolvedStream } from '@shared/types';
import { useApp, activeSource, type NowPlaying } from '@/state/store';
import { attachStream, bufferedEnd, detach, isPiped, mediaClock, seekTo, type MediaClock } from '@/lib/playback';
import { splitGenres } from '@/lib/catalog';
import {
  Button, Kicker, LogoPlate, PauseGlyph, PlayGlyph, Poster, Spinner, Tally, Tooltip, TruncateTail,
} from '@/components/Primitives';
import { CastButton, toggleCastPicker } from '@/components/CastBar';
import { IS_MAC, PLATFORM, WindowControls } from '@/components/TitleBar';
import { classNames, errorText, formatClock, formatDuration, isTextEntry, progressThrough } from '@/lib/format';
import './player.css';

function BackGlyph({ seconds }: { seconds: number }) {
  return (
    <RotateCcw size={20} strokeWidth={1.5} aria-hidden>
      <text key="n" className="skipnum" x="12.4" y="15.6" textAnchor="middle">{seconds}</text>
    </RotateCcw>
  );
}
function ForwardGlyph({ seconds }: { seconds: number }) {
  return (
    <RotateCw size={20} strokeWidth={1.5} aria-hidden>
      <text key="n" className="skipnum" x="11.6" y="15.6" textAnchor="middle">{seconds}</text>
    </RotateCw>
  );
}
function VolumeGlyph({ level }: { level: number }) {
  if (level <= 0) return <VolumeX size={20} strokeWidth={1.5} aria-hidden />;
  return level > 0.55
    ? <Volume2 size={20} strokeWidth={1.5} aria-hidden />
    : <Volume1 size={20} strokeWidth={1.5} aria-hidden />;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

interface MediaState {
  position: number;
  elementDuration: number;
  buffered: number;
  paused: boolean;
  volume: number;
  muted: boolean;
}

const LIVE_STALL_REVIVE_MS = 5_000;
/** Opening a live channel means a connection, the provider's replay and a first keyframe. Reviving
 *  on the 5 s budget throws all of that away and asks a one-connection provider for a slot it has
 *  not released yet, which is slower than simply waiting. */
const LIVE_START_REVIVE_MS = 20_000;
const MAX_LIVE_REVIVALS = 6;
/** ffmpeg prints the input header within a second or two of starting, or not at all. */
const DURATION_POLL_MS = 500;
const MAX_DURATION_POLLS = 20;

const ZERO: MediaState = { position: 0, elementDuration: 0, buffered: 0, paused: true, volume: 1, muted: false };

export function Player() {
  const nowPlaying = useApp((s) => s.nowPlaying);
  if (!nowPlaying) return null;
  return <PlayerSurface now={nowPlaying} />;
}

function PlayerSurface({ now }: { now: NowPlaying }) {
  const { item } = now;
  const isLive = item.kind === 'live';

  const cast = useApp((s) => s.cast);
  const castPanelOpen = useApp((s) => s.castPanelOpen);
  const storeSourceId = useApp((s) => s.activeSourceId);
  const sourceId = storeSourceId ?? activeSource()?.id;
  const casting = cast.connected;

  const videoRef = useRef<HTMLVideoElement>(null);
  const clockRef = useRef<MediaClock>(mediaClock(now.stream, now.startAt ?? 0));
  const posRef = useRef(0);
  const durRef = useRef(0);
  const resumeRef = useRef(now.startAt ?? 0);
  const castTimeRef = useRef(0);
  const retriedTranscodeRef = useRef(false);
  const playedRef = useRef(false);
  if (cast.connected) castTimeRef.current = cast.currentTime;

  const [media, setMedia] = useState<MediaState>(ZERO);
  const [error, setError] = useState<string>();
  const [transcoded, setTranscoded] = useState<ResolvedStream>();
  const stream = transcoded ?? now.stream;
  const [attempt, setAttempt] = useState(0);
  const [stall, setStall] = useState(0);
  const [idle, setIdle] = useState(false);
  const [hold, setHold] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [subsOpen, setSubsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [nowNext, setNowNext] = useState<NowNext>();
  const [clockTick, setClockTick] = useState(() => Math.floor(Date.now() / 1000));
  const [{ prev: prevEpisode, next: nextEpisode }, setSiblings] = useState<{ prev?: Episode; next?: Episode }>({});
  const [tracks, setTracks] = useState<Array<{ index: number; label: string }>>([]);
  const [activeTrack, setActiveTrack] = useState(-1);
  const [hover, setHover] = useState<{ x: number; t: number }>();
  // An ffmpeg pipe has no length of its own: the element's duration is only what has arrived so far.
  const [learnedDuration, setLearnedDuration] = useState<number>();

  const known = stream.duration && stream.duration > 0 ? stream.duration : learnedDuration;
  const total = isLive ? 0 : (known ?? media.elementDuration);
  durRef.current = total;
  posRef.current = media.position;

  const lastNow = useRef(now);
  const wasCasting = useRef(false);
  if (lastNow.current !== now) {
    lastNow.current = now;
    resumeRef.current = now.startAt ?? 0;
    retriedTranscodeRef.current = false;
    if (transcoded) setTranscoded(undefined);
  } else if (wasCasting.current && !casting) {
    resumeRef.current = castTimeRef.current;
  }
  wasCasting.current = casting;

  const timeshift = isLive ? Math.max(0, resumeRef.current) : 0;

  const sync = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const next = {
      position: clockRef.current.positionOf(v.currentTime),
      elementDuration: Number.isFinite(v.duration) ? v.duration : 0,
      buffered: clockRef.current.positionOf(bufferedEnd(v)),
      paused: v.paused,
      volume: v.volume,
      muted: v.muted,
    };
    setMedia((prev) => (
      prev.position === next.position && prev.elementDuration === next.elementDuration
        && prev.buffered === next.buffered && prev.paused === next.paused
        && prev.volume === next.volume && prev.muted === next.muted
        ? prev
        : next
    ));
  }, []);

  const retryViaTranscode = useCallback(() => {
    if (retriedTranscodeRef.current || !sourceId) return;
    retriedTranscodeRef.current = true;
    const req = { sourceId, itemId: item.id, episodeId: now.episodeId, startAt: resumeRef.current };
    // The provider allows one connection at a time, and ffmpeg is about to want it. Release the
    // failed attachment first, or the retry gets refused upstream.
    detach();
    setStall((s) => Math.max(s, 1));
    void window.iptv.player.markTranscode(req).catch(() => undefined);
    window.iptv.player.resolve({ ...req, transcode: true })
      .then((next) => setTranscoded(next))
      .catch((err: unknown) => {
        setStall(0);
        setError(errorText(err, 'This stream could not be converted.'));
      });
  }, [sourceId, item.id, now.episodeId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || casting) return;

    setError(undefined);
    setStall(0);
    playedRef.current = false;
    clockRef.current = mediaClock(stream, resumeRef.current);

    let alive = true;
    void attachStream(video, stream, {
      startAt: resumeRef.current,
      onError: (message) => {
        if (!alive) return;
        setStall(0);
        setError(message);
        void window.iptv.player.lastError().then((why) => {
          if (alive && why) setError(why);
        }).catch(() => undefined);
      },
      onRecovering: () => { if (alive) setStall((s) => Math.max(s, 1)); },
      onUnsupported: () => { if (alive) retryViaTranscode(); },
    }).then(() => { if (alive) sync(); });

    return () => {
      alive = false;
      detach();
    };
  }, [stream, casting, attempt, sync, retryViaTranscode]);

  useEffect(() => {
    setLearnedDuration(undefined);
    if (isLive || casting || !isPiped(stream) || (stream.duration ?? 0) > 0) return;
    let alive = true;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      void window.iptv.player.streamDuration().then((secs) => {
        if (!alive) return;
        if (secs && secs > 0) {
          setLearnedDuration(secs);
          clearInterval(timer);
        } else if (tries >= MAX_DURATION_POLLS) {
          clearInterval(timer);
        }
      }).catch(() => undefined);
    }, DURATION_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [stream, isLive, casting, attempt]);

  const saveRef = useRef<() => void>(() => undefined);
  useEffect(() => () => {
    saveRef.current();
    detach();
    void window.iptv.player.stopRemux().catch(() => undefined);
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const events = ['timeupdate', 'progress', 'durationchange', 'play', 'pause', 'playing', 'volumechange', 'seeked', 'loadedmetadata', 'ended'] as const;
    for (const e of events) v.addEventListener(e, sync);
    return () => { for (const e of events) v.removeEventListener(e, sync); };
  }, [sync]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || casting) return;
    let t1: ReturnType<typeof setTimeout> | undefined;
    let t2: ReturnType<typeof setTimeout> | undefined;
    const begin = (): void => {
      if (t1) return;
      t1 = setTimeout(() => setStall((s) => Math.max(s, 1)), 400);
      t2 = setTimeout(() => setStall(2), 3000);
    };
    const end = (): void => {
      if (t1) clearTimeout(t1);
      if (t2) clearTimeout(t2);
      t1 = undefined; t2 = undefined;
      setStall(0);
    };
    v.addEventListener('waiting', begin);
    v.addEventListener('stalled', begin);
    v.addEventListener('loadstart', begin);
    v.addEventListener('playing', end);
    v.addEventListener('canplay', end);
    v.addEventListener('pause', end);
    begin();
    return () => {
      end();
      v.removeEventListener('waiting', begin);
      v.removeEventListener('stalled', begin);
      v.removeEventListener('loadstart', begin);
      v.removeEventListener('playing', end);
      v.removeEventListener('canplay', end);
      v.removeEventListener('pause', end);
    };
  }, [stream, casting, attempt]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const refresh = (): void => {
      const list: Array<{ index: number; label: string }> = [];
      for (let i = 0; i < v.textTracks.length; i++) {
        const t = v.textTracks[i];
        if (t.kind === 'subtitles' || t.kind === 'captions') {
          list.push({ index: i, label: t.label || t.language.toUpperCase() || `Track ${list.length + 1}` });
        }
      }
      setTracks(list);
    };
    refresh();
    v.textTracks.addEventListener('addtrack', refresh);
    v.textTracks.addEventListener('removetrack', refresh);
    return () => {
      v.textTracks.removeEventListener('addtrack', refresh);
      v.textTracks.removeEventListener('removetrack', refresh);
    };
  }, [stream, attempt]);

  const pickTrack = useCallback((index: number) => {
    const v = videoRef.current;
    if (!v) return;
    for (let i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = i === index ? 'showing' : 'disabled';
    setActiveTrack(index);
    setSubsOpen(false);
  }, []);

  useEffect(() => {
    const channelId = item.epgChannelId;
    if (!isLive || !channelId || !sourceId) { setNowNext(undefined); return; }
    let alive = true;
    const load = (): void => {
      window.iptv.epg.nowNext(sourceId, channelId)
        .then((n) => { if (alive) setNowNext(n); })
        .catch(() => { if (alive) setNowNext(undefined); });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [isLive, item.epgChannelId, sourceId]);

  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => setClockTick(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(timer);
  }, [isLive]);

  useEffect(() => {
    const episodeId = now.episodeId;
    if (item.kind !== 'series' || !episodeId || !sourceId) { setSiblings({}); return; }
    let alive = true;
    window.iptv.catalog.seriesDetail(sourceId, item.id)
      .then((detail) => {
        if (!alive) return;
        const flat = detail.seasons.flatMap((s) => detail.episodes[s] ?? []);
        const i = flat.findIndex((e) => e.id === episodeId);
        if (i >= 0) setSiblings({ prev: flat[i - 1], next: flat[i + 1] });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [item.kind, item.id, now.episodeId, sourceId]);

  const save = useCallback(() => {
    if (isLive || !sourceId) return;
    const duration = durRef.current;
    const position = posRef.current;
    if (!duration || position < 5) return;
    void window.iptv.library.saveProgress({
      itemId: item.id,
      sourceId,
      position: Math.floor(position),
      duration: Math.floor(duration),
      updatedAt: Date.now(),
      title: item.title || item.name,
      image: item.logo,
      kind: item.kind,
      episodeId: now.episodeId,
    }).catch(() => undefined);
  }, [isLive, sourceId, item.id, item.title, item.name, item.logo, item.kind, now.episodeId]);

  saveRef.current = save;

  useEffect(() => {
    if (isLive) return;
    const timer = setInterval(() => saveRef.current(), 10_000);
    return () => clearInterval(timer);
  }, [isLive]);

  const castLoaded = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!casting) {
      castLoaded.current = undefined;
      return;
    }
    if (castLoaded.current === stream.url) return;
    castLoaded.current = stream.url;
    void window.iptv.cast.load(stream, isLive ? undefined : posRef.current).catch((err: unknown) => {
      useApp.getState().toast$(errorText(err, 'The television refused this stream.'), 'error');
    });
  }, [casting, stream, isLive]);

  const stopped = media.paused || error !== undefined;

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined); else v.pause();
  }, []);

  const seekTime = useCallback((seconds: number) => {
    const v = videoRef.current;
    if (!v || isLive) return;
    const limit = durRef.current > 0 ? durRef.current - 1 : Number.MAX_SAFE_INTEGER;
    clockRef.current = seekTo(v, stream, clamp(seconds, 0, limit));
    sync();
  }, [isLive, stream, sync]);

  const seekBy = useCallback((delta: number) => seekTime(posRef.current + delta), [seekTime]);

  const nudgeVolume = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = clamp(v.volume + delta, 0, 1);
    if (v.volume > 0) v.muted = false;
  }, []);

  const setVolume = useCallback((level: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = clamp(level, 0, 1);
    v.muted = v.volume === 0;
  }, []);

  const toggleFullscreen = useCallback(() => {
    void window.iptv.window.toggleFullscreen().then(setFullscreen).catch(() => undefined);
  }, []);

  useEffect(() => window.iptv.on('window-state', (s) => setFullscreen(s.fullscreen)), []);

  const close = useCallback(() => {
    useApp.getState().patch({ nowPlaying: undefined, castPanelOpen: false });
  }, []);

  const retry = useCallback(() => {
    if (!isLive) resumeRef.current = posRef.current;
    setError(undefined);
    setAttempt((a) => a + 1);
  }, [isLive]);

  // A live pipe that ends or stays stalled has died behind the element; reattaching opens a new one.
  const revivalsRef = useRef(0);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !isLive || casting || error) return;
    const revive = (): void => {
      if (revivalsRef.current >= MAX_LIVE_REVIVALS) {
        setError('This channel keeps dropping out.');
        return;
      }
      revivalsRef.current += 1;
      retry();
    };
    const onPlaying = (): void => { revivalsRef.current = 0; playedRef.current = true; };
    const budget = playedRef.current ? LIVE_STALL_REVIVE_MS : LIVE_START_REVIVE_MS;
    const timer = stall > 1 ? setTimeout(revive, budget) : undefined;
    v.addEventListener('ended', revive);
    v.addEventListener('playing', onPlaying);
    return () => {
      if (timer) clearTimeout(timer);
      v.removeEventListener('ended', revive);
      v.removeEventListener('playing', onPlaying);
    };
  }, [isLive, casting, error, stall, retry]);

  const playFrom = useCallback((secondsAgo: number) => {
    if (!sourceId) return;
    resumeRef.current = Math.max(0, secondsAgo);
    window.iptv.player.resolve({ sourceId, itemId: item.id, startAt: Math.max(0, secondsAgo) })
      .then((next) => useApp.getState().patch({ nowPlaying: { stream: next, item, startAt: Math.max(0, secondsAgo) } }))
      .catch(() => setError('The catch-up recording for this programme is not available.'));
  }, [sourceId, item]);

  const playEpisode = useCallback((episode: Episode) => {
    if (!sourceId) return;
    saveRef.current();
    resumeRef.current = 0;
    window.iptv.player.resolve({ sourceId, itemId: item.id, episodeId: episode.id })
      .then((next) => useApp.getState().patch({ nowPlaying: { stream: next, item, episodeId: episode.id } }))
      .catch(() => setError('That episode did not resolve to a playable stream.'));
  }, [sourceId, item]);

  const holdRef = useRef(false);
  holdRef.current = hold || infoOpen || subsOpen || castPanelOpen || !!error;

  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (holdRef.current) return;
    idleTimer.current = setTimeout(() => setIdle(true), 2400);
  }, []);

  useEffect(() => {
    wake();
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current); };
  }, [wake, hold, infoOpen, subsOpen, castPanelOpen, error]);

  useEffect(() => {
    const onMove = (): void => wake();
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [wake]);

  useEffect(() => {
    if (!infoOpen) return;
    const timer = setTimeout(() => setInfoOpen(false), 6000);
    return () => clearTimeout(timer);
  }, [infoOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTextEntry(e.target as Element | null)) return;
      wake();

      switch (e.key) {
        case ' ': case 'k': case 'K': e.preventDefault(); togglePlay(); return;
        case 'ArrowLeft': e.preventDefault(); seekBy(-10); return;
        case 'ArrowRight': e.preventDefault(); seekBy(10); return;
        case 'j': case 'J': e.preventDefault(); seekBy(-30); return;
        case 'l': case 'L': e.preventDefault(); seekBy(30); return;
        case 'ArrowUp': e.preventDefault(); nudgeVolume(0.05); return;
        case 'ArrowDown': e.preventDefault(); nudgeVolume(-0.05); return;
        case 'm': case 'M': {
          const v = videoRef.current;
          if (v) v.muted = !v.muted;
          return;
        }
        case 'f': case 'F': toggleFullscreen(); return;
        case 'i': case 'I': setInfoOpen((o) => !o); return;
        case 'c': case 'C': toggleCastPicker('player'); return;
        case 'Escape':
          if (subsOpen) { setSubsOpen(false); return; }
          if (infoOpen) { setInfoOpen(false); return; }
          if (castPanelOpen) return;
          close();
          return;
        default: break;
      }

      if (!isLive && durRef.current > 0 && e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        seekTime((Number(e.key) / 10) * durRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wake, togglePlay, seekBy, seekTime, nudgeVolume, toggleFullscreen, close, isLive, subsOpen, infoOpen, castPanelOpen]);

  const programme: EpgProgramme | undefined = nowNext?.now;
  const liveFraction = programme ? progressThrough(programme.start, programme.stop, clockTick) : 0;
  const playedFraction = programme
    ? progressThrough(programme.start, programme.stop, clockTick - timeshift)
    : 0;
  const vodFraction = total > 0 ? clamp(media.position / total, 0, 1) : 0;
  const bufferedFraction = total > 0 ? clamp(media.buffered / total, 0, 1) : 0;
  const volumeLevel = media.muted ? 0 : media.volume;

  const heading = isLive ? (programme?.title ?? (item.title || item.name)) : (stream.title || item.title || item.name);
  const subheading = isLive && programme ? (item.title || item.name) : undefined;

  const scrubbable = !isLive && total > 0;
  const epgPending = isLive && !!item.epgChannelId && nowNext === undefined;
  const archived = isLive && (item.hasArchive === true) && !!programme;

  const trackRef = useRef<HTMLDivElement>(null);
  const timeAt = (clientX: number): { fraction: number; seconds: number } | undefined => {
    const el = trackRef.current;
    if (!el) return undefined;
    const box = el.getBoundingClientRect();
    const fraction = clamp((clientX - box.left) / box.width, 0, 1);
    if (scrubbable) return { fraction, seconds: fraction * total };
    if (programme) return { fraction, seconds: programme.start + fraction * (programme.stop - programme.start) };
    return undefined;
  };

  const commitScrub = (clientX: number): void => {
    const at = timeAt(clientX);
    if (!at) return;
    if (scrubbable) { seekTime(at.seconds); return; }
    if (archived) playFrom(Math.max(0, clockTick - at.seconds));
  };

  const interactive = scrubbable || archived;

  return (
    <div
      className="player"
      data-idle={idle}
      data-casting={casting}
    >
      <video
        ref={videoRef}
        className="player__video"
        playsInline
        hidden={casting}
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
      />

      {casting && (
        <div className="castscreen">
          <div className="castscreen__art">
            {isLive
              ? <LogoPlate item={item} size="large" />
              : <Poster item={item} className="castscreen__poster" />}
          </div>
          <h2 className="serif-2 castscreen__title" dir="auto">{item.title || item.name}</h2>
          <p className="castscreen__to sm">Casting to {cast.device?.name ?? 'your television'}</p>
        </div>
      )}

      {stall > 0 && !error && !casting && (
        <div className="player__stall">
          <Spinner />
          {stall > 1 && (
            <span className="player__stallnote data">
              {Math.max(0, Math.round(media.buffered - media.position))}s buffered
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="failure" role="alert">
          <span className="failure__glyph"><TriangleAlert size={20} strokeWidth={1.5} /></span>
          <h2 className="h2">{isLive ? 'This channel did not respond' : 'This title did not start'}</h2>
          <p className="failure__body sm t-secondary">{error}</p>
          <div className="failure__actions">
            <Button variant="primary" onClick={retry}>Retry</Button>
            <Button variant="ghost" onClick={() => void window.iptv.player.openExternal(stream.directUrl)}>
              Open in external player
            </Button>
          </div>
        </div>
      )}

      <div
        className="player__top drag"
        data-platform={PLATFORM}
        onPointerEnter={() => setHold(true)}
        onPointerLeave={() => setHold(false)}
      >
        <button className="player__back no-drag" onClick={close} aria-label="Back">
          <ChevronLeft size={26} strokeWidth={1.5} />
        </button>
        <button className="player__heading no-drag" onClick={() => setInfoOpen((o) => !o)}>
          <span className="player__title h2"><TruncateTail text={heading} /></span>
          {subheading
            ? <span className="player__sub data">{subheading}</span>
            : (!isLive && <Kicker className="player__sub" parts={[item.year, total > 0 && `${Math.round(total / 60)} MIN`]} rating={item.rating} />)}
        </button>
        <span className="player__topspacer" />
        {!IS_MAC && <WindowControls className="player__controls" />}
      </div>

      {!casting && (
        <div
          className="player__bottom"
          onPointerEnter={() => setHold(true)}
          onPointerLeave={() => setHold(false)}
        >
          {isLive && !programme ? (
            <div className="scrub scrub--bare">
              {epgPending ? <span className="scrub__pending" aria-hidden /> : (
                <span className="livemark kicker">
                  <span className="livemark__dot"><Tally orientation="horizontal" /></span>
                  Live
                </span>
              )}
            </div>
          ) : (
            <div className="scrub">
              {isLive && programme && (
                <div className="scrub__programme">
                  <span className="scrub__progtitle" dir="auto">{programme.title}</span>
                  {nowNext?.next && <span className="scrub__next caption t-tertiary" dir="auto">Next: {nowNext.next.title}</span>}
                </div>
              )}
              <div className="scrub__row">
                {isLive && programme && <span className="scrub__clock data">{formatClock(programme.start)}</span>}
                <div
                  className={classNames('scrub__hit', interactive && 'scrub__hit--seekable')}
                  ref={trackRef}
                  role="slider"
                  tabIndex={0}
                  aria-label={isLive ? 'Programme position' : 'Playback position'}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round((isLive ? playedFraction : vodFraction) * 100)}
                  onPointerDown={(e) => {
                    if (!interactive) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setHover({ x: e.clientX - e.currentTarget.getBoundingClientRect().left, t: timeAt(e.clientX)?.seconds ?? 0 });
                  }}
                  onPointerMove={(e) => {
                    if (!interactive) return;
                    const at = timeAt(e.clientX);
                    if (at) setHover({ x: e.clientX - e.currentTarget.getBoundingClientRect().left, t: at.seconds });
                  }}
                  onPointerUp={(e) => {
                    if (!interactive) return;
                    e.currentTarget.releasePointerCapture(e.pointerId);
                    commitScrub(e.clientX);
                  }}
                  onPointerLeave={() => setHover(undefined)}
                >
                  <div className="scrub__track">
                    {!isLive && <div className="scrub__buffered" style={{ width: `${bufferedFraction * 100}%` }} />}
                    {isLive && timeshift > 0 && <div className="scrub__shift" style={{ width: `${liveFraction * 100}%` }} />}
                    <div className="scrub__fill" style={{ width: `${(isLive ? playedFraction : vodFraction) * 100}%` }}>
                      <Tally orientation="horizontal" />
                    </div>
                    {interactive && (
                      <div className="scrub__knob" style={{ insetInlineStart: `${(isLive ? playedFraction : vodFraction) * 100}%` }}>
                        <Tally orientation="horizontal" />
                      </div>
                    )}
                  </div>
                  {hover && interactive && (
                    <span className="scrub__bubble data" style={{ insetInlineStart: `${hover.x}px` }}>
                      {isLive ? formatClock(hover.t) : formatDuration(hover.t)}
                    </span>
                  )}
                </div>
                {isLive && programme && <span className="scrub__clock data">{formatClock(programme.stop)}</span>}
              </div>
            </div>
          )}

          <div className="transport">
            <div className="transport__cluster">
              <button className="player__btn player__btn--play" onClick={togglePlay} aria-label={stopped ? 'Play' : 'Pause'}>
                {stopped ? <PlayGlyph /> : <PauseGlyph />}
              </button>

              {prevEpisode && (
                <Tooltip label="Previous episode" placement="top">
                  <button className="player__btn" onClick={() => playEpisode(prevEpisode)} aria-label="Previous episode">
                    <SkipBack size={20} strokeWidth={1.5} />
                  </button>
                </Tooltip>
              )}
              {nextEpisode && (
                <Tooltip label="Next episode" placement="top">
                  <button className="player__btn" onClick={() => playEpisode(nextEpisode)} aria-label="Next episode">
                    <SkipForward size={20} strokeWidth={1.5} />
                  </button>
                </Tooltip>
              )}

              {!isLive && (
                <>
                  <button className="player__btn" onClick={() => seekBy(-10)} aria-label="Back ten seconds"><BackGlyph seconds={10} /></button>
                  <button className="player__btn" onClick={() => seekBy(30)} aria-label="Forward thirty seconds"><ForwardGlyph seconds={30} /></button>
                </>
              )}

              <span className="transport__time">
                {formatDuration(media.position)}
                {total > 0 && <span className="transport__total"> / {formatDuration(total)}</span>}
              </span>
            </div>

            <div className="transport__cluster transport__cluster--end">
              <div className="volume">
                <button
                  className="player__btn"
                  onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted; }}
                  aria-label={media.muted ? 'Unmute' : 'Mute'}
                >
                  <VolumeGlyph level={volumeLevel} />
                </button>
                <div
                  className="volume__hit"
                  role="slider"
                  tabIndex={0}
                  aria-label="Volume"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(volumeLevel * 100)}
                  onKeyDown={(e) => {
                    const step = e.key === 'ArrowLeft' ? -0.05 : e.key === 'ArrowRight' ? 0.05 : 0;
                    if (!step) return;
                    e.preventDefault();
                    nudgeVolume(step);
                  }}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    const box = e.currentTarget.getBoundingClientRect();
                    setVolume((e.clientX - box.left) / box.width);
                  }}
                  onPointerMove={(e) => {
                    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                    const box = e.currentTarget.getBoundingClientRect();
                    setVolume((e.clientX - box.left) / box.width);
                  }}
                  onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
                >
                  <div className="volume__track"><div className="volume__fill" style={{ width: `${volumeLevel * 100}%` }} /></div>
                </div>
              </div>

              {tracks.length > 0 && (
                <div className="menu-anchor">
                  <button
                    className={classNames('player__btn', activeTrack >= 0 && 'player__btn--on')}
                    onClick={() => setSubsOpen((o) => !o)}
                    aria-label="Subtitles"
                    aria-expanded={subsOpen}
                  >
                    <Captions size={20} strokeWidth={1.5} />
                  </button>
                  {subsOpen && (
                    <div className="menu" role="menu">
                      <button className="menu__row sm" role="menuitem" onClick={() => pickTrack(-1)}>
                        <span className="menu__check">{activeTrack < 0 && <Check size={12} strokeWidth={1.5} />}</span>Off
                      </button>
                      {tracks.map((t) => (
                        <button key={t.index} className="menu__row sm" role="menuitem" onClick={() => pickTrack(t.index)}>
                          <span className="menu__check">{activeTrack === t.index && <Check size={12} strokeWidth={1.5} />}</span>
                          <span className="truncate">{t.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <CastButton place="player" />

              {document.pictureInPictureEnabled && (
                <Tooltip label="Picture in picture" placement="top">
                  <button
                    className="player__btn"
                    aria-label="Picture in picture"
                    onClick={() => {
                      const v = videoRef.current;
                      if (!v) return;
                      if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
                      else void v.requestPictureInPicture().catch(() => undefined);
                    }}
                  >
                    <PictureInPicture2 size={20} strokeWidth={1.5} />
                  </button>
                </Tooltip>
              )}

              <button className="player__btn" onClick={toggleFullscreen} aria-label={fullscreen ? 'Leave fullscreen' : 'Fullscreen'}>
                {fullscreen ? <Minimize size={20} strokeWidth={1.5} /> : <Maximize size={20} strokeWidth={1.5} />}
              </button>
            </div>
          </div>
        </div>
      )}

      {infoOpen && (
        <InfoPanel
          now={now}
          programme={programme}
          next={nowNext?.next}
          archived={archived}
          onWatchFromStart={() => programme && playFrom(Math.max(0, clockTick - programme.start))}
          onClose={() => setInfoOpen(false)}
        />
      )}
    </div>
  );
}

function InfoPanel({
  now, programme, next, archived, onWatchFromStart, onClose,
}: {
  now: NowPlaying;
  programme?: EpgProgramme;
  next?: EpgProgramme;
  archived: boolean;
  onWatchFromStart: () => void;
  onClose: () => void;
}) {
  const { item } = now;
  const isLive = item.kind === 'live';
  const body = programme?.description ?? item.plot;

  const genres = useMemo(
    () => splitGenres(item.genre).filter(Boolean).slice(0, 4),
    [item.genre],
  );

  return (
    <aside className="info" aria-label="Now playing">
      <div className="info__art">
        {isLive ? <LogoPlate item={item} size="large" /> : <Poster item={item} className="info__poster" />}
      </div>

      <h2 className="info__title h2" dir="auto">{programme?.title ?? item.title ?? item.name}</h2>
      {isLive && <p className="info__channel sm t-secondary"><TruncateTail text={item.name} /></p>}

      {programme && (
        <p className="info__times data">
          {formatClock(programme.start)} – {formatClock(programme.stop)}
        </p>
      )}
      {!isLive && <Kicker parts={[item.year]} rating={item.rating} className="info__kicker" />}

      {body ? <p className="info__body sm t-secondary" dir="auto">{body}</p> : <p className="info__body info__body--none sm t-tertiary">No description was published for this programme.</p>}

      {next && <p className="info__next caption t-tertiary">Next: {next.title}</p>}

      {genres.length > 0 && (
        <div className="info__genres">
          {genres.map((g) => <span key={g} className="info__genre micro">{g}</span>)}
        </div>
      )}

      <div className="info__actions">
        {archived && <Button variant="ghost" onClick={onWatchFromStart}>Watch from start</Button>}
        <Button variant="plain" onClick={onClose}>Close</Button>
      </div>
    </aside>
  );
}
