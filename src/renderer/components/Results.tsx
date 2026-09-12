import { LanguageBadge } from '@/components/LanguageBadge';
import type { ReactNode } from 'react';
import type { MediaItem } from '@shared/types';
import { useApp } from '@/state/store';
import { Kicker, LogoPlate, Poster, Skeleton, TruncateTail } from '@/components/Primitives';
import { Glyph, ICON, playItem } from '@/components/CommandPalette';
import { metaParts } from '@/components/MediaCard';
import { formatWhen } from '@/lib/format';

export function kindWord(kind: MediaItem['kind']): string {
  return kind === 'live' ? 'Channel' : kind === 'movie' ? 'Movie' : 'Series';
}

export function PosterCard({ item, artH }: { item: MediaItem; artH: number }) {
  const navigate = useApp((s) => s.navigate);
  return (
    <div className="mx-card">
      <div className="mx-card__art" style={{ height: artH }}>
        <Poster item={item} className="mx-card__img" />
        <button
          type="button"
          className="mx-card__open"
          aria-label={item.title || item.name}
          onClick={() => navigate({ view: 'detail', item })}
        >
          <LanguageBadge item={item} overlay />
        </button>
        <button
          type="button"
          className="mx-card__play"
          aria-label="Play"
          onClick={() => void playItem(item)}
        >
          <Glyph icon={ICON.play} />
        </button>
      </div>
      <div className="mx-card__cap" title={item.title || item.name}>
        <span className="mx-card__title" dir="auto">{item.title || item.name}</span>
        <Kicker parts={metaParts(item)} rating={item.kind === 'series' ? undefined : item.rating} className="mx-card__kicker" />
      </div>
    </div>
  );
}

export function PosterCardSkeleton({ artH }: { artH: number }) {
  return (
    <div className="mx-card">
      <Skeleton height={artH} radius={6} />
      <div className="mx-card__cap">
        <Skeleton width="78%" height={12} radius={3} style={{ marginTop: 4 }} />
      </div>
    </div>
  );
}

export function MediaRow({ item, showKind, right }: { item: MediaItem; showKind?: boolean; right?: ReactNode }) {
  const navigate = useApp((s) => s.navigate);
  const label = item.title || item.name;
  const programme = item.programmeMatch ?? item.nowPlaying;
  return (
    <div className="mx-row">
      <button type="button" className="mx-row__hit" onClick={() => navigate({ view: 'detail', item })}>
        <span className="mx-row__art">
          {item.kind === 'live'
            ? <LogoPlate item={item} size="row" />
            : <span className="mx-row__poster"><Poster item={item} /></span>}
        </span>
        <span className="mx-row__text">
          {/* A virtualised row is `contain: strict`, so a popover anchored inside it clips
              at the row edge. Do not use <Tooltip> here. */}
          <TruncateTail text={label} className="mx-row__name" />
          {programme !== undefined ? (
            <span className="mx-row__epg truncate" dir="auto">
              <span className="mx-row__epg-when data">
                {formatWhen(programme.start, programme.stop, Math.floor(Date.now() / 1000))}
              </span>
              {programme.title}
            </span>
          ) : item.kind !== 'live' && (item.year !== undefined || item.rating !== undefined) ? (
            <Kicker parts={metaParts(item)} rating={item.kind === 'series' ? undefined : item.rating} className="mx-row__kicker" />
          ) : null}
        </span>
      </button>
      <div className="mx-row__end">
        <div className="mx-row__act">
          {right}
          <button type="button" className="mx-icon-btn" aria-label={`Play ${label}`} onClick={() => void playItem(item)}>
            <Glyph icon={ICON.play} />
          </button>
        </div>
        <LanguageBadge item={item} />
        {showKind && <span className="mx-kind">{kindWord(item.kind)}</span>}
      </div>
    </div>
  );
}
