import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties,
} from 'react';
import { RotateCcw, Play, CalendarClock } from 'lucide-react';
import type { EpgProgramme, MediaItem } from '@shared/types';
import { activeSource, useApp } from '@/state/store';
import { parseCategory, qualityTag, withoutQuality } from '@/lib/catalog';
import { bezier, reducedMotion } from '@/lib/ease';
import { readPx, useTokenPx } from '@/lib/metrics';
import { Absence, Button, EmptyState, LogoPlate, Tally, Tooltip, TruncateTail } from '@/components/Primitives';
import { classNames, debounce, formatClock, formatDayLabel, isTextEntry, progressThrough, useNowSeconds } from '@/lib/format';
import '@/views/live.css';

const DAYS = 5;
const DAY_MIN = 24 * 60;
const H_OVERSCAN = 900;
const ROW_OVERSCAN = 4;
const EPG_ROW_OVERSCAN = 20;
const CHUNK = 6 * 3600;
const PPM_STEPS = [3, 5, 8];
const TIER_FULL = 120;
const TIER_TITLE = 72;
const TIER_WORD = 28;

const easeStandard = bezier(0.2, 0, 0, 1);

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

interface Slot {
  key: string;
  startMin: number;
  durMin: number;
  prog?: EpgProgramme;
}

function layoutChannel(list: EpgProgramme[], baseStart: number, spanMin: number): Slot[] {
  const endTs = baseStart + spanMin * 60;
  const clean = list
    .filter((p) => p.stop > p.start && p.stop > baseStart && p.start < endTs)
    .sort((a, b) => a.start - b.start);

  const slots: Slot[] = [];
  let cursor = 0;
  for (let i = 0; i < clean.length; i++) {
    const p = clean[i];
    const next = clean[i + 1];
    const stopTs = next && next.start < p.stop ? next.start : p.stop;
    const startMin = Math.max(cursor, (p.start - baseStart) / 60);
    const endMin = Math.min(spanMin, (stopTs - baseStart) / 60);
    if (endMin <= startMin) continue;
    if (startMin > cursor + 0.5) {
      slots.push({ key: `gap:${cursor}`, startMin: cursor, durMin: startMin - cursor });
    }
    slots.push({ key: `${p.channelId}:${p.start}`, startMin, durMin: endMin - startMin, prog: p });
    cursor = endMin;
  }
  if (cursor < spanMin - 0.5) slots.push({ key: `gap:${cursor}`, startMin: cursor, durMin: spanMin - cursor });
  return slots;
}

export interface EpgGuideProps {
  /** When omitted, falls back to the store's live items for the selected category. */
  channels?: MediaItem[];
  categoryName?: string;
  onTune?: (item: MediaItem) => void;
}

export function EpgGuide({ channels: given, categoryName, onTune }: EpgGuideProps) {
  const sourceId = useApp((s) => s.activeSourceId ?? s.sources[0]?.id);
  const storeItems = useApp((s) => s.items);
  const selectedId = useApp((s) => s.selectedCategory.live);
  const categories = useApp((s) => s.categories.live);
  const nowPlaying = useApp((s) => s.nowPlaying);

  const fallback = useMemo(
    () => storeItems.filter((i) => i.kind === 'live' && (!selectedId || i.categoryId === selectedId)),
    [storeItems, selectedId],
  );
  const all = given ?? fallback;
  const scopeLabel = categoryName
    ?? (() => {
      const c = categories?.find((x) => x.id === selectedId);
      return c ? parseCategory(c).label : 'All live channels';
    })();

  const pitch = useTokenPx('--row-h-guide', 52);
  const gutter = useTokenPx('--w-gutter', 240);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const [ppm, setPpm] = useState(5);
  const ppmRef = useRef(5);
  const [view, setView] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const now = useNowSeconds(15_000);
  const [query, setQuery] = useState('');
  const [dataOnly, setDataOnly] = useState<boolean>();
  const [focus, setFocus] = useState<{ row: number; min: number }>(
    () => ({ row: 0, min: Math.max(0, (Math.floor(Date.now() / 1000) - startOfToday()) / 60) }),
  );
  const [ring, setRing] = useState(false);
  const [info, setInfo] = useState<{ item: MediaItem; prog: EpgProgramme }>();
  const [tip, setTip] = useState<{ x: number; y: number; title: string; body?: string }>();

  const base = useMemo(() => startOfToday(), []);
  const spanMin = DAYS * DAY_MIN;

  useEffect(() => {
    const parsed = readPx('--ppm', 0);
    if (parsed > 0) { ppmRef.current = parsed; setPpm(parsed); }
  }, []);

  const withData = useMemo(() => all.filter((c) => c.epgChannelId), [all]);
  const coverage = all.length ? withData.length / all.length : 0;
  const onlyWithData = dataOnly ?? coverage < 0.6;

  const channels = useMemo(() => {
    const pool = onlyWithData ? withData : all;
    const q = query.trim().toLowerCase();
    return q ? pool.filter((c) => `${c.title} ${c.name}`.toLowerCase().includes(q)) : pool;
  }, [all, withData, onlyWithData, query]);

  const nowMin = (now - base) / 60;
  const totalHeight = channels.length * pitch;
  const timelineLeft = Math.max(0, view.left - gutter);
  const fromMin = (timelineLeft - H_OVERSCAN) / ppm;
  const toMin = (timelineLeft + view.width + H_OVERSCAN) / ppm;
  const firstRow = Math.max(0, Math.floor(view.top / pitch) - ROW_OVERSCAN);
  const lastRow = Math.min(channels.length, Math.ceil((view.top + view.height) / pitch) + ROW_OVERSCAN);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setView({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight });
  }, []);

  const frame = useRef(0);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; measure(); setTip(undefined); });
  }, [measure]);

  const hasRows = channels.length > 0;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); if (frame.current) cancelAnimationFrame(frame.current); };
  }, [measure, hasRows]);

  const landed = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || landed.current || !el.clientWidth || !channels.length) return;
    landed.current = true;
    el.scrollLeft = Math.max(0, nowMin * ppmRef.current - el.clientWidth * 0.25);
    measure();
  }, [channels.length, nowMin, measure]);

  const [epg, setEpg] = useState<Record<string, EpgProgramme[]>>({});
  const fetched = useRef(new Set<string>());
  const wanted = useRef({ lo: 0, hi: 0, from: 0, to: 0 });

  useEffect(() => { fetched.current.clear(); setEpg({}); }, [sourceId, selectedId]);

  const pump = useMemo(() => debounce(() => {
    const src = activeSource()?.id;
    if (!src) return;
    const { lo, hi, from, to } = wanted.current;
    const list = channelsRef.current;
    if (!list.length) return;

    const c0 = Math.floor(from / CHUNK);
    const c1 = Math.floor(to / CHUNK);
    for (let chunk = c0; chunk <= c1; chunk++) {
      const ids: string[] = [];
      for (let i = lo; i <= hi; i++) {
        const id = list[i]?.epgChannelId;
        if (!id) continue;
        const key = `${id}|${chunk}`;
        if (fetched.current.has(key)) continue;
        fetched.current.add(key);
        ids.push(id);
      }
      if (!ids.length) continue;
      window.iptv.epg.grid(src, ids, chunk * CHUNK, (chunk + 1) * CHUNK).then((grid) => {
        setEpg((prev) => {
          const next = { ...prev };
          for (const id of ids) {
            const seen = new Set((next[id] ?? []).map((p) => p.start));
            const merged = (next[id] ?? []).concat((grid[id] ?? []).filter((p) => !seen.has(p.start)));
            next[id] = merged.sort((a, b) => a.start - b.start);
          }
          return next;
        });
      }).catch(() => {
        setEpg((prev) => {
          const next = { ...prev };
          for (const id of ids) if (!next[id]) next[id] = [];
          return next;
        });
      });
    }
  }, 120), []);

  const channelsRef = useRef(channels);
  useEffect(() => { channelsRef.current = channels; }, [channels]);

  useEffect(() => {
    if (!channels.length) return;
    wanted.current = {
      lo: Math.max(0, firstRow - EPG_ROW_OVERSCAN),
      hi: Math.min(channels.length - 1, lastRow + EPG_ROW_OVERSCAN),
      from: base + Math.max(0, fromMin - 180) * 60,
      to: base + Math.min(spanMin, toMin + 180) * 60,
    };
    pump();
  }, [channels.length, firstRow, lastRow, fromMin, toMin, base, spanMin, pump]);

  const laid = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const [id, list] of Object.entries(epg)) map.set(id, layoutChannel(list, base, spanMin));
    return map;
  }, [epg, base, spanMin]);

  const tween = useRef(0);
  const scrollTo = useCallback((target: number) => {
    const el = scrollRef.current;
    if (!el) return;
    cancelAnimationFrame(tween.current);
    const from = el.scrollLeft;
    const delta = target - from;
    if (reducedMotion() || Math.abs(delta) < 2) { el.scrollLeft = target; measure(); return; }
    if (Math.abs(delta) > 6 * 60 * ppmRef.current) {
      const root = rootRef.current;
      if (root) {
        root.dataset.jump = 'true';
        setTimeout(() => { delete root.dataset.jump; }, 140);
      }
      el.scrollLeft = target;
      measure();
      return;
    }
    const t0 = performance.now();
    const step = (t: number): void => {
      const k = Math.min(1, (t - t0) / 420);
      el.scrollLeft = from + delta * easeStandard(k);
      if (k < 1) tween.current = requestAnimationFrame(step);
      else measure();
    };
    tween.current = requestAnimationFrame(step);
  }, [measure]);

  useEffect(() => () => cancelAnimationFrame(tween.current), []);

  const zoom = useRef(0);
  const zoomTo = useCallback((target: number, anchorClientX?: number) => {
    const el = scrollRef.current;
    const root = rootRef.current;
    if (!el || !root || target === ppmRef.current) return;
    cancelAnimationFrame(zoom.current);
    const rect = el.getBoundingClientRect();
    const anchorX = anchorClientX !== undefined
      ? anchorClientX - rect.left
      : Math.min(Math.max(gutter + 40, nowMin * ppmRef.current - el.scrollLeft + gutter), rect.width - 40);
    const anchorMin = (el.scrollLeft + anchorX - gutter) / ppmRef.current;
    const from = ppmRef.current;

    const apply = (value: number): void => {
      ppmRef.current = value;
      root.style.setProperty('--ppm', `${value}px`);
      el.scrollLeft = anchorMin * value + gutter - anchorX;
    };
    if (reducedMotion()) { apply(target); setPpm(target); measure(); return; }

    root.dataset.zooming = 'true';
    const t0 = performance.now();
    const step = (t: number): void => {
      const k = Math.min(1, (t - t0) / 240);
      apply(from + (target - from) * easeStandard(k));
      if (k < 1) { zoom.current = requestAnimationFrame(step); return; }
      delete root.dataset.zooming;
      setPpm(target);
      measure();
    };
    zoom.current = requestAnimationFrame(step);
  }, [gutter, nowMin, measure]);

  useEffect(() => () => cancelAnimationFrame(zoom.current), []);

  const stepZoom = useCallback((dir: 1 | -1, anchorClientX?: number) => {
    const i = PPM_STEPS.indexOf(Math.round(ppmRef.current));
    const at = i === -1 ? 1 : i;
    const next = PPM_STEPS[Math.min(PPM_STEPS.length - 1, Math.max(0, at + dir))];
    zoomTo(next, anchorClientX);
  }, [zoomTo]);

  const jumpToNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    scrollTo(Math.max(0, nowMin * ppmRef.current - el.clientWidth * 0.25));
  }, [nowMin, scrollTo]);

  const tune = useCallback((item: MediaItem) => {
    if (onTune) { onTune(item); return; }
    const src = activeSource()?.id;
    if (!src) return;
    window.iptv.player.resolve({ sourceId: src, itemId: item.id })
      .then((stream) => useApp.getState().patch({ nowPlaying: { stream, item } }))
      .catch(() => useApp.getState().toast$('This channel did not respond.', 'error'));
  }, [onTune]);

  const playFromStart = useCallback((item: MediaItem, prog: EpgProgramme) => {
    const src = activeSource()?.id;
    if (!src) return;
    window.iptv.player.resolve({ sourceId: src, itemId: item.id, startAt: Math.max(0, Math.floor(Date.now() / 1000 - prog.start)) })
      .then((stream) => useApp.getState().patch({ nowPlaying: { stream, item } }))
      .catch(() => useApp.getState().toast$('That programme is no longer in the archive.', 'error'));
  }, []);

  const ensureVisible = useCallback((row: number, min: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = row * pitch;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + pitch > el.scrollTop + el.clientHeight - 40) el.scrollTop = top + pitch - el.clientHeight + 40;
    const x = min * ppmRef.current;
    const leftEdge = el.scrollLeft;
    if (x < leftEdge) scrollTo(Math.max(0, x - 60));
    else if (x > leftEdge + el.clientWidth - gutter - 120) scrollTo(x - el.clientWidth + gutter + 240);
  }, [pitch, gutter, scrollTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = isTextEntry(e.target as Element | null);
      const app = useApp.getState();
      if (app.paletteOpen || app.nowPlaying) return;

      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=' || e.key === '-')) {
        e.preventDefault();
        stepZoom(e.key === '-' ? -1 : 1);
        return;
      }
      if (typing) {
        if (e.key === 'Escape') { setQuery(''); filterRef.current?.blur(); }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          e.preventDefault();
          setRing(true);
          setFocus((f) => {
            const row = Math.min(Math.max(0, f.row + (e.key === 'ArrowDown' ? 1 : -1)), Math.max(0, channelsRef.current.length - 1));
            ensureVisible(row, f.min);
            return { row, min: f.min };
          });
          break;
        }
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          setRing(true);
          setFocus((f) => {
            const id = channelsRef.current[f.row]?.epgChannelId;
            const slots = id ? laidRef.current.get(id) : undefined;
            if (!slots?.length) {
              const min = Math.max(0, f.min + (e.key === 'ArrowRight' ? 30 : -30));
              ensureVisible(f.row, min);
              return { row: f.row, min };
            }
            const at = slots.findIndex((s) => f.min >= s.startMin && f.min < s.startMin + s.durMin);
            const nextIndex = Math.min(Math.max(0, (at === -1 ? 0 : at) + (e.key === 'ArrowRight' ? 1 : -1)), slots.length - 1);
            const min = slots[nextIndex].startMin + 0.5;
            ensureVisible(f.row, min);
            return { row: f.row, min };
          });
          break;
        }
        case '[':
        case ']': {
          e.preventDefault();
          setRing(true);
          setFocus((f) => {
            const min = Math.max(0, f.min + (e.key === ']' ? 30 : -30));
            ensureVisible(f.row, min);
            return { row: f.row, min };
          });
          break;
        }
        case 'Enter': {
          const item = channelsRef.current[focusRef.current.row];
          if (item) { e.preventDefault(); tune(item); }
          break;
        }
        case 't':
        case 'T': {
          e.preventDefault();
          jumpToNow();
          setFocus((f) => ({ row: f.row, min: (Math.floor(Date.now() / 1000) - base) / 60 }));
          break;
        }
        case 'i':
        case 'I': {
          e.preventDefault();
          const item = channelsRef.current[focusRef.current.row];
          const id = item?.epgChannelId;
          const slots = id ? laidRef.current.get(id) : undefined;
          const prog = slots?.find((s) => focusRef.current.min >= s.startMin && focusRef.current.min < s.startMin + s.durMin)?.prog;
          if (item && prog) setInfo((open) => (open ? undefined : { item, prog }));
          break;
        }
        case 'Escape':
          setInfo(undefined);
          break;
        case '/':
          e.preventDefault();
          filterRef.current?.focus();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepZoom, ensureVisible, jumpToNow, tune, base]);

  const focusRef = useRef(focus);
  useEffect(() => { focusRef.current = focus; }, [focus]);
  const laidRef = useRef(laid);
  useEffect(() => { laidRef.current = laid; }, [laid]);

  /* React binds `wheel` passively at the root, so Ctrl+wheel zoom has to be a native listener
     or the browser page-zooms instead. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      stepZoom(e.deltaY < 0 ? 1 : -1, e.clientX);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [stepZoom]);

  const dwell = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(dwell.current), []);
  const openTip = useCallback((rect: DOMRect, title: string, body?: string) => {
    clearTimeout(dwell.current);
    const root = rootRef.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    dwell.current = setTimeout(() => {
      setTip({ x: Math.min(rect.left - box.left, box.width - 356), y: rect.bottom - box.top + 6, title, body });
    }, 400);
  }, []);
  const closeTip = useCallback(() => { clearTimeout(dwell.current); setTip(undefined); }, []);

  const hours = useMemo(() => {
    const out: number[] = [];
    const start = Math.max(0, Math.floor(fromMin / 60) * 60);
    const end = Math.min(spanMin, Math.ceil(toMin / 60) * 60);
    for (let m = start; m <= end; m += 60) out.push(m);
    return out;
  }, [fromMin, toMin, spanMin]);

  const days = useMemo(
    () => Array.from({ length: DAYS }, (_, i) => ({ index: i, ts: base + i * DAY_MIN * 60 })),
    [base],
  );
  const activeDay = Math.min(DAYS - 1, Math.floor(timelineLeft / ppm / DAY_MIN));

  const playheadOffscreen = Math.abs(nowMin * ppm - (timelineLeft + view.width / 2)) > (view.width / 2 + 60 * ppm);
  const playingId = nowPlaying?.item.kind === 'live' ? nowPlaying.item.id : undefined;

  const style = {
    '--span-min': spanMin,
    '--now-min': nowMin,
    /* Blocks read this to keep their label at the visible left edge of the timeline. */
    '--scroll-left': `${view.left}px`,
  } as CSSProperties;

  if (!all.length) {
    return (
      <div className="guide guide--empty">
        <EmptyState
          glyph={<CalendarClock size={24} strokeWidth={1.5} />}
          title="No channels to show"
          body="Pick a category on the left and the guide fills in behind it. It always shows one category. A timeline over every channel your provider ships is a mile of scroll nobody can navigate."
        />
      </div>
    );
  }

  return (
    <div className="guide" ref={rootRef} style={style}>
      <div className="guide__chrome">
        <input
          ref={filterRef}
          className="guide__filter"
          value={query}
          spellCheck={false}
          placeholder="Filter channels"
          aria-label="Filter channels"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="guide__scope t-secondary truncate">{scopeLabel}</span>
        <Tooltip label={`${withData.length.toLocaleString()} of ${all.length.toLocaleString()} channels have guide data`}>
          <span className="guide__gcount data t-tertiary">
            {withData.length.toLocaleString()}/{all.length.toLocaleString()}
          </span>
        </Tooltip>
        <span className="guide__chrome-spacer" />
        <div className="guide__days">
          {days.map((d) => (
            <button
              key={d.index}
              type="button"
              className={classNames('guide__day', d.index === activeDay && 'is-on')}
              onClick={() => scrollTo(d.index === 0
                ? Math.max(0, nowMin * ppm - view.width * 0.25)
                : d.index * DAY_MIN * ppm)}
            >
              {formatDayLabel(d.ts)}
            </button>
          ))}
        </div>
      </div>

      {!channels.length ? (
        <EmptyState
          glyph={<CalendarClock size={24} strokeWidth={1.5} />}
          title={query ? 'Nothing matches that' : 'No listings in this category'}
          body={query
            ? `None of the ${all.length.toLocaleString()} channels here match "${query.trim()}". The filter reads the cleaned title and the raw provider name, so a shorter fragment is worth trying.`
            : `Not one of these ${all.length.toLocaleString()} channels carries an XMLTV id, so the provider ships no listings for any of them. They all still play. Use the List tab for this category.`}
          action={query
            ? <Button variant="ghost" onClick={() => setQuery('')}>Clear the filter</Button>
            : onlyWithData ? <Button variant="ghost" onClick={() => setDataOnly(false)}>Show them anyway</Button> : undefined}
        />
      ) : (
      <div className="guide__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="guide__canvas">
          <div className="guide__timehead">
            <div className="guide__corner">
              <button
                type="button"
                className={classNames('guide__switch', onlyWithData && 'is-on')}
                aria-pressed={onlyWithData}
                onClick={() => setDataOnly(!onlyWithData)}
              >
                <span className="guide__switch-track"><span className="guide__switch-knob" /></span>
                <span className="sm">Guide data only</span>
              </button>
            </div>
            {/* Hidden under the channel column, and under the opaque now pill, either would leave
                a stray digit at the edge. */}
            {hours
              .filter((m) => m * ppm - view.left > 12 && Math.abs((m - nowMin) * ppm) > 60)
              .map((m) => (
                <span key={m} className="guide__hour data" style={{ '--m0': m } as CSSProperties}>
                  {formatClock(base + m * 60)}
                </span>
              ))}
            <span className="guide__pill data">{formatClock(now)}</span>
            <div className="guide__cap" aria-hidden><Tally /></div>
          </div>

          <div className="guide__body" style={{ height: totalHeight }}>
            <div className="guide__gutter" style={{ height: totalHeight }}>
              {channels.slice(firstRow, lastRow).map((item, i) => (
                <GutterCell
                  key={item.id}
                  item={item}
                  top={(firstRow + i) * pitch}
                  height={pitch}
                  playing={item.id === playingId}
                  focused={ring && firstRow + i === focus.row}
                  onTune={tune}
                  onFocus={() => { setRing(false); setFocus((f) => ({ row: firstRow + i, min: f.min })); }}
                />
              ))}
            </div>

            <div className="guide__rows">
              {channels.slice(firstRow, lastRow).map((item, i) => {
                const index = firstRow + i;
                const id = item.epgChannelId;
                const slots = id ? laid.get(id) : undefined;
                return (
                  <GuideRow
                    key={item.id}
                    item={item}
                    top={index * pitch}
                    height={pitch}
                    slots={slots}
                    fromMin={fromMin}
                    toMin={toMin}
                    ppm={ppm}
                    now={now}
                    focusMin={ring && index === focus.row ? focus.min : undefined}
                    scrollLeft={view.left}
                    absenceLeft={gutter + Math.max(0, timelineLeft - H_OVERSCAN)}
                    absenceWidth={view.width + H_OVERSCAN * 2}
                    voidLabelLeft={view.left + gutter + 12}
                    onTune={tune}
                    onArchive={playFromStart}
                    onInfo={(prog) => setInfo({ item, prog })}
                    onFocusCell={(min) => { setRing(false); setFocus({ row: index, min }); }}
                    onTip={openTip}
                    onTipOut={closeTip}
                  />
                );
              })}
            </div>

            <div className="guide__playhead" aria-hidden><Tally /></div>
          </div>
        </div>
      </div>
      )}

      {playheadOffscreen && channels.length > 0 && (
        <button type="button" className="guide__now" onClick={jumpToNow}>Now</button>
      )}

      {tip && (
        <div className="guide__tip sm" style={{ left: Math.max(8, tip.x), top: tip.y }} role="tooltip">
          <span className="guide__tip-title" dir="auto">{tip.title}</span>
          {tip.body && <span className="guide__tip-body t-secondary" dir="auto">{tip.body}</span>}
        </div>
      )}

      {info && (
        <aside className="guide__info">
          <div className="guide__info-head">
            <LogoPlate item={info.item} size="large" />
            <TruncateTail text={info.item.title || info.item.name} className="h2" />
          </div>
          <span className="guide__info-time data">{formatClock(info.prog.start)} – {formatClock(info.prog.stop)}</span>
          <h2 className="guide__info-title" dir="auto">{info.prog.title}</h2>
          {info.prog.description
            ? <p className="t-secondary guide__info-plot" dir="auto">{info.prog.description}</p>
            : <Absence label="No synopsis" className="guide__info-absence" />}
          <div className="guide__info-acts">
            <Button variant="primary" onClick={() => tune(info.item)}><Play size={16} strokeWidth={1.5} />Watch live</Button>
            {info.item.hasArchive === true && info.prog.start < now && (
              <Button variant="ghost" onClick={() => playFromStart(info.item, info.prog)}>
                <RotateCcw size={16} strokeWidth={1.5} />Watch from start
              </Button>
            )}
          </div>
          <Button variant="plain" className="guide__info-close" onClick={() => setInfo(undefined)}>Close</Button>
        </aside>
      )}
    </div>
  );
}

const GutterCell = memo(function GutterCell({
  item, top, height, playing, focused, onTune, onFocus,
}: {
  item: MediaItem; top: number; height: number; playing: boolean; focused: boolean;
  onTune: (i: MediaItem) => void; onFocus: () => void;
}) {
  const quality = useMemo(() => qualityTag(item.name), [item.name]);
  return (
    <div
      className="guide__gcell"
      data-playing={playing || undefined}
      data-focused={focused || undefined}
      style={{ top, height }}
      role="button"
      tabIndex={-1}
      onClick={() => { onFocus(); onTune(item); }}
    >
      <LogoPlate item={item} size="row" />
      <span className="guide__gname">
        <TruncateTail text={withoutQuality(item.title || item.name, quality)} className="live__title" />
        {quality && <span className="live__q">{quality}</span>}
      </span>
    </div>
  );
});

interface GuideRowProps {
  item: MediaItem;
  top: number;
  height: number;
  slots?: Slot[];
  fromMin: number;
  toMin: number;
  ppm: number;
  now: number;
  focusMin?: number;
  /** Timeline scroll offset in px, to measure how much of a clipped block still shows. */
  scrollLeft: number;
  absenceLeft: number;
  absenceWidth: number;
  /** Where the visible left edge of the timeline is, so a "No guide data" lane says so once. */
  voidLabelLeft: number;
  onTune: (i: MediaItem) => void;
  onArchive: (i: MediaItem, p: EpgProgramme) => void;
  onInfo: (p: EpgProgramme) => void;
  onFocusCell: (min: number) => void;
  onTip: (rect: DOMRect, title: string, body?: string) => void;
  onTipOut: () => void;
}

const GuideRow = memo(function GuideRow(p: GuideRowProps) {
  const { item, slots } = p;

  if (!item.epgChannelId || (slots && !slots.some((s) => s.prog))) {
    return (
      <div className="guide__row" style={{ top: p.top, height: p.height }}>
        <span className="guide__void-label sm" style={{ insetInlineStart: p.voidLabelLeft }}>No guide data</span>
      </div>
    );
  }

  if (!slots) {
    return (
      <div className="guide__row" style={{ top: p.top, height: p.height }}>
        <div
          className="guide__pending skeleton"
          style={{ insetInlineStart: p.absenceLeft, width: p.absenceWidth }}
        />
      </div>
    );
  }

  return (
    <div className="guide__row" style={{ top: p.top, height: p.height }}>
      {slots.map((slot) => {
        if (slot.startMin + slot.durMin < p.fromMin || slot.startMin > p.toMin) return null;
        const width = slot.durMin * p.ppm;
        const vars = { '--m0': slot.startMin, '--dm': slot.durMin } as CSSProperties;

        if (!slot.prog) {
          return (
            <Absence
              key={slot.key}
              className="guide__gap"
              style={vars}
              label={width >= TIER_FULL ? 'No listing' : undefined}
            />
          );
        }

        const prog = slot.prog;
        const past = prog.stop <= p.now;
        const live = prog.start <= p.now && prog.stop > p.now;
        const focused = p.focusMin !== undefined
          && p.focusMin >= slot.startMin && p.focusMin < slot.startMin + slot.durMin;
        const state = past ? 'past' : live ? 'live' : 'future';
        const tier = width < TIER_WORD || slot.durMin < 3 ? 'hair'
          : width < TIER_TITLE ? 'word'
          : width < TIER_FULL ? 'title' : 'full';

        if (tier === 'hair') {
          return (
            <div
              key={slot.key}
              className="guide__hair"
              data-state={state}
              style={vars}
              onPointerEnter={(e) => p.onTip(e.currentTarget.getBoundingClientRect(), prog.title, prog.description)}
              onPointerLeave={p.onTipOut}
              onClick={() => { p.onFocusCell(slot.startMin + 0.5); p.onTune(item); }}
            />
          );
        }

        const style = live
          ? { ...vars, '--elapsed': `${progressThrough(prog.start, prog.stop, p.now) * 100}%` } as CSSProperties
          : vars;

        /* A block scrolled almost off the left keeps only a sliver on screen. A glyph or two of its
           title there reads as debris rather than as a label, so it renders plain. */
        const sliver = (slot.startMin + slot.durMin) * p.ppm - p.scrollLeft < 40;

        /* This channel keeps an archive, so a finished programme can be played from its start.
           Said in a word: at 12px the rotate glyph that used to mark it lost its arrowhead and
           read as a bare ring. Only where the block has room for the words. */
        const catchUp = past && item.hasArchive === true && width >= 200;

        return (
          <div
            key={slot.key}
            className="guide__block"
            data-state={state}
            data-tier={tier}
            data-focused={focused || undefined}
            style={style}
            role="button"
            tabIndex={-1}
            onPointerEnter={(e) => p.onTip(e.currentTarget.getBoundingClientRect(), prog.title, prog.description)}
            onPointerLeave={p.onTipOut}
            onClick={(e) => {
              p.onFocusCell(slot.startMin + 0.5);
              if (e.shiftKey) p.onInfo(prog);
              else if (past && item.hasArchive === true) p.onArchive(item, prog);
              else p.onTune(item);
            }}
          >
            {!sliver && (
              <span className="guide__block-text">
                <span className="guide__block-title" dir="auto">
                  {tier === 'word' ? prog.title.split(/\s+/)[0] : prog.title}
                </span>
                {tier === 'full' && (
                  <span className="guide__block-time data">
                    {formatClock(prog.start)} – {formatClock(prog.stop)}
                    {catchUp && <span className="guide__catchup">Catch up</span>}
                  </span>
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
});
