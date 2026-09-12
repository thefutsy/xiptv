import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { Category, MediaKind } from '@shared/types';
import { useApp, type Route } from '@/state/store';
import { Tooltip } from '@/components/Primitives';
import { CastButton } from '@/components/CastBar';
import { parseCategory } from '@/lib/catalog';
import './titlebar.css';

export const PLATFORM: 'mac' | 'win' | 'linux' =
  /Mac/i.test(navigator.userAgent) ? 'mac' : /Windows/i.test(navigator.userAgent) ? 'win' : 'linux';
export const IS_MAC = PLATFORM === 'mac';
const MOD_KEY = IS_MAC ? '⌘K' : 'Ctrl K';

function crumbsFor(
  route: Route,
  categories: Partial<Record<MediaKind, Category[]>>,
  selected: Partial<Record<MediaKind, string>>,
): string[] {
  const section = (kind: MediaKind, label: string): string[] => {
    const id = selected[kind];
    const category = id ? categories[kind]?.find((c) => c.id === id) : undefined;
    return category ? [label, parseCategory(category).label] : [label];
  };
  switch (route.view) {
    case 'live': return section('live', 'Live TV');
    case 'movies': return section('movie', 'Movies');
    case 'shows': return section('series', 'TV Shows');
    case 'guide': return ['Live TV', 'Guide'];
    case 'favourites': return ['Favourites'];
    case 'continue': return ['Continue Watching'];
    case 'search': {
      const label = route.kind === 'movie' ? 'Movies' : route.kind === 'series' ? 'TV Shows' : route.kind === 'live' ? 'Live TV' : 'Search';
      return route.query ? [label, route.query] : [label];
    }
    case 'settings': return ['Settings'];
    case 'detail': {
      const parent = route.item.kind === 'movie' ? 'Movies' : route.item.kind === 'series' ? 'TV Shows' : 'Live TV';
      return [parent, route.item.title || route.item.name];
    }
  }
}

// Caption glyphs are drawn by hand rather than taken from lucide: icon-set glyphs carry
// different amounts of padding inside their 24-unit viewBox, so at a shared `size` the square
// renders half again as large as the X. These share a 10px box, and their half-pixel
// coordinates put the 1px stroke on whole device pixels instead of a 0.625px blur.
function CaptionGlyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      aria-hidden
    >
      {children}
    </svg>
  );
}

const MinimiseGlyph = () => <CaptionGlyph><path d="M0 5.5h10" /></CaptionGlyph>;
const MaximiseGlyph = () => <CaptionGlyph><rect x="0.5" y="0.5" width="9" height="9" /></CaptionGlyph>;
const RestoreGlyph = () => (
  <CaptionGlyph>
    <rect x="0.5" y="3.5" width="6" height="6" />
    <path d="M3.5 3.5v-3h6v6h-3" />
  </CaptionGlyph>
);
const CloseGlyph = () => <CaptionGlyph><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></CaptionGlyph>;

export function WindowControls({ className = 'titlebar__controls' }: { className?: string }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.iptv.window.isMaximized().then(setMaximized).catch(() => undefined);
    return window.iptv.on('window-state', (s) => setMaximized(s.maximized));
  }, []);

  return (
    <div className={`${className} no-drag`}>
      <button className="titlebar__wc" aria-label="Minimise" onClick={() => window.iptv.window.minimize()}>
        <MinimiseGlyph />
      </button>
      <button
        className="titlebar__wc"
        aria-label={maximized ? 'Restore' : 'Maximise'}
        onClick={() => window.iptv.window.maximize()}
      >
        {maximized ? <RestoreGlyph /> : <MaximiseGlyph />}
      </button>
      <button className="titlebar__wc titlebar__wc--close" aria-label="Close" onClick={() => window.iptv.window.close()}>
        <CloseGlyph />
      </button>
    </div>
  );
}

export function TitleBar({ minimal = false }: { minimal?: boolean }) {
  const route = useApp((s) => s.route);
  const history = useApp((s) => s.history);
  const future = useApp((s) => s.future);
  const categories = useApp((s) => s.categories);
  const selected = useApp((s) => s.selectedCategory);

  const searchKind = route.view === 'movies' ? 'movie' : route.view === 'shows' ? 'series'
    : route.view === 'detail' && route.item.kind !== 'live' ? route.item.kind
    : route.view === 'search' ? route.kind : undefined;
  const searchLabel = searchKind === 'movie' ? 'Search movies' : searchKind === 'series' ? 'Search TV shows'
    : searchKind === 'live' ? 'Search Live TV' : 'Search';

  const crumbs = minimal ? [] : crumbsFor(route, categories, selected);

  // macOS toggles maximise on a drag-region double-click itself. The frame is still the system's.
  const onDoubleClick = (e: MouseEvent<HTMLElement>): void => {
    if (IS_MAC || (e.target as HTMLElement).closest('button, input, select')) return;
    window.iptv.window.maximize();
  };

  return (
    <header className="titlebar drag" data-platform={PLATFORM} onDoubleClick={onDoubleClick}>
      <div className="titlebar__start">
        {minimal ? (
          <span className="titlebar__wordmark sm t-tertiary">xiptv</span>
        ) : (
          <>
            <div className="titlebar__nav no-drag">
              <Tooltip label="Back" placement="bottom">
                <button
                  className="titlebar__step"
                  aria-label="Back"
                  disabled={!history.length}
                  onClick={() => useApp.getState().back()}
                >
                  <ChevronLeft size={16} strokeWidth={1.5} />
                </button>
              </Tooltip>
              <Tooltip label="Forward" placement="bottom">
                <button
                  className="titlebar__step"
                  aria-label="Forward"
                  disabled={!future.length}
                  onClick={() => useApp.getState().forward()}
                >
                  <ChevronRight size={16} strokeWidth={1.5} />
                </button>
              </Tooltip>
            </div>
            <nav className="titlebar__crumbs sm" aria-label="Breadcrumb">
              {crumbs.map((crumb, i) => (
                <span className="titlebar__crumb" key={`${i}-${crumb}`} data-leaf={i === crumbs.length - 1}>
                  {i > 0 && <span className="titlebar__slash" aria-hidden>/</span>}
                  <span className="truncate" dir="auto">{crumb}</span>
                </span>
              ))}
            </nav>
          </>
        )}
      </div>

      {!minimal && (
        <button
          className="titlebar__search no-drag"
          aria-label={searchLabel}
          onMouseDown={(event) => {
            // Keep the text field focused when this control is clicked from an existing search.
            // Otherwise the browser's default button focus runs after the click handler.
            if (route.view === 'search') event.preventDefault();
          }}
          onClick={() => {
            if (route.view === 'search') document.querySelector<HTMLInputElement>('.search__input')?.focus();
            else if (searchKind) useApp.getState().navigate({ view: 'search', query: '', kind: searchKind });
            else useApp.getState().patch({ paletteOpen: true });
          }}
        >
          <Search className="titlebar__search-glyph" size={15} strokeWidth={1.5} />
          <span className="titlebar__search-label sm">{searchLabel}</span>
          {!searchKind && <span className="titlebar__chip" title="Global search palette">{MOD_KEY}</span>}
        </button>
      )}

      <div className="titlebar__end">
        {!minimal && (
          <>
            <CastButton place="titlebar" />
            {!IS_MAC && <span className="titlebar__divider" aria-hidden />}
          </>
        )}
        {!IS_MAC && <WindowControls />}
      </div>
    </header>
  );
}
