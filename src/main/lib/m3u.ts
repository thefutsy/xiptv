import { createReadStream } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import type { Category, MediaItem, MediaKind } from '@shared/types';

import { redactUrl } from './redact.js';
import { NO_EPG_CHANNEL } from './xtream.js';

export interface M3uParseResult {
  items: MediaItem[];
  categories: Category[];
  epgUrl?: string;
  /**
   * Item id to stream URL. An M3U entry carries its URL inline and nothing else can rebuild it,
   * so the caller has to hold this for as long as the items are live.
   */
  urls: ReadonlyMap<string, string>;
}



const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
/** A body that keeps sending bytes forever is not a playlist. Bound the whole download as well
 * as the per-socket idle timeout, while still allowing large playlists several minutes to land. */
const MAX_PLAYLIST_TIME_MS = 5 * 60_000;
const MAX_WIRE_BYTES = 600 * 1024 * 1024;
const MAX_TEXT_CHARS = 300_000_000;
const PROGRESS_STEP_BYTES = 512 * 1024;
/** Several Xtream panels 403/404 anything that is not a known player; VLC is the safe UA. */
const USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';

const MAX_STREAM_ID = Number.MAX_SAFE_INTEGER;
const FALLBACK_GROUP = 'Uncategorised';
/** Placeholder this provider uses instead of a real XMLTV id; means "no EPG". */
const NO_EPG_CHANNEL_FOLDED = NO_EPG_CHANNEL.toLowerCase();

const CHAR_TAB = 9;
const CHAR_LF = 10;
const CHAR_CR = 13;
const CHAR_SPACE = 32;
const CHAR_QUOTE = 34;
const CHAR_HASH = 35;
const CHAR_COMMA = 44;
const CHAR_EQUALS = 61;
const CHAR_BACKSLASH = 92;
const BOM = 0xfeff;

class PlaylistError extends Error {
  override readonly name = 'PlaylistError';
}


const GROUP_MOVIE_RE = /\b(vod|movies?|films?|cinema)\b/;
const GROUP_SERIES_RE = /\b(series?|tv shows?|shows?|seasons?)\b/;
const EPISODE_RE = /\bs\d{1,3}[\s._-]*e\d{1,3}\b/i;
const VIDEO_CONTAINER_RE = /\.(mkv|mp4|avi|mov)$/;

const groupKindCache = new Map<string, MediaKind | undefined>();

function groupKind(group: string): MediaKind | undefined {
  if (group === '') return undefined;
  if (groupKindCache.has(group)) return groupKindCache.get(group);

  // Strip diacritics so "Séries FR" and "PELÍCULAS" still hit the ASCII word patterns.
  const normalised = group.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const movie = GROUP_MOVIE_RE.test(normalised);
  const series = GROUP_SERIES_RE.test(normalised);
  // "VOD | SERIES A-Z" matches both patterns; the series marker is the more specific one.
  const kind: MediaKind | undefined = series ? 'series' : movie ? 'movie' : undefined;

  if (groupKindCache.size > 4096) groupKindCache.clear();
  groupKindCache.set(group, kind);
  return kind;
}

/**
 * M3U has no notion of live vs VOD vs series, so this function infers it. Playlists exported from
 * an Xtream panel keep /live/, /movie/ and /series/ in the URL path; the rest is a heuristic.
 */
export function classifyEntry(name: string, group: string, url: string): MediaKind {
  const path = urlPath(url).toLowerCase();

  if (path.includes('/movie/')) return 'movie';
  if (path.includes('/series/')) return 'series';
  if (path.includes('/live/')) return 'live';

  const byGroup = groupKind(group);
  if (byGroup !== undefined) return byGroup;

  if (EPISODE_RE.test(name)) return 'series';
  if (VIDEO_CONTAINER_RE.test(path)) return 'movie';

  return 'live';
}

function urlPath(url: string): string {
  let end = url.length;
  const hash = url.indexOf('#');
  if (hash !== -1) end = hash;
  const query = url.indexOf('?');
  if (query !== -1 && query < end) end = query;
  return end === url.length ? url : url.slice(0, end);
}


function hashUrl(url: string): number {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0xc2b2ae35 | 0;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  h1 ^= h1 >>> 15;
  h2 ^= h2 >>> 13;
  const hi = (h1 >>> 11) & 0x1fffff;
  const lo = h2 >>> 0;
  const value = hi * 0x100000000 + lo;
  return value === 0 ? 1 : value;
}


/**
 * Providers decorate names and groups with a country tag plus a symbol: `EN ★ Netflix`,
 * `US ❖ NEWS`, `VIP ◉ 4K`. Strip that for display; `MediaItem.name` keeps the original
 * so search still matches what the provider called it.
 */
const DECORATION_RE =
  /^[\s|]*(?:[A-Z0-9]{1,5}[\s|:-]*)?[★☆✪✫✬✭✮✯✰◉◎●○◆◇■□▪▫❖✦✧✶✷✸✹✺⁕※▶►➤‣•|]+[\s|:-]*/u;

function cleanTitle(name: string): string {
  let out = name.trim();
  // Two passes, because `VIP ❖ EN ★ Name` happens.
  for (let pass = 0; pass < 2; pass++) {
    const stripped = out.replace(DECORATION_RE, '');
    if (stripped === out) break;
    out = stripped;
  }
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out === '' ? name.trim() : out;
}

const YEAR_RE = /\((19\d{2}|20\d{2})\)/;

function containerExtension(url: string): string | undefined {
  const path = urlPath(url);
  const dot = path.lastIndexOf('.');
  if (dot === -1 || dot < path.lastIndexOf('/')) return undefined;
  const ext = path.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : undefined;
}

function nameFromUrl(url: string): string {
  const path = urlPath(url);
  const slash = path.lastIndexOf('/');
  const base = slash === -1 ? path : path.slice(slash + 1);
  if (base === '') return url;
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}


function isSpace(code: number): boolean {
  return code === CHAR_SPACE || code === CHAR_TAB;
}

/**
 * Walk `key=value` pairs in `text[start, end)` and hand each one to `assign`.
 *
 * Only `"` counts as a quote. Single quotes deliberately do not: an apostrophe inside an
 * unquoted value (`tvg-name=L'Equipe`) is far more common in real playlists than a
 * single-quoted attribute, and treating `'` as a quote would swallow the rest of the line.
 * Values may be quoted or bare; bare values end at whitespace or a comma. `\"` is honoured
 * inside a quoted value.
 */
function scanAttributes<T>(
  text: string,
  start: number,
  end: number,
  target: T,
  assign: (target: T, key: string, value: string) => void,
): void {
  let i = start;
  while (i < end) {
    const c = text.charCodeAt(i);
    if (isSpace(c) || c === CHAR_COMMA) {
      i++;
      continue;
    }

    const keyStart = i;
    while (i < end) {
      const k = text.charCodeAt(i);
      if (k === CHAR_EQUALS || isSpace(k)) break;
      i++;
    }
    // A token with no `=` is the EXTINF duration or junk between attributes.
    if (i >= end || text.charCodeAt(i) !== CHAR_EQUALS) continue;
    const key = text.slice(keyStart, i).toLowerCase();
    i++;

    let value: string;
    if (i < end && text.charCodeAt(i) === CHAR_QUOTE) {
      i++;
      const valueStart = i;
      let escaped = false;
      while (i < end) {
        const v = text.charCodeAt(i);
        if (v === CHAR_BACKSLASH && i + 1 < end) {
          escaped = true;
          i += 2;
          continue;
        }
        if (v === CHAR_QUOTE) break;
        i++;
      }
      value = text.slice(valueStart, i);
      if (escaped) value = value.replace(/\\(.)/g, '$1');
      if (i < end) i++;
    } else {
      const valueStart = i;
      while (i < end && !isSpace(text.charCodeAt(i)) && text.charCodeAt(i) !== CHAR_COMMA) i++;
      value = text.slice(valueStart, i);
    }

    assign(target, key, value);
  }
}


interface ExtInf {
  name: string;
  tvgId: string;
  tvgName: string;
  logo: string;
  group: string;
  hasArchive: boolean;
}

function emptyExtInf(): ExtInf {
  return { name: '', tvgId: '', tvgName: '', logo: '', group: '', hasArchive: false };
}

function assignExtInfAttr(info: ExtInf, key: string, value: string): void {
  switch (key) {
    case 'tvg-id':
    case 'channel-id':
      info.tvgId = value;
      break;
    case 'tvg-name':
      info.tvgName = value;
      break;
    case 'tvg-logo':
    case 'logo':
      info.logo = value;
      break;
    case 'group-title':
    case 'group':
      info.group = value;
      break;
    case 'catchup':
    case 'catchup-type':
    case 'catchup-source':
    case 'catchup-days':
    case 'tvg-rec':
    case 'timeshift':
      if (isTruthyAttr(value)) info.hasArchive = true;
      break;
    default:
      break;
  }
}

function isTruthyAttr(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'none';
}

function parseExtInf(text: string, start: number, end: number): ExtInf {
  // The display name is everything after the first comma that is *not* inside quotes. That
  // single rule keeps both `group-title="Kids, Family",My Show` and `-1,Lock, Stock` right,
  // which a naive first-comma or last-comma split gets wrong one way or the other.
  let split = -1;
  let inQuote = false;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (inQuote) {
      if (c === CHAR_BACKSLASH) i++;
      else if (c === CHAR_QUOTE) inQuote = false;
      continue;
    }
    if (c === CHAR_QUOTE) inQuote = true;
    else if (c === CHAR_COMMA) {
      split = i;
      break;
    }
  }
  // Unbalanced quotes: fall back to the last comma on the line, which is what the naive
  // parsers such playlists were written against would do.
  if (split === -1) {
    const last = text.lastIndexOf(',', end - 1);
    if (last >= start) split = last;
  }
  const attrEnd = split === -1 ? end : split;

  const info = emptyExtInf();
  if (attrEnd < end) info.name = text.slice(attrEnd + 1, end).trim();
  scanAttributes(text, start, attrEnd, info, assignExtInfAttr);
  if (info.name === '') info.name = info.tvgName;
  return info;
}

interface HeaderInfo {
  epgUrl: string;
}

function assignHeaderAttr(header: HeaderInfo, key: string, value: string): void {
  if (key !== 'url-tvg' && key !== 'x-tvg-url' && key !== 'tvg-url') return;
  if (header.epgUrl !== '') return;
  // The attribute may hold several comma-separated XMLTV urls; we can only use one.
  const first = value.split(',')[0]?.trim() ?? '';
  if (first !== '') header.epgUrl = first;
}

export function parseM3u(text: string): M3uParseResult {
  const items: MediaItem[] = [];
  const idToUrl = new Map<string, string>();
  const categories = new Map<string, Category>();
  let epgUrl = '';

  let pending: ExtInf | null = null;
  let extGrp = '';
  let pos = text.charCodeAt(0) === BOM ? 1 : 0;
  const len = text.length;

  while (pos <= len) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = len;
    let start = pos;
    let end = nl;
    pos = nl + 1;
    if (end > start && text.charCodeAt(end - 1) === CHAR_CR) end--;
    while (start < end && isSpace(text.charCodeAt(start))) start++;
    while (end > start && isSpace(text.charCodeAt(end - 1))) end--;
    if (start >= end) continue;

    if (text.charCodeAt(start) === CHAR_HASH) {
      if (text.startsWith('#EXTINF:', start)) {
        pending = parseExtInf(text, start + 8, end);
      } else if (text.startsWith('#EXTGRP:', start)) {
        // Sticky: an #EXTGRP applies to every following entry until the next one.
        extGrp = text.slice(start + 8, end).trim();
      } else if (epgUrl === '' && text.startsWith('#EXTM3U', start)) {
        const header: HeaderInfo = { epgUrl: '' };
        scanAttributes(text, start + 7, end, header, assignHeaderAttr);
        epgUrl = header.epgUrl;
      }
      continue;
    }

    const url = text.slice(start, end);
    const info = pending ?? emptyExtInf();
    pending = null;

    const name = info.name !== '' ? info.name : nameFromUrl(url);
    const group = info.group !== '' ? info.group : extGrp !== '' ? extGrp : FALLBACK_GROUP;
    const kind = classifyEntry(name, group, url);

    let streamId = hashUrl(url);
    let id = `${kind}:${streamId}`;
    let taken = idToUrl.get(id);
    if (taken !== undefined) {
      if (taken === url) continue;
      let guard = 0;
      do {
        streamId = streamId >= MAX_STREAM_ID ? 1 : streamId + 1;
        id = `${kind}:${streamId}`;
        taken = idToUrl.get(id);
      } while (taken !== undefined && taken !== url && ++guard < 64);
      if (taken !== undefined) continue;
    }
    idToUrl.set(id, url);

    const categoryId = `${kind}:${group}`;
    const category = categories.get(categoryId);
    if (category === undefined) {
      categories.set(categoryId, { id: categoryId, name: cleanTitle(group), kind, count: 1 });
    } else {
      category.count = (category.count ?? 0) + 1;
    }

    const item: MediaItem = {
      id,
      kind,
      name,
      title: cleanTitle(name),
      categoryId,
      streamId,
    };
    if (info.logo !== '') item.logo = info.logo;
    if (kind === 'live') {
      if (info.tvgId !== '' && info.tvgId.toLowerCase() !== NO_EPG_CHANNEL_FOLDED) item.epgChannelId = info.tvgId;
      if (info.hasArchive) item.hasArchive = true;
    } else {
      const ext = containerExtension(url);
      if (ext !== undefined) item.containerExtension = ext;
      const year = YEAR_RE.exec(name);
      if (year !== null) item.year = Number(year[1]);
    }
    items.push(item);
  }

  const kindOrder: Record<MediaKind, number> = { live: 0, movie: 1, series: 2 };
  const sorted = [...categories.values()].sort(
    (a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name),
  );

  return epgUrl === '' ? { items, categories: sorted, urls: idToUrl } : { items, categories: sorted, epgUrl, urls: idToUrl };
}


/**
 * Download (or read) a playlist and return its text.
 *
 * `timeoutMs` is an *idle* timeout on network reads, not a total deadline. A 200 MB
 * playlist can take minutes, but a socket that goes quiet for that long is dead. It stays
 * armed while the body streams, so a stalled download can never hang the app. Local files
 * are read without a timeout, because there is no socket to stall.
 *
 * Throws a descriptive `Error` on a non-2xx status, an empty body, or a body that is not
 * an M3U playlist.
 */
export async function fetchPlaylist(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  onProgress?: (bytes: number) => void,
): Promise<string> {
  const source = url.trim();
  if (source === '') throw new PlaylistError('Playlist URL is empty.');

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(source)?.[1]?.toLowerCase();
  let raw: string;
  if (scheme === 'http' || scheme === 'https') {
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      throw new PlaylistError(`Playlist URL is not valid: ${source}`);
    }
    raw = await fetchOverHttp(parsed, timeoutMs, onProgress);
  } else if (scheme === 'file') {
    let path: string;
    try {
      path = fileURLToPath(source);
    } catch {
      throw new PlaylistError(`Playlist file URL is not valid: ${source}`);
    }
    raw = await readLocalPlaylist(path, onProgress);
  } else if (scheme === undefined) {
    raw = await readLocalPlaylist(source, onProgress);
  } else {
    throw new PlaylistError(
      `Unsupported playlist URL scheme "${scheme}:". Use http://, https:// or a local file path.`,
    );
  }

  return assertPlaylistBody(raw, source);
}

async function readLocalPlaylist(path: string, onProgress?: (bytes: number) => void): Promise<string> {
  const stream = createReadStream(path);
  try {
    return await decodeBody(stream, '', onProgress);
  } catch (err) {
    if (err instanceof PlaylistError) throw err;
    const e = err as NodeJS.ErrnoException;
    switch (e.code) {
      case 'ENOENT':
        throw new PlaylistError(`Playlist file not found: ${path}`);
      case 'EACCES':
      case 'EPERM':
        throw new PlaylistError(`Playlist file is not readable: ${path}`);
      case 'EISDIR':
        throw new PlaylistError(`Playlist path is a directory, not a file: ${path}`);
      default:
        throw new PlaylistError(`Playlist file could not be read: ${path} (${e.message})`);
    }
  } finally {
    stream.destroy();
  }
}

async function fetchOverHttp(
  url: URL,
  timeoutMs: number,
  onProgress?: (bytes: number) => void,
): Promise<string> {
  let openDeadline: ReturnType<typeof setTimeout> | undefined;
  const res = await Promise.race([
    openHttp(url, timeoutMs),
    new Promise<IncomingMessage>((_, reject) => {
      openDeadline = setTimeout(() => reject(new PlaylistError(
        `Playlist connection timed out after ${Math.round(timeoutMs / 1000)} seconds from ${redactUrl(url)}.`,
      )), timeoutMs);
    }),
  ]).finally(() => {
    if (openDeadline !== undefined) clearTimeout(openDeadline);
  });
  const totalTimeoutMs = Math.max(timeoutMs, MAX_PLAYLIST_TIME_MS);
  const deadline = setTimeout(() => {
    res.destroy(new PlaylistError(
      `Playlist download timed out after ${Math.round(totalTimeoutMs / 1000)} seconds from ${redactUrl(url)}.`,
    ));
  }, totalTimeoutMs);
  try {
    const encoding = String(res.headers['content-encoding'] ?? '');
    return await decodeBody(res, encoding, onProgress);
  } catch (err) {
    const aborted = res.errored;
    if (aborted instanceof PlaylistError) throw aborted;
    if (err instanceof PlaylistError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new PlaylistError(`Playlist download failed while reading the body: ${message}`, { cause: err });
  } finally {
    clearTimeout(deadline);
    res.destroy();
  }
}

async function openHttp(initial: URL, timeoutMs: number): Promise<IncomingMessage> {
  let url = initial;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await sendRequest(url, timeoutMs);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;

    // This provider 302s constantly (stream urls hop to a token-signed CDN host), so
    // redirects are the normal case, not an error.
    if (status >= 300 && status < 400 && location !== undefined && location !== '') {
      res.resume(); // drain so the socket can be reused/freed
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new PlaylistError(`Playlist redirect pointed at an invalid location: ${location}`);
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new PlaylistError(`Playlist redirect to an unsupported scheme: ${next.protocol}`);
      }
      url = next;
      continue;
    }

    if (status < 200 || status > 299) {
      res.resume();
      throw new PlaylistError(describeHttpFailure(status, res.statusMessage ?? '', url));
    }
    return res;
  }
  throw new PlaylistError(
    `Playlist download failed: more than ${MAX_REDIRECTS} redirects starting at ${redactUrl(initial)}.`,
  );
}

function sendRequest(url: URL, timeoutMs: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let response: IncomingMessage | null = null;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const req = send(
      url,
      {
        method: 'GET',
        headers: {
          'user-agent': USER_AGENT,
          accept: '*/*',
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        settled = true;
        if (deadline !== undefined) clearTimeout(deadline);
        response = res;
        resolve(res);
      },
    );

    const fail = (error: PlaylistError): void => {
      if (settled && response === null) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (response === null) reject(error);
      else response.destroy(error);
      if (!req.destroyed) req.destroy(error);
    };

    const timedOut = (): void => {
      fail(
        new PlaylistError(
          `Playlist download timed out: no data from ${redactUrl(url)} for ${timeoutMs} ms.`,
        ),
      );
    };
    // req.setTimeout only arms once the socket is CONNECTED, so a black-holed host would sit in
    // the TCP handshake for the OS default (~2 min) no matter what budget the caller asked for.
    // Arming on 'socket' covers connect, DNS stalls and an idle body alike.
    req.on('socket', (socket) => {
      socket.setTimeout(timeoutMs);
      socket.once('timeout', timedOut);
    });
    req.setTimeout(timeoutMs, timedOut);
    // Socket timeouts are not reliable for every DNS/proxy combination. Keep a second,
    // request-level deadline so a provider that never completes the connection cannot leave
    // the catalogue on an endless "Downloading playlist…" state.
    deadline = setTimeout(timedOut, timeoutMs);

    req.on('error', (err: NodeJS.ErrnoException) => {
      fail(
        new PlaylistError(`Playlist download failed: ${describeNetworkError(err)} (${redactUrl(url)}).`, {
          cause: err,
        }),
      );
    });

    req.end();
  });
}

function describeHttpFailure(status: number, statusText: string, url: URL): string {
  const suffix = statusText === '' ? '' : ` ${statusText}`;
  const head = `Playlist download failed: HTTP ${status}${suffix} from ${redactUrl(url)}.`;
  if (status === 404 || status === 403 || status === 410) {
    return (
      `${head} Many Xtream providers disable the get.php playlist endpoint. If this is an ` +
      `Xtream account, add it as an Xtream source (host, username, password) instead of an M3U URL.`
    );
  }
  if (status === 401) return `${head} Check the username and password in the playlist URL.`;
  if (status === 429) return `${head} The provider is rate limiting; wait a minute and retry.`;
  if (status >= 500) return `${head} The provider's server is failing; try again later.`;
  return head;
}

function describeNetworkError(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case 'ENOTFOUND':
      return 'host not found';
    case 'ECONNREFUSED':
      return 'connection refused';
    case 'ECONNRESET':
      return 'connection reset by the server';
    case 'ETIMEDOUT':
      return 'connection timed out';
    case 'EAI_AGAIN':
      return 'DNS lookup failed';
    case 'CERT_HAS_EXPIRED':
      return "the server's TLS certificate has expired";
    default:
      return err.message;
  }
}

/**
 * Read a byte stream to text, transparently decompressing it.
 *
 * This peeks the first chunk before building the pipeline, so it can detect gzip by its
 * magic bytes as well as by Content-Encoding. Plenty of providers serve a `.m3u.gz`, or
 * gzip the body without advertising it.
 */
async function decodeBody(
  source: Readable,
  declaredEncoding: string,
  onProgress?: (bytes: number) => void,
): Promise<string> {
  const iterator = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const first = await iterator.next();
  if (first.done === true) return '';

  const head = first.value;
  const decompressor = decompressorFor(declaredEncoding, head);
  const chunks = countBytes(head, iterator, onProgress);
  return await readPlaylistText(chunks, decompressor);
}

function decompressorFor(encoding: string, head: Buffer): Transform | null {
  const enc = encoding.toLowerCase();
  if (enc.includes('br')) return createBrotliDecompress();
  if (enc.includes('gzip')) return createGunzip();
  if (enc.includes('deflate')) return createInflate();
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return createGunzip();
  return null;
}

async function* countBytes(
  head: Buffer,
  rest: AsyncIterator<Buffer>,
  onProgress?: (bytes: number) => void,
): AsyncGenerator<Buffer> {
  let total = 0;
  let reported = 0;
  let chunk: Buffer | undefined = head;
  while (chunk !== undefined) {
    total += chunk.length;
    if (total > MAX_WIRE_BYTES) {
      throw new PlaylistError(
        `Playlist is larger than ${Math.round(MAX_WIRE_BYTES / (1024 * 1024))} MB; refusing to load it.`,
      );
    }
    if (onProgress !== undefined && total - reported >= PROGRESS_STEP_BYTES) {
      reported = total;
      onProgress(total);
    }
    yield chunk;
    const next = await rest.next();
    chunk = next.done === true ? undefined : next.value;
  }
  if (onProgress !== undefined && total !== reported) onProgress(total);
}

class HeadRejected extends Error {
  override readonly name = 'HeadRejected';
}

async function decodeToText(
  source: AsyncIterable<Buffer>,
  transform: Transform | null,
  onText: (piece: string) => void,
): Promise<void> {
  // A decoder, not `chunk.toString()`: a multi-byte character can straddle two chunks.
  const decoder = new StringDecoder('utf8');
  const sink = async (input: AsyncIterable<Buffer>): Promise<void> => {
    for await (const chunk of input) onText(decoder.write(chunk));
    onText(decoder.end());
  };
  if (transform === null) await pipeline(source, sink);
  else await pipeline(source, transform, sink);
}

async function readPlaylistText(
  source: AsyncIterable<Buffer>,
  transform: Transform | null,
): Promise<string> {
  const parts: string[] = [];
  let chars = 0;
  let head = '';
  let verdict: PlaylistStart = 'undecided';

  try {
    await decodeToText(source, transform, (piece) => {
      chars += piece.length;
      if (chars > MAX_TEXT_CHARS) {
        throw new PlaylistError('Playlist is too large to hold in memory; refusing to load it.');
      }
      parts.push(piece);

      // Stop as soon as it is clear this is not a playlist: this provider 301s any unknown path to
      // `http://speedtest.tele2.net/1000GB.zip`, so one typo in a playlist URL would otherwise
      // stream a terabyte until the size cap trips.
      if (verdict !== 'undecided') return;
      head += piece;
      verdict = looksLikePlaylistStart(head);
      if (verdict === 'not-playlist') throw new HeadRejected();
      head = head.slice(blankPrefixLength(head));
    });
  } catch (err) {
    if (!(err instanceof HeadRejected)) throw err;
  }
  return parts.join('');
}

type PlaylistStart = 'playlist' | 'not-playlist' | 'undecided';

const PLAYLIST_MAGIC = '#EXTM3U';

function blankPrefixLength(text: string): number {
  let i = text.charCodeAt(0) === BOM ? 1 : 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (!isSpace(c) && c !== CHAR_LF && c !== CHAR_CR) break;
    i++;
  }
  return i;
}

function looksLikePlaylistStart(text: string): PlaylistStart {
  const i = blankPrefixLength(text);
  if (text.startsWith(PLAYLIST_MAGIC, i)) return 'playlist';
  return text.length - i < PLAYLIST_MAGIC.length ? 'undecided' : 'not-playlist';
}

function assertPlaylistBody(raw: string, source: string): string {
  const text = raw.charCodeAt(0) === BOM ? raw.slice(1) : raw;
  const where = redactUrl(source);
  if (text.length === 0) {
    throw new PlaylistError(
      `Playlist at ${where} was empty (0 bytes). The server answered but sent no playlist.`,
    );
  }

  if (looksLikePlaylistStart(text) !== 'playlist') {
    // The body may be binary (a wrong URL can land on a zip): keep the snippet printable.
    const snippet = text.slice(0, 160).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
    throw new PlaylistError(
      `Playlist at ${where} is not an M3U file: expected it to start with "#EXTM3U", got "${snippet}".`,
    );
  }
  return text;
}
