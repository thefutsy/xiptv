import { useEffect, useRef, useState } from 'react';
import { Captions, Check } from 'lucide-react';
import type { TrackState, CaptionAppearance } from '@shared/tracks';
import { DEFAULT_PLAYBACK, languageCode } from '@shared/tracks';
import { getTrackController } from '@/lib/playback';

export function TrackMenu({ state, open, onOpen, appearance, onAppearance }: {
  state: TrackState; open: boolean; onOpen: (open: boolean) => void;
  appearance: CaptionAppearance; onAppearance: (appearance: CaptionAppearance) => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [delay, setDelay] = useState(0);
  useEffect(() => setDelay(getTrackController()?.delay ?? 0), [state.sessionId]);
  const close = () => { onOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) onOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const image = state.tracks.find(t => t.id === state.subtitleId)?.image;
  const pick = (kind: 'audio' | 'subtitle', id?: string) => { void getTrackController()?.select(kind, id); };
  return (
    <div className="menu-anchor" ref={anchor}>
      <button ref={trigger} className={`player__btn${state.subtitleId ? ' player__btn--on' : ''}`} aria-label="Audio & captions"
        aria-expanded={open} aria-haspopup="dialog" onClick={() => onOpen(!open)}><Captions size={20} strokeWidth={1.5} /></button>
      {open && <div ref={panel} className="track-menu" role="dialog" aria-label="Audio & captions" onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); return; }
        const target = event.target as HTMLElement;
        if (target.matches('input, select')) return;
        if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const group = target.closest('[role=radiogroup]');
        const buttons = Array.from((group ?? panel.current)?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const at = buttons.indexOf(target as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
        if (group) buttons[next]?.click();
      }}>
        <div className="track-menu__heading"><strong>Audio & captions</strong><button onClick={close} aria-label="Close audio and captions">Close</button></div>
        {(state.status === 'discovering' || state.switching) && <p role="status">{state.status === 'discovering' ? 'Finding available tracks…' : 'Switching tracks…'}</p>}
        {state.error && <p className="track-menu__error" role="status">{state.error} <button onClick={() => void getTrackController()?.retry()}>Retry</button></p>}
        {(['audio', 'subtitle'] as const).map(kind => <section key={kind} aria-label={kind === 'audio' ? 'Audio' : 'Captions'}>
          <h3>{kind === 'audio' ? 'Audio' : 'Captions'}</h3>
          <div role="radiogroup" aria-label={kind === 'audio' ? 'Audio track' : 'Caption track'}>
            {kind === 'subtitle' && <button role="radio" tabIndex={!state.subtitleId ? 0 : -1} aria-checked={!state.subtitleId} className="track-menu__track" onClick={() => pick('subtitle')}><Check size={14} style={{ visibility: !state.subtitleId ? 'visible' : 'hidden' }} />Off</button>}
            {state.tracks.filter(t => t.kind === kind).map(t => {
              let label = t.label;
              if (t.language && t.label.toLowerCase() === t.language.toLowerCase()) {
                try { label = new Intl.DisplayNames(['en'], { type: 'language' }).of(languageCode(t.language)) ?? label; } catch {}
              }
              const checked = (kind === 'audio' ? state.audioId : state.subtitleId) === t.id;
              return <button key={t.id} className="track-menu__track" role="radio" tabIndex={checked ? 0 : -1} aria-checked={checked} disabled={!t.supported} title={t.reason} onClick={() => pick(kind, t.id)}>
                <Check size={14} style={{ visibility: checked ? 'visible' : 'hidden' }} />
                <span><span>{label}</span><small>{[t.language?.toUpperCase(), t.codec, t.forced && 'Forced', ...t.roles, t.image && 'Image subtitles', t.reason].filter(Boolean).join(' · ')}</small></span>
              </button>;
            })}
            {!state.tracks.some(t => t.kind === kind) && state.status !== 'discovering' && <p>{kind === 'audio' ? 'Source audio' : 'No embedded captions detected.'}</p>}
          </div>
        </section>)}
        <button className="track-menu__load" onClick={() => void getTrackController()?.importSubtitles()}>Load subtitle file…</button>
        <section aria-label="Caption appearance">
          <h3>Text appearance</h3>
          {image && <p>Image subtitles keep their original appearance.</p>}
          <label>Text size <span>{appearance.size}%</span><input disabled={image} aria-label="Caption text size" type="range" min="75" max="200" step="5" value={appearance.size} onChange={e => onAppearance({ ...appearance, size: +e.target.value })} /></label>
          <label>Text color<select disabled={image} aria-label="Caption text color" value={appearance.color} onChange={e => onAppearance({ ...appearance, color: e.target.value as 'white' | 'yellow' })}><option value="white">White</option><option value="yellow">Yellow</option></select></label>
          <label>Background <span>{Math.round(appearance.background * 100)}%</span><input disabled={image} aria-label="Caption background opacity" type="range" min="0" max="100" step="5" value={Math.round(appearance.background * 100)} onChange={e => onAppearance({ ...appearance, background: +e.target.value / 100 })} /></label>
          <button disabled={image} onClick={() => onAppearance(DEFAULT_PLAYBACK.appearance)}>Reset appearance</button>
        </section>
        <section aria-label="Caption timing">
          <h3>Timing</h3><label>Delay (seconds)<input aria-label="Caption delay in seconds" type="number" min="-10" max="10" step="0.1" value={delay} onChange={e => {
            const value = e.target.valueAsNumber; if (!Number.isFinite(value)) return;
            const next = Math.max(-10, Math.min(10, value)); setDelay(next); void getTrackController()?.setDelay(next);
          }} /></label><p>Positive values show captions later.</p>
          <button onClick={() => { setDelay(0); void getTrackController()?.setDelay(0); }}>Reset timing</button>
        </section>
      </div>}
    </div>
  );
}
