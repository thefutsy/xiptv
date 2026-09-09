import {
  memo, useCallback, useEffect, useRef, useState,
  type ReactNode,
} from 'react';
import {
  ArrowRight, ArrowUpDown, Cast, Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink,
  Film, Play, Star, Tv,
} from 'lucide-react';
import type { MediaItem, WatchProgress } from '@shared/types';
import { Absence, Kicker, Poster } from '@/components/Primitives';
import { classNames, progressThrough } from '@/lib/format';
import { activeSource, useApp } from '@/state/store';
import '@/views/browse.css';

interface GlyphProps { size?: number }

const ICON = { strokeWidth: 1.5, absoluteStrokeWidth: true, 'aria-hidden': true, focusable: false } as const;

export const Glyph = {
  Play: ({ size = 16 }: GlyphProps) => <Play {...ICON} size={size} fill="currentColor" stroke="none" />,
  Star: ({ size = 16, filled = false }: GlyphProps & { filled?: boolean }) => (
    <Star {...ICON} size={size} fill={filled ? 'currentColor' : 'none'} />
  ),
  Check: ({ size = 16 }: GlyphProps) => <Check {...ICON} size={size} />,
  ChevronDown: ({ size = 16 }: GlyphProps) => <ChevronDown {...ICON} size={size} />,
  ChevronLeft: ({ size = 16 }: GlyphProps) => <ChevronLeft {...ICON} size={size} />,
  ChevronRight: ({ size = 16 }: GlyphProps) => <ChevronRight {...ICON} size={size} />,
  ArrowRight: ({ size = 16 }: GlyphProps) => <ArrowRight {...ICON} size={size} />,
  External: ({ size = 16 }: GlyphProps) => <ExternalLink {...ICON} size={size} />,
  Cast: ({ size = 16 }: GlyphProps) => <Cast {...ICON} size={size} />,
  Sort: ({ size = 16 }: GlyphProps) => <ArrowUpDown {...ICON} size={size} />,
  Film: ({ size = 16 }: GlyphProps) => <Film {...ICON} size={size} />,
  Tv: ({ size = 16 }: GlyphProps) => <Tv {...ICON} size={size} />,
};

const QUALITY = /\b(4K|UHD|FHD|HD|SD|HEVC|H\.?265)\b/i;

export function qualityTag(name: string): string | undefined {
  const m = QUALITY.exec(name);
  return m ? m[1].toUpperCase().replace('.', '') : undefined;
}

export function humanGenre(input: string): string {
  const t = input.trim();
  if (!t) return t;
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err ?? '');
}

/** "1h 16m", "48m". */
export function coarseDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function seasonsLabel(n: number): string {
  return `${n} ${n === 1 ? 'season' : 'seasons'}`;
}

export function useIsFavourite(id: string): boolean {
  return useApp((s) => s.favourites.some((f) => f.id === id));
}

export async function toggleFavourite(item: MediaItem): Promise<void> {
  const { favourites, patch, toast$ } = useApp.getState();
  try {
    const on = await window.iptv.library.toggleFavourite(item);
    patch({
      favourites: on
        ? [...favourites.filter((f) => f.id !== item.id), item]
        : favourites.filter((f) => f.id !== item.id),
    });
  } catch (err) {
    toast$(messageOf(err) || 'Could not update favourites.', 'error');
  }
}

export async function playItem(
  item: MediaItem,
  opts: { episodeId?: string; startAt?: number } = {},
): Promise<void> {
  const src = activeSource();
  const { patch, toast$ } = useApp.getState();
  if (!src) { toast$('No provider is connected.', 'error'); return; }
  try {
    const stream = await window.iptv.player.resolve({
      sourceId: src.id, itemId: item.id, episodeId: opts.episodeId, startAt: opts.startAt,
    });
    patch({ nowPlaying: { stream, item, episodeId: opts.episodeId, startAt: opts.startAt } });
  } catch (err) {
    toast$(messageOf(err) || 'That stream did not respond.', 'error');
  }
}

export async function openExternally(item: MediaItem, episodeId?: string): Promise<void> {
  const src = activeSource();
  const { toast$ } = useApp.getState();
  if (!src) return;
  try {
    const stream = await window.iptv.player.resolve({ sourceId: src.id, itemId: item.id, episodeId });
    await window.iptv.player.openExternal(stream.directUrl);
  } catch (err) {
    toast$(messageOf(err) || 'Could not hand this stream to an external player.', 'error');
  }
}

export async function playProgress(p: WatchProgress): Promise<void> {
  const src = activeSource();
  if (!src) return;
  let item: MediaItem;
  try {
    item = await window.iptv.catalog.itemDetail(src.id, p.itemId);
  } catch {
    item = {
      id: p.itemId, kind: p.kind, name: p.title, title: p.title,
      categoryId: '', streamId: 0, logo: p.image,
    };
  }
  await playItem(item, { episodeId: p.episodeId, startAt: p.position > 30 ? p.position : undefined });
}

const ASPECT_VERDICT = new Map<string, boolean>();

function metaParts(item: MediaItem): Array<string | number | undefined> {
  if (item.kind !== 'series') return [item.year];
  return [item.year, item.seasonCount ? seasonsLabel(item.seasonCount) : undefined];
}

export const MediaCard = memo(function MediaCard({
  item, onOpen,
}: { item: MediaItem; onOpen?: (item: MediaItem) => void }) {
  const favourite = useIsFavourite(item.id);
  const frame = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(() => (item.logo ? ASPECT_VERDICT.get(item.logo) ?? false : false));

  useEffect(() => {
    setWide(item.logo ? ASPECT_VERDICT.get(item.logo) ?? false : false);
  }, [item.logo]);

  // `load` does not bubble, so the frame catches it in the capture phase. A landscape image
  // sold as a poster is shown whole rather than cropped to a stripe.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const url = item.logo;
    const onLoad = (e: Event) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.naturalWidth || !img.naturalHeight) return;
      const landscape = img.naturalWidth / img.naturalHeight > 1;
      if (url) ASPECT_VERDICT.set(url, landscape);
      setWide(landscape);
    };
    el.addEventListener('load', onLoad, true);
    return () => el.removeEventListener('load', onLoad, true);
  }, [item.logo]);

  const open = useCallback(() => {
    if (onOpen) onOpen(item);
    else useApp.getState().navigate({ view: 'detail', item });
  }, [item, onOpen]);

  return (
    <div
      className="mcard"
      role="button"
      tabIndex={0}
      aria-label={item.title || item.name}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      }}
    >
      <div className="mcard__frame" ref={frame}>
        <Poster item={item} className={classNames('mcard__poster', wide && 'mcard__poster--contain')} />
        <button
          type="button"
          className={classNames('mcard__fav', favourite && 'is-on')}
          aria-pressed={favourite}
          aria-label={favourite ? 'Remove from favourites' : 'Add to favourites'}
          onClick={(e) => { e.stopPropagation(); void toggleFavourite(item); }}
        >
          <Glyph.Star size={12} filled={favourite} />
        </button>
      </div>
      <div className="mcard__caption" title={item.title || item.name}>
        <span className="mcard__title" dir="auto">{item.title || item.name}</span>
        <Kicker
          className="mcard__meta"
          parts={metaParts(item)}
          rating={item.kind === 'series' ? undefined : item.rating}
        />
      </div>
    </div>
  );
});

export function MediaCardSkeleton({ index = 0 }: { index?: number }) {
  const delay = { animationDelay: `${(index % 3) * 120}ms` };
  return (
    <div className="mcard mcard--skeleton" aria-hidden>
      <div className="mcard__frame"><div className="skeleton mcard__poster" style={delay} /></div>
      <div className="mcard__caption">
        <div className="skeleton mcard__skel mcard__skel--title" style={delay} />
        <div className="skeleton mcard__skel mcard__skel--kicker" style={delay} />
      </div>
    </div>
  );
}

export function ContinueCard({ progress }: { progress: WatchProgress }) {
  const [broken, setBroken] = useState(false);
  const pct = progressThrough(0, progress.duration, progress.position);
  const left = Math.max(0, progress.duration - progress.position);
  const play = () => { void playProgress(progress); };

  return (
    <div
      className="ccard"
      role="button"
      tabIndex={0}
      aria-label={`Resume ${progress.title}`}
      onClick={play}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); } }}
    >
      <div className="ccard__frame">
        {progress.image && !broken ? (
          <img
            className="ccard__still"
            src={progress.image}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setBroken(true)}
          />
        ) : (
          <Absence className="ccard__still ccard__still--absent" />
        )}
        <span className="ccard__play" aria-hidden><Glyph.Play size={18} /></span>
        <span className="ccard__track"><span className="ccard__progress" style={{ width: `${pct * 100}%` }} /></span>
      </div>
      <div className="mcard__caption" title={progress.title}>
        <span className="mcard__title" dir="auto">{progress.title}</span>
        <Kicker className="mcard__meta" parts={[left > 30 ? `${coarseDuration(left)} left` : 'Finished']} />
      </div>
    </div>
  );
}

export function ContinueCardSkeleton({ index = 0 }: { index?: number }) {
  const delay = { animationDelay: `${(index % 3) * 120}ms` };
  return (
    <div className="ccard ccard--skeleton" aria-hidden>
      <div className="ccard__frame"><div className="skeleton ccard__still" style={delay} /></div>
      <div className="mcard__caption">
        <div className="skeleton mcard__skel mcard__skel--one" style={delay} />
        <div className="skeleton mcard__skel mcard__skel--kicker" style={delay} />
      </div>
    </div>
  );
}

export function MenuButton({
  label, glyph, align = 'end', width = 208, className, panelClassName, ariaLabel, children,
}: {
  label?: ReactNode;
  glyph?: ReactNode;
  align?: 'start' | 'end';
  width?: number;
  className?: string;
  panelClassName?: string;
  ariaLabel?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (host.current && !host.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={host}>
      <button
        type="button"
        className={classNames('menu__trigger', open && 'is-open', className)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        {glyph}
        {label !== undefined && <span className="menu__label truncate">{label}</span>}
        <Glyph.ChevronDown size={14} />
      </button>
      {open && (
        <div className={classNames('menu__panel', `menu__panel--${align}`, panelClassName)} role="menu" style={{ width }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  selected, onSelect, trailing, children,
}: { selected?: boolean; onSelect: () => void; trailing?: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={classNames('menu__item', selected && 'is-selected')}
      onClick={onSelect}
    >
      <span className="menu__tick" aria-hidden>{selected ? <Glyph.Check size={14} /> : null}</span>
      <span className="truncate">{children}</span>
      {trailing !== undefined && <span className="menu__trailing data">{trailing}</span>}
    </button>
  );
}
