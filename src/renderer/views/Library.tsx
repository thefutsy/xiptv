import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaItem, WatchProgress } from '@shared/types';
import { useApp } from '@/state/store';
import { Absence, Button, EmptyState, Kicker, Skeleton, TruncateTail, Tally } from '@/components/Primitives';
import { Glyph, ICON, Segmented, playItem } from '@/components/CommandPalette';
import { kindWord, MediaRow, PosterCard } from '@/components/Results';
import { VGrid, VList } from '@/lib/virtual';
import { useGridMetrics } from '@/lib/metrics';
import { countKinds, hasMixedKinds, prefersRows, sortItems, type KindTab, type SortKey } from '@/lib/catalog';
import { errorText, formatDuration, progressThrough } from '@/lib/format';
import { coarseDuration } from '@/components/MediaCard';
import './misc.css';

const SORTS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'provider', label: 'Order added' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'rating', label: 'Rating' },
  { value: 'year', label: 'Year' },
];

const CONTINUE_ROW_H = 84;

export function Library() {
  const view = useApp((s) => s.route.view);
  return view === 'continue' ? <ContinueWatching /> : <Favourites />;
}

function Favourites() {
  const navigate = useApp((s) => s.navigate);
  const [items, setItems] = useState<MediaItem[] | undefined>();
  const [tab, setTab] = useState<KindTab>('all');
  const [sort, setSort] = useState<SortKey>('provider');
  const pageRef = useRef<HTMLDivElement>(null);
  const metrics = useGridMetrics(pageRef);

  const load = useCallback(async () => {
    try {
      const list = await window.iptv.library.favourites();
      setItems(list);
      useApp.getState().patch({ favourites: list });
      const tally = countKinds(list);
      const best = (['movie', 'series', 'live'] as const).reduce((a, k) => (tally[k] > tally[a] ? k : a));
      if (tally[best] > 0) setTab(best);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const all = items ?? [];
  const counts = useMemo(() => countKinds(all), [all]);

  const scoped = useMemo(() => tab === 'all' ? all : all.filter((i) => i.kind === tab), [all, tab]);
  const shown = useMemo(() => sortItems(scoped, sort), [scoped, sort]);

  const unfavourite = useCallback(async (item: MediaItem) => {
    setItems((prev) => prev?.filter((i) => i.id !== item.id));
    try {
      await window.iptv.library.toggleFavourite(item);
      useApp.getState().patch({ favourites: useApp.getState().favourites.filter((i) => i.id !== item.id) });
    } catch (err) {
      void load();
      useApp.getState().toast$(errorText(err, 'Could not update favourites.'), 'error');
    }
  }, [load]);

  const tabs = useMemo(() => ([
    { value: 'all' as KindTab, label: 'All', count: counts.all },
    { value: 'live' as KindTab, label: 'Live TV', count: counts.live },
    { value: 'movie' as KindTab, label: 'Movies', count: counts.movie },
    { value: 'series' as KindTab, label: 'TV Shows', count: counts.series },
  ]), [counts]);

  const header = (
    <header className="mx-head">
      <div className="mx-head__titles">
        <h1 className="h1">Favourites</h1>
        <p className="mx-head__count data">
          {counts.all.toLocaleString()} {counts.all === 1 ? 'title' : 'titles'}
          {counts.live > 0 && counts.live !== counts.all && <> · {counts.live.toLocaleString()} {counts.live === 1 ? 'channel' : 'channels'}</>}
        </p>
      </div>
      <span className="mx-head__spacer" />
      {counts.all > 0 && (
        <>
          <Segmented label="Favourite kind" value={tab} options={tabs} onChange={setTab} />
          <label className="mx-select">
            <span className="mx-select__label">Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        </>
      )}
    </header>
  );

  if (items === undefined) {
    return (
      <div className="mx-page library" ref={pageRef}>
        <div className="mx-scroll">
          {header}
          <div className="library__skel" style={{ padding: metrics.pad }}>
            {Array.from({ length: 8 }, (_, i) => (
              <div className="library__skel-row" style={{ height: metrics.listRowH }} key={i}>
                <Skeleton width={56} height={34} radius={6} />
                <Skeleton width={`${46 - i * 3}%`} height={12} radius={3} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (shown.length === 0) {
    return (
      <div className="mx-page library" ref={pageRef}>
        <div className="mx-scroll">
          {header}
          <EmptyState
            glyph={<Glyph icon={ICON.star} size={24} />}
            title={counts.all === 0 ? 'Nothing starred yet' : 'Nothing of that kind'}
            body={counts.all === 0
              ? 'A provider ships tens of thousands of rows. Star the twelve you actually watch and this becomes the only list you open.'
              : 'You have favourites, just none in this tab. Try another kind, or star something while you browse.'}
            action={counts.all === 0
              ? <Button variant="ghost" onClick={() => navigate({ view: 'live' })}>Browse live channels</Button>
              : <Button variant="ghost" onClick={() => setTab('all')}>Show everything</Button>}
          />
        </div>
      </div>
    );
  }

  const asList = prefersRows(tab, counts);
  const mixed = hasMixedKinds(counts);

  return (
    <div className="mx-page library" ref={pageRef}>
      {asList ? (
        <VList className="mx-scroll" header={header} count={shown.length} rowHeight={metrics.listRowH}>
          {(i) => (
            <MediaRow
              item={shown[i]}
              showKind={tab === 'all' && mixed}
              right={
                <button
                  type="button"
                  className="mx-icon-btn mx-icon-btn--on"
                  aria-label={`Remove ${shown[i].title || shown[i].name} from favourites`}
                  onClick={() => void unfavourite(shown[i])}
                >
                  <Glyph icon={ICON.star} />
                </button>
              }
            />
          )}
        </VList>
      ) : (
        <VGrid
          className="mx-scroll"
          header={header}
          count={shown.length}
          columnWidth={metrics.cellW - 0.5}
          rowHeight={metrics.cellH}
          gapX={metrics.gapX}
          gapY={metrics.gapY}
          padding={metrics.pad}
        >
          {(i) => (
            <div className="library__cell">
              <PosterCard item={shown[i]} artH={metrics.artH} />
              <button
                type="button"
                className="library__unstar"
                aria-label={`Remove ${shown[i].title || shown[i].name} from favourites`}
                onClick={() => void unfavourite(shown[i])}
              >
                <Glyph icon={ICON.star} />
              </button>
            </div>
          )}
        </VGrid>
      )}
    </div>
  );
}

function ContinueWatching() {
  const navigate = useApp((s) => s.navigate);
  const [entries, setEntries] = useState<WatchProgress[] | undefined>();

  const load = useCallback(async () => {
    try {
      const list = await window.iptv.library.continueWatching();
      setEntries([...list].sort((a, b) => b.updatedAt - a.updatedAt));
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const forget = useCallback(async (entry: WatchProgress) => {
    setEntries((prev) => prev?.filter((e) => e.itemId !== entry.itemId || e.episodeId !== entry.episodeId));
    try {
      await window.iptv.library.clearProgress(entry.itemId);
    } catch (err) {
      void load();
      useApp.getState().toast$(errorText(err, 'Could not forget that.'), 'error');
    }
  }, [load]);

  const forgetAll = useCallback(async () => {
    const list = entries ?? [];
    setEntries([]);
    try {
      for (const entry of list) await window.iptv.library.clearProgress(entry.itemId);
    } catch {
      void load();
    }
  }, [entries, load]);

  const resume = useCallback(async (entry: WatchProgress) => {
    const { sources, activeSourceId, toast$ } = useApp.getState();
    const source = sources.find((s) => s.id === (entry.sourceId || activeSourceId)) ?? sources[0];
    if (!source) return;
    try {
      const item = await window.iptv.catalog.itemDetail(source.id, entry.itemId);
      await playItem(item, { episodeId: entry.episodeId, startAt: entry.position });
    } catch (err) {
      toast$(errorText(err, 'That title is no longer in the catalogue.'), 'error');
    }
  }, []);

  const list = entries ?? [];

  const header = (
    <header className="mx-head">
      <div className="mx-head__titles">
        <h1 className="h1">Continue Watching</h1>
        <p className="mx-head__count data">
          {list.length.toLocaleString()} {list.length === 1 ? 'title' : 'titles'} in progress
        </p>
      </div>
      <span className="mx-head__spacer" />
      {list.length > 0 && <Button variant="plain" onClick={() => void forgetAll()}>Clear all</Button>}
    </header>
  );

  if (entries === undefined) {
    return (
      <div className="mx-page library">
        <div className="mx-scroll">
          {header}
          <div className="library__skel library__skel--wide">
            {Array.from({ length: 5 }, (_, i) => (
              <div className="library__skel-row" style={{ height: CONTINUE_ROW_H }} key={i}>
                <Skeleton width={128} height={72} radius={6} />
                <Skeleton width={`${52 - i * 4}%`} height={12} radius={3} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="mx-page library">
        <div className="mx-scroll">
          {header}
          <EmptyState
            glyph={<Glyph icon={ICON.clock} size={24} />}
            title="Nothing half-watched"
            body="Stop a movie or an episode partway and xiptv keeps the second you left it, ready on whichever source you were using."
            action={<Button variant="ghost" onClick={() => navigate({ view: 'movies' })}>Browse movies</Button>}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-page library">
      <VList className="mx-scroll" header={header} count={list.length} rowHeight={CONTINUE_ROW_H}>
        {(i) => <ContinueRow entry={list[i]} onResume={resume} onForget={forget} />}
      </VList>
    </div>
  );
}

function ContinueRow({
  entry, onResume, onForget,
}: {
  entry: WatchProgress;
  onResume: (e: WatchProgress) => void | Promise<void>;
  onForget: (e: WatchProgress) => void | Promise<void>;
}) {
  const [broken, setBroken] = useState(false);
  const through = entry.duration > 0 ? progressThrough(0, entry.duration, entry.position) : 0;
  const left = Math.max(0, entry.duration - entry.position);

  return (
    <div className="library__cont">
      <button type="button" className="library__cont-hit" onClick={() => void onResume(entry)}>
        <span className="library__still">
          {entry.image && !broken
            ? <img className="library__still-img" src={entry.image} alt="" draggable={false} decoding="async" loading="lazy" onError={() => setBroken(true)} />
            : <Absence className="library__still-abs" />}
          <span className="library__still-frame" />
          <span className="library__track">
            <span className="library__track-fill" style={{ width: `${Math.round(through * 100)}%` }}>
              <Tally orientation="horizontal" />
            </span>
          </span>
        </span>
        <span className="library__cont-text">
          <TruncateTail text={entry.title} className="library__cont-name" />
          <Kicker
            className="library__cont-kicker"
            parts={[
              entry.duration > 0 && `${coarseDuration(left)} left`,
              entry.duration > 0
                ? `${formatDuration(entry.position)} of ${formatDuration(entry.duration)}`
                : formatDuration(entry.position),
            ]}
          />
        </span>
      </button>

      <div className="library__cont-end">
        <div className="library__cont-act">
          <Button variant="ghost" onClick={() => void onResume(entry)}>
            <Glyph icon={ICON.play} />Resume
          </Button>
          <button
            type="button"
            className="mx-icon-btn"
            aria-label={`Forget ${entry.title}`}
            onClick={() => void onForget(entry)}
          >
            <Glyph icon={ICON.close} />
          </button>
        </div>
        <span className="mx-kind">{kindWord(entry.kind)}</span>
      </div>
    </div>
  );
}
