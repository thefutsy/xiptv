import type { Category, MediaItem, MediaKind } from '@shared/types';
import { fold, KIND_MARKERS, PREFIX_CODES } from '@shared/text';

const DECOR = '★☆✪❖◉▣●■◆♦▪▸►|:';
const CATEGORY_PREFIX = new RegExp(`^([\\p{L}\\d-]{2,6})\\s*[${DECOR}-]*\\s*`, 'u');
const CATEGORY_SUFFIX = /\s*[[(]([\p{L}\d-]{2,8})[\])]\s*$/u;
const CATEGORY_DECOR = new RegExp(`^[${DECOR}\\s]+`, 'u');

const QUALITY_TOKENS = new Set(['4K', 'UHD', 'FHD', 'HD', 'SD', 'HEVC', 'H265']);

const QUALITY_TAG = /(?:^|[\s\-_[(|])(4K|UHD|FHD|HD|SD|HEVC|H265)(?:$|[\s\-_\])|])/i;

/** Strips the quality token off a title once it is being shown as a chip. */
export function withoutQuality(title: string, quality?: string): string {
  if (!quality) return title;
  const trimmed = title.replace(new RegExp(`[\\s\\-_|]*\\(?${quality}\\)?\\s*$`, 'i'), '').trim();
  return trimmed || title;
}

export function qualityTag(name: string): string | undefined {
  const m = QUALITY_TAG.exec(name);
  return m ? m[1].toUpperCase() : undefined;
}

export interface ParsedCategory {
  chips: string[];
  label: string;
  raw: string;
}

/** Title-cases in JS. `text-transform: capitalize` is a no-op on these ALL-CAPS sources. */
function titleCase(input: string): string {
  return input.toLowerCase().replace(/\b([\p{L}\p{N}])([\p{L}\p{N}'’-]*)/gu, (_m, head: string, tail: string) => {
    const word = head + tail;
    if (QUALITY_TOKENS.has(word.toUpperCase()) || /^\d+$/.test(word)) return word.toUpperCase();
    if (word.length <= 3 && /^[a-z]+$/.test(word) && PREFIX_CODES.has(word.toUpperCase())) return word.toUpperCase();
    return head.toUpperCase() + tail;
  });
}

export function parseCategory(category: Category): ParsedCategory {
  const raw = category.name;
  // Leading decoration comes off first, or a name wrapped like `|UK| GENERAL` never reaches the
  // prefix rule at all.
  let rest = raw.trim().replace(CATEGORY_DECOR, '').trim();
  const chips: string[] = [];

  // A trailing language tag (`VOD - ACTION [EN]`) is a chip like any other prefix.
  const suffix = CATEGORY_SUFFIX.exec(rest);
  if (suffix && PREFIX_CODES.has(suffix[1].toUpperCase())) {
    chips.push(suffix[1].toUpperCase());
    rest = rest.slice(0, suffix.index).trim();
  }

  for (let i = 0; i < 3; i++) {
    const m = CATEGORY_PREFIX.exec(rest);
    if (!m) break;
    const token = m[1].toUpperCase();
    const marker = KIND_MARKERS.has(token);
    // A token the provider fenced with a pipe (`NA| USA GENERAL`) is a prefix even when
    // it is not on the list.
    const fenced = rest.slice(m[1].length).trimStart().startsWith('|');
    if (!marker && !fenced && !PREFIX_CODES.has(token)) break;
    const remainder = rest.slice(m[0].length).replace(CATEGORY_DECOR, '').trim();
    if (!remainder) break;
    // `VOD`/`SRS` repeat on every category in a section, so they are dropped rather than chipped.
    if (!marker && !chips.includes(token)) chips.push(token);
    rest = remainder;
  }

  rest = rest.replace(CATEGORY_DECOR, '').trim();
  return { chips, label: titleCase(rest) || titleCase(raw), raw };
}

export function isAdultCategory(category: Category): boolean {
  return /\b(xxx|adult|porn|18\+)\b/i.test(category.name);
}

export { fold };

export function matchesName(item: MediaItem, folded: string): boolean {
  return fold(item.title).includes(folded) || fold(item.name).includes(folded);
}

export interface VariantGroup {
  item: MediaItem;
  variants: MediaItem[];
  labels: string[];
}

/**
 * A trailing marker that distinguishes duplicates of the same channel rather than a different
 * channel. A bare number is deliberately not on this list: `BBC 1` and `BBC 2` are two channels,
 * not two feeds of one, and stripping the digit collapsed the whole of ITV into a single row.
 */
const VARIANT_SUFFIX = /\s*(?:\[[^\]]*\]|\([^)]*\)|\b(?:4K|UHD|FHD|HD|SD|HEVC|H265|MULTI-?SUB|BACKUP\s*\d*|ALT\s*\d*)\b)\s*$/i;

function variantKey(item: MediaItem): string {
  let name = item.title;
  for (let i = 0; i < 4; i++) {
    const next = name.replace(VARIANT_SUFFIX, '');
    if (next === name) break;
    name = next;
  }
  return fold(name).replace(/[^a-z0-9]+/g, ' ').trim();
}

function variantLabel(item: MediaItem, key: string): string {
  const tail = item.title.trim();
  const stripped = fold(tail).replace(/[^a-z0-9]+/g, ' ').trim();
  if (stripped === key) return 'SD';
  const m = VARIANT_SUFFIX.exec(item.title);
  return (m?.[0] ?? '').replace(/[[\]()]/g, '').trim().toUpperCase() || '·';
}

export function groupVariants(items: MediaItem[]): VariantGroup[] {
  const keys = items.map(variantKey);
  const out: VariantGroup[] = [];
  let i = 0;
  while (i < items.length) {
    const key = keys[i];
    let j = i + 1;
    while (j < items.length && key.length > 2 && keys[j] === key) j++;
    const run = items.slice(i, j);
    out.push({
      item: run[0],
      variants: run,
      labels: run.length > 1 ? run.map((v) => variantLabel(v, key)) : [],
    });
    i = j;
  }
  return out;
}

export type KindTab = 'all' | MediaKind;

export type KindCounts = Record<KindTab, number>;

export function countKinds(items: MediaItem[]): KindCounts {
  const counts: KindCounts = { all: items.length, live: 0, movie: 0, series: 0 };
  for (const item of items) counts[item.kind]++;
  return counts;
}

export function prefersRows(tab: KindTab, counts: KindCounts): boolean {
  return tab === 'live' || (tab === 'all' && counts.live > 0);
}

export function hasMixedKinds(counts: KindCounts): boolean {
  return [counts.live, counts.movie, counts.series].filter((n) => n > 0).length > 1;
}

export interface Facets {
  genres: string[];
  years: number[];
  minRating: number;
  qualities: string[];
}

export const EMPTY_FACETS: Facets = { genres: [], years: [], minRating: 0, qualities: [] };

export function activeFacetCount(f: Facets): number {
  return f.genres.length + f.years.length + f.qualities.length + (f.minRating > 0 ? 1 : 0);
}

export function toggleIn<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function deriveDecades(items: MediaItem[]): number[] {
  const seen = new Set<number>();
  for (const item of items) if (item.year) seen.add(Math.floor(item.year / 10) * 10);
  return [...seen].sort((a, b) => b - a).slice(0, 8);
}

export function splitGenres(genre: string | undefined): string[] {
  return genre ? genre.split(/[,/|]/).map((g) => g.trim()) : [];
}

export function deriveGenres(items: MediaItem[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const name of splitGenres(item.genre)) {
      if (name.length > 1) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([g]) => g);
}

export function applyFacets(items: MediaItem[], f: Facets): MediaItem[] {
  if (!f.genres.length && !f.years.length && !f.minRating && !f.qualities.length) return items;
  const decades = new Set(f.years);
  return items.filter((item) => {
    if (f.minRating && (item.rating ?? 0) < f.minRating) return false;
    if (decades.size) {
      const decade = item.year ? Math.floor(item.year / 10) * 10 : undefined;
      if (decade === undefined || !decades.has(decade)) return false;
    }
    if (f.genres.length) {
      const genre = item.genre ?? '';
      if (!f.genres.some((g) => genre.includes(g))) return false;
    }
    if (f.qualities.length) {
      const upper = item.name.toUpperCase();
      if (!f.qualities.some((q) => upper.includes(q))) return false;
    }
    return true;
  });
}

export type SortKey = 'provider' | 'name' | 'rating' | 'year' | 'added';

export function sortItems(items: MediaItem[], key: SortKey): MediaItem[] {
  if (key === 'provider') return items;
  const copy = items.slice();
  switch (key) {
    case 'name': return copy.sort((a, b) => a.title.localeCompare(b.title));
    case 'rating': return copy.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    case 'year': return copy.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    case 'added': return copy.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
  }
}
