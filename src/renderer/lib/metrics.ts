import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { columnsFor } from '@/lib/virtual';

/* 10px above, up to two 20px title lines, 2px, an 18px facts line, 2px below. Matches .mcard__caption. */
export const CAPTION_H = 72;
const SCROLLBAR = 10;

export function px(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const n = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readPx(name: string, fallback: number): number {
  return px(getComputedStyle(document.documentElement), name, fallback);
}

export function useTokenPx(name: string, fallback: number): number {
  const [px, setPx] = useState(fallback);
  useEffect(() => {
    const read = (): void => setPx(readPx(name, fallback));
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    window.addEventListener('resize', read);
    return () => { mo.disconnect(); window.removeEventListener('resize', read); };
  }, [name, fallback]);
  return px;
}

export interface GridMetrics {
  cellW: number; cellH: number; artH: number;
  gapX: number; gapY: number; pad: number; columns: number; listRowH: number;
  ready: boolean;
}

export function useGridMetrics(ref: RefObject<HTMLElement | null>): GridMetrics {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const min = px(style, '--grid-min', 168);
    const gapX = px(style, '--grid-gap-x', 20);
    const gapY = px(style, '--grid-gap-y', 28);
    const pad = px(style, '--pad-page', 32);
    const listRowH = px(style, '--row-h-list', 64);
    const usable = width - SCROLLBAR;
    const inner = Math.max(0, usable - pad * 2);
    const columns = columnsFor(usable, min, gapX, pad);
    const cellW = inner > 0 ? (inner - gapX * (columns - 1)) / columns : min;
    const artH = Math.round(cellW * 1.5);
    return { cellW, cellH: artH + CAPTION_H, artH, gapX, gapY, pad, columns, listRowH, ready: width > 0 };
  }, [width]);
}

export function useMeasured<T>(pick: (el: HTMLElement) => T, initial: T): [(el: HTMLElement | null) => void, T] {
  const [value, setValue] = useState(initial);
  const ro = useRef<ResizeObserver | null>(null);
  const attach = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    setValue(pick(el));
    const obs = new ResizeObserver(() => setValue(pick(el)));
    obs.observe(el);
    ro.current = obs;
  }, [pick]);
  useEffect(() => () => ro.current?.disconnect(), []);
  return [attach, value];
}
