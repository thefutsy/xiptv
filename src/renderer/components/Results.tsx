import type { ReactNode } from 'react';
import type { MediaItem } from '@shared/types';
import { useApp } from '@/state/store';
import { Kicker, LogoPlate, Poster, Skeleton, TruncateTail } from '@/components/Primitives';
import { Glyph, ICON, playItem } from '@/components/CommandPalette';
import { formatWhen } from '@/lib/format';

export function PosterCard({ item, artH }: { item: MediaItem; artH: number }) {
  const navigate = useApp((s) => s.navigate);
  return (
    <div className="mx-card">
      <div className="mx-card__art" style={{ height: artH }}>
        <Poster item={item} className="mx-card__img" />
        <span className="mx-card__frame" />
        <button
          type="button"
          className="mx-card__open"
          aria-label={item.title || item.name}
          onClick={() => navigate({ view: 'detail', item })}
        />
        <button
          type="button"
          className="mx-card__play"
          aria-label="Play"
          onClick={() => void playItem(item)}
        >
          <Glyph icon={ICON.play} />
        </button>
      </div>
      <div className="mx-card__cap">
        <span className="mx-card__title" dir="auto">{item.title || item.name}</span>
        <Kicker parts={[item.year]} rating={item.rating} className="mx-card__kicker" />
      </div>
    </div>
  );
}

export function PosterCardSkeleton({ artH }: { artH: number }) {
  return (
    <div className="mx-card">
      <Skeleton height={artH} radius={6} />
      <div className="mx-card__cap">
        <Skeleton width="82%" height={12} radius={3} />
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
            <Kicker parts={[item.year]} rating={item.rating} className="mx-row__kicker" />
          ) : null}
        </span>
      </button>
      <div className="mx-row__end">
        {showKind && <span className="mx-chip micro">{item.kind === 'live' ? 'CHANNEL' : item.kind === 'movie' ? 'MOVIE' : 'SERIES'}</span>}
        <div className="mx-row__act">
          {right}
          <button type="button" className="mx-icon-btn" aria-label={`Play ${label}`} onClick={() => void playItem(item)}>
            <Glyph icon={ICON.play} />
          </button>
        </div>
      </div>
    </div>
  );
}
