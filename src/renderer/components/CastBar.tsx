import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type RefObject,
} from 'react';
import { Check, Tv, Volume2, VolumeX } from 'lucide-react';
import type { CastDevice, MediaItem } from '@shared/types';
import { useApp } from '@/state/store';
import {
  Button, EmptyState, LogoPlate, PauseGlyph, PlayGlyph, Poster, Skeleton, Tooltip, TruncateTail,
} from '@/components/Primitives';
import { classNames, errorText, formatDuration, progressThrough } from '@/lib/format';
import './castbar.css';

type CastState = 'idle' | 'found' | 'connecting' | 'connected' | 'error';

function CastGlyph({ state }: { state: CastState }) {
  return (
    <svg className={`castglyph castglyph--${state}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path className="castglyph__screen" d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
      <path className="castglyph__arc castglyph__arc--3" d="M2 12a9 9 0 0 1 8 8" />
      <path className="castglyph__arc castglyph__arc--2" d="M2 16a5 5 0 0 1 4 4" />
      <path className="castglyph__arc castglyph__arc--1" d="M2 20h.01" />
    </svg>
  );
}

type Place = 'titlebar' | 'player';

let panelOwner: Place = 'titlebar';

export function toggleCastPicker(place: Place = 'titlebar'): void {
  const { castPanelOpen, patch } = useApp.getState();
  const open = panelOwner === place ? !castPanelOpen : true;
  panelOwner = place;
  patch({ castPanelOpen: open });
}

let lastDevices: CastDevice[] = [];
const foundSubs = new Set<() => void>();

function publishDevices(devices: CastDevice[]): void {
  lastDevices = devices;
  for (const notify of foundSubs) notify();
}

function subscribeFound(notify: () => void): () => void {
  foundSubs.add(notify);
  return () => { foundSubs.delete(notify); };
}

function useFoundCount(): number {
  return useSyncExternalStore(subscribeFound, () => lastDevices.length);
}

interface PickerProps {
  place: Place;
  connectingId?: string;
  onConnect: (device: CastDevice) => void;
  onDisconnect: () => void;
}

function DevicePicker({ place, connectingId, onConnect, onDisconnect }: PickerProps) {
  const cast = useApp((s) => s.cast);
  const [devices, setDevices] = useState<CastDevice[]>(lastDevices);
  const [scanning, setScanning] = useState(true);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const found = await window.iptv.cast.scan();
      setDevices(found);
      publishDevices(found);
    } catch {
      setDevices([]);
      publishDevices([]);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => { void scan(); }, [scan]);

  return (
    <div className="castpicker" data-place={place} role="dialog" aria-label="Cast to a device">
      <div className="castpicker__head">
        <span className="kicker">Cast to</span>
        {!scanning && (
          <button className="castpicker__rescan caption" onClick={() => void scan()}>Rescan</button>
        )}
      </div>

      {cast.error && <p className="castpicker__error sm">{cast.error}</p>}

      {scanning && devices.length === 0 && (
        <div className="castpicker__list">
          {[0, 1, 2].map((i) => (
            <div className="castpicker__row castpicker__row--ghost" key={i}>
              <Skeleton width={16} height={16} radius={4} style={{ animationDelay: `${i * 120}ms` }} />
              <div className="castpicker__ghosttext">
                <Skeleton width={`${66 - i * 11}%`} height={9} radius={3} style={{ animationDelay: `${i * 120}ms` }} />
                <Skeleton width="30%" height={7} radius={3} style={{ animationDelay: `${i * 120 + 60}ms` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {!scanning && devices.length === 0 && !cast.connected && (
        <EmptyState
          glyph={<Tv size={24} strokeWidth={1.5} />}
          title="Nothing answered"
          body="No Chromecast on this network answered the scan."
          action={<Button variant="ghost" onClick={() => void scan()}>Scan again</Button>}
        />
      )}

      {devices.length > 0 && (
        <div className="castpicker__list">
          {devices.map((d) => {
            const active = cast.connected && cast.device?.id === d.id;
            return (
              <button
                key={d.id}
                className={classNames('castpicker__row', active && 'castpicker__row--active')}
                onClick={() => { if (!active) onConnect(d); }}
                disabled={connectingId !== undefined}
              >
                <span className="castpicker__glyph"><Tv size={16} strokeWidth={1.5} /></span>
                <span className="castpicker__name">
                  <TruncateTail text={d.name} />
                  {d.model && <span className="castpicker__model">{d.model}</span>}
                </span>
                {active && <span className="castpicker__check"><Check size={14} strokeWidth={1.5} /></span>}
                {connectingId === d.id && <span className="castpicker__busy caption">Connecting</span>}
              </button>
            );
          })}
        </div>
      )}

      {cast.connected && (
        <div className="castpicker__foot">
          <button className="castpicker__row castpicker__row--stop sm" onClick={onDisconnect}>Disconnect</button>
        </div>
      )}
    </div>
  );
}

export function CastButton({ place = 'titlebar' }: { place?: Place }) {
  const cast = useApp((s) => s.cast);
  const open = useApp((s) => s.castPanelOpen) && panelOwner === place;
  const found = useFoundCount();
  const [connectingId, setConnectingId] = useState<string>();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) useApp.getState().patch({ castPanelOpen: false });
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        useApp.getState().patch({ castPanelOpen: false });
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const connect = (device: CastDevice): void => {
    setConnectingId(device.id);
    window.iptv.cast
      .connect(device.id)
      .then(() => useApp.getState().patch({ castPanelOpen: false }))
      .catch((err: unknown) => {
        useApp.getState().toast$(errorText(err, `${device.name} did not answer.`), 'error');
      })
      .finally(() => setConnectingId(undefined));
  };

  const disconnect = (): void => {
    void window.iptv.cast.disconnect().catch(() => undefined);
    useApp.getState().patch({ castPanelOpen: false });
  };

  const state: CastState = cast.error ? 'error'
    : cast.connected ? 'connected'
      : connectingId ? 'connecting'
        : found > 0 ? 'found'
          : 'idle';
  const label = cast.connected && cast.device ? `Casting to ${cast.device.name}` : 'Cast to a device';

  return (
    <div className="castbtn-wrap no-drag" ref={wrap}>
      {cast.connected && cast.device && place === 'titlebar' && (
        <span className="castbtn__device sm"><TruncateTail text={cast.device.name} /></span>
      )}
      <Tooltip label={label} placement={place === 'player' ? 'top' : 'bottom'}>
        <button
          className={classNames('castbtn', `castbtn--${place}`, `castbtn--${state}`)}
          aria-label={label}
          aria-expanded={open}
          onClick={() => toggleCastPicker(place)}
        >
          <CastGlyph state={state} />
        </button>
      </Tooltip>
      {open && (
        <DevicePicker place={place} connectingId={connectingId} onConnect={connect} onDisconnect={disconnect} />
      )}
    </div>
  );
}

function useContentEdge(line: RefObject<HTMLDivElement | null>, active: boolean): void {
  const route = useApp((s) => s.route);

  useLayoutEffect(() => {
    if (!active) return;
    const content = document.querySelector('.shell__content');
    if (!content) return;
    const place = (): void => {
      const el = line.current;
      if (!el) return;
      const box = content.getBoundingClientRect();
      el.style.top = `${box.top}px`;
      el.style.left = `${box.left}px`;
      el.style.width = `${box.width}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(content);
    return () => observer.disconnect();
  }, [line, active, route]);
}

export function CastBar() {
  const cast = useApp((s) => s.cast);
  const item = useApp((s) => s.nowPlaying?.item);

  const [artwork, setArtwork] = useState<MediaItem>();
  useEffect(() => { if (item) setArtwork(item); }, [item]);
  useEffect(() => { if (!cast.connected) setArtwork(undefined); }, [cast.connected]);

  const [scrub, setScrub] = useState<number>();
  const trackRef = useRef<HTMLDivElement>(null);

  const lineRef = useRef<HTMLDivElement>(null);
  useContentEdge(lineRef, cast.connected);

  const [volLocal, setVolLocal] = useState<number>();
  const volSend = useRef<ReturnType<typeof setTimeout>>(undefined);
  const volRelease = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => {
    if (volSend.current) clearTimeout(volSend.current);
    if (volRelease.current) clearTimeout(volRelease.current);
  }, []);

  const pushVolume = useCallback((level: number, immediate: boolean) => {
    setVolLocal(level);
    if (volSend.current) clearTimeout(volSend.current);
    if (volRelease.current) clearTimeout(volRelease.current);
    const send = (): void => { void window.iptv.cast.setVolume(level).catch(() => undefined); };
    if (immediate) send();
    else volSend.current = setTimeout(send, 120);
    volRelease.current = setTimeout(() => setVolLocal(undefined), 900);
  }, []);

  if (!cast.connected) return null;

  const duration = cast.duration && cast.duration > 0 ? cast.duration : undefined;
  const position = scrub ?? cast.currentTime;
  const fraction = progressThrough(0, duration ?? 0, position);
  const playing = cast.state === 'PLAYING' || cast.state === 'BUFFERING';
  const muted = cast.muted || cast.volume <= 0;

  const timeAt = (clientX: number): number | undefined => {
    const el = trackRef.current;
    if (!el || !duration) return undefined;
    const box = el.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - box.left) / box.width) * duration));
  };

  return (
    <>
      <div className="castline" ref={lineRef} aria-hidden />
      <div className="castbar" role="region" aria-label="Cast transport">
        <div className="castbar__art">
          {artwork
            ? (artwork.kind === 'live'
              ? <LogoPlate item={artwork} size="compact" />
              : <Poster item={artwork} className="castbar__poster" />)
            : <span className="castbar__artfallback"><Tv size={16} strokeWidth={1.5} /></span>}
        </div>

        <div className="castbar__meta">
          <span className="castbar__title sm">
            <TruncateTail text={cast.title ?? artwork?.title ?? 'Nothing loaded'} />
          </span>
          <span className="castbar__device caption">
            {cast.state === 'BUFFERING' ? 'Buffering on ' : 'Casting to '}
            {cast.device?.name ?? 'a television'}
          </span>
        </div>

        <button
          className="castbar__btn castbar__btn--transport"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => { void (playing ? window.iptv.cast.pause() : window.iptv.cast.play()).catch(() => undefined); }}
        >
          {playing ? <PauseGlyph size={18} /> : <PlayGlyph size={18} />}
        </button>

        <div className="castbar__scrub">
          <span className="castbar__time data">{formatDuration(position)}</span>
          {duration ? (
            <div
              className="castbar__track"
              ref={trackRef}
              role="slider"
              tabIndex={0}
              aria-label="Cast position"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(position)}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setScrub(timeAt(e.clientX));
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) setScrub(timeAt(e.clientX));
              }}
              onPointerUp={(e) => {
                e.currentTarget.releasePointerCapture(e.pointerId);
                const t = timeAt(e.clientX);
                setScrub(undefined);
                if (t !== undefined) void window.iptv.cast.seek(t).catch(() => undefined);
              }}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowLeft' ? -10 : e.key === 'ArrowRight' ? 10 : 0;
                if (!step) return;
                e.preventDefault();
                void window.iptv.cast.seek(Math.max(0, Math.min(duration, cast.currentTime + step))).catch(() => undefined);
              }}
            >
              <div className="castbar__fill" style={{ transform: `scaleX(${fraction})` }} />
            </div>
          ) : (
            <div className="castbar__track castbar__track--flat" />
          )}
          <span className="castbar__time data">{duration ? formatDuration(duration) : '--:--'}</span>
        </div>

        <div className="castbar__volume">
          <button
            className="castbar__btn"
            aria-label={muted ? 'Unmute' : 'Mute'}
            onClick={() => pushVolume(muted ? 0.6 : 0, true)}
          >
            {muted ? <VolumeX size={16} strokeWidth={1.5} /> : <Volume2 size={16} strokeWidth={1.5} />}
          </button>
          <input
            className="castbar__vol"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volLocal ?? (muted ? 0 : cast.volume)}
            aria-label="Cast volume"
            onChange={(e) => pushVolume(Number(e.target.value), false)}
            onPointerUp={(e) => pushVolume(Number(e.currentTarget.value), true)}
          />
        </div>

        <Button variant="ghost" onClick={() => { void window.iptv.cast.disconnect().catch(() => undefined); }}>
          Stop casting
        </Button>
      </div>
    </>
  );
}
