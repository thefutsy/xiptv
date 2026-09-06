import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const OVERSCAN = 4;

function useViewport(ref: React.RefObject<HTMLElement | null>): { height: number; width: number; scrollTop: number } {
  const [box, setBox] = useState({ height: 0, width: 0, scrollTop: 0 });
  const frame = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setBox((b) => ({ ...b, height: el.clientHeight, width: el.clientWidth }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);

    const onScroll = (): void => {
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setBox((b) => (b.scrollTop === el.scrollTop ? b : { ...b, scrollTop: el.scrollTop }));
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [ref]);

  return box;
}

export interface VListProps {
  count: number;
  rowHeight: number;
  children: (index: number) => ReactNode;
  className?: string;
  header?: ReactNode;
  overscan?: number;
  scrollToIndex?: number;
}

export function VList({ count, rowHeight, children, className, header, overscan = OVERSCAN, scrollToIndex }: VListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { height, scrollTop } = useViewport(ref);

  useEffect(() => {
    const el = ref.current;
    if (!el || scrollToIndex === undefined || scrollToIndex < 0) return;
    const top = scrollToIndex * rowHeight;
    if (top < el.scrollTop || top + rowHeight > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: Math.max(0, top - el.clientHeight / 2), behavior: 'auto' });
    }
  }, [scrollToIndex, rowHeight]);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan);

  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    rows.push(
      <div
        key={i}
        style={{
          position: 'absolute', top: i * rowHeight, left: 0, right: 0, height: rowHeight,
          contain: 'strict', contentVisibility: 'auto', containIntrinsicSize: `${rowHeight}px`,
        }}
      >
        {children(i)}
      </div>,
    );
  }

  return (
    <div ref={ref} className={className} style={{ overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}>
      {header}
      <div style={{ height: count * rowHeight, position: 'relative' }}>{rows}</div>
    </div>
  );
}

export interface VGridProps {
  count: number;
  columnWidth: number;
  rowHeight: number;
  gapX: number;
  gapY: number;
  children: (index: number) => ReactNode;
  className?: string;
  header?: ReactNode;
  padding?: number;
}

export function VGrid({ count, columnWidth, rowHeight, gapX, gapY, children, className, header, padding = 0 }: VGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { height, width, scrollTop } = useViewport(ref);

  const inner = Math.max(0, width - padding * 2);
  const columns = columnsFor(width, columnWidth, gapX, padding);
  const cellWidth = (inner - gapX * (columns - 1)) / columns;
  const pitch = rowHeight + gapY;
  const rowCount = Math.ceil(count / columns);

  const firstRow = Math.max(0, Math.floor(scrollTop / pitch) - 2);
  const lastRow = Math.min(rowCount, Math.ceil((scrollTop + height) / pitch) + 2);

  const cells: ReactNode[] = [];
  for (let r = firstRow; r < lastRow; r++) {
    for (let c = 0; c < columns; c++) {
      const index = r * columns + c;
      if (index >= count) break;
      cells.push(
        <div
          key={index}
          style={{
            position: 'absolute',
            top: r * pitch,
            left: padding + c * (cellWidth + gapX),
            width: cellWidth,
            height: rowHeight,
            contain: 'strict', contentVisibility: 'auto', containIntrinsicSize: `${cellWidth}px ${rowHeight}px`,
          }}
        >
          {children(index)}
        </div>,
      );
    }
  }

  return (
    <div ref={ref} className={className} style={{ overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}>
      {header}
      <div style={{ height: Math.max(0, rowCount * pitch - gapY), position: 'relative' }}>{cells}</div>
    </div>
  );
}

export function columnsFor(width: number, columnWidth: number, gapX: number, padding = 0): number {
  const inner = Math.max(0, width - padding * 2);
  return Math.max(1, Math.floor((inner + gapX) / (columnWidth + gapX)));
}
