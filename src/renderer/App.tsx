import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, RotateCw } from 'lucide-react';
import type { SourceStats, SyncProgress } from '@shared/types';
import { useApp, type Route } from '@/state/store';
import { classNames, errorText, isTextEntry } from '@/lib/format';
import { Button, Tally } from '@/components/Primitives';
import { TitleBar } from '@/components/TitleBar';
import { NavRail } from '@/components/NavRail';
import { ContextColumn } from '@/components/ContextColumn';
import { Toast } from '@/components/Toast';
import { CastBar } from '@/components/CastBar';
import { CommandPalette } from '@/components/CommandPalette';
import { ShaderBackdrop } from '@/components/ShaderBackdrop';
import { EpgGuide } from '@/components/EpgGuide';
import { Player } from '@/components/Player';
import { Onboarding } from '@/views/Onboarding';
import { LiveTv } from '@/views/LiveTv';
import { Movies } from '@/views/Movies';
import { Shows } from '@/views/Shows';
import { Library } from '@/views/Library';
import { Search as SearchPage } from '@/views/Search';
import { Settings } from '@/views/Settings';
import { Detail } from '@/views/Detail';
import '@/components/titlebar.css';

function viewFor(route: Route): ReactNode {
  switch (route.view) {
    case 'live': return <LiveTv />;
    case 'movies': return <Movies />;
    case 'shows': return <Shows />;
    case 'favourites':
    case 'continue': return <Library />;
    case 'search': return <SearchPage />;
    case 'settings': return <Settings />;
    case 'detail': return <Detail />;
    case 'guide': return <EpgGuide />;
  }
}

function contentKey(route: Route): string {
  return route.view === 'detail' ? `detail:${route.item.id}` : route.view;
}

const CONTEXT_ROUTES = new Set<Route['view']>(['live', 'movies', 'shows']);

function useBootstrap(): void {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [settings, sources, favourites] = await Promise.all([
        window.iptv.settings.get().catch(() => useApp.getState().settings),
        window.iptv.sources.list().catch(() => []),
        window.iptv.library.favourites().catch(() => []),
      ]);
      if (cancelled) return;
      const active = sources.find((s) => s.id === settings.activeSourceId)?.id ?? sources[0]?.id;
      useApp.getState().patch({ settings, sources, activeSourceId: active, favourites, ready: true });
    })();
    return () => { cancelled = true; };
  }, []);
}

function useMainEvents(): void {
  useEffect(() => {
    const app = useApp.getState();
    const offCast = window.iptv.on('cast-status', (cast) => app.patch({ cast }));
    const offSync = window.iptv.on('sync-progress', (sync) => app.patch({ sync }));
    const offWindow = window.iptv.on('window-state', ({ maximized, fullscreen }) => {
      document.documentElement.dataset.maximized = String(maximized);
      document.documentElement.dataset.fullscreen = String(fullscreen);
    });
    return () => { offCast(); offSync(); offWindow(); };
  }, []);
}

/**
 * Writes the character through the prototype setter React patches over on the node, then
 * dispatches the event the browser would have sent. React tracks input values itself and
 * ignores a plain `el.value = x`.
 */
function seedPalette(char: string): void {
  requestAnimationFrame(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLInputElement) || el.value !== '') return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, char);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const RESERVED: Partial<Record<Route['view'], RegExp>> = { live: /^[0-9gGtTiI/[\]]$/ };

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const app = useApp.getState();
      const mod = e.metaKey || e.ctrlKey;
      const claim = (): void => { e.preventDefault(); e.stopPropagation(); };

      if (mod && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'k') { claim(); app.patch({ paletteOpen: !app.paletteOpen }); return; }
        if (key === 'b') { claim(); app.patch({ contextHidden: !app.contextHidden }); return; }
      }
      if (e.altKey && e.key === 'ArrowLeft') { claim(); app.back(); return; }
      if (e.altKey && e.key === 'ArrowRight') { claim(); app.forward(); return; }

      if (e.key === 'Escape') {
        if (app.paletteOpen) { claim(); app.patch({ paletteOpen: false }); return; }
        if (app.castPanelOpen) { claim(); app.patch({ castPanelOpen: false }); return; }
        return;
      }

      if (mod || e.altKey || app.paletteOpen || app.nowPlaying) return;
      if (e.key.length !== 1 || e.key === ' ' || isTextEntry(document.activeElement) || document.activeElement?.tagName === 'SELECT') return;
      if (RESERVED[app.route.view]?.test(e.key)) return;
      claim();
      app.patch({ paletteOpen: true });
      seedPalette(e.key);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

const LEDGER: Array<{ phase: SyncProgress['phase']; label: string }> = [
  { phase: 'categories', label: 'Categories' },
  { phase: 'live', label: 'Channels' },
  { phase: 'movies', label: 'Movies' },
  { phase: 'series', label: 'Series' },
  { phase: 'epg', label: 'Guide' },
];

function SyncLedger() {
  const sync = useApp((s) => s.sync);
  const sources = useApp((s) => s.sources);
  const activeSourceId = useApp((s) => s.activeSourceId);
  const source = sources.find((s) => s.id === activeSourceId) ?? sources[0];
  const [stats, setStats] = useState<SourceStats>();
  const lastPhase = useRef<SyncProgress['phase']>('categories');

  const phase = sync?.phase ?? 'categories';
  const failed = phase === 'error';

  useEffect(() => {
    if (phase !== 'error' && phase !== 'idle' && phase !== 'done') lastPhase.current = phase;
  }, [phase]);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    window.iptv.catalog.stats(source.id)
      .then((s) => { if (alive) setStats(s); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [source, phase]);

  const at = failed ? lastPhase.current : phase;
  const cursor = phase === 'done' ? LEDGER.length : Math.max(0, LEDGER.findIndex((r) => r.phase === at));

  const retry = (): void => {
    if (!source) return;
    void window.iptv.catalog.refresh(source.id).catch((err: unknown) => {
      useApp.getState().toast$(errorText(err, 'Could not reach the provider.'), 'error');
    });
  };

  return (
    <div className="ledger">
      <h1 className="h1">Reading your provider</h1>
      {source && <p className="ledger__source t-secondary">{source.name}</p>}

      <ol className="ledger__rows">
        {LEDGER.map((row, i) => {
          const state = i < cursor ? 'done' : i === cursor ? (failed ? 'error' : 'active') : 'pending';
          return (
            <li key={row.phase} className="ledger__row" data-state={state}>
              <span className="ledger__label">{row.label}</span>
              <span className="ledger__state">
                {state === 'pending' && <span className="ledger__pending">····</span>}
                {state === 'error' && <span className="ledger__failed">Failed</span>}
                {state === 'active' && (
                  <span className="ledger__track" data-indeterminate={sync?.progress == null}>
                    <span
                      className="ledger__bar"
                      style={sync?.progress != null ? { transform: `scaleX(${sync.progress})` } : undefined}
                    >
                      <Tally orientation="horizontal" />
                    </span>
                  </span>
                )}
                {state === 'done' && (
                  <span className="ledger__done">
                    <Check size={12} strokeWidth={2} />
                    {ledgerCount(row.phase, stats)}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="ledger__message sm t-tertiary">{sync?.message ?? 'Contacting the provider…'}</p>

      {failed && (
        <>
          <p className="ledger__error">{sync?.error ?? 'The provider refused the request.'}</p>
          <div className="ledger__actions">
            <Button variant="primary" onClick={retry}><RotateCw size={14} strokeWidth={1.5} />Retry</Button>
            <Button variant="ghost" onClick={() => useApp.getState().navigate({ view: 'settings' })}>Edit source</Button>
          </div>
        </>
      )}
    </div>
  );
}

function ledgerCount(phase: SyncProgress['phase'], stats?: SourceStats): string | undefined {
  if (!stats) return undefined;
  if (phase === 'categories') return (stats.liveCategories + stats.movieCategories + stats.seriesCategories).toLocaleString();
  if (phase === 'epg') return stats.epgProgrammes.toLocaleString();
  return undefined;
}

export function App() {
  const ready = useApp((s) => s.ready);
  const sources = useApp((s) => s.sources);
  const activeSourceId = useApp((s) => s.activeSourceId);
  const route = useApp((s) => s.route);
  const categories = useApp((s) => s.categories);
  const sync = useApp((s) => s.sync);
  const contextHidden = useApp((s) => s.contextHidden);
  const paletteOpen = useApp((s) => s.paletteOpen);
  const nowPlaying = useApp((s) => s.nowPlaying);
  const casting = useApp((s) => s.cast.connected);
  const accelerated = useApp((s) => s.settings.hardwareAcceleration);

  useBootstrap();
  useMainEvents();
  useShortcuts();

  const [synced, setSynced] = useState<boolean>();
  useEffect(() => {
    if (!activeSourceId) return;
    let alive = true;
    window.iptv.catalog.stats(activeSourceId)
      .then((s) => { if (alive) setSynced(Boolean(s.lastSync)); })
      .catch(() => { if (alive) setSynced(false); });
    return () => { alive = false; };
  }, [activeSourceId]);

  const catalogueEmpty = !categories.live?.length && !categories.movie?.length && !categories.series?.length;
  const running = !!sync && sync.phase !== 'idle' && sync.phase !== 'done' && sync.phase !== 'epg';
  const firstRun = running && catalogueEmpty && synced === false;

  if (!ready) {
    return (
      <div className="shell shell--bare">
        <TitleBar minimal />
        <div className="shell__bare-body" />
      </div>
    );
  }

  if (!sources.length || firstRun) {
    return (
      <div
        className={classNames(
          'shell shell--bare',
          accelerated && 'shell--shader',
          !sources.length && 'shell--onboard',
        )}
      >
        <ShaderBackdrop />
        <TitleBar minimal />
        <div className="shell__bare-body">{sources.length ? <SyncLedger /> : <Onboarding />}</div>
        <Toast />
      </div>
    );
  }

  const showContext = !contextHidden && CONTEXT_ROUTES.has(route.view);

  return (
    <div
      className={classNames('shell', accelerated && 'shell--shader')}
      data-castbar={casting}
      data-playing={!!nowPlaying}
    >
      <ShaderBackdrop />
      <TitleBar />
      <div className="shell__body">
        <NavRail />
        {showContext && <ContextColumn />}
        <main className="shell__content" key={contentKey(route)}>{viewFor(route)}</main>
      </div>
      <CastBar />
      {nowPlaying && <Player />}
      {paletteOpen && <CommandPalette />}
      <Toast />
    </div>
  );
}
