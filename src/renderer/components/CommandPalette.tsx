import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, Bookmark, Check, Clock, Eye, EyeOff, History, Info, ListFilter, Monitor, Play,
  Plus, RotateCw, Search as SearchIcon, Server, SlidersHorizontal, Star, Trash2, TriangleAlert, X,
  type LucideIcon,
} from 'lucide-react';
import type { MediaItem, MediaKind } from '@shared/types';
import { activeSource, useActiveSource, useApp } from '@/state/store';
import { LogoPlate, Poster, TruncateTail, Kicker, Tally, Skeleton, EmptyState } from '@/components/Primitives';
import { fold, isAdultCategory } from '@/lib/catalog';
import { classNames, errorText, formatWhen, readStringList, writeStringList } from '@/lib/format';
import { useUiPrefs } from '@/views/Settings';
import './palette.css';

export const ICON = {
  search: SearchIcon,
  arrowRight: ArrowRight,
  play: Play,
  star: Star,
  close: X,
  check: Check,
  plus: Plus,
  refresh: RotateCw,
  trash: Trash2,
  clock: Clock,
  alert: TriangleAlert,
  filter: ListFilter,
  sliders: SlidersHorizontal,
  eye: Eye,
  eyeOff: EyeOff,
  server: Server,
  monitor: Monitor,
  info: Info,
  bookmark: Bookmark,
  history: History,
} satisfies Record<string, LucideIcon>;

export function Glyph({ icon: Icon, size = 16, className }: { icon: LucideIcon; size?: number; className?: string }) {
  return <Icon size={size} strokeWidth={1.5} className={className} aria-hidden />;
}

export interface SegmentOption<T extends string> { value: T; label: string; count?: number }

export function Segmented<T extends string>({
  options, value, onChange, className, label,
}: { options: ReadonlyArray<SegmentOption<T>>; value: T; onChange: (v: T) => void; className?: string; label?: string }) {
  return (
    <div className={classNames('mx-seg', className)} role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={classNames('mx-seg__opt', o.value === value && 'mx-seg__opt--on')}
          onClick={() => onChange(o.value)}
        >
          <span className="mx-seg__label">{o.label}</span>
          {o.count !== undefined && <span className="mx-seg__count data">{o.count.toLocaleString()}</span>}
        </button>
      ))}
    </div>
  );
}

export function ProgressBar({ value, className }: { value: number | null; className?: string }) {
  const done = value === null ? null : Math.min(1, Math.max(0, value));
  return (
    <div className={classNames('mx-bar', done === null && 'mx-bar--indet', className)} role="progressbar" aria-valuenow={done === null ? undefined : Math.round(done * 100)}>
      <div className="mx-bar__fill" style={done === null ? undefined : { transform: `scaleX(${done})` }}>
        <Tally orientation="horizontal" />
      </div>
    </div>
  );
}

const RECENTS_KEY = 'xiptv.recent-searches';
const RECENTS_MAX = 8;

export function readRecents(): string[] {
  return readStringList(RECENTS_KEY).filter((v) => v.trim().length > 0).slice(0, RECENTS_MAX);
}

export function pushRecent(query: string): string[] {
  const q = query.trim();
  if (q.length < 2) return readRecents();
  const folded = fold(q);
  const next = [q, ...readRecents().filter((r) => fold(r) !== folded)].slice(0, RECENTS_MAX);
  writeStringList(RECENTS_KEY, next);
  return next;
}

export function clearRecents(): void {
  try { localStorage.removeItem(RECENTS_KEY); } catch {}
}

export async function playItem(item: MediaItem, opts: { episodeId?: string; startAt?: number } = {}): Promise<void> {
  const { patch, navigate, toast$ } = useApp.getState();
  const source = activeSource();
  if (!source) return;

  if (item.kind === 'series' && !opts.episodeId) {
    patch({ paletteOpen: false });
    navigate({ view: 'detail', item });
    return;
  }
  try {
    const stream = await window.iptv.player.resolve({
      sourceId: source.id, itemId: item.id, episodeId: opts.episodeId, startAt: opts.startAt,
    });
    patch({ nowPlaying: { stream, item, episodeId: opts.episodeId, startAt: opts.startAt }, paletteOpen: false });
  } catch (err) {
    toast$(errorText(err, 'That stream did not respond.'), 'error');
  }
}

const KIND_LABEL: Record<MediaKind, string> = { live: 'Live TV', movie: 'Movies', series: 'TV Shows' };
const KIND_ORDER: readonly MediaKind[] = ['live', 'movie', 'series'];
const GROUP_CAP = 6;
const DEBOUNCE_MS = 170;

const CATEGORIES_IN_FLIGHT = new Set<string>();

export function useAdultIds(sourceId: string | undefined): Set<string> {
  const categories = useApp((s) => s.categories);
  const { hideAdult } = useUiPrefs();

  useEffect(() => {
    if (!sourceId || !hideAdult) return;
    for (const kind of KIND_ORDER) {
      const key = `${sourceId}:${kind}`;
      if (useApp.getState().categories[kind] || CATEGORIES_IN_FLIGHT.has(key)) continue;
      CATEGORIES_IN_FLIGHT.add(key);
      void window.iptv.catalog.categories(sourceId, kind)
        .then((rows) => {
          const now = useApp.getState().categories;
          if (now[kind]) return;
          useApp.getState().patch({ categories: { ...now, [kind]: rows } });
        })
        .catch(() => undefined)
        .finally(() => CATEGORIES_IN_FLIGHT.delete(key));
    }
  }, [sourceId, hideAdult]);

  return useMemo(() => {
    const ids = new Set<string>();
    if (!hideAdult) return ids;
    // Keyed by kind. On Xtream, Category.id is the raw provider category_id and the three kinds
    // number independently, so an adult LIVE category 77 would otherwise hide every movie in VOD
    // category 77.
    for (const kind of KIND_ORDER) {
      for (const c of categories[kind] ?? []) if (isAdultCategory(c)) ids.add(`${kind}:${c.id}`);
    }
    return ids;
  }, [categories, hideAdult]);
}

export function isAdultItem(ids: Set<string>, item: { kind: MediaKind; categoryId: string }): boolean {
  return ids.has(`${item.kind}:${item.categoryId}`);
}

interface Group { key: string; label: string; total: number; items: MediaItem[] }

type Row =
  | { t: 'item'; item: MediaItem }
  | { t: 'recent'; query: string }
  | { t: 'seeall' };

function rank(items: MediaItem[], folded: string): MediaItem[] {
  const scored = items.map((item, i) => {
    const t = fold(item.title);
    const n = fold(item.name);
    let score = 3;
    if (t.startsWith(folded) || n.startsWith(folded)) score = 0;
    else if (t.includes(` ${folded}`) || n.includes(` ${folded}`)) score = 1;
    else if (t.includes(folded) || n.includes(folded)) score = 2;
    return { item, score, i };
  });
  scored.sort((a, b) => (a.score - b.score) || (a.i - b.i));
  return scored.map((s) => s.item);
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);

  return open ? <PaletteBody /> : null;
}

function PaletteBody() {
  const source = useActiveSource();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MediaItem[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [recents, setRecents] = useState<string[]>(() => readRecents());

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const request = useRef(0);

  const close = useCallback(() => useApp.getState().patch({ paletteOpen: false }), []);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const q = query.trim();
    if (!source || q.length < 2) { setResults([]); setError(undefined); setLoading(false); return; }
    setLoading(true);
    const id = ++request.current;
    const timer = setTimeout(() => {
      window.iptv.catalog.search(source.id, q)
        .then((found) => { if (id === request.current) { setResults(found); setError(undefined); setLoading(false); } })
        .catch((err: unknown) => {
          if (id !== request.current) return;
          setResults([]);
          setError(errorText(err));
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, source]);

  const adultIds = useAdultIds(source?.id);

  const ranked = useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return [];
    const visible = adultIds.size ? results.filter((r) => !isAdultItem(adultIds, r)) : results;
    return rank(visible, fold(q));
  }, [results, query, adultIds]);

  const groups = useMemo<Group[]>(() => {
    const named: MediaItem[] = [];
    const guide: MediaItem[] = [];
    const seenChannels = new Set<string>();
    for (const item of ranked) {
      if (item.programmeMatch === undefined) { named.push(item); continue; }
      if (seenChannels.has(item.programmeMatch.channelId)) continue;
      seenChannels.add(item.programmeMatch.channelId);
      guide.push(item);
    }
    const out: Group[] = [];
    const push = (key: string, label: string, items: MediaItem[]): void => {
      if (items.length > 0) out.push({ key, label, total: items.length, items: items.slice(0, GROUP_CAP) });
    };
    for (const kind of KIND_ORDER) {
      push(kind, KIND_LABEL[kind], named.filter((r) => r.kind === kind));
      if (kind === 'live') push('guide', 'In the guide', guide);
    }
    return out;
  }, [ranked]);

  const hasQuery = query.trim().length >= 2;
  const nowSecs = Math.floor(Date.now() / 1000);

  const rows = useMemo<Row[]>(() => {
    const flat: Row[] = hasQuery
      ? groups.flatMap((g) => g.items.map((item): Row => ({ t: 'item', item })))
      : recents.map((q): Row => ({ t: 'recent', query: q }));
    flat.push({ t: 'seeall' });
    return flat;
  }, [groups, recents, hasQuery]);

  useEffect(() => { setCursor(0); }, [query, ranked.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor, rows.length]);

  const openSearchPage = useCallback((q: string) => {
    const trimmed = q.trim();
    if (trimmed.length >= 2) setRecents(pushRecent(trimmed));
    useApp.getState().patch({ paletteOpen: false });
    useApp.getState().navigate({ view: 'search', query: trimmed });
  }, []);

  const activate = useCallback((row: Row, detail: boolean) => {
    if (row.t === 'seeall') { openSearchPage(query); return; }
    if (row.t === 'recent') { setQuery(row.query); inputRef.current?.focus(); return; }
    setRecents(pushRecent(query));
    if (detail) {
      useApp.getState().patch({ paletteOpen: false });
      useApp.getState().navigate({ view: 'detail', item: row.item });
      return;
    }
    void playItem(row.item);
  }, [query, openSearchPage]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % rows.length); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + rows.length) % rows.length); return; }
    if (e.key === 'Home') { e.preventDefault(); setCursor(0); return; }
    if (e.key === 'End') { e.preventDefault(); setCursor(rows.length - 1); return; }
    if (e.key === 'Enter') { e.preventDefault(); activate(rows[cursor] ?? rows[rows.length - 1], e.shiftKey); }
  };

  let index = -1;

  return (
    <div className="palette__scrim" onPointerDown={close} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search the catalogue"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="palette__input-row">
          <span className="palette__glyph"><Glyph icon={ICON.search} /></span>
          <input
            ref={inputRef}
            className="palette__input"
            value={query}
            spellCheck={false}
            autoComplete="off"
            placeholder="Search channels, movies and series"
            aria-activedescendant={`palette-row-${cursor}`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {hasQuery && !loading && error === undefined && (
            <span className="palette__count data">{ranked.length.toLocaleString()}</span>
          )}
        </div>

        <div className="palette__results" ref={listRef} role="listbox" aria-label="Results">
          {loading && ranked.length === 0 && (
            <div className="palette__loading">
              {[0, 1, 2, 3, 4].map((i) => (
                <div className="palette__row palette__row--skel" key={i}>
                  <Skeleton width={40} height={24} radius={6} />
                  <div className="palette__text">
                    <Skeleton width={`${62 - i * 7}%`} height={11} radius={3} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!hasQuery && recents.length > 0 && (
            <>
              <div className="palette__group">
                <span>Recent</span>
                <button type="button" className="palette__group-act" onClick={() => { clearRecents(); setRecents([]); }}>Clear</button>
              </div>
              {recents.map((q) => {
                index += 1;
                const on = index === cursor;
                const idx = index;
                return (
                  <button
                    key={q}
                    id={`palette-row-${idx}`}
                    data-idx={idx}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={classNames('palette__row', on && 'palette__row--on')}
                    onPointerMove={() => setCursor(idx)}
                    onClick={() => activate({ t: 'recent', query: q }, false)}
                  >
                    <span className="palette__art palette__art--glyph"><Glyph icon={ICON.history} /></span>
                    <span className="palette__text"><span className="palette__name truncate">{q}</span></span>
                  </button>
                );
              })}
            </>
          )}

          {!hasQuery && recents.length === 0 && !loading && (
            <p className="palette__hint t-secondary">
              Type at least two characters. xiptv folds accents, then matches against both the
              provider's raw name and the cleaned title.
            </p>
          )}

          {hasQuery && !loading && !error && groups.length === 0 && (
            <div className="palette__empty">
              <EmptyState
                glyph={<Glyph icon={ICON.search} size={24} />}
                title="Nothing under that name"
                body="Provider naming is inconsistent. Try a shorter fragment, and drop the year or the quality tag."
              />
            </div>
          )}

          {hasQuery && groups.map((g) => (
            <div key={g.key}>
              <div className="palette__group">
                <span>{g.label}</span>
                <span className="palette__group-sep">·</span>
                <span>{g.total.toLocaleString()}</span>
              </div>
              {g.items.map((item) => {
                index += 1;
                const on = index === cursor;
                const idx = index;
                const programme = item.programmeMatch ?? item.nowPlaying;
                return (
                  <button
                    key={item.id}
                    id={`palette-row-${idx}`}
                    data-idx={idx}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={classNames('palette__row', on && 'palette__row--on')}
                    onPointerMove={() => setCursor(idx)}
                    onClick={(e) => activate({ t: 'item', item }, e.shiftKey)}
                  >
                    <span className="palette__art">
                      {item.kind === 'live'
                        ? <LogoPlate item={item} size="compact" />
                        : <span className="palette__poster"><Poster item={item} /></span>}
                    </span>
                    <span className="palette__text">
                      <TruncateTail text={item.title || item.name} className="palette__name" />
                      {programme !== undefined ? (
                        <span className="palette__epg truncate" dir="auto">
                          <span className="palette__epg-when data">{formatWhen(programme.start, programme.stop, nowSecs)}</span>
                          {programme.title}
                        </span>
                      ) : item.kind !== 'live' && (item.year || item.rating) ? (
                        <Kicker parts={[item.year]} rating={item.rating} className="palette__kicker" />
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

        </div>

        {error !== undefined && (
          <p className="palette__error" role="alert">
            <span className="palette__error-glyph"><Glyph icon={ICON.alert} /></span>
            <span className="truncate" dir="auto">{error}</span>
          </p>
        )}

        <button
          id={`palette-row-${rows.length - 1}`}
          data-idx={rows.length - 1}
          type="button"
          role="option"
          aria-selected={cursor === rows.length - 1}
          className={classNames('palette__row', 'palette__seeall', cursor === rows.length - 1 && 'palette__row--on')}
          onPointerMove={() => setCursor(rows.length - 1)}
          onClick={() => openSearchPage(query)}
        >
          <span className="palette__art palette__art--glyph"><Glyph icon={ICON.filter} /></span>
          <span className="palette__text">
            {hasQuery && error === undefined
              ? <>See all <span className="data">{ranked.length.toLocaleString()}</span> results</>
              : <>Open the full search page</>}
          </span>
          <span className="palette__seeall-arrow"><Glyph icon={ICON.arrowRight} /></span>
        </button>

        <div className="palette__footer">
          <span className="palette__hint-key"><kbd className="palette__key">↑</kbd><kbd className="palette__key">↓</kbd>Navigate</span>
          <span className="palette__hint-key"><kbd className="palette__key">↵</kbd>Play</span>
          <span className="palette__hint-key"><kbd className="palette__key">⇧↵</kbd>Details</span>
          <span className="palette__hint-key palette__hint-key--end"><kbd className="palette__key">esc</kbd>Close</span>
        </div>
      </div>
    </div>
  );
}
