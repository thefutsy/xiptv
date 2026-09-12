import { LanguageFilter } from '@/components/LanguageFilter';
import { matchesLanguage } from '@shared/language';
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import type { MediaItem, SourceStats } from '@shared/types';
import { useActiveSource, useApp } from '@/state/store';
import { Skeleton, EmptyState, Button } from '@/components/Primitives';
import {
  Glyph, ICON, Segmented, pushRecent, readRecents, clearRecents, useAdultIds, isAdultItem } from '@/components/CommandPalette';
import { MediaRow, PosterCard, PosterCardSkeleton } from '@/components/Results';
import { VGrid, VList } from '@/lib/virtual';
import { useGridMetrics } from '@/lib/metrics';
import {
  activeFacetCount, applyFacets, countKinds, deriveDecades, deriveGenres, fold, hasMixedKinds,
  matchesName, prefersRows, sortItems, toggleIn, EMPTY_FACETS,
  type Facets, type KindTab, type SortKey,
} from '@/lib/catalog';
import { classNames, errorText } from '@/lib/format';
import './misc.css';

const RATING_STEPS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '0', label: 'Any' }, { value: '6.5', label: '6.5+' }, { value: '7.5', label: '7.5+' },
];
const QUALITIES = ['4K', 'FHD', 'HD'] as const;

function FacetToggle({ facets, languageActive, open, onOpen, onClear }: { facets: Facets; languageActive?: boolean; open: boolean; onOpen: () => void; onClear: () => void }) {
  const count = activeFacetCount(facets) + (languageActive ? 1 : 0);
  return (
    <div className="mx-facets__bar">
      <button type="button" className={classNames('mx-facets__toggle', open && 'mx-facets__toggle--on')} onClick={onOpen}>
        <Glyph icon={ICON.sliders} />
        Filters
        {count > 0 && <span className="mx-facets__badge data">{count}</span>}
      </button>
      {count > 0 && <button type="button" className="mx-facets__clear t-secondary" onClick={onClear}>Clear all</button>}
    </div>
  );
}

function FacetPanel({ items, facets, onChange }: { items: MediaItem[]; facets: Facets; onChange: (f: Facets) => void }) {
  const genres = useMemo(() => deriveGenres(items), [items]);
  const decades = useMemo(() => deriveDecades(items), [items]);

  return (
    <div className="mx-facets__panel">
      {genres.length > 0 && (
        <div className="mx-facets__group">
          <span className="mx-facets__label">Genre</span>
          <div className="mx-facets__chips">
            {genres.map((g) => (
              <button
                key={g}
                type="button"
                className={classNames('mx-tog', facets.genres.includes(g) && 'mx-tog--on')}
                onClick={() => onChange({ ...facets, genres: toggleIn(facets.genres, g) })}
              >{g}</button>
            ))}
          </div>
        </div>
      )}

      {decades.length > 0 && (
        <div className="mx-facets__group">
          <span className="mx-facets__label">Decade</span>
          <div className="mx-facets__chips">
            {decades.map((d) => (
              <button
                key={d}
                type="button"
                className={classNames('mx-tog data', facets.years.includes(d) && 'mx-tog--on')}
                onClick={() => onChange({ ...facets, years: toggleIn(facets.years, d) })}
              >{d}s</button>
            ))}
          </div>
        </div>
      )}

      <div className="mx-facets__group">
        <span className="mx-facets__label">Rating</span>
        <Segmented
          label="Minimum rating"
          value={String(facets.minRating)}
          options={RATING_STEPS}
          onChange={(v) => onChange({ ...facets, minRating: Number(v) })}
        />
      </div>

      <div className="mx-facets__group">
        <span className="mx-facets__label">Quality</span>
        <div className="mx-facets__chips">
          {QUALITIES.map((q) => (
            <button
              key={q}
              type="button"
              className={classNames('mx-tog data', facets.qualities.includes(q) && 'mx-tog--on')}
              onClick={() => onChange({ ...facets, qualities: toggleIn(facets.qualities, q) })}
            >{q}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

const SORTS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'provider', label: 'Best match' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'rating', label: 'Rating' },
  { value: 'year', label: 'Year' },
  { value: 'added', label: 'Recently added' },
];

export function SearchPage() {
  const route = useApp((s) => s.route);
  const source = useActiveSource();

  const scope = route.view === 'search' ? route.kind : undefined;
  const language = route.view === 'search' ? route.language ?? '' : '';
  const scopeLabel = scope === 'movie' ? 'movies' : scope === 'series' ? 'TV shows' : 'Live TV';
  const routeQuery = route.view === 'search' ? route.query : '';
  const [draft, setDraft] = useState(routeQuery);
  const [query, setQuery] = useState(routeQuery);
  const [results, setResults] = useState<MediaItem[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<KindTab>(scope ?? 'all');
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);
  const [sort, setSort] = useState<SortKey>('provider');
  const [facetsOpen, setFacetsOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => readRecents());
  const [stats, setStats] = useState<SourceStats | undefined>();

  const pageRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const metrics = useGridMetrics(pageRef);

  useEffect(() => { setDraft(routeQuery); setQuery(routeQuery); }, [routeQuery]);
  useEffect(() => { setTab(scope ?? 'all'); setFacets(EMPTY_FACETS); }, [scope]);

  // A title-bar click navigates here from another view. `autoFocus` is not reliable across
  // Electron route transitions because the title-bar button can retain native focus, so focus
  // explicitly after this scoped search page has mounted.
  useEffect(() => {
    if (!scope) return;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [scope]);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    window.iptv.catalog.stats(source.id).then((s) => { if (alive) setStats(s); }).catch(() => undefined);
    return () => { alive = false; };
  }, [source]);

  useEffect(() => {
    const q = draft.trim();
    if (q === query) return;
    const timer = setTimeout(() => {
      setQuery(q);
      const app = useApp.getState();
      if (app.route.view === 'search') app.patch({ route: { ...app.route, query: q } });
    }, 220);
    return () => clearTimeout(timer);
  }, [draft, query]);

  // Scoped search reads the full catalogue once; typing and filtering then happen locally.
  const remoteQuery = scope ? '' : query;
  const remoteLanguage = scope ? '' : language;
  useEffect(() => {
    const q = remoteQuery.trim();
    const id = ++request.current;
    if (!source || (!scope && q.length < 2)) { setResults([]); setError(undefined); setLoading(false); return; }
    setLoading(true);
    setResults([]);
    const fetchResults = scope
      ? window.iptv.catalog.all(source.id, scope)
      : window.iptv.catalog.search(source.id, q, undefined, remoteLanguage);
    fetchResults
      .then((found) => {
        if (id !== request.current) return;
        setResults(found);
        setError(undefined);
        setLoading(false);
        if (source.kind === 'xtream') {
          void window.iptv.catalog.stats(source.id)
            .then((s) => { if (id === request.current) setStats(s); })
            .catch(() => undefined);
        }
      })
      .catch((err: unknown) => {
        if (id !== request.current) return;
        setResults([]);
        setError(errorText(err));
        setLoading(false);
      });
    return () => { request.current++; };
  }, [remoteQuery, remoteLanguage, scope, source, attempt]);

  const adultIds = useAdultIds(source?.id);

  const matched = useMemo(() => {
    const q = fold(query.trim());
    if (!scope && q.length < 2) return [];
    const visible = adultIds.size ? results.filter((r) => !isAdultItem(adultIds, r)) : results;
    return visible.filter((item) => (!scope || item.kind === scope) && (!q || matchesName(item, q) || item.programmeMatch !== undefined));
  }, [results, query, adultIds, scope]);

  const counts = useMemo(() => countKinds(matched), [matched]);

  const scoped = useMemo(() => tab === 'all' ? matched : matched.filter((m) => m.kind === tab), [matched, tab]);
  const shown = useMemo(() => sortItems(applyFacets(scoped, facets).filter((item) => matchesLanguage(item, language)), sort), [scoped, facets, sort, language]);

  const asList = prefersRows(tab, counts);
  const mixed = hasMixedKinds(counts);

  const commit = useCallback((value: string) => {
    const q = value.trim();
    setDraft(q);
    setQuery(q);
    if (q.length >= 2) setRecents(pushRecent(q));
    useApp.getState().navigate({ view: 'search', query: q, kind: scope, language });
  }, [scope, language]);

  const setLanguage = (value: string) => {
    useApp.getState().patch({ route: { view: 'search', query: draft.trim(), kind: scope, language: value || undefined } });
  };
  const clearFilters = () => { setFacets(EMPTY_FACETS); setLanguage(''); };
  const canShowResults = !!scope || query.trim().length >= 2;

  const counted = canShowResults && error === undefined;
  const tabs = useMemo(() => ([
    { value: 'all' as KindTab, label: 'All', count: counted ? counts.all : undefined },
    { value: 'live' as KindTab, label: 'Live TV', count: counted ? counts.live : undefined },
    { value: 'movie' as KindTab, label: 'Movies', count: counted ? counts.movie : undefined },
    { value: 'series' as KindTab, label: 'TV Shows', count: counted ? counts.series : undefined },
  ]).filter((option) => !scope || option.value === scope), [counts, counted, scope]);

  const headerBar = (
    <header className="mx-head search__head">
      <div className="search__bar">
        <span className="search__glyph"><Glyph icon={ICON.search} /></span>
        <input
          ref={searchInputRef}
          className="search__input"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          autoFocus
          aria-label={scope ? `Search ${scopeLabel}` : 'Search every channel, movie and series'}
          placeholder={scope ? `Search all ${scopeLabel}` : 'Search every channel, movie and series'}
          dir="auto"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value);
            if (e.key === 'Escape') { setDraft(''); commit(''); }
          }}
        />
        {draft.length > 0 && (
          <button type="button" className="search__clear" aria-label="Clear search" onClick={() => { setDraft(''); commit(''); }}>
            <Glyph icon={ICON.close} />
          </button>
        )}
      </div>

      <div className="search__meta">
        <Segmented className="search__tabs" label="Result kind" value={tab} options={tabs} onChange={(next) => { setTab(next); if (next === 'live') setLanguage(''); }} />
        {/* The tabs carry the counts, so this line appears only when a filter has cut the list. */}
        {(error !== undefined || !canShowResults || shown.length !== scoped.length) && (
          <p className="mx-head__count data">
            {error !== undefined
              ? <>Catalogue did not answer</>
              : canShowResults
              ? <>{shown.length.toLocaleString()} of {scoped.length.toLocaleString()} shown</>
              : stats
                ? stats.catalogReady
                  ? <>{((stats.liveItems ?? 0) + (stats.movieItems ?? 0) + (stats.seriesItems ?? 0)).toLocaleString()} titles indexed</>
                  : <>{(stats.liveCategories + stats.movieCategories + stats.seriesCategories).toLocaleString()} categories indexed</>
                : <>Catalogue not read yet</>}
          </p>
        )}
        <span className="search__meta-spacer" />
        {tab !== 'live' && <LanguageFilter value={language} onChange={setLanguage} />}
        {canShowResults && (
          <FacetToggle
            facets={facets}
            languageActive={!!language}
            open={facetsOpen}
            onOpen={() => setFacetsOpen((o) => !o)}
            onClear={clearFilters}
          />
        )}
        <label className="mx-select">
          <span className="mx-select__label">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      </div>
    </header>
  );

  let body: ReactNode;

  if (loading && shown.length === 0) {
    body = asList || !metrics.ready ? (
      <div className="mx-scroll">
        <div className="search__skel-rows" style={{ padding: metrics.pad }}>
          {Array.from({ length: 10 }, (_, i) => (
            <div className="search__skel-row" style={{ height: metrics.listRowH }} key={i}>
              <Skeleton width={56} height={34} radius={6} />
              <Skeleton width={`${44 - i * 2}%`} height={12} radius={3} />
            </div>
          ))}
        </div>
      </div>
    ) : (
      <VGrid
        className="mx-scroll"
        count={metrics.columns * 3}
        columnWidth={metrics.cellW - 0.5}
        rowHeight={metrics.cellH}
        gapX={metrics.gapX}
        gapY={metrics.gapY}
        padding={metrics.pad}
      >
        {() => <PosterCardSkeleton artH={metrics.artH} />}
      </VGrid>
    );
  } else if (!canShowResults) {
    body = (
      <div className="mx-scroll">
        <div className="search__idle-body" style={{ paddingInline: metrics.pad }}>
          {recents.length > 0 && (
            <>
              <div className="mx-section-label">
                <span>Recent searches</span>
                <button type="button" className="mx-section-label__act" onClick={() => { clearRecents(); setRecents([]); }}>Clear</button>
              </div>
              <div className="search__recents">
                {recents.map((r) => (
                  <button key={r} type="button" className="mx-tog search__recent" onClick={() => commit(r)}>
                    <Glyph icon={ICON.history} />
                    <span className="truncate">{r}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <EmptyState
            glyph={<Glyph icon={ICON.search} size={24} />}
            title="Find it by name"
            body={stats
              ? stats.catalogReady
                ? `${((stats.liveItems ?? 0) + (stats.movieItems ?? 0) + (stats.seriesItems ?? 0)).toLocaleString()} titles are indexed on this machine. Two characters is enough.`
                : `Channels, movies and series across ${(stats.liveCategories + stats.movieCategories + stats.seriesCategories).toLocaleString()} categories are indexed on this machine. Two characters is enough.`
              : 'Everything your provider ships is indexed on this machine. Two characters is enough to start.'}
            action={<Button variant="ghost" onClick={() => useApp.getState().patch({ paletteOpen: true })}>Open the quick palette</Button>}
          />
        </div>
      </div>
    );
  } else if (error !== undefined) {
    body = (
      <div className="mx-scroll">
        <EmptyState
          glyph={<Glyph icon={ICON.alert} size={24} />}
          title="That search did not come back"
          body={error}
          action={<Button variant="ghost" onClick={() => setAttempt((a) => a + 1)}>Try again</Button>}
        />
      </div>
    );
  } else if (shown.length === 0) {
    body = (
      <div className="mx-scroll">
        <EmptyState
          glyph={<Glyph icon={ICON.search} size={24} />}
          title={matched.length > 0 || language ? 'Filtered down to nothing' : 'No title under that name'}
          body={matched.length > 0 || language
            ? 'No titles match these filters. Choose another language or clear the filters to see more.'
            : 'Providers name things strangely. A movie can arrive as "TITLE 2019 MULTI-SUB 4K". Try a shorter fragment without the year.'}
          action={matched.length > 0 || language
            ? <Button variant="ghost" onClick={clearFilters}>Clear filters</Button>
            : <Button variant="ghost" onClick={() => { setDraft(''); commit(''); }}>Clear search</Button>}
        />
      </div>
    );
  } else if (asList) {
    body = (
      <VList className="mx-scroll" count={shown.length} rowHeight={metrics.listRowH}>
        {(i) => <MediaRow item={shown[i]} showKind={tab === 'all' && mixed} />}
      </VList>
    );
  } else {
    body = (
      <VGrid
        className="mx-scroll"
        count={shown.length}
        columnWidth={metrics.cellW - 0.5}
        rowHeight={metrics.cellH}
        gapX={metrics.gapX}
        gapY={metrics.gapY}
        padding={metrics.pad}
      >
        {(i) => <PosterCard item={shown[i]} artH={metrics.artH} />}
      </VGrid>
    );
  }

  return (
    <div className="mx-page search" ref={pageRef}>
      {headerBar}
      {canShowResults && facetsOpen && (
        <div className="search__facets">
          <FacetPanel items={scoped} facets={facets} onChange={setFacets} />
        </div>
      )}
      {body}
    </div>
  );
}

export { SearchPage as Search };
