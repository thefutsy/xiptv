import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import type { Category, MediaItem, WatchProgress } from '@shared/types';
import {
  Button, EmptyState, Skeleton,
} from '@/components/Primitives';
import {
  ContinueCard, ContinueCardSkeleton, Glyph, humanGenre, MediaCard, MediaCardSkeleton,
  MenuButton, MenuItem,
} from '@/components/MediaCard';
import { columnsFor, VGrid } from '@/lib/virtual';
import {
  activeFacetCount, applyFacets, EMPTY_FACETS, isAdultCategory, parseCategory, sortItems,
  type Facets, type SortKey,
} from '@/lib/catalog';
import { classNames, errorText, readStringList, writeStringList } from '@/lib/format';
import { bezier, reducedMotion } from '@/lib/ease';
import { CAPTION_H, px, useMeasured } from '@/lib/metrics';
import { useApp } from '@/state/store';
import { getUiPrefs } from '@/views/Settings';
import './browse.css';

export function Movies() {
  return <Browse kind="movie" />;
}

export type BrowseKind = 'movie' | 'series';

interface KindMeta {
  title: string;
  noun: string;
  glyph: ReactNode;
}

const EMPTY_BODY = 'Continue Watching, Recently added and Highest rated come from the categories you open. Pick one to start filling them.';

const META: Record<BrowseKind, KindMeta> = {
  movie: {
    title: 'Movies',
    noun: 'movies',
    glyph: <Glyph.Film size={24} />,
  },
  series: {
    title: 'TV Shows',
    noun: 'series',
    glyph: <Glyph.Tv size={24} />,
  },
};

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'provider', label: 'Provider order' },
  { key: 'name', label: 'Name A–Z' },
  { key: 'added', label: 'Recently added' },
  { key: 'rating', label: 'Rating' },
  { key: 'year', label: 'Year' },
];

const clientWidth = (el: HTMLElement): number => el.clientWidth;

interface Metrics { gridMin: number; gapX: number; gapY: number; padPage: number }

function readMetrics(): Metrics {
  const style = getComputedStyle(document.documentElement);
  return {
    gridMin: px(style, '--grid-min', 168),
    gapX: px(style, '--grid-gap-x', 20),
    gapY: px(style, '--grid-gap-y', 28),
    padPage: px(style, '--pad-page', 32),
  };
}

function useMetrics(): Metrics {
  const [m, setM] = useState<Metrics>(readMetrics);
  useEffect(() => {
    const refresh = () => setM(readMetrics());
    window.addEventListener('resize', refresh);
    return () => window.removeEventListener('resize', refresh);
  }, []);
  return m;
}

interface CategoryLoad { failed: boolean; retry: () => void }

function useCategories(sourceId: string | undefined, kind: BrowseKind): CategoryLoad {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!sourceId) return;
    const { categories, patch } = useApp.getState();
    if (categories[kind]) return;
    let dead = false;
    setFailed(false);
    void window.iptv.catalog.categories(sourceId, kind)
      .then((rows) => {
        if (dead) return;
        const now = useApp.getState().categories;
        patch({ categories: { ...now, [kind]: rows } });
      })
      .catch(() => { if (!dead) setFailed(true); });
    return () => { dead = true; };
  }, [sourceId, kind, attempt]);
  return { failed, retry: () => setAttempt((n) => n + 1) };
}

let loadedKey: string | null = null;

function useCategoryItems(
  sourceId: string | undefined, kind: BrowseKind, categoryId: string | undefined, nonce: number,
): void {
  useLayoutEffect(() => {
    if (!sourceId || !categoryId) return;
    const key = `${sourceId}:${kind}:${categoryId}:${nonce}`;
    const current = useApp.getState().items;
    const holdsIt = current.length > 0 && current[0].categoryId === categoryId && current[0].kind === kind;
    if (loadedKey === key && (holdsIt || current.length === 0)) return;

    let dead = false;
    loadedKey = key;
    useApp.getState().patch({ items: [], itemsLoading: true, itemsError: undefined });
    void window.iptv.catalog.items(sourceId, kind, categoryId)
      .then((rows) => {
        if (dead) return;
        useApp.getState().patch({ items: rows, itemsLoading: false, itemsError: undefined });
      })
      .catch((err: unknown) => {
        if (dead) return;
        loadedKey = null;
        useApp.getState().patch({
          items: [], itemsLoading: false,
          itemsError: errorText(err, 'The provider did not answer.'),
        });
      });
    return () => { dead = true; };
  }, [sourceId, kind, categoryId, nonce]);
}

const RECENT_LIMIT = 3;
const RAIL_LIMIT = 24;

function recentKey(sourceId: string, kind: BrowseKind): string {
  return `xiptv.recent-categories.${sourceId}.${kind}`;
}

function readRecent(sourceId: string, kind: BrowseKind): string[] {
  return readStringList(recentKey(sourceId, kind));
}

function pushRecent(sourceId: string, kind: BrowseKind, categoryId: string): boolean {
  const prev = readRecent(sourceId, kind);
  if (prev[0] === categoryId) return false;
  writeStringList(recentKey(sourceId, kind), [categoryId, ...prev.filter((id) => id !== categoryId)].slice(0, 8));
  return true;
}

interface LandingData {
  continueWatching: WatchProgress[];
  recentlyAdded: MediaItem[];
  topRated: MediaItem[];
}

const landingCache = new Map<string, LandingData>();

function pickCategories(sourceId: string, kind: BrowseKind, categories: Category[]): string[] {
  const browsable = getUiPrefs().hideAdult ? categories.filter((c) => !isAdultCategory(c)) : categories;
  const allowed = new Set(browsable.map((c) => c.id));
  const mru = readRecent(sourceId, kind).filter((id) => allowed.has(id));
  const seed = browsable.map((c) => c.id);
  const out: string[] = [];
  for (const id of [...mru, ...seed]) {
    if (!out.includes(id)) out.push(id);
    if (out.length === RECENT_LIMIT) break;
  }
  return out;
}

async function loadLanding(sourceId: string, kind: BrowseKind, categories: Category[]): Promise<LandingData> {
  const [progress, favourites] = await Promise.all([
    window.iptv.library.continueWatching().catch((): WatchProgress[] => []),
    window.iptv.library.favourites().catch((): MediaItem[] => []),
  ]);
  useApp.getState().patch({ favourites });

  const pool = new Map<string, MediaItem>();
  const ids = pickCategories(sourceId, kind, categories);
  for (let i = 0; i < ids.length; i += 2) {
    const batch = await Promise.all(
      ids.slice(i, i + 2).map((id) => window.iptv.catalog.items(sourceId, kind, id).catch((): MediaItem[] => [])),
    );
    for (const rows of batch) for (const row of rows) if (!pool.has(row.id)) pool.set(row.id, row);
  }

  const all = [...pool.values()];
  const dated = all.filter((i) => i.addedAt !== undefined);
  return {
    continueWatching: progress
      .filter((p) => p.kind === kind)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 18),
    recentlyAdded: (dated.length ? sortItems(dated, 'added') : all).slice(0, 24),
    topRated: sortItems(all.filter((i) => (i.rating ?? 0) >= 7.5), 'rating').slice(0, 24),
  };
}

const EASE_OUT = bezier(0.16, 1, 0.3, 1);

function tweenScrollLeft(el: HTMLElement, to: number, ms: number): void {
  if (reducedMotion()) { el.scrollLeft = to; return; }
  const from = el.scrollLeft;
  const delta = to - from;
  const started = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - started) / ms);
    el.scrollLeft = from + delta * EASE_OUT(p);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function Rail({
  title, count, onSeeAll, children,
}: { title: string; count: string; onSeeAll?: () => void; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const sync = useCallback(() => {
    const el = track.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft > 4,
      end: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  }, []);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    el.addEventListener('scroll', sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', sync); ro.disconnect(); };
  }, [sync]);

  useEffect(sync, [children, sync]);

  const page = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const to = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, el.scrollLeft + dir * el.clientWidth * 0.82));
    tweenScrollLeft(el, to, 420);
  };

  return (
    <section className="rail">
      <div className="rail__head">
        <div className="rail__heading">
          <h2 className="t-title rail__title">{title}</h2>
          <span className="kicker rail__count">{count}</span>
        </div>
        {onSeeAll && (
          <button type="button" className="rail__all" onClick={onSeeAll}>
            See all<Glyph.ArrowRight size={15} />
          </button>
        )}
      </div>
      <div className="rail__body" data-start={edges.start} data-end={edges.end}>
        <div className="rail__track" ref={track}>{children}</div>
        <button
          type="button"
          className={classNames('rail__arrow rail__arrow--start', edges.start && 'is-live')}
          aria-label="Scroll back"
          tabIndex={-1}
          onClick={() => page(-1)}
        ><Glyph.ChevronLeft size={20} /></button>
        <button
          type="button"
          className={classNames('rail__arrow rail__arrow--end', edges.end && 'is-live')}
          aria-label="Scroll forward"
          tabIndex={-1}
          onClick={() => page(1)}
        ><Glyph.ChevronRight size={20} /></button>
      </div>
    </section>
  );
}

function titleCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'title' : 'titles'}`;
}

function PosterGrid({
  items, loading, sticky, empty,
}: { items: MediaItem[]; loading: boolean; sticky: ReactNode; empty?: ReactNode }) {
  const m = useMetrics();
  const [measure, width] = useMeasured(clientWidth, 0);

  const inner = Math.max(0, width - m.padPage * 2);
  const columns = columnsFor(width, m.gridMin, m.gapX, m.padPage);
  const cell = inner > 0 ? (inner - m.gapX * (columns - 1)) / columns : m.gridMin;
  const rowHeight = Math.round(cell * 1.5) + CAPTION_H;

  const header = (
    <>
      <div className="browse__sticky" ref={measure}>{sticky}</div>
      <div className="browse__gridtop" />
    </>
  );
  const showSkeletons = loading && items.length === 0;

  if (inner > 0 && !showSkeletons && items.length === 0 && empty) {
    return <div className="browse__scroll">{header}{empty}</div>;
  }

  const count = inner === 0 ? 0 : showSkeletons ? columns * 4 : items.length;

  return (
    <VGrid
      className="browse__scroll"
      header={header}
      count={count}
      columnWidth={cell - 0.5}
      rowHeight={rowHeight}
      gapX={m.gapX}
      gapY={m.gapY}
      padding={m.padPage}
    >
      {(index) => (showSkeletons ? <MediaCardSkeleton index={index} /> : <MediaCard item={items[index]} />)}
    </VGrid>
  );
}

export function Browse({ kind }: { kind: BrowseKind }) {
  const meta = META[kind];
  const sources = useApp((s) => s.sources);
  const activeSourceId = useApp((s) => s.activeSourceId);
  const sourceId = (sources.find((s) => s.id === activeSourceId) ?? sources[0])?.id;

  const categoryId = useApp((s) => s.selectedCategory[kind]);
  const categories = useApp((s) => s.categories[kind]);
  const items = useApp((s) => s.items);
  const itemsLoading = useApp((s) => s.itemsLoading);
  const itemsError = useApp((s) => s.itemsError);
  const facets = useApp((s) => s.facets);
  const sort = useApp((s) => s.sort);
  const favourites = useApp((s) => s.favourites);

  const [retry, setRetry] = useState(0);
  const categoryLoad = useCategories(sourceId, kind);
  useCategoryItems(sourceId, kind, categoryId, retry);

  const [seeAll, setSeeAll] = useState<{ title: string; items: MediaItem[] } | null>(null);
  useEffect(() => { setSeeAll(null); }, [kind, categoryId]);

  useEffect(() => {
    if (!sourceId || !categoryId) return;
    if (pushRecent(sourceId, kind, categoryId)) landingCache.delete(`${sourceId}:${kind}`);
  }, [sourceId, kind, categoryId]);

  const shown = useMemo(() => sortItems(applyFacets(items, facets), sort), [items, facets, sort]);
  const facetsActive = activeFacetCount(facets) > 0;

  const category = categories?.find((c) => c.id === categoryId);

  const tools = (
    <MenuButton
      className="browse__sort"
      glyph={<Glyph.Sort size={14} />}
      label={SORTS.find((s) => s.key === sort)?.label ?? 'Sort'}
      width={196}
    >
      {(close) => SORTS.map((option) => (
        <MenuItem
          key={option.key}
          selected={option.key === sort}
          onSelect={() => { useApp.getState().patch({ sort: option.key }); close(); }}
        >
          {option.label}
        </MenuItem>
      ))}
    </MenuButton>
  );

  if (seeAll) {
    return (
      <div className="browse">
        <PosterGrid
          items={seeAll.items}
          loading={false}
          sticky={
            <SectionHeader
              title={seeAll.title}
              count={titleCount(seeAll.items.length)}
              tools={tools}
              onBack={() => setSeeAll(null)}
            />
          }
        />
      </div>
    );
  }

  if (!categoryId) {
    const landingHeader = (
      <SectionHeader
        title={meta.title}
        count={
          categoryLoad.failed
            ? 'Catalogue unavailable'
            : categories === undefined
              ? <Skeleton width={168} height={12} radius={3} />
              : landingCount(categories, meta.noun)
        }
      />
    );

    if (categoryLoad.failed && !categories) {
      return (
        <div className="browse">
          <div className="browse__scroll">
            <div className="browse__sticky">{landingHeader}</div>
            <EmptyState
              glyph={meta.glyph}
              title="The category list did not load"
              body="The provider did not answer for this catalogue. Nothing has been lost. Try again, or pick another source in Settings."
              action={<Button variant="ghost" onClick={categoryLoad.retry}>Try again</Button>}
            />
          </div>
        </div>
      );
    }

    return (
      <div className="browse">
        <Landing
          kind={kind}
          sourceId={sourceId}
          categories={categories}
          favourites={favourites}
          onSeeAll={(title, list) => setSeeAll({ title, items: list })}
          sticky={landingHeader}
        />
      </div>
    );
  }

  const countLine = itemsLoading
    ? <Skeleton width={132} height={12} radius={3} />
    : facetsActive
      ? (
        <span className="browse__summary">
          <span className="data">{shown.length.toLocaleString()} of {items.length.toLocaleString()}</span>
          {summaryBits(facets).map((bit) => <span key={bit} className="browse__summary-bit">{bit}</span>)}
          <button
            type="button"
            className="browse__clear"
            onClick={() => useApp.getState().patch({ facets: EMPTY_FACETS })}
          >Clear</button>
        </span>
      )
      : <span className="data">{items.length.toLocaleString()} titles</span>;

  const sticky = <SectionHeader title={meta.title} count={countLine} tools={tools} />;

  const empty = itemsError ? (
    <EmptyState
      glyph={meta.glyph}
      title="That category did not load"
      body={itemsError}
      action={<Button variant="ghost" onClick={() => setRetry((n) => n + 1)}>Try again</Button>}
    />
  ) : facetsActive && items.length > 0 ? (
    <EmptyState
      glyph={meta.glyph}
      title="Nothing matches those filters"
      body={`The filters only cover the ${items.length.toLocaleString()} titles loaded from this category. Loosen the year range or drop a genre.`}
      action={<Button variant="ghost" onClick={() => useApp.getState().patch({ facets: EMPTY_FACETS })}>Clear filters</Button>}
    />
  ) : (
    <EmptyState
      glyph={meta.glyph}
      title="This category came back empty"
      body={`The provider lists ${category ? `"${parseCategory(category).label}"` : 'this category'} but ships nothing inside it. Nothing is broken. Pick another one.`}
      action={
        <Button
          variant="ghost"
          onClick={() => useApp.getState().patch({ selectedCategory: { ...useApp.getState().selectedCategory, [kind]: undefined } })}
        >Back to {meta.title}</Button>
      }
    />
  );

  return (
    <div className="browse">
      <PosterGrid items={shown} loading={itemsLoading} sticky={sticky} empty={empty} />
    </div>
  );
}

function landingCount(categories: Category[], noun: string): string {
  const cats = `${categories.length.toLocaleString()} ${categories.length === 1 ? 'category' : 'categories'}`;
  if (categories.length > 0 && categories.every((c) => c.count !== undefined)) {
    const items = categories.reduce((n, c) => n + (c.count ?? 0), 0);
    return `${items.toLocaleString()} ${noun} · ${cats}`;
  }
  return cats;
}

function summaryBits(facets: Facets): string[] {
  const years = facets.years.slice().sort((a, b) => a - b);
  return [
    facets.genres.map(humanGenre).join(', '),
    years.length ? years.map((y) => `${y}s`).join(', ') : '',
    facets.minRating ? `${facets.minRating}+` : '',
    facets.qualities.join(', '),
  ].filter((s): s is string => s.length > 0);
}

function SectionHeader({
  title, count, tools, onBack,
}: { title: string; count: ReactNode; tools?: ReactNode; onBack?: () => void }) {
  return (
    <header className="browse__header">
      {onBack && (
        <button type="button" className="browse__back" aria-label="Back" onClick={onBack}>
          <Glyph.ChevronLeft size={16} />
        </button>
      )}
      <div className="browse__heading">
        <h1 className="h1 truncate">{title}</h1>
        <div className="browse__count">{count}</div>
      </div>
      {tools && <div className="browse__tools">{tools}</div>}
    </header>
  );
}

function Landing({
  kind, sourceId, categories, favourites, sticky, onSeeAll,
}: {
  kind: BrowseKind;
  sourceId?: string;
  categories?: Category[];
  favourites: MediaItem[];
  sticky: ReactNode;
  onSeeAll: (title: string, items: MediaItem[]) => void;
}) {
  const meta = META[kind];
  const cacheKey = sourceId ? `${sourceId}:${kind}` : '';
  const [data, setData] = useState<LandingData | undefined>(() => landingCache.get(cacheKey));
  const [loading, setLoading] = useState(!landingCache.has(cacheKey));

  useEffect(() => {
    if (!sourceId || !categories) return;
    const key = `${sourceId}:${kind}`;
    const cached = landingCache.get(key);
    if (cached) { setData(cached); setLoading(false); return; }
    let dead = false;
    setLoading(true);
    void loadLanding(sourceId, kind, categories)
      .then((result) => {
        landingCache.set(key, result);
        if (dead) return;
        setData(result);
        setLoading(false);
      })
      .catch(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [sourceId, kind, categories]);

  const mine = favourites.filter((f) => f.kind === kind);
  const nothing = !loading && !!data
    && data.continueWatching.length === 0 && data.recentlyAdded.length === 0
    && data.topRated.length === 0 && mine.length === 0;

  return (
    <div className="browse__scroll">
      <div className="browse__sticky">{sticky}</div>
      <div className="landing">
        {loading && (
          <>
            <RailSkeleton wide />
            <RailSkeleton />
          </>
        )}

        {!loading && data && data.continueWatching.length > 0 && (
          <Rail title="Continue Watching" count={titleCount(data.continueWatching.length)}>
            {data.continueWatching.map((p) => (
              <div className="rail__item rail__item--wide" key={`${p.itemId}:${p.episodeId ?? ''}`}>
                <ContinueCard progress={p} />
              </div>
            ))}
          </Rail>
        )}

        {!loading && data && data.recentlyAdded.length > 0 && (
          <Rail
            title="Recently added"
            count={titleCount(data.recentlyAdded.length)}
            onSeeAll={() => onSeeAll('Recently added', data.recentlyAdded)}
          >
            {data.recentlyAdded.map((item) => (
              <div className="rail__item" key={item.id}><MediaCard item={item} /></div>
            ))}
          </Rail>
        )}

        {!loading && data && data.topRated.length > 0 && (
          <Rail
            title="Highest rated"
            count={titleCount(data.topRated.length)}
            onSeeAll={() => onSeeAll('Highest rated', data.topRated)}
          >
            {data.topRated.map((item) => (
              <div className="rail__item" key={item.id}><MediaCard item={item} /></div>
            ))}
          </Rail>
        )}

        {mine.length > 0 && (
          <Rail
            title="Your favourites"
            count={titleCount(mine.length)}
            onSeeAll={() => onSeeAll('Your favourites', mine)}
          >
            {mine.slice(0, RAIL_LIMIT).map((item) => (
              <div className="rail__item" key={item.id}><MediaCard item={item} /></div>
            ))}
          </Rail>
        )}

        {nothing && (
          <EmptyState
            glyph={meta.glyph}
            title="Your shelves fill as you watch"
            body={EMPTY_BODY}
            action={
              <Button variant="ghost" onClick={() => useApp.getState().patch({ contextHidden: false })}>
                Show categories
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}

function RailSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <section className="rail" aria-hidden>
      <div className="rail__head">
        <div className="rail__heading">
          <Skeleton width={200} height={22} radius={4} />
          <Skeleton width={64} height={12} radius={3} />
        </div>
      </div>
      <div className="rail__body">
        <div className="rail__track rail__track--static">
          {Array.from({ length: wide ? 5 : 8 }, (_, i) => (
            <div className={classNames('rail__item', wide && 'rail__item--wide')} key={i}>
              {wide ? <ContinueCardSkeleton index={i} /> : <MediaCardSkeleton index={i} />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
