import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react';
import {
  CalendarClock, Copy, ExternalLink, Link2, MoreHorizontal, Play, Rows3, Star, TriangleAlert, Tv,
} from 'lucide-react';
import type { Category, EpgChannelOption, EpgProgramme, MediaItem, WatchProgress } from '@shared/types';
import { useApp } from '@/state/store';
import { VList } from '@/lib/virtual';
import { useTokenPx } from '@/lib/metrics';
import { groupVariants, parseCategory, qualityTag, withoutQuality, type VariantGroup } from '@/lib/catalog';
import {
  Absence, Button, CategoryLabel, EmptyState, LogoPlate, Skeleton, TruncateTail,
} from '@/components/Primitives';
import {
  classNames, debounce, formatClock, formatDayLabel, isTextEntry, progressThrough,
  readStringList, useNowSeconds, writeStringList,
} from '@/lib/format';
import { EpgGuide } from '@/components/EpgGuide';
import { useUiPrefs } from '@/views/Settings';
import './live.css';

const EPG_BEHIND = 30 * 60;
const EPG_AHEAD = 6 * 3600;
const EPG_OVERSCAN = 6;
const RECENTS_KEY = 'xiptv.live.recent-categories';

function nowNextFrom(list: EpgProgramme[], now: number): { now?: EpgProgramme; next?: EpgProgramme } {
  let current: EpgProgramme | undefined;
  let upcoming: EpgProgramme | undefined;
  for (const p of list) {
    if (p.start <= now && p.stop > now) current = p;
    else if (p.start > now && (!upcoming || p.start < upcoming.start)) upcoming = p;
  }
  return { now: current, next: upcoming };
}

function remainingLabel(stop: number, now: number): string {
  const mins = Math.max(0, Math.round((stop - now) / 60));
  if (mins < 60) return `${mins}m left`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m left`;
}

let liveLoadedKey: string | null = null;

interface RowModel {
  key: string;
  item: MediaItem;
  group: VariantGroup;
  variantIndex: number;
}

export function LiveTv() {
  const route = useApp((s) => s.route);
  const sourceId = useApp((s) => s.activeSourceId ?? s.sources[0]?.id);
  const items = useApp((s) => s.items);
  const itemsLoading = useApp((s) => s.itemsLoading);
  const itemsError = useApp((s) => s.itemsError);
  const categories = useApp((s) => s.categories.live);
  const selectedId = useApp((s) => s.selectedCategory.live);
  const nowPlaying = useApp((s) => s.nowPlaying);
  const favourites = useApp((s) => s.favourites);

  const rowH = useTokenPx('--row-h', 56);
  const [mode, setMode] = useState<'list' | 'guide'>(route.view === 'guide' ? 'guide' : 'list');
  const collapseDuplicates = useUiPrefs().collapseDuplicates;
  const [collapse, setCollapse] = useState(collapseDuplicates);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [focus, setFocus] = useState(0);
  const [focusRing, setFocusRing] = useState(false);
  const [scrollTarget, setScrollTarget] = useState(-1);
  const [tuning, setTuning] = useState<string>();
  const [failures, setFailures] = useState<Record<string, true>>({});
  const [menu, setMenu] = useState<{ row: RowModel; x: number; y: number }>();
  const [guidePick, setGuidePick] = useState<MediaItem>();
  const [digits, setDigits] = useState('');
  const now = useNowSeconds(30_000);

  useEffect(() => { if (route.view === 'guide') setMode('guide'); }, [route.view]);
  useEffect(() => setCollapse(collapseDuplicates), [collapseDuplicates]);

  const category = useMemo(
    () => categories?.find((c) => c.id === selectedId),
    [categories, selectedId],
  );

  const channels = useMemo(() => {
    const live = items.filter((i) => i.kind === 'live');
    return selectedId ? live.filter((i) => i.categoryId === selectedId) : live;
  }, [items, selectedId]);

  const groups = useMemo<VariantGroup[]>(
    () => (collapse
      ? groupVariants(channels)
      : channels.map((item) => ({ item, variants: [item], labels: [] }))),
    [channels, collapse],
  );

  const rows = useMemo<RowModel[]>(() => {
    const out: RowModel[] = [];
    for (const group of groups) {
      const key = group.item.id;
      if (group.variants.length > 1 && expanded.has(key)) {
        group.variants.forEach((item, i) => out.push({ key: `${key}#${i}`, item, group, variantIndex: i }));
      } else {
        out.push({ key, item: group.variants[chosen[key] ?? 0] ?? group.item, group, variantIndex: -1 });
      }
    }
    return out;
  }, [groups, expanded, chosen]);

  const guideChannels = useMemo(() => rows.map((r) => r.item), [rows]);

  const rowsRef = useRef(rows);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  const [reload, setReload] = useState(0);
  useLayoutEffect(() => {
    if (!sourceId || !selectedId) return;
    const key = `${sourceId}:${selectedId}:${reload}`;
    const current = useApp.getState().items;
    const holdsIt = current.length > 0 && current[0].kind === 'live' && current[0].categoryId === selectedId;
    if (holdsIt) return;
    if (liveLoadedKey === key && useApp.getState().itemsLoading) return;
    liveLoadedKey = key;
    useApp.getState().patch({ items: [], itemsLoading: true, itemsError: undefined });
    window.iptv.catalog.items(sourceId, 'live', selectedId)
      .then((list) => {
        const app = useApp.getState();
        if (app.selectedCategory.live !== selectedId) return;
        app.patch({ items: list, itemsLoading: false, itemsError: undefined });
      })
      .catch(() => {
        liveLoadedKey = null;
        const app = useApp.getState();
        if (app.selectedCategory.live !== selectedId) return;
        app.patch({ items: [], itemsLoading: false, itemsError: 'The provider did not answer.' });
      });
  }, [sourceId, selectedId, reload]);

  useEffect(() => {
    if (!selectedId) return;
    const next = [selectedId, ...readStringList(RECENTS_KEY).filter((id) => id !== selectedId)].slice(0, 6);
    writeStringList(RECENTS_KEY, next);
  }, [selectedId]);

  const [epg, setEpg] = useState<Record<string, EpgProgramme[]>>({});
  const requested = useRef(new Set<string>());
  const visible = useRef(new Set<number>());
  const epgWindow = useRef({ from: 0, to: 0 });

  useEffect(() => {
    requested.current.clear();
    visible.current.clear();
    setEpg({});
    epgWindow.current = { from: 0, to: 0 };
  }, [sourceId, selectedId]);

  const pump = useMemo(() => debounce(() => {
    const src = useApp.getState().activeSourceId ?? useApp.getState().sources[0]?.id;
    if (!src || !visible.current.size) return;
    const list = rowsRef.current;
    let lo = Number.POSITIVE_INFINITY;
    let hi = -1;
    for (const i of visible.current) { if (i < lo) lo = i; if (i > hi) hi = i; }
    lo = Math.max(0, lo - EPG_OVERSCAN);
    hi = Math.min(list.length - 1, hi + EPG_OVERSCAN);

    const clock = Math.floor(Date.now() / 1000);
    if (clock > epgWindow.current.to - 3600) {
      epgWindow.current = { from: clock - EPG_BEHIND, to: clock + EPG_AHEAD };
      requested.current.clear();
      setEpg({});
    }
    const ids: string[] = [];
    for (let i = lo; i <= hi; i++) {
      const id = list[i]?.item.epgChannelId;
      if (id && !requested.current.has(id)) { requested.current.add(id); ids.push(id); }
    }
    if (!ids.length) return;
    const { from, to } = epgWindow.current;
    window.iptv.epg.grid(src, ids, from, to).then((grid) => {
      setEpg((prev) => {
        const next = { ...prev };
        for (const id of ids) next[id] = (grid[id] ?? []).slice().sort((a, b) => a.start - b.start);
        return next;
      });
    }).catch(() => {
      setEpg((prev) => {
        const next = { ...prev };
        for (const id of ids) if (!next[id]) next[id] = [];
        return next;
      });
    });
  }, 120), []);

  const register = useCallback((index: number) => {
    visible.current.add(index);
    pump();
    return () => { visible.current.delete(index); };
  }, [pump]);

  const play = useCallback(async (item: MediaItem) => {
    if (!sourceId) return;
    setTuning(item.id);
    try {
      const stream = await window.iptv.player.resolve({ sourceId, itemId: item.id });
      setFailures((f) => {
        if (!f[item.id]) return f;
        const next = { ...f };
        delete next[item.id];
        return next;
      });
      useApp.getState().patch({ nowPlaying: { stream, item } });
    } catch {
      setFailures((f) => ({ ...f, [item.id]: true }));
    } finally {
      setTuning((current) => (current === item.id ? undefined : current));
    }
  }, [sourceId]);

  const openExternal = useCallback(async (item: MediaItem) => {
    if (!sourceId) return;
    try {
      const stream = await window.iptv.player.resolve({ sourceId, itemId: item.id });
      await window.iptv.player.openExternal(stream.directUrl);
    } catch {
      useApp.getState().toast$('That channel did not respond.', 'error');
    }
  }, [sourceId]);

  const copyUrl = useCallback(async (item: MediaItem) => {
    if (!sourceId) return;
    try {
      const stream = await window.iptv.player.resolve({ sourceId, itemId: item.id });
      await navigator.clipboard.writeText(stream.directUrl);
      useApp.getState().toast$('Stream URL copied.');
    } catch {
      useApp.getState().toast$('That channel did not respond.', 'error');
    }
  }, [sourceId]);

  const toggleFavourite = useCallback(async (item: MediaItem) => {
    await window.iptv.library.toggleFavourite(item);
    const list = await window.iptv.library.favourites();
    useApp.getState().patch({ favourites: list });
  }, []);

  const expand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const chooseVariant = useCallback((key: string, index: number) => {
    setChosen((prev) => ({ ...prev, [key]: index }));
  }, []);

  const focusRow = useCallback((index: number) => { setFocus(index); setFocusRing(false); }, []);
  const rootRef = useRef<HTMLDivElement>(null);
  const openMenu = useCallback((row: RowModel, anchor: DOMRect) => {
    const box = rootRef.current?.getBoundingClientRect();
    setMenu({ row, x: anchor.right - (box?.left ?? 0), y: anchor.bottom - (box?.top ?? 0) + 4 });
  }, []);

  const digitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(digitTimer.current), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTextEntry(e.target as Element | null)) return;
      const app = useApp.getState();
      if (app.paletteOpen || app.nowPlaying) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        setMode((m) => (m === 'list' ? 'guide' : 'list'));
        return;
      }
      if (mode !== 'list') return;

      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        setDigits((d) => (d + e.key).slice(0, 4));
        clearTimeout(digitTimer.current);
        digitTimer.current = setTimeout(() => setDigits(''), 1200);
        return;
      }
      if (e.key === 'Enter' && digits) {
        e.preventDefault();
        const index = Math.min(Math.max(1, Number(digits)), rowsRef.current.length) - 1;
        setDigits('');
        clearTimeout(digitTimer.current);
        setFocus(index);
        setFocusRing(true);
        setScrollTarget(index);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = Math.min(Math.max(0, focus + (e.key === 'ArrowDown' ? 1 : -1)), rowsRef.current.length - 1);
        setFocusRing(true);
        setFocus(next);
        setScrollTarget(next);
        return;
      }
      if (e.key === 'Enter') {
        const row = rowsRef.current[focus];
        if (row) { e.preventDefault(); void play(row.item); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, digits, focus, play]);

  const favouriteIds = useMemo(() => new Set(favourites.map((f) => f.id)), [favourites]);
  const focusedRow: RowModel | undefined = rows[focus];
  const playingId = nowPlaying?.item.kind === 'live' ? nowPlaying.item.id : undefined;

  const folded = channels.length - rows.length;
  const header = (
    <header className="live__header">
      <div className="live__heading">
        <h1 className="h1 truncate">Live TV</h1>
        <div className="live__count">
          {category ? <CategoryLabel category={category} /> : <span>All categories</span>}
          {selectedId && (
            <>
              <span className="live__dot-sep">·</span>
              <span className="data">{rows.length.toLocaleString()} channels</span>
            </>
          )}
          {folded > 0 && (
            <>
              <span className="live__dot-sep">·</span>
              <span className="data">{folded.toLocaleString()} folded</span>
            </>
          )}
        </div>
      </div>

      <div className="live__tools">
        <button
          type="button"
          className={classNames('live__switch', collapse && 'is-on')}
          aria-pressed={collapse}
          onClick={() => setCollapse((c) => !c)}
        >
          <span className="live__switch-track"><span className="live__switch-knob" /></span>
          <span className="sm">Collapse duplicates</span>
        </button>

        <div className="live__seg" role="tablist" aria-label="Live TV layout">
          <button
            type="button" role="tab" aria-selected={mode === 'list'}
            className={classNames('live__seg-btn', mode === 'list' && 'is-on')}
            onClick={() => setMode('list')}
          >
            <Rows3 size={15} strokeWidth={1.5} />List
          </button>
          <button
            type="button" role="tab" aria-selected={mode === 'guide'}
            className={classNames('live__seg-btn', mode === 'guide' && 'is-on')}
            onClick={() => setMode('guide')}
          >
            <CalendarClock size={15} strokeWidth={1.5} />Guide
          </button>
        </div>
      </div>
    </header>
  );

  if (!selectedId) {
    return (
      <div className="live">
        <div className="live__main">
          {header}
          <LiveLanding categories={categories} onPlay={play} />
        </div>
      </div>
    );
  }

  if (mode === 'guide') {
    return (
      <div className="live live--guide">
        <div className="live__main">
          {header}
          <EpgGuide
            channels={guideChannels}
            categoryName={category ? parseCategory(category).label : 'All live channels'}
            onTune={play}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="live" ref={rootRef}>
      <div className="live__main">
        {header}

        {itemsError ? (
          <EmptyState
            glyph={<TriangleAlert size={24} strokeWidth={1.5} />}
            title="That category did not load"
            body="The provider answered, but not with a channel list. It is usually a timeout on their side rather than anything wrong with your subscription."
            action={<Button variant="ghost" onClick={() => { useApp.getState().patch({ itemsError: undefined }); setReload((n) => n + 1); }}>Try again</Button>}
          />
        ) : itemsLoading && !rows.length ? (
          <SkeletonList rowHeight={rowH} />
        ) : !rows.length ? (
          <EmptyState
            glyph={<Tv size={24} strokeWidth={1.5} />}
            title="Nothing in this category"
            body="The provider lists it but ships no channels inside it. That happens more often than it should. Pick another category on the left."
            action={<Button variant="ghost" onClick={() => setReload((n) => n + 1)}>Reload category</Button>}
          />
        ) : (
          <div className="live__listwrap">
            <VList
              className="live__list"
              count={rows.length}
              rowHeight={rowH}
              scrollToIndex={scrollTarget}
            >
              {(index) => {
                const row = rows[index];
                const id = row.item.epgChannelId;
                return (
                  <ChannelRow
                    index={index}
                    row={row}
                    programmes={id ? epg[id] : undefined}
                    now={now}
                    playing={row.item.id === playingId}
                    focused={index === focus && focusRing}
                    failed={Boolean(failures[row.item.id])}
                    favourite={favouriteIds.has(row.item.id)}
                    register={register}
                    onPlay={play}
                    onFocus={focusRow}
                    onExpand={expand}
                    onFavourite={toggleFavourite}
                    onMenu={openMenu}
                  />
                );
              }}
            </VList>
            {digits && (
              <div className="live__tunein" aria-live="polite">
                <span className="live__tunein-digits">{digits}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {focusedRow && (
        <PreviewPanel
          row={focusedRow}
          programmes={focusedRow.item.epgChannelId ? epg[focusedRow.item.epgChannelId] : undefined}
          now={now}
          tuning={tuning === focusedRow.item.id}
          failed={Boolean(failures[focusedRow.item.id])}
          playing={focusedRow.item.id === playingId}
          favourite={favouriteIds.has(focusedRow.item.id)}
          onPlay={play}
          onExternal={openExternal}
          onFavourite={toggleFavourite}
          onVariant={chooseVariant}
        />
      )}

      {menu && (
        <RowMenu
          row={menu.row}
          x={menu.x}
          y={menu.y}
          favourite={favouriteIds.has(menu.row.item.id)}
          onClose={() => setMenu(undefined)}
          onPlay={play}
          onExternal={openExternal}
          onCopyUrl={copyUrl}
          onFavourite={toggleFavourite}
          onGuide={setGuidePick}
        />
      )}

      {guidePick && sourceId && (
        <GuidePicker
          sourceId={sourceId}
          item={guidePick}
          onClose={() => setGuidePick(undefined)}
          onDone={() => {
            setGuidePick(undefined);
            useApp.getState().patch({ items: [] });
            setReload((r) => r + 1);
          }}
        />
      )}
    </div>
  );
}

/** Pins a channel to a guide channel by hand, for names no alias or fuzzy match gets right. */
function GuidePicker({ sourceId, item, onClose, onDone }: {
  sourceId: string; item: MediaItem; onClose: () => void; onDone: () => void;
}) {
  const [query, setQuery] = useState(item.title || item.name);
  const [options, setOptions] = useState<EpgChannelOption[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const q = query.trim();
    if (q.length < 2) { setOptions([]); return; }
    const t = setTimeout(() => {
      window.iptv.epg.channels(sourceId, q)
        .then((list) => { if (live) setOptions(list); })
        .catch(() => { if (live) setOptions([]); });
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [sourceId, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choose = async (channelId: string | null): Promise<void> => {
    setBusy(true);
    try {
      await window.iptv.epg.setOverride(sourceId, item.id, channelId);
      useApp.getState().toast$(channelId ? 'Guide channel set.' : 'Back to the automatic match.');
      onDone();
    } catch (err) {
      useApp.getState().toast$(err instanceof Error ? err.message : 'Could not save that.', 'error');
      setBusy(false);
    }
  };

  return (
    <div className="live__picker-veil" onPointerDown={onClose}>
      <div className="live__picker" role="dialog" aria-label="Set guide channel" onPointerDown={(e) => e.stopPropagation()}>
        <span className="sm t-tertiary">Guide channel for</span>
        <span className="live__picker-name h2 truncate" dir="auto">{item.title || item.name}</span>
        <input
          className="live__picker-input"
          value={query}
          autoFocus
          placeholder="Search the guide by channel name"
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul className="live__picker-list">
          {options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                className={classNames('live__picker-opt', o.id === item.epgChannelId && 'live__picker-opt--on')}
                disabled={busy}
                onClick={() => void choose(o.id)}
              >
                <span className="live__picker-opt-name truncate" dir="auto">{o.name}</span>
                <span className="live__picker-opt-meta sm t-tertiary truncate">{o.feed} · {o.id}</span>
              </button>
            </li>
          ))}
          {options.length === 0 && query.trim().length >= 2 && (
            <li className="live__picker-empty sm t-tertiary">No guide channel matches that name.</li>
          )}
        </ul>
        <div className="live__picker-acts">
          <Button variant="plain" disabled={busy} onClick={() => void choose(null)}>Use automatic match</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  index: number;
  row: RowModel;
  programmes?: EpgProgramme[];
  now: number;
  playing: boolean;
  focused: boolean;
  failed: boolean;
  favourite: boolean;
  register: (index: number) => () => void;
  onPlay: (item: MediaItem) => void;
  onFocus: (index: number) => void;
  onExpand: (key: string) => void;
  onFavourite: (item: MediaItem) => void;
  onMenu: (row: RowModel, anchor: DOMRect) => void;
}

const ChannelRow = memo(function ChannelRow(p: RowProps) {
  useEffect(() => p.register(p.index), [p.index, p.register]);

  const item = p.row.item;
  const hasEpgId = Boolean(item.epgChannelId);
  const loading = hasEpgId && p.programmes === undefined;
  const nn = useMemo(
    () => (p.programmes ? nowNextFrom(p.programmes, p.now) : undefined),
    [p.programmes, p.now],
  );
  const quality = useMemo(() => qualityTag(item.name), [item.name]);
  const label = useMemo(() => withoutQuality(item.title || item.name, quality), [item.title, item.name, quality]);
  const current = nn?.now;
  const variants = p.row.group.variants;

  return (
    <div
      className="live__row"
      data-playing={p.playing || undefined}
      data-focused={p.focused || undefined}
      data-failed={p.failed || undefined}
      role="button"
      tabIndex={-1}
      onClick={(e) => {
        p.onFocus(p.index);
        if (e.altKey && variants.length > 1) p.onExpand(p.row.group.item.id);
        else p.onPlay(item);
      }}
    >
      <LogoPlate item={item} size="row" className="live__plate" />

      <div className="live__name">
        <span className="live__nameline">
          {p.failed && <span className="live__warn" aria-label="Recently failed" />}
          <TruncateTail text={label} className="live__title" />
          {quality && <span className="live__q">{quality}</span>}
        </span>

        {current ? (
          <span className="live__prog truncate" dir="auto">{current.title}</span>
        ) : loading ? (
          <span className="live__prog"><Skeleton width={90} height={10} radius={2} style={{ marginTop: 4 }} /></span>
        ) : (
          <span className="live__prog live__prog--none">No guide data</span>
        )}

        {current && (
          <span className="live__bar" aria-hidden>
            <span
              className="live__bar-fill"
              style={{ width: `${progressThrough(current.start, current.stop, p.now) * 100}%` }}
            />
          </span>
        )}
      </div>

      <div className="live__right">
        <span className={classNames('live__times data', !current && 'live__times--empty')}>
          {current ? `${formatClock(current.start)} – ${formatClock(current.stop)}` : '–'}
        </span>

        <span className="live__acts">
          <button
            type="button"
            className={classNames('live__act', p.favourite && 'is-on')}
            aria-label={p.favourite ? 'Remove from favourites' : 'Add to favourites'}
            onClick={(e) => { e.stopPropagation(); p.onFavourite(item); }}
          >
            <Star size={16} strokeWidth={1.5} fill={p.favourite ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            className="live__act"
            aria-label="More actions"
            onClick={(e) => { e.stopPropagation(); p.onMenu(p.row, e.currentTarget.getBoundingClientRect()); }}
          >
            <MoreHorizontal size={16} strokeWidth={1.5} />
          </button>
        </span>
      </div>
    </div>
  );
});

function RowMenu({
  row, x, y, favourite, onClose, onPlay, onExternal, onCopyUrl, onFavourite, onGuide,
}: {
  row: RowModel; x: number; y: number; favourite: boolean; onClose: () => void;
  onPlay: (i: MediaItem) => void; onExternal: (i: MediaItem) => void;
  onCopyUrl: (i: MediaItem) => void; onFavourite: (i: MediaItem) => void;
  onGuide: (i: MediaItem) => void;
}) {
  useEffect(() => {
    const close = (): void => onClose();
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const item = row.item;
  const run = (fn: (i: MediaItem) => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(item); onClose(); };

  return (
    <div
      className="live__menu"
      style={{ insetInlineStart: Math.max(8, x - 232), top: y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button type="button" className="live__menu-item sm" onClick={run(onPlay)}><Play size={14} strokeWidth={1.5} />Play</button>
      <button type="button" className="live__menu-item sm" onClick={run(onExternal)}><ExternalLink size={14} strokeWidth={1.5} />Open in external player</button>
      <span className="live__menu-rule" />
      <button type="button" className="live__menu-item sm" onClick={run(onFavourite)}>
        <Star size={14} strokeWidth={1.5} />{favourite ? 'Remove from favourites' : 'Add to favourites'}
      </button>
      <button type="button" className="live__menu-item sm" onClick={run(onGuide)}><Link2 size={14} strokeWidth={1.5} />Set guide channel…</button>
      <button type="button" className="live__menu-item sm" onClick={run(onCopyUrl)}><Copy size={14} strokeWidth={1.5} />Copy stream URL</button>
      <button
        type="button" className="live__menu-item sm"
        onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(item.name); useApp.getState().toast$('Raw name copied.'); onClose(); }}
      >
        <Copy size={14} strokeWidth={1.5} />Copy raw name
      </button>
      <span className="live__menu-rule" />
      <span className="live__menu-raw sm" dir="auto">{item.name}</span>
    </div>
  );
}

function PreviewPanel({
  row, programmes, now, tuning, failed, playing, favourite, onPlay, onExternal, onFavourite, onVariant,
}: {
  row: RowModel; programmes?: EpgProgramme[]; now: number; tuning: boolean; failed: boolean;
  playing: boolean; favourite: boolean;
  onPlay: (i: MediaItem) => void; onExternal: (i: MediaItem) => void;
  onFavourite: (i: MediaItem) => void; onVariant: (key: string, index: number) => void;
}) {
  const item = row.item;
  const nn = programmes ? nowNextFrom(programmes, now) : undefined;
  const current = nn?.now;
  const siblings = row.group.variants;
  const alt = siblings.findIndex((v) => v.id !== item.id);

  return (
    <aside className="live__preview">
      <span className="live__preview-kicker">{playing ? 'Playing now' : failed ? 'Last attempt' : 'Selected'}</span>

      <div className="live__preview-head">
        <LogoPlate item={item} size="large" />
        <div className="live__preview-id">
          <TruncateTail text={withoutQuality(item.title || item.name, qualityTag(item.name))} className="h2" />
          <span className="live__preview-raw sm t-tertiary truncate" dir="auto">{item.name}</span>
        </div>
      </div>

      {siblings.length > 1 && (
        <div className="live__preview-feeds">
          <span className="live__preview-kicker">Feeds</span>
          <span className="live__pills">
            {siblings.map((v, i) => (
              <button
                key={v.id}
                type="button"
                className={classNames('live__pill', v.id === item.id && 'is-on')}
                onClick={() => onVariant(row.key, i)}
              >
                {row.group.labels[i] || '·'}
              </button>
            ))}
          </span>
        </div>
      )}

      {failed ? (
        <div className="live__fail">
          <TriangleAlert size={20} strokeWidth={1.5} className="live__fail-glyph" />
          <h2 className="h2">This channel did not respond</h2>
          <p className="t-secondary">
            The provider accepted the request and then sent nothing playable. It is almost always the
            stream rather than your connection. A backup variant usually works.
          </p>
          <div className="live__fail-acts">
            <Button variant="primary" onClick={() => onPlay(item)}>Retry</Button>
            {siblings.length > 1 && (
              <Button
                variant="ghost"
                onClick={() => { if (alt >= 0) { onVariant(row.key, alt); onPlay(siblings[alt]); } }}
              >
                Try {row.group.labels[alt] || 'another'} variant
              </Button>
            )}
            <Button variant="ghost" onClick={() => onExternal(item)}>Open in external player</Button>
          </div>
        </div>
      ) : (
        <>
          {current ? (
            <div className="live__preview-now">
              <span className="live__preview-time data">{formatClock(current.start)} – {formatClock(current.stop)}</span>
              <span className="live__preview-title" dir="auto">{current.title}</span>
              <span className="live__track live__track--wide">
                <span
                  className="live__track-fill"
                  style={{ width: `${progressThrough(current.start, current.stop, now) * 100}%` }}
                />
              </span>
              <span className="live__preview-left data">{remainingLabel(current.stop, now)}</span>
              {current.description && <p className="live__preview-plot" dir="auto">{current.description}</p>}
              {nn?.next && (
                <p className="live__preview-next">
                  Next at {formatClock(nn.next.start)} <span className="t-secondary" dir="auto">{nn.next.title}</span>
                </p>
              )}
            </div>
          ) : (
            <Absence label="No guide data" className="live__preview-absence" />
          )}

          <div className="live__preview-acts">
            <Button variant="primary" onClick={() => onPlay(item)} disabled={tuning}>
              <Play size={16} strokeWidth={1.5} />{tuning ? 'Tuning' : playing ? 'Playing' : 'Play'}
            </Button>
            <Button variant="plain" onClick={() => onFavourite(item)}>
              <Star size={16} strokeWidth={1.5} fill={favourite ? 'currentColor' : 'none'} />
              {favourite ? 'Favourited' : 'Favourite'}
            </Button>
          </div>
        </>
      )}
    </aside>
  );
}

function LiveLanding({ categories, onPlay }: { categories?: Category[]; onPlay: (i: MediaItem) => void }) {
  const favourites = useApp((s) => s.favourites);
  const sourceId = useApp((s) => s.activeSourceId ?? s.sources[0]?.id);
  const [recent, setRecent] = useState<WatchProgress[]>([]);

  useEffect(() => {
    let live = true;
    window.iptv.library.continueWatching()
      .then((list) => { if (live) setRecent(list.filter((w) => w.kind === 'live').slice(0, 6)); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [sourceId]);

  const favouriteChannels = useMemo(() => favourites.filter((f) => f.kind === 'live').slice(0, 9), [favourites]);
  const recentCategories = useMemo(() => {
    const ids = readStringList(RECENTS_KEY);
    return ids.map((id) => categories?.find((c) => c.id === id)).filter((c): c is Category => Boolean(c)).slice(0, 6);
  }, [categories]);

  const openCategory = useCallback((id: string) => {
    const app = useApp.getState();
    app.patch({ selectedCategory: { ...app.selectedCategory, live: id }, items: [], itemsError: undefined });
  }, []);

  if (!recent.length && !favouriteChannels.length && !recentCategories.length) {
    const biggest = categories?.slice().sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
    const named = categories?.find((c) => /\ball\b/i.test(c.name));
    const target = named ?? biggest;
    return (
      <EmptyState
        glyph={<Tv size={24} strokeWidth={1.5} />}
        title="Pick a category to start"
        body={`Your provider ships ${(categories?.length ?? 0).toLocaleString()} live categories. Choose one on the left and its channels land here, with now and next wherever the guide reaches.`}
        action={target ? <Button variant="ghost" onClick={() => openCategory(target.id)}>Browse all channels</Button> : undefined}
      />
    );
  }

  return (
    <div className="live__landing">
      {recent.length > 0 && (
        <LandingBlock title="Continue Watching" count={`${recent.length} channels`}>
          {recent.map((w) => (
            <button
              key={w.itemId}
              type="button"
              className="live__card"
              onClick={() => onPlay({
                id: w.itemId, kind: 'live', name: w.title, title: w.title,
                categoryId: '', streamId: 0, logo: w.image,
              })}
            >
              <LogoPlate item={{ logo: w.image, title: w.title, name: w.title }} size="row" />
              <span className="live__card-body">
                <span className="sm truncate" dir="auto">{w.title}</span>
                <span className="caption t-tertiary">{formatDayLabel(Math.floor(w.updatedAt / 1000))}</span>
              </span>
            </button>
          ))}
        </LandingBlock>
      )}

      {favouriteChannels.length > 0 && (
        <LandingBlock title="Favourites" count={`${favouriteChannels.length} channels`}>
          {favouriteChannels.map((item) => (
            <button key={item.id} type="button" className="live__card" onClick={() => onPlay(item)}>
              <LogoPlate item={item} size="row" />
              <span className="live__card-body">
                <TruncateTail text={item.title || item.name} className="sm" />
              </span>
            </button>
          ))}
        </LandingBlock>
      )}

      {recentCategories.length > 0 && (
        <LandingBlock title="Recent categories" count={`${recentCategories.length} of ${(categories?.length ?? 0).toLocaleString()}`}>
          {recentCategories.map((c) => (
            <button key={c.id} type="button" className="live__card live__card--cat" onClick={() => openCategory(c.id)}>
              <span className="live__card-body">
                <CategoryLabel category={c} />
                {c.count !== undefined && <span className="caption t-tertiary">{c.count.toLocaleString()} channels</span>}
              </span>
            </button>
          ))}
        </LandingBlock>
      )}
    </div>
  );
}

function LandingBlock({ title, count, children }: { title: string; count: string; children: ReactNode }) {
  return (
    <section className="live__block">
      <header className="live__block-head">
        <h2 className="t-title">{title}</h2>
        <span className="kicker">{count}</span>
      </header>
      <div className="live__block-grid">{children}</div>
    </section>
  );
}

function SkeletonList({ rowHeight }: { rowHeight: number }) {
  return (
    <div className="live__list live__list--skeleton" aria-hidden>
      {Array.from({ length: 14 }, (_, i) => (
        <div className="live__row" key={i} style={{ height: rowHeight } as CSSProperties}>
          <Skeleton width={56} height={34} radius={6} style={{ animationDelay: `${i * 120}ms`, flex: 'none' }} />
          <div className="live__name">
            <Skeleton width={i % 3 === 0 ? 260 : 180} height={12} radius={3} style={{ animationDelay: `${i * 120}ms`, marginTop: 4 }} />
          </div>
          <div className="live__right"><Skeleton width={96} height={12} radius={3} style={{ animationDelay: `${i * 120}ms` }} /></div>
        </div>
      ))}
    </div>
  );
}
