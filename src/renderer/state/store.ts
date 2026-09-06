import { create } from 'zustand';
import type {
  Source, MediaKind, MediaItem, Category, Settings, CastStatus, SyncProgress, ResolvedStream,
} from '@shared/types';
import type { Facets, SortKey } from '@/lib/catalog';
import { EMPTY_FACETS } from '@/lib/catalog';

export type Route =
  | { view: 'live' }
  | { view: 'movies' }
  | { view: 'shows' }
  | { view: 'favourites' }
  | { view: 'continue' }
  | { view: 'search'; query: string }
  | { view: 'settings' }
  | { view: 'detail'; item: MediaItem }
  | { view: 'guide' };

export interface NowPlaying {
  stream: ResolvedStream;
  item: MediaItem;
  episodeId?: string;
  startAt?: number;
}

interface AppState {
  ready: boolean;
  sources: Source[];
  activeSourceId?: string;
  settings: Settings;

  route: Route;
  history: Route[];
  future: Route[];

  selectedCategory: Partial<Record<MediaKind, string>>;
  categories: Partial<Record<MediaKind, Category[]>>;
  items: MediaItem[];
  itemsLoading: boolean;
  itemsError?: string;

  facets: Facets;
  sort: SortKey;
  categoryFilter: string;

  contextHidden: boolean;
  paletteOpen: boolean;

  sync?: SyncProgress;
  cast: CastStatus;
  castPanelOpen: boolean;
  nowPlaying?: NowPlaying;
  toast?: { message: string; tone: 'info' | 'error' };

  favourites: MediaItem[];

  navigate(route: Route): void;
  back(): void;
  forward(): void;
  patch(partial: Partial<AppState>): void;
  toast$(message: string, tone?: 'info' | 'error'): void;
}

const DEFAULT_SETTINGS: Settings = {
  liveFormat: 'ts',
  hardwareAcceleration: true,
  epgAutoRefreshHours: 12,
  epgFill: { auto: true, enabled: [], disabled: [] },
};

const IDLE_CAST: CastStatus = {
  connected: false, state: 'IDLE', currentTime: 0, volume: 1, muted: false,
};

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  sources: [],
  settings: DEFAULT_SETTINGS,

  route: { view: 'live' },
  history: [],
  future: [],

  selectedCategory: {},
  categories: {},
  items: [],
  itemsLoading: false,

  facets: EMPTY_FACETS,
  sort: 'provider',
  categoryFilter: '',

  contextHidden: false,
  paletteOpen: false,

  cast: IDLE_CAST,
  castPanelOpen: false,
  favourites: [],

  navigate(route) {
    const { route: current, history } = get();
    if (current.view === route.view && JSON.stringify(current) === JSON.stringify(route)) return;
    set({ route, history: [...history, current].slice(-40), future: [] });
  },
  back() {
    const { history, route, future } = get();
    if (!history.length) return;
    set({ route: history[history.length - 1], history: history.slice(0, -1), future: [route, ...future].slice(0, 40) });
  },
  forward() {
    const { future, route, history } = get();
    if (!future.length) return;
    set({ route: future[0], future: future.slice(1), history: [...history, route] });
  },
  patch: (partial) => set(partial),
  toast$: (message, tone = 'info') => {
    set({ toast: { message, tone } });
    setTimeout(() => {
      if (get().toast?.message === message) set({ toast: undefined });
    }, tone === 'error' ? 6000 : 3200);
  },
}));

function pickActive(sources: Source[], activeSourceId?: string): Source | undefined {
  return sources.find((s) => s.id === activeSourceId) ?? sources[0];
}

export function activeSource(): Source | undefined {
  const { sources, activeSourceId } = useApp.getState();
  return pickActive(sources, activeSourceId);
}

export function useActiveSource(): Source | undefined {
  return useApp((s) => pickActive(s.sources, s.activeSourceId));
}
