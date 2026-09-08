import { memo, useCallback, useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import type { Category, MediaItem } from '@shared/types';
import { hueFromString, initialsFor, formatRating, classNames } from '@/lib/format';
import { parseCategory } from '@/lib/catalog';
import './primitives.css';

/** The accent marker: vertical beside a selected row, horizontal as a progress fill. */
export function Tally({ orientation = 'vertical' }: { orientation?: 'vertical' | 'horizontal' }) {
  return <span className={`tally tally--${orientation}`} aria-hidden />;
}

type PlateSize = 'compact' | 'row' | 'large';

const PLATE: Record<PlateSize, { w: number; h: number; maxW: number; maxH: number }> = {
  compact: { w: 40, h: 24, maxW: 34, maxH: 18 },
  row: { w: 56, h: 34, maxW: 48, maxH: 26 },
  large: { w: 88, h: 52, maxW: 76, maxH: 40 },
};

/**
 * Cached images can be complete before React attaches `onLoad`, so the ref checks too. The
 * `key` on the image remounts it per source, which re-runs this on every change.
 */
function primedRef(setLoaded: (v: boolean) => void) {
  return (el: HTMLImageElement | null): void => {
    if (el && el.complete && el.naturalWidth > 0) setLoaded(true);
  };
}

/** A channel logo over its initials. The initials are always painted; the logo fades in on top. */
export const LogoPlate = memo(function LogoPlate({
  item, size = 'row', className,
}: { item: Pick<MediaItem, 'logo' | 'title' | 'name'>; size?: PlateSize; className?: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const box = PLATE[size];

  useEffect(() => { setFailed(false); setLoaded(false); }, [item.logo]);

  const name = item.title || item.name;
  const hue = hueFromString(name);
  const showImage = Boolean(item.logo) && !failed;

  return (
    <div
      className={classNames('plate', `plate--${size}`, className)}
      style={{ width: box.w, height: box.h }}
    >
      <span
        className="plate__initials"
        style={{ background: `hsl(${hue} 10% 17%)`, color: `hsl(${hue} 14% 74%)` }}
        aria-hidden
      >
        {initialsFor(name)}
      </span>
      {showImage && (
        <img
          key={item.logo}
          ref={primedRef(setLoaded)}
          className="plate__img"
          data-loaded={loaded}
          src={item.logo}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          style={{ maxWidth: box.maxW, maxHeight: box.maxH }}
          onError={() => setFailed(true)}
          onLoad={(e) => {
            if (e.currentTarget.naturalWidth < 24) setFailed(true); else setLoaded(true);
          }}
        />
      )}
    </div>
  );
});

/** Artwork over a titled placeholder. The placeholder is always painted; the image fades in. */
export const Poster = memo(function Poster({
  item, className, style,
}: { item: Pick<MediaItem, 'logo' | 'title' | 'name'>; className?: string; style?: CSSProperties }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { setFailed(false); setLoaded(false); }, [item.logo]);

  const showImage = Boolean(item.logo) && !failed;

  return (
    <div className={classNames('poster', showImage && loaded && 'poster--loaded', className)} style={style}>
      <span className="poster__fallback" dir="auto">{item.title || item.name}</span>
      {showImage && (
        <img
          key={item.logo}
          ref={primedRef(setLoaded)}
          className="poster__img"
          src={item.logo}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
});

/* A bracketed suffix or a quality token is a disambiguator worth demoting. A bare trailing
   number is not: it is the part of "Channel 4" or "Sky Sports 1" that carries the meaning. */
const TAIL = /\s*(\[[^\]]*\]|\([^)]*\)|\b(?:4K|UHD|FHD|HD|SD|HEVC|H265|RAW|MULTI-?SUB)\b)\s*$/i;

/** Without `dir="auto"`, an LTR-forced ellipsis clips an Arabic name at the wrong end. */
export function TruncateTail({ text, className }: { text: string; className?: string }) {
  const m = TAIL.exec(text);
  if (!m || m.index < 6) {
    return <span className={classNames('truncate', className)} dir="auto" title="">{text}</span>;
  }
  return (
    <span className={classNames('trunc-tail', className)} dir="auto">
      <span className="truncate">{text.slice(0, m.index)}</span>
      <span className="trunc-tail__tail">{m[0].trim()}</span>
    </span>
  );
}

/** "MULTISUB" reads as a word, "UK" as a code. */
export function prefixWord(chip: string): string {
  return chip.length > 3 ? chip.charAt(0) + chip.slice(1).toLowerCase() : chip;
}

/** The category's cleaned label, with the provider's prefix demoted to a quiet word after it. */
export function CategoryLabel({ category }: { category: Category }) {
  const parsed = parseCategory(category);
  return (
    <span className="catlabel" data-raw={parsed.raw}>
      <span className="truncate" dir="auto">{parsed.label}</span>
      {parsed.chips.length > 0 && (
        <span className="catlabel__prefix">{parsed.chips.map(prefixWord).join(' ')}</span>
      )}
    </span>
  );
}

/** One secondary line of facts: "2024 · ★ 7.6". */
export function Kicker({ parts, rating, className }: { parts: Array<string | number | undefined | false>; rating?: number; className?: string }) {
  const clean = parts.filter((p): p is string | number => p !== undefined && p !== false && p !== '');
  const stars = formatRating(rating);
  if (!clean.length && !stars) return null;
  return (
    <span className={classNames('kicker-line data', className)}>
      {clean.map((p, i) => (
        <span key={i}>{p}</span>
      ))}
      {stars && (
        <span className="kicker-rating">
          <span className="kicker-star" aria-hidden>★</span>
          {stars}
        </span>
      )}
    </span>
  );
}

/** A quiet raised box that says what is missing, so nothing is ever an empty hole. */
export function Absence({ label, className, style }: { label?: string; className?: string; style?: CSSProperties }) {
  return (
    <div className={classNames('absence', className)} style={style}>
      {label && <span className="absence__label sm">{label}</span>}
    </div>
  );
}

export function EmptyState({
  glyph, title, body, action,
}: { glyph: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__glyph">{glyph}</div>
      <h2 className="t-title">{title}</h2>
      <p className="empty__body t-secondary">{body}</p>
      {action}
    </div>
  );
}

export function Skeleton({ width, height, radius, style }: { width?: number | string; height: number | string; radius?: number; style?: CSSProperties }) {
  return <div className="skeleton" style={{ width: width ?? '100%', height, borderRadius: radius, ...style }} />;
}

type ButtonVariant = 'primary' | 'ghost' | 'plain' | 'danger';

/** primary: the accent. ghost: a filled quiet button. plain: text only. */
export function Button({
  variant = 'plain', children, className, ...rest
}: { variant?: ButtonVariant } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={classNames('btn', `btn--${variant}`, className)} {...rest}>
      {children}
    </button>
  );
}

export function Tooltip({ label, children, placement = 'bottom' }: { label: string; children: ReactNode; placement?: 'top' | 'bottom' | 'right' }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback(() => { timer.current = setTimeout(() => setOpen(true), 380); }, []);
  return (
    <span
      className="tip-anchor"
      onPointerEnter={show}
      onPointerLeave={() => { clearTimeout(timer.current); setOpen(false); }}
    >
      {children}
      {open && <span className={`tip tip--${placement} sm`} role="tooltip">{label}</span>}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function PlayGlyph({ size }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M8 5.6a1 1 0 0 1 1.53-.85l9 6.4a1 1 0 0 1 0 1.7l-9 6.4A1 1 0 0 1 8 18.4Z" />
    </svg>
  );
}

export function PauseGlyph({ size }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <rect x="7" y="5" width="3.4" height="14" rx="1.1" />
      <rect x="13.6" y="5" width="3.4" height="14" rx="1.1" />
    </svg>
  );
}
