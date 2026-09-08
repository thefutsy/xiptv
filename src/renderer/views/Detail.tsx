import {
  useCallback, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import type { Episode, MediaItem, SeriesDetail, WatchProgress } from '@shared/types';
import { Absence, Button, Kicker, Poster, Skeleton, Tooltip, TruncateTail } from '@/components/Primitives';
import {
  coarseDuration, Glyph, humanGenre, MenuButton, MenuItem, openExternally, playItem, qualityTag,
  seasonsLabel, toggleFavourite, useIsFavourite,
} from '@/components/MediaCard';
import { VList } from '@/lib/virtual';
import { EMPTY_FACETS, splitGenres } from '@/lib/catalog';
import { useMeasured } from '@/lib/metrics';
import { classNames, formatDuration, progressThrough } from '@/lib/format';
import { activeSource, useApp } from '@/state/store';
import './browse.css';

const EPISODE_H = 80;
const TAB_LIMIT = 12;

export function Detail() {
  const route = useApp((s) => s.route);
  if (route.view !== 'detail') return null;
  return <DetailPage key={route.item.id} item={route.item} />;
}

function enrich(base: MediaItem, extra?: Partial<MediaItem>): MediaItem {
  if (!extra) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') Object.assign(out, { [key]: value });
  }
  return out;
}

function orderSeasons(seasons: number[]): number[] {
  return [...new Set(seasons)].sort((a, b) => (a === 0 ? Infinity : a) - (b === 0 ? Infinity : b));
}

function seasonLabel(n: number): string {
  return n === 0 ? 'Specials' : `Season ${n}`;
}

function episodesOf(detail: SeriesDetail | null, season: number | null): Episode[] {
  if (!detail || season === null) return [];
  const rows = detail.episodes[season];
  if (!rows || rows.length === 0) return [];
  return [...rows].sort((a, b) => a.episodeNum - b.episodeNum);
}

function formatAdded(value?: number): string | undefined {
  if (!value || !Number.isFinite(value)) return undefined;
  const ms = value > 1e12 ? value : value * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function episodeCode(episode: Episode): string {
  return `S${episode.season} E${episode.episodeNum}`;
}

/**
 * Providers often file an episode as "Show (2026) (US) - S01E01 - One". The show and the code are
 * already on the page, so the row keeps only the part that names the episode.
 */
function episodeTitle(episode: Episode): string {
  const raw = (episode.title || '').trim();
  const m = /^(?:.*?\s[-\u2013]\s)?S\d{1,2}\s?E\d{1,3}(?:\s[-\u2013:]\s*|\s+)(.+)$/i.exec(raw);
  const kept = m?.[1]?.trim();
  if (kept) return kept;
  return raw || `Episode ${episode.episodeNum}`;
}

function episodeDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

interface GenreChip {
  label: string;
  raw: string;
}

function genresOf(item: MediaItem): GenreChip[] {
  const seen = new Set<string>();
  const out: GenreChip[] = [];
  for (const raw of splitGenres(item.genre)) {
    const label = humanGenre(raw);
    if (label.length > 1 && !seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      out.push({ label, raw });
    }
  }
  return out.slice(0, 8);
}

function watchedFraction(p?: WatchProgress): number {
  return p ? progressThrough(0, p.duration, p.position) : 0;
}

const offsetHeight = (el: HTMLElement): number => el.offsetHeight;

interface NextUp { episode: Episode; startAt?: number }

function nextUp(detail: SeriesDetail, progress: WatchProgress[]): NextUp | undefined {
  const flat = orderSeasons(detail.seasons).flatMap((s) => episodesOf(detail, s));
  if (!flat.length) return undefined;
  const byEpisode = new Map<string, WatchProgress>();
  for (const p of progress) if (p.episodeId) byEpisode.set(p.episodeId, p);

  let bestIndex = -1;
  let bestAt = -1;
  let best: WatchProgress | undefined;
  flat.forEach((ep, i) => {
    const p = byEpisode.get(ep.id);
    if (p && p.updatedAt > bestAt) { bestAt = p.updatedAt; bestIndex = i; best = p; }
  });

  if (best) {
    if (watchedFraction(best) < 0.95) return { episode: flat[bestIndex], startAt: best.position };
    if (bestIndex + 1 < flat.length) return { episode: flat[bestIndex + 1] };
    return { episode: flat[bestIndex] };
  }
  return { episode: flat[0] };
}

function DetailPage({ item }: { item: MediaItem }) {
  const [detail, setDetail] = useState<MediaItem>(item);
  const [series, setSeries] = useState<SeriesDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [progress, setProgress] = useState<WatchProgress[]>([]);
  const [season, setSeason] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  const isSeries = item.kind === 'series';

  useEffect(() => {
    const src = activeSource();
    if (!src) { setLoading(false); return; }
    let dead = false;
    setLoading(true);

    const work: Promise<void> = isSeries
      ? window.iptv.catalog.seriesDetail(src.id, item.id).then((sd) => {
        if (dead) return;
        setSeries(sd);
        setDetail(enrich(item, sd.item));
      })
      : window.iptv.catalog.itemDetail(src.id, item.id).then((full) => {
        if (dead) return;
        setDetail(enrich(item, full));
      });

    void work.catch(() => undefined).finally(() => { if (!dead) setLoading(false); });
    void window.iptv.library.continueWatching()
      .then((rows) => { if (!dead) setProgress(rows); })
      .catch(() => undefined);

    return () => { dead = true; };
  }, [item, isSeries, nonce]);

  const seasons = useMemo(() => orderSeasons(series?.seasons ?? []), [series]);

  useEffect(() => {
    if (!seasons.length) { setSeason(null); return; }
    const firstFilled = seasons.find((s) => (series?.episodes[s]?.length ?? 0) > 0);
    setSeason(firstFilled ?? seasons[0]);
    setFocusIndex(null);
  }, [seasons, series]);

  const episodes = useMemo(() => episodesOf(series, season), [series, season]);

  const progressFor = useCallback(
    (episodeId: string) => progress.find((p) => p.episodeId === episodeId),
    [progress],
  );

  const itemProgress = progress.find((p) => p.itemId === detail.id && !p.episodeId);
  const next = useMemo(() => (series ? nextUp(series, progress) : undefined), [series, progress]);

  const movieResumeAt = itemProgress && watchedFraction(itemProgress) < 0.95 && itemProgress.position > 30
    ? itemProgress.position
    : undefined;
  const episodeResumeAt = next?.startAt !== undefined && next.startAt > 30 ? next.startAt : undefined;

  const playPrimary = () => {
    if (!isSeries) {
      void playItem(detail, { startAt: movieResumeAt });
      return;
    }
    if (next) void playItem(detail, { episodeId: next.episode.id, startAt: next.startAt });
  };

  const resumeLine = isSeries
    ? next && (episodeResumeAt !== undefined
      ? `${episodeCode(next.episode)} · from ${formatDuration(episodeResumeAt)}`
      : episodeCode(next.episode))
    : movieResumeAt !== undefined ? `Resume from ${formatDuration(movieResumeAt)}` : undefined;

  const playLabel = (isSeries ? episodeResumeAt : movieResumeAt) !== undefined ? 'Resume' : 'Play';

  const spread = (
    <Spread
      detail={detail}
      loading={loading}
      playLabel={playLabel}
      resumeLine={resumeLine}
      canPlay={!isSeries || !!next}
      onPlay={playPrimary}
    />
  );

  if (!isSeries) {
    return <div className="detail browse__scroll">{spread}</div>;
  }

  const seasonBar = (
    <SeasonBar
      seasons={seasons}
      active={season}
      detail={series}
      onPick={(s) => { setSeason(s); setFocusIndex(null); }}
    />
  );

  const noSeasons = !loading && (!series || series.seasons.length === 0);

  return (
    <SeriesBody
      spread={spread}
      seasonBar={seasons.length > 0 ? seasonBar : null}
      episodes={episodes}
      tail={
        noSeasons ? (
          <NoEpisodeList onRetry={() => setNonce((n) => n + 1)} onExternal={() => void openExternally(detail)} />
        ) : loading ? (
          <div className="episodes__loading">
            {Array.from({ length: 6 }, (_, i) => <EpisodeSkeleton key={i} />)}
          </div>
        ) : seasons.length > 0 && episodes.length === 0 ? (
          <div className="episodes__hole">
            <Absence className="episodes__absence" label="No episodes listed" />
          </div>
        ) : null
      }
      renderEpisode={(index) => {
        const ep = episodes[index];
        return (
          <EpisodeRow
            episode={ep}
            progress={progressFor(ep.id)}
            focused={focusIndex === index}
            onFocus={() => setFocusIndex(index)}
            onMove={(delta) => setFocusIndex(Math.min(episodes.length - 1, Math.max(0, index + delta)))}
            onSeasonStep={(delta) => {
              const at = season === null ? -1 : seasons.indexOf(season);
              const target = seasons[Math.min(seasons.length - 1, Math.max(0, at + delta))];
              if (target !== undefined) { setSeason(target); setFocusIndex(0); }
            }}
            onPlay={(startAt) => void playItem(detail, { episodeId: ep.id, startAt })}
            onToggleWatched={() => {
              const p = progressFor(ep.id);
              const duration = p?.duration || ep.durationSecs || 1;
              if (watchedFraction(p) >= 0.95) {
                void window.iptv.library.clearProgress(detail.id, ep.id).catch(() => undefined);
                setProgress((rows) => rows.filter((r) => r.episodeId !== ep.id));
                return;
              }
              const row: WatchProgress = {
                itemId: detail.id, sourceId: activeSource()?.id ?? '', position: duration, duration,
                updatedAt: Date.now(), title: detail.title, image: ep.image,
                kind: 'series', episodeId: ep.id,
              };
              void window.iptv.library.saveProgress(row).catch(() => undefined);
              setProgress((rows) => [...rows.filter((r) => r.episodeId !== ep.id), row]);
            }}
          />
        );
      }}
    />
  );
}

function SeriesBody({
  spread, seasonBar, episodes, tail, renderEpisode,
}: {
  spread: ReactNode;
  seasonBar: ReactNode;
  episodes: Episode[];
  tail: ReactNode;
  renderEpisode: (index: number) => ReactNode;
}) {
  const [measure, headerH] = useMeasured(offsetHeight, 0);

  return (
    <VList
      className="detail browse__scroll"
      count={episodes.length}
      rowHeight={EPISODE_H}
      overscan={Math.ceil((headerH + 200) / EPISODE_H) + 4}
      header={
        <>
          <div ref={measure}>{spread}</div>
          {seasonBar}
          {tail}
        </>
      }
    >
      {renderEpisode}
    </VList>
  );
}

function Spread({
  detail, loading, playLabel, resumeLine, canPlay, onPlay,
}: {
  detail: MediaItem;
  loading: boolean;
  playLabel: string;
  resumeLine?: string;
  canPlay: boolean;
  onPlay: () => void;
}) {
  const favourite = useIsFavourite(detail.id);
  const genres = genresOf(detail);
  const title = detail.title || detail.name;
  const kind = detail.kind === 'series' ? 'series' : 'movie';

  const titleSize = title.length > 56 ? 'detail__title--xs' : title.length > 34 ? 'detail__title--sm' : '';
  const quality = qualityTag(detail.name);
  // Providers sometimes ship a sample length in this field; anything under a quarter hour is noise.
  const runtime = detail.kind === 'movie' && detail.durationSecs && detail.durationSecs >= 15 * 60
    ? coarseDuration(detail.durationSecs)
    : undefined;

  const jumpToGenre = (genre: string) => {
    const state = useApp.getState();
    state.patch({
      selectedCategory: { ...state.selectedCategory, [kind]: detail.categoryId },
      facets: { ...EMPTY_FACETS, genres: [genre] },
    });
    state.navigate({ view: kind === 'series' ? 'shows' : 'movies' });
  };

  return (
    <div className="detail__spread">
      <div className="detail__aside">
        <div className="detail__poster-frame">
          <Poster item={detail} className="detail__poster" />
        </div>

        <Button variant="primary" className="detail__play" disabled={!canPlay} onClick={onPlay}>
          <Glyph.Play size={16} />{playLabel}
        </Button>
        {resumeLine && <div className="detail__resume data">{resumeLine}</div>}

        <div className="detail__actions">
          <Button
            variant="plain"
            className="detail__action"
            aria-pressed={favourite}
            onClick={() => void toggleFavourite(detail)}
          >
            <Glyph.Star size={16} filled={favourite} />{favourite ? 'In favourites' : 'Favourite'}
          </Button>
          <Button
            variant="plain"
            className="detail__action"
            onClick={() => useApp.getState().patch({ castPanelOpen: true })}
          >
            <Glyph.Cast size={16} />Cast
          </Button>
          <Button
            variant="plain"
            className="detail__action"
            onClick={() => void openExternally(detail)}
          >
            <Glyph.External size={16} />Open externally
          </Button>
        </div>
      </div>

      <div className="detail__main">
        <h1 className={classNames('t-display detail__title', titleSize)} dir="auto">{title}</h1>
        <Kicker
          className="detail__meta"
          parts={[
            detail.year,
            runtime,
            detail.kind === 'series' && detail.seasonCount ? seasonsLabel(detail.seasonCount) : undefined,
            quality,
          ]}
          rating={detail.rating}
        />
        <Plot text={detail.plot} loading={loading} />
        {genres.length > 0 && (
          <div className="detail__genres">
            {genres.map((g) => (
              <button
                type="button"
                key={g.raw}
                className="detail__genre"
                onClick={() => jumpToGenre(g.raw)}
              >{g.label}</button>
            ))}
          </div>
        )}
        <SpecSheet detail={detail} loading={loading} />
      </div>
    </div>
  );
}

function Plot({ text, loading }: { text?: string; loading: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (!el) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  if (!text) {
    if (loading) {
      return (
        <div className="detail__plot-skel">
          <Skeleton height={14} radius={3} />
          <Skeleton height={14} radius={3} style={{ width: '92%' }} />
          <Skeleton height={14} radius={3} style={{ width: '64%' }} />
        </div>
      );
    }
    return <p className="detail__plot detail__plot--absent">No synopsis came with this record.</p>;
  }

  return (
    <div className="detail__plot-block">
      <p ref={ref} className={classNames('detail__plot', expanded && 'is-open')} dir="auto">{text}</p>
      {(overflows || expanded) && (
        <button type="button" className="detail__more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}

function SpecSheet({ detail, loading }: { detail: MediaItem; loading: boolean }) {
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, value?: string) => {
    const v = value?.trim();
    if (v) rows.push({ label, value: v });
  };
  push('Director', detail.director);
  push('Cast', detail.cast);
  push('Added', formatAdded(detail.addedAt));
  push('Format', detail.containerExtension?.toUpperCase());

  if (!rows.length) {
    if (!loading) return null;
    return (
      <div className="spec">
        {Array.from({ length: 3 }, (_, i) => (
          <div className="spec__row" key={i}>
            <span className="spec__label">&nbsp;</span>
            <span className="spec__value"><Skeleton height={14} radius={3} style={{ width: `${70 - i * 12}%` }} /></span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="spec">
      {rows.map((row) => (
        <div className="spec__row" key={row.label}>
          <span className="spec__label">{row.label}</span>
          <span className="spec__value" dir="auto">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

function SeasonBar({
  seasons, active, detail, onPick,
}: { seasons: number[]; active: number | null; detail: SeriesDetail | null; onPick: (season: number) => void }) {
  const countOf = (s: number) => detail?.episodes[s]?.length ?? 0;

  if (seasons.length > TAB_LIMIT) {
    return (
      <div className="season-bar season-bar--menu">
        <MenuButton
          className="season-bar__picker"
          label={active === null ? 'Seasons' : seasonLabel(active)}
          width={240}
          panelClassName="season-bar__panel"
          align="start"
        >
          {(close) => (
            <div className="season-bar__list">
              {seasons.map((s) => (
                <MenuItem
                  key={s}
                  selected={s === active}
                  trailing={countOf(s) > 0 ? String(countOf(s)) : undefined}
                  onSelect={() => { if (countOf(s) > 0) onPick(s); close(); }}
                >
                  {seasonLabel(s)}
                </MenuItem>
              ))}
            </div>
          )}
        </MenuButton>
        <span className="season-bar__meta data">
          {active !== null && countOf(active) > 0 ? `${countOf(active)} episodes` : ''}
        </span>
      </div>
    );
  }

  return (
    <div className="season-bar" role="tablist" aria-label="Seasons">
      {seasons.map((s) => {
        const count = countOf(s);
        const isActive = s === active;
        const tab = (
          <button
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-disabled={count === 0}
            tabIndex={count === 0 ? -1 : 0}
            className={classNames('season-tab', isActive && 'is-active', count === 0 && 'is-empty')}
            onClick={() => count > 0 && onPick(s)}
          >
            <span>{seasonLabel(s)}</span>
            {count > 0 && <span className="season-tab__count data">{count}</span>}
          </button>
        );
        return count === 0
          ? <Tooltip key={s} label="No episodes listed" placement="bottom">{tab}</Tooltip>
          : <span key={s} className="season-tab__slot">{tab}</span>;
      })}
    </div>
  );
}

function EpisodeRow({
  episode, progress, focused, onFocus, onMove, onSeasonStep, onPlay, onToggleWatched,
}: {
  episode: Episode;
  progress?: WatchProgress;
  focused: boolean;
  onFocus: () => void;
  onMove: (delta: number) => void;
  onSeasonStep: (delta: number) => void;
  onPlay: (startAt?: number) => void;
  onToggleWatched: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [episode.image]);
  useEffect(() => { if (focused) ref.current?.focus(); }, [focused]);

  const fraction = watchedFraction(progress);
  const finished = fraction >= 0.95;
  const partial = fraction > 0.02 && !finished;
  const resumeAt = partial ? progress?.position : undefined;
  const still = episode.image && !broken;

  return (
    <div
      ref={ref}
      className={classNames('episode', finished && 'is-done')}
      role="button"
      tabIndex={0}
      aria-label={`Episode ${episode.episodeNum}. ${episode.title}`}
      onClick={() => onPlay(resumeAt)}
      onFocus={onFocus}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); onMove(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); onMove(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); onSeasonStep(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); onSeasonStep(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); onPlay(resumeAt); }
        else if (e.key === ' ') { e.preventDefault(); onToggleWatched(); }
      }}
    >
      <div className="episode__still">
        {still ? (
          <img
            className="episode__img"
            src={episode.image}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="episode__ghost data">{episode.episodeNum}</span>
        )}
        <span className="episode__play" aria-hidden><Glyph.Play size={14} /></span>
        {partial && <span className="episode__progress" style={{ width: `${fraction * 100}%` }} />}
      </div>

      <div className="episode__text">
        <div className="episode__line">
          <span className="episode__num data">{episode.episodeNum}</span>
          <TruncateTail text={episodeTitle(episode)} className="episode__title" />
        </div>
        {episode.plot && <p className="episode__plot sm" dir="auto">{episode.plot}</p>}
      </div>

      <div className="episode__end">
        {episode.durationSecs !== undefined && episode.durationSecs > 0 && (
          <span className="episode__dur data">{episodeDuration(episode.durationSecs)}</span>
        )}
        <button
          type="button"
          className="episode__watch"
          aria-pressed={finished}
          aria-label={finished ? 'Mark as unwatched' : 'Mark as watched'}
          onClick={(e) => { e.stopPropagation(); onToggleWatched(); }}
        ><Glyph.Check size={16} /></button>
      </div>
    </div>
  );
}

function EpisodeSkeleton() {
  return (
    <div className="episode episode--skeleton" aria-hidden>
      <div className="episode__still"><div className="skeleton episode__img" /></div>
      <div className="episode__text">
        <Skeleton width={220} height={14} radius={3} />
        <Skeleton height={12} radius={3} style={{ marginTop: 8, width: '76%' }} />
      </div>
      <div className="episode__end"><Skeleton width={44} height={12} radius={3} /></div>
    </div>
  );
}

function NoEpisodeList({ onRetry, onExternal }: { onRetry: () => void; onExternal: () => void }) {
  return (
    <div className="no-episodes">
      <div className="no-episodes__body">
        <h2 className="t-title">No episode list from this provider</h2>
        <p className="t-secondary">
          The series is in the catalogue but its season data came back empty. Some providers fill
          this in lazily, so a retry sometimes works.
        </p>
        <div className="no-episodes__actions">
          <Button variant="ghost" onClick={onRetry}>Retry</Button>
          <Button variant="ghost" onClick={onExternal}>Open in external player</Button>
        </div>
      </div>
    </div>
  );
}
