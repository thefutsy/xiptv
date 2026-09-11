import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  Category,
  Episode,
  MediaItem,
  MediaKind,
  SeriesDetail,
} from '@shared/types';

import { PREFIX_CODES, SERVICE_CODES } from '@shared/text';

import { redactText } from './redact.js';

/** Some providers gate their API/streams on a player-ish User-Agent. VLC is universally allowed. */
const USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';

const DEFAULT_TIMEOUT_MS = 30_000;

/** `get_series` with no category returns 28 MB in ~190 s. Anything less than this will abort it. */
const ALL_ITEMS_TIMEOUT_MS = 420_000;

/** Provider sentinel meaning "this channel has no EPG", alongside `null` and `""`. */
export const NO_EPG_CHANNEL = '#.No.Channel.#';


/**
 * Decorative separators the provider sprinkles through names and category labels.
 * `-` is last so it is a literal inside the character classes below.
 */
const DECOR_CHARS = '★❖✪◉▣●✺✦✧✩✰☆◆◇■□▪▫•○►▶➤※»«|—–-';

const LEADING_DECOR_RE = new RegExp(`^[\\s${DECOR_CHARS}]+`);
const TRAILING_DECOR_RE = new RegExp(`[\\s${DECOR_CHARS}]+$`);

/**
 * Glyphs that never occur inside a real channel or film name. Deliberately excludes `-`, `|`,
 * `—` and `–`, which do occur in genuine titles, so those need the stricter rule below.
 */
const GLYPH_CHARS = '★❖✪◉▣●✺✦✧✩✰☆◆◇■□▪▫•○►▶➤※»«';

const GLYPH_PREFIX_RE = new RegExp(`^[\\p{L}\\p{N}][\\p{L}\\p{N}\\s./-]{0,11}?\\s*[${GLYPH_CHARS}]+\\s*`, 'u');

const PIPE_PREFIX_RE = /^[A-Z]{2,5}\s*\|\s*/;

/**
 * `UK - BBC 1 UHD` -> `BBC 1 UHD`. Only a token on `PREFIX_CODES` or `SERVICE_CODES` is stripped,
 * and the dash has to be followed by a space, so `MI-5` and `NCIS - Los Angeles` survive intact.
 */
const DASH_PREFIX_RE = /^([\p{L}\p{N}]{2,5})\s*[-\u2013\u2014]\s+/u;

function stripDashPrefix(s: string): string {
  const m = DASH_PREFIX_RE.exec(s);
  if (!m) return s;
  const code = m[1].toUpperCase();
  if (!PREFIX_CODES.has(code) && !SERVICE_CODES.has(code)) return s;
  return s.slice(m[0].length);
}

const TRAILING_YEAR_RE = /\s*[-–—([]\s*(?:19|20)\d{2}\s*[)\]]?\s*$/;

/**
 * A bracketed tag a provider hangs off the end of a title, either a year or a language note like
 * `(Multi-Audio)` and `(MULTI-SUBS)`. A country such as `(US)` is left alone, since it is what
 * tells `The Office (US)` from `The Office`.
 */
const TAG_RE = /^(?:(?:19|20)\d{2}|multi[\s-]*(?:audio|subs?|lang(?:uage)?s?)|dual[\s-]*audio|(?:sub|dub)bed|multisub)$/i;

const TAIL_GROUP_RE = /\s*[([]\s*([^()[\]]{1,24}?)\s*[)\]]\s*$/;

/**
 * Peels bracketed groups off the end. A tag is dropped, a country code is put back once the tags
 * behind it are gone, and anything else stops the walk.
 *
 * `Man on Fire (2026) (US)` -> `Man on Fire (US)`
 */
function stripTrailingTags(input: string): string {
  let s = input;
  const kept: string[] = [];
  for (let i = 0; i < 5; i++) {
    const m = TAIL_GROUP_RE.exec(s);
    if (!m) break;
    const inner = m[1].trim();
    if (TAG_RE.test(inner)) { s = s.slice(0, m.index); continue; }
    if (/^[A-Z]{2,3}$/.test(inner)) { kept.unshift(`(${inner})`); s = s.slice(0, m.index); continue; }
    break;
  }
  s = s.replace(TRAILING_DECOR_RE, '');
  return kept.length && s.length ? `${s} ${kept.join(' ')}` : s;
}

/** `##### [UK] ENTERTAINMENT #####` is a section divider the provider ships as a channel row. */
const SEPARATOR_RE = /^\s*[#=*_]{3,}.*[#=*_]{3,}\s*$/;

export function isSeparatorName(name: string): boolean {
  return SEPARATOR_RE.test(name);
}

const TRAILING_YEAR_CAPTURE_RE = /[-–—([]\s*((?:19|20)\d{2})\s*[)\]]?\s*$/;

/** `releaseDate` / `air_date` fields arrive as `2025-07-16`. */
const ISO_DATE_RE = /^((?:19|20)\d{2})-\d{2}-\d{2}/;

const MULTI_SPACE_RE = /\s{2,}/g;

/**
 * Strip provider decoration from a raw name for display.
 *
 * `EN ★ Soumsoum, the Night of the Stars - 2026` -> `Soumsoum, the Night of the Stars`
 * `UK ★ BBC NEWS FHD`                            -> `BBC NEWS FHD`
 * `UK - BBC 1 UHD`                               -> `BBC 1 UHD`
 *
 * Quality tags are deliberately kept: on live channels `FHD`/`4K` is the only thing that
 * distinguishes otherwise identical entries. Never returns an empty string for a non-empty input.
 */
export function cleanTitle(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';

  let s = raw.replace(TRAILING_DECOR_RE, '').replace(LEADING_DECOR_RE, '');
  for (let i = 0; i < 3; i++) {
    const stripped = s
      .replace(GLYPH_PREFIX_RE, '')
      .replace(PIPE_PREFIX_RE, '');
    const dashed = stripDashPrefix(stripped).replace(LEADING_DECOR_RE, '');
    if (dashed === s || dashed.length === 0) break;
    s = dashed;
  }
  let undecorated = s.replace(TRAILING_DECOR_RE, '');
  // `Title (Multi-Audio) (2025)` sheds one tag per pass.
  for (let i = 0; i < 4; i++) {
    const next = stripTrailingTags(undecorated).replace(TRAILING_YEAR_RE, '').replace(TRAILING_DECOR_RE, '');
    if (next === undecorated || next.length === 0) break;
    undecorated = next;
  }
  s = undecorated;
  if (s.includes('  ')) s = s.replace(MULTI_SPACE_RE, ' ');
  s = s.trim();

  return s.length > 0 ? s : raw.trim();
}

/** `01:52:33` or `52:33` → seconds. Providers that lack `duration_secs` usually still send this. */
export function parseHms(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(raw.trim());
  if (!m) return undefined;
  const secs = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return secs > 0 ? secs : undefined;
}

/**
 * Release year from a raw name (`... - 2026`) or an ISO date (`2025-07-16`).
 *
 * Only an explicitly delimited year counts, so `Blade Runner 2049` is not mistaken for a 2049
 * release.
 */
export function parseYear(raw: string): number | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;

  const iso = ISO_DATE_RE.exec(raw);
  if (iso) return Number(iso[1]);

  const trailing = TRAILING_YEAR_CAPTURE_RE.exec(raw);
  if (trailing) return Number(trailing[1]);

  // In `Man on Fire (2026) (US)` the year sits one tag in from the end.
  const bracketed = [...raw.matchAll(/[([]\s*((?:19|20)\d{2})\s*[)\]]/g)].pop();
  if (bracketed) return Number(bracketed[1]);

  return undefined;
}

type Row = Record<string, unknown>;

function isRecord(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Accepts numbers because the provider mixes types in the same field. */
function str(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.length === 0) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function bool(v: unknown): boolean {
  return v === 1 || v === '1' || v === true;
}

/**
 * Coerce a response that *should* be an array into one.
 *
 * The provider answers `get_live_streams&category_id=<bogus>` with `[]`, but answers an expired
 * or wrong login with `{"error":"Authentication failed"}` and some deployments answer with the
 * `{"user_info":...}` auth blob regardless of `action`. None of those may crash a grid load.
 */
function asRows(raw: unknown, context: string): Row[] {
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (isRecord(raw)) {
    const err = str(raw.error) ?? str(raw.message);
    console.warn(`[xtream] ${context}: expected an array, got an object${err ? ` (${err})` : ''}`);
  } else if (raw !== null && raw !== undefined) {
    console.warn(`[xtream] ${context}: expected an array, got ${typeof raw}`);
  }
  return [];
}

function normalizeEpgChannelId(v: unknown): string | undefined {
  const s = str(v);
  if (s === undefined || s === NO_EPG_CHANNEL) return undefined;
  return s;
}

/**
 * Normalise a source url to a scheme + host[:port] with no trailing slash, dropping any path the
 * user pasted (`.../player_api.php`, `.../c/`) since we build our own.
 *
 * Deliberately not done with `new URL()`: that lower-cases the host, and providers of this kind
 * embed the account name in the hostname (`A7KP2QX9.cdn.example.com`). DNS does not care, but
 * rewriting what the user typed is a surprise we do not need.
 */
const BASE_URL_RE = /^(https?:\/\/)?([^/?#]+)/i;

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  const m = BASE_URL_RE.exec(trimmed);
  if (!m) return trimmed.replace(/\/+$/, '');
  const scheme = m[1] ?? 'http://';
  return `${scheme.toLowerCase()}${m[2]}`;
}

function safeExtension(ext: string | undefined, fallback: string): string {
  if (!ext) return fallback;
  const cleaned = ext.trim().replace(/^\.+/, '').toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(cleaned) ? cleaned : fallback;
}


export class XtreamError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'XtreamError';
    this.status = status;
  }
}

async function errorMessageFromBody(res: Response): Promise<string> {
  const statusLine = `HTTP ${res.status} ${res.statusText || ''}`.trim();
  try {
    const text = (await res.text()).slice(0, 500).trim();
    if (text.length === 0) return statusLine;
    if (text.startsWith('{')) {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        const msg = str(parsed.error) ?? str(parsed.message);
        if (msg) return msg;
      }
    }
    return statusLine;
  } catch {
    return statusLine;
  }
}

/**
 * Scrubs credentials out of an error message. `apiUrl()` puts the password in a query string, and
 * a provider that echoes the request back in an HTML error body would carry it into the message
 * verbatim.
 */
function describeError(err: unknown): string {
  return redactText(describeErrorRaw(err));
}

function describeErrorRaw(err: unknown): string {
  if (err instanceof XtreamError) return err.message;
  if (err instanceof Error) {
    // AbortSignal.timeout() surfaces as a TimeoutError DOMException through fetch.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'Request timed out';
    // undici wraps DNS/ECONNREFUSED in a terse "fetch failed"; the cause has the detail.
    const cause = (err as { cause?: unknown }).cause;
    if (err.message === 'fetch failed' && cause instanceof Error) return cause.message;
    return err.message;
  }
  return String(err);
}


export interface XtreamClientOptions {
  url: string;
  username: string;
  password: string;
  timeoutMs?: number;
}

export interface AuthResult {
  ok: boolean;
  message: string;
  maxConnections: number;
  status: string;
  expiresAtSeconds?: number;
}

export type AllItemsProgress =
  | { phase: 'downloading'; kind: MediaKind; receivedBytes: number }
  | { phase: 'complete'; kind: MediaKind; receivedBytes: number; items: number };

interface RequestOptions {
  timeoutMs?: number;
  retries?: number;
  onBytes?: (received: number) => void;
}

export class XtreamClient {
  readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;

  constructor(opts: XtreamClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.url);
    this.username = opts.username;
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  }


  private apiUrl(params: Record<string, string | number>): string {
    const q = new URLSearchParams({ username: this.username, password: this.password });
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    return `${this.baseUrl}/player_api.php?${q.toString()}`;
  }

  private async request(
    params: Record<string, string | number>,
    opts: RequestOptions = {},
  ): Promise<unknown> {
    const url = this.apiUrl(params);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const retries = opts.retries ?? 1;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.requestOnce(url, timeoutMs, opts.onBytes);
      } catch (err) {
        lastError = err;
        const status = err instanceof XtreamError ? err.status : undefined;
        const retryable =
          attempt < retries &&
          (status === undefined || status >= 500 || status === 429) &&
          !(err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'));
        if (!retryable) break;
        await delay(500);
      }
    }
    throw lastError instanceof XtreamError
      ? lastError
      : new XtreamError(describeError(lastError));
  }

  private async requestOnce(
    url: string,
    timeoutMs: number,
    onBytes?: (received: number) => void,
  ): Promise<unknown> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new XtreamError(await errorMessageFromBody(res), res.status);
    }

    const text = onBytes ? await readTextWithProgress(res, onBytes) : await res.text();
    if (text.trim().length === 0) {
      // Seen in the wild: 200 with a zero-byte body. Treat as "nothing", not as a parse error.
      return null;
    }

    try {
      // Strip a UTF-8 BOM: the provider emits one on some endpoints and JSON.parse chokes on it.
      return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      // Seen for real on the 28 MB `get_series` dump when the origin was under load: a 200 with
      // a body that stops mid-object.
      const preview = text.slice(0, 120).replace(/\s+/g, ' ');
      throw new XtreamError(`Provider returned unparseable JSON (${text.length} chars): ${preview}`);
    }
  }


  /** Never throws. Transport failures come back as `ok: false`. */
  async auth(): Promise<AuthResult> {
    let raw: unknown;
    try {
      raw = await this.request({});
    } catch (err) {
      const httpStatus = err instanceof XtreamError ? err.status : undefined;
      const rejected = httpStatus === 401 || httpStatus === 403;
      return {
        ok: false,
        message: describeError(err),
        maxConnections: 0,
        status: rejected ? 'Failed' : 'Unreachable',
      };
    }

    if (!isRecord(raw)) {
      return { ok: false, message: 'Unexpected response from provider', maxConnections: 0, status: 'Unknown' };
    }

    // Wrong credentials answer `{"error":"Authentication failed"}`, not an auth blob.
    const topLevelError = str(raw.error);
    if (topLevelError) {
      return { ok: false, message: topLevelError, maxConnections: 0, status: 'Failed' };
    }

    const info = isRecord(raw.user_info) ? raw.user_info : undefined;
    if (!info) {
      return { ok: false, message: 'Provider did not return account info', maxConnections: 0, status: 'Unknown' };
    }

    const status = str(info.status) ?? 'Unknown';
    const authed = bool(info.auth);
    const active = status.toLowerCase() === 'active';
    const maxConnections = num(info.max_connections) ?? 1;
    const expiresAtSeconds = num(info.exp_date);

    let message: string;
    if (!authed) message = str(info.message) ?? 'Authentication failed';
    else if (!active) message = `Account status: ${status}`;
    else message = str(info.message) ?? 'Connected';

    return {
      ok: authed && active,
      message,
      maxConnections,
      status,
      ...(expiresAtSeconds !== undefined && expiresAtSeconds > 0 ? { expiresAtSeconds } : {}),
    };
  }


  async categories(kind: MediaKind): Promise<Category[]> {
    const action =
      kind === 'live'
        ? 'get_live_categories'
        : kind === 'movie'
          ? 'get_vod_categories'
          : 'get_series_categories';

    const rows = asRows(await this.request({ action }), action);
    const out: Category[] = [];
    for (const row of rows) {
      const id = str(row.category_id);
      if (id === undefined) continue;
      // The raw label is kept: the `EN`/`FR`/`VIP` prefix is the only thing separating the
      // ~451 live categories from each other.
      out.push({ id, name: str(row.category_name) ?? id, kind });
    }
    return out;
  }

  async items(kind: MediaKind, categoryId: string): Promise<MediaItem[]> {
    const action = listAction(kind);
    const raw = await this.request({ action, category_id: categoryId });
    return this.mapItems(asRows(raw, `${action}&category_id=${categoryId}`), kind, categoryId);
  }

  /**
   * Full catalogue dump. `MediaItem.id` is NOT unique here: the provider lists the same stream in
   * several categories (23,607 live rows for 21,562 distinct stream ids), so anything keying by id
   * must dedupe.
   */
  async allItems(kind: MediaKind, onProgress?: (p: AllItemsProgress) => void): Promise<MediaItem[]> {
    const action = listAction(kind);
    let receivedBytes = 0;

    const raw = await this.request(
      { action },
      {
        timeoutMs: ALL_ITEMS_TIMEOUT_MS,
        onBytes: onProgress
          ? (n) => {
              receivedBytes = n;
              onProgress({ phase: 'downloading', kind, receivedBytes: n });
            }
          : undefined,
      },
    );

    const items = this.mapItems(asRows(raw, action), kind);
    onProgress?.({ phase: 'complete', kind, receivedBytes, items: items.length });
    return items;
  }

  private mapItems(rows: Row[], kind: MediaKind, fallbackCategoryId = ''): MediaItem[] {
    const out: MediaItem[] = [];
    for (const row of rows) {
      const item =
        kind === 'live'
          ? mapLive(row, fallbackCategoryId)
          : kind === 'movie'
            ? mapMovie(row, fallbackCategoryId)
            : mapSeries(row, fallbackCategoryId);
      if (item) out.push(item);
    }
    return out;
  }

  /**
   * `get_vod_info` splits what `get_vod_streams` returns as one row across two objects:
   * `movie_data` carries the playable fields (stream id, container) and `info` the descriptive
   * ones, under slightly different names.
   */
  async vodDetail(vodId: string): Promise<MediaItem> {
    const raw = await this.request({ action: 'get_vod_info', vod_id: vodId });
    if (!isRecord(raw)) throw new XtreamError(`No film info returned for ${vodId}`);
    const err = str(raw.error);
    if (err) throw new XtreamError(err);

    const info = isRecord(raw.info) ? raw.info : {};
    const data = isRecord(raw.movie_data) ? raw.movie_data : {};
    // An unknown id comes back as a well-formed response with both halves empty, not as an error.
    if (Object.keys(data).length === 0 && Object.keys(info).length === 0) {
      throw new XtreamError(`No film found for ${vodId}`);
    }

    const row: Row = {
      ...info,
      ...data,
      stream_id: data.stream_id ?? vodId,
      stream_icon: info.movie_image ?? info.cover_big,
      cover: info.cover_big ?? info.movie_image,
    };
    const item = mapMovie(row, str(data.category_id) ?? '');
    if (!item) throw new XtreamError(`Film ${vodId} could not be read`);
    return item;
  }

  async seriesDetail(seriesId: string): Promise<SeriesDetail> {
    const raw = await this.request({ action: 'get_series_info', series_id: seriesId });
    if (!isRecord(raw)) {
      throw new XtreamError(`No series info returned for ${seriesId}`);
    }
    const err = str(raw.error);
    if (err) throw new XtreamError(err);

    const info = isRecord(raw.info) ? raw.info : {};
    const item =
      mapSeries({ ...info, series_id: info.series_id ?? seriesId }, str(info.category_id) ?? '') ??
      fallbackSeriesItem(seriesId, info);

    const episodes: Record<number, Episode[]> = {};
    // `episodes` is normally `{ "1": [...], "2": [...] }` but some deployments send an array.
    const buckets: Array<[string, unknown]> = Array.isArray(raw.episodes)
      ? raw.episodes.map((v, i) => [String(i + 1), v] as [string, unknown])
      : isRecord(raw.episodes)
        ? Object.entries(raw.episodes)
        : [];

    for (const [key, value] of buckets) {
      if (!Array.isArray(value)) continue;
      const seasonFromKey = num(key);
      const list: Episode[] = [];
      for (const entry of value) {
        if (!isRecord(entry)) continue;
        const ep = mapEpisode(entry, seriesId, seasonFromKey ?? 1, list.length + 1);
        if (ep) list.push(ep);
      }
      if (list.length === 0) continue;
      const season = list[0].season;
      episodes[season] = (episodes[season] ?? []).concat(list);
    }

    for (const list of Object.values(episodes)) {
      list.sort((a, b) => a.episodeNum - b.episodeNum);
    }

    // The provider's `seasons` array routinely declares seasons it has no files for. "Law &
    // Order" declares season 0 (specials) and season 26, both empty.
    const withEpisodes = Object.keys(episodes)
      .map(Number)
      .sort((a, b) => a - b);
    const declared = Array.isArray(raw.seasons)
      ? Array.from(
          new Set(
            raw.seasons
              .filter(isRecord)
              .map((s) => num(s.season_number))
              .filter((n): n is number => n !== undefined),
          ),
        ).sort((a, b) => a - b)
      : [];
    const seasons = withEpisodes.length > 0 ? withEpisodes : declared;
    for (const season of seasons) episodes[season] ??= [];

    return {
      item: { ...item, seasonCount: seasons.length || undefined },
      seasons,
      episodes,
    };
  }



  /**
   * Direct provider stream url. All three forms 302-redirect to a token-signed CDN host, so the
   * consumer must follow redirects.
   *
   * Defaults match what this provider actually serves: live is MPEG-TS, VOD is `mkv` for 99.8%
   * of titles, series episodes are usually `mp4`.
   */
  streamUrl(kind: MediaKind, streamId: number, containerExtension?: string): string {
    const u = encodeURIComponent(this.username);
    const p = encodeURIComponent(this.password);
    switch (kind) {
      case 'live':
        return `${this.baseUrl}/live/${u}/${p}/${streamId}.${safeExtension(containerExtension, 'ts')}`;
      case 'movie':
        return `${this.baseUrl}/movie/${u}/${p}/${streamId}.${safeExtension(containerExtension, 'mkv')}`;
      case 'series':
        return `${this.baseUrl}/series/${u}/${p}/${streamId}.${safeExtension(containerExtension, 'mp4')}`;
    }
  }

  /** The 126 MB XMLTV dump. Must be consumed with a streaming parser, never buffered whole. */
  xmltvUrl(): string {
    const q = new URLSearchParams({ username: this.username, password: this.password });
    return `${this.baseUrl}/xmltv.php?${q.toString()}`;
  }
}


function listAction(kind: MediaKind): string {
  return kind === 'live' ? 'get_live_streams' : kind === 'movie' ? 'get_vod_streams' : 'get_series';
}

function mapLive(row: Row, fallbackCategoryId: string): MediaItem | undefined {
  const streamId = num(row.stream_id);
  if (streamId === undefined) return undefined;
  const name = str(row.name) ?? `Channel ${streamId}`;
  if (isSeparatorName(name)) return undefined;

  return {
    id: `live:${streamId}`,
    kind: 'live',
    name,
    title: cleanTitle(name),
    categoryId: str(row.category_id) ?? fallbackCategoryId,
    logo: str(row.stream_icon),
    streamId,
    epgChannelId: normalizeEpgChannelId(row.epg_channel_id),
    hasArchive: bool(row.tv_archive),
    addedAt: num(row.added),
  };
}

function mapMovie(row: Row, fallbackCategoryId: string): MediaItem | undefined {
  const streamId = num(row.stream_id);
  if (streamId === undefined) return undefined;
  const name = str(row.name) ?? `Movie ${streamId}`;

  return {
    id: `movie:${streamId}`,
    kind: 'movie',
    name,
    title: cleanTitle(name),
    categoryId: str(row.category_id) ?? fallbackCategoryId,
    logo: str(row.stream_icon) ?? str(row.cover),
    streamId,
    containerExtension: str(row.container_extension),
    rating: num(row.rating),
    year: parseYear(name),
    plot: str(row.plot) ?? str(row.description),
    genre: str(row.genre),
    cast: str(row.cast) ?? str(row.actors),
    director: str(row.director),
    backdrop: firstBackdrop(row.backdrop_path),
    durationSecs: num(row.duration_secs) ?? parseHms(str(row.duration)),
    addedAt: num(row.added),
  };
}

function mapSeries(row: Row, fallbackCategoryId: string): MediaItem | undefined {
  const seriesId = num(row.series_id);
  if (seriesId === undefined) return undefined;
  const name = str(row.name) ?? `Series ${seriesId}`;
  const releaseDate = str(row.releaseDate) ?? str(row.release_date);

  return {
    id: `series:${seriesId}`,
    kind: 'series',
    name,
    title: cleanTitle(name),
    categoryId: str(row.category_id) ?? fallbackCategoryId,
    logo: str(row.cover),
    streamId: seriesId,
    rating: num(row.rating),
    year: (releaseDate ? parseYear(releaseDate) : undefined) ?? parseYear(name),
    plot: str(row.plot),
    genre: str(row.genre),
    cast: str(row.cast),
    director: str(row.director),
    backdrop: firstBackdrop(row.backdrop_path),
    addedAt: num(row.last_modified) ?? num(row.added),
  };
}

/** `backdrop_path` is an array of urls, occasionally a bare string. Take the first usable one. */
function firstBackdrop(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    for (const entry of v) {
      const s = str(entry);
      if (s) return s;
    }
    return undefined;
  }
  return str(v);
}

function fallbackSeriesItem(seriesId: string, info: Row): MediaItem {
  const name = str(info.name) ?? `Series ${seriesId}`;
  return {
    id: `series:${seriesId}`,
    kind: 'series',
    name,
    title: cleanTitle(name),
    categoryId: str(info.category_id) ?? '',
    logo: str(info.cover),
    streamId: num(seriesId) ?? 0,
    plot: str(info.plot),
    genre: str(info.genre),
    cast: str(info.cast),
    director: str(info.director),
    backdrop: firstBackdrop(info.backdrop_path),
    rating: num(info.rating),
    year: parseYear(str(info.releaseDate) ?? name),
  };
}

function mapEpisode(
  row: Row,
  seriesId: string,
  seasonFromKey: number,
  positionFallback: number,
): Episode | undefined {
  // The episode id is what goes into /series/U/P/<id>.<ext>, so it is mandatory.
  const streamId = num(row.id);
  if (streamId === undefined) return undefined;

  const info = isRecord(row.info) ? row.info : {};
  const rawTitle = str(row.title) ?? `Episode ${positionFallback}`;

  return {
    id: str(row.id) ?? String(streamId),
    seriesId,
    season: num(row.season) ?? seasonFromKey,
    episodeNum: num(row.episode_num) ?? positionFallback,
    title: cleanTitle(rawTitle),
    plot: str(info.plot) ?? str(info.description),
    image: str(info.movie_image) ?? str(info.cover_big) ?? str(row.cover),
    durationSecs: num(info.duration_secs),
    containerExtension: str(row.container_extension),
    streamId,
  };
}

async function readTextWithProgress(
  res: Response,
  onBytes: (received: number) => void,
): Promise<string> {
  const body = res.body;
  if (!body) return res.text();

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const chunks: string[] = [];
  let received = 0;
  let lastReport = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
      if (received - lastReport >= 512 * 1024) {
        lastReport = received;
        onBytes(received);
      }
    }
  } finally {
    reader.releaseLock();
  }

  chunks.push(decoder.decode());
  onBytes(received);
  return chunks.join('');
}
