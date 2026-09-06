/**
 * The provider's XMLTV dump is 131 MB of XML with no line structure. Elements are not
 * line-delimited, so this parser can only read it incrementally. Materialising it as one
 * string, or handing it to a DOM parser, costs upwards of half a gigabyte.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Duplex, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createBrotliDecompress, createGunzip, createGzip, createInflate } from 'node:zlib';

import type { EpgChannelOption, EpgFeedStatus, EpgProgramme, NowNext } from '@shared/types';
import { fold } from '@shared/text';

import { redactText } from './redact.js';
import {
  FileChangedError, SOCKET_IDLE_TIMEOUT_MS, headerString, probe, rangedStream, single,
  type Validators,
} from './rangedFetch.js';
import { NO_EPG_CHANNEL } from './xtream.js';

const MAX_ELEMENT_CHARS = 1 << 20;
const CHAR_PLUS = '+'.charCodeAt(0);
const CHAR_MINUS = '-'.charCodeAt(0);
const CHAR_DOUBLE_QUOTE = '"'.charCodeAt(0);
const CHAR_SINGLE_QUOTE = "'".charCodeAt(0);
const CHAR_GREATER_THAN = '>'.charCodeAt(0);
const CHAR_SLASH = '/'.charCodeAt(0);
const TAG_LOOKBEHIND = 24;
const CACHE_FILE = 'epg-cache.ndjson.gz';
const DEFAULT_PROGRAMME_SECONDS = 3600;




/**
 * V8 represents `big.slice(a, b)` as a SlicedString that keeps the *whole* parent alive, so text
 * sliced straight out of the parse buffer would pin every chunk of the 131 MB document.
 * Round-tripping through a Buffer yields an independent, flat string.
 */
function detach(s: string): string {
  return s.length === 0 ? '' : Buffer.from(s, 'utf8').toString('utf8');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const ENTITY_RE = /&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g;

function fromCodePoint(cp: number, original: string): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return original;
  // Surrogate halves are not legal standalone characters in XML.
  if (cp >= 0xd800 && cp <= 0xdfff) return original;
  return String.fromCodePoint(cp);
}

function decodeEntities(raw: string): string {
  if (raw.length === 0) return '';
  if (!raw.includes('&')) return detach(raw);
  const out = raw.replace(ENTITY_RE, (match, hex?: string, dec?: string, name?: string) => {
    if (hex !== undefined) return fromCodePoint(parseInt(hex, 16), match);
    if (dec !== undefined) return fromCodePoint(parseInt(dec, 10), match);
    return name !== undefined ? (NAMED_ENTITIES[name.toLowerCase()] ?? match) : match;
  });
  // `replace` hands back the receiver when nothing matched, which would still
  // be a slice of the parse buffer.
  return out === raw ? detach(raw) : out;
}

function destroyStream(stream: NodeJS.ReadableStream): void {
  const destroyable = stream as { destroy?: (err?: Error) => void };
  try {
    destroyable.destroy?.();
  } catch {
  }
}

const attrPatterns = new Map<string, RegExp>();

function attrValue(attrs: string, name: string): string | undefined {
  let re = attrPatterns.get(name);
  if (re === undefined) {
    // `\b` is not enough: `-` is a non-word character, so `\bstart` also matches inside
    // `pdc-start`/`vps-start` and `\bid` inside `tvg-id`. Anchor on a real attribute separator.
    re = new RegExp(`(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    attrPatterns.set(name, re);
  }
  const m = re.exec(attrs);
  if (m === null) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? '');
}

const CDATA_RE = /^<!\[CDATA\[([\s\S]*)\]\]>$/;

function decodeText(raw: string): string {
  const trimmed = raw.trim();
  const cdata = CDATA_RE.exec(trimmed);
  if (cdata !== null) return detach(cdata[1]);
  return decodeEntities(trimmed);
}

const DISPLAY_NAME_RE = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/;
const ICON_SRC_RE = /<icon\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/;
const DESC_RE = /<desc\b[^>]*>([\s\S]*?)<\/desc>/;

function isUsableChannelId(id: string): boolean {
  if (id.length === 0) return false;
  if (id === NO_EPG_CHANNEL || id === 'null' || id === 'undefined') return false;
  return /[a-z0-9]/i.test(id);
}


function digits(s: string, at: number, len: number): number {
  if (at + len > s.length) return -1;
  let v = 0;
  for (let i = at; i < at + len; i++) {
    const d = s.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return -1;
    v = v * 10 + d;
  }
  return v;
}

/** XMLTV timestamps are `YYYYMMDDHHMMSS +HHMM`, e.g. `20260828120000 +0200`. */
function parseXmltvTime(raw: string): number {
  const s = raw.trim();
  const year = digits(s, 0, 4);
  const month = digits(s, 4, 2);
  const day = digits(s, 6, 2);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return Number.NaN;
  const hour = s.length >= 10 ? digits(s, 8, 2) : 0;
  const minute = s.length >= 12 ? digits(s, 10, 2) : 0;
  const second = s.length >= 14 ? digits(s, 12, 2) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 60) {
    return Number.NaN;
  }
  let t = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;

  // Optional trailing UTC offset. The dump is Europe/Paris local time, so
  // ignoring this would shift the whole guide by one or two hours.
  const p = s.length - 5;
  if (p >= 8) {
    const sign = s.charCodeAt(p);
    if (sign === CHAR_PLUS || sign === CHAR_MINUS) {
      const oh = digits(s, p + 1, 2);
      const om = digits(s, p + 3, 2);
      if (oh >= 0 && om >= 0) t -= (sign === CHAR_PLUS ? 1 : -1) * (oh * 3600 + om * 60);
    }
  }
  return t;
}


const ELEMENT_START_RE = /<(channel|programme)(?=[\s>/])/g;

function findTagEnd(buf: string, from: number): number {
  let quote = 0;
  for (let i = from; i < buf.length; i++) {
    const c = buf.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if (c === CHAR_DOUBLE_QUOTE || c === CHAR_SINGLE_QUOTE) {
      quote = c;
    } else if (c === CHAR_GREATER_THAN) {
      return i;
    }
  }
  return -1;
}

function emitChannel(
  attrs: string,
  inner: string,
  onChannel: (id: string, displayName: string, icon?: string) => void,
): void {
  const id = attrValue(attrs, 'id');
  if (id === undefined || !isUsableChannelId(id)) return;
  const nameMatch = DISPLAY_NAME_RE.exec(inner);
  const displayName = nameMatch !== null ? decodeText(nameMatch[1]) : '';
  const iconMatch = ICON_SRC_RE.exec(inner);
  const icon = iconMatch !== null ? decodeEntities(iconMatch[1] ?? iconMatch[2] ?? '') : '';
  onChannel(id, displayName.length > 0 ? displayName : id, icon.length > 0 ? icon : undefined);
}

function emitProgramme(attrs: string, inner: string, onProgramme: (p: EpgProgramme) => void): void {
  const channelId = attrValue(attrs, 'channel');
  if (channelId === undefined || !isUsableChannelId(channelId)) return;
  const startRaw = attrValue(attrs, 'start');
  if (startRaw === undefined) return;
  const start = parseXmltvTime(startRaw);
  if (!Number.isFinite(start)) return;
  const stopRaw = attrValue(attrs, 'stop');
  const stopParsed = stopRaw !== undefined ? parseXmltvTime(stopRaw) : Number.NaN;
  const stop =
    Number.isFinite(stopParsed) && stopParsed > start ? stopParsed : start + DEFAULT_PROGRAMME_SECONDS;

  const titleMatch = TITLE_RE.exec(inner);
  const descMatch = DESC_RE.exec(inner);
  const description = descMatch !== null ? decodeText(descMatch[1]) : '';
  const programme: EpgProgramme = {
    channelId,
    title: titleMatch !== null ? decodeText(titleMatch[1]) : '',
    start,
    stop,
  };
  if (description.length > 0) programme.description = description;
  onProgramme(programme);
}

function scanBuffer(
  buf: string,
  onChannel: (id: string, displayName: string, icon?: string) => void,
  onProgramme: (p: EpgProgramme) => void,
  final: boolean,
): string {
  let pos = 0;
  let pending = -1;
  for (;;) {
    ELEMENT_START_RE.lastIndex = pos;
    const m = ELEMENT_START_RE.exec(buf);
    if (m === null) break;

    const start = m.index;
    const isChannel = m[1] === 'channel';
    const tagEnd = findTagEnd(buf, ELEMENT_START_RE.lastIndex);
    if (tagEnd < 0) {
      if (final || buf.length - start > MAX_ELEMENT_CHARS) {
        pos = start + m[0].length;
        continue;
      }
      pending = start;
      break;
    }

    const selfClosing = buf.charCodeAt(tagEnd - 1) === CHAR_SLASH;
    const attrs = buf.slice(ELEMENT_START_RE.lastIndex, selfClosing ? tagEnd - 1 : tagEnd);
    let inner = '';
    let elementEnd: number;
    if (selfClosing) {
      elementEnd = tagEnd + 1;
    } else {
      const closeTag = isChannel ? '</channel>' : '</programme>';
      const close = buf.indexOf(closeTag, tagEnd + 1);
      if (close < 0) {
        if (!final && buf.length - start <= MAX_ELEMENT_CHARS) {
          pending = start;
          break;
        }
        pos = start + m[0].length;
        continue;
      }
      inner = buf.slice(tagEnd + 1, close);
      elementEnd = close + closeTag.length;
    }

    if (isChannel) emitChannel(attrs, inner, onChannel);
    else emitProgramme(attrs, inner, onProgramme);
    pos = elementEnd;
  }

  if (final) return '';
  const keep = pending >= 0 ? pending : Math.max(pos, buf.length - TAG_LOOKBEHIND);
  return keep >= buf.length ? '' : buf.slice(keep);
}

export async function parseXmltv(
  stream: NodeJS.ReadableStream,
  onChannel: (id: string, displayName: string, icon?: string) => void,
  onProgramme: (p: EpgProgramme) => void,
  onProgress?: (bytes: number) => void,
): Promise<void> {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let bytes = 0;
  let bomChecked = false;

  for await (const chunk of stream) {
    const bin = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    bytes += bin.length;
    let text = decoder.write(bin);
    if (!bomChecked && text.length > 0) {
      bomChecked = true;
      // The provider prefixes the document with a UTF-8 BOM; left in place it
      // would make the very first `<tv>` tag unmatchable by a strict scanner.
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (text.length === 0) continue;
    buf += text;
    buf = scanBuffer(buf, onChannel, onProgramme, false);
    onProgress?.(bytes);
  }

  buf += decoder.end();
  scanBuffer(buf, onChannel, onProgramme, true);
  onProgress?.(bytes);
}


const QUALITY_TOKENS = new Set([
  'hd', 'fhd', 'uhd', 'sd', 'hq', 'lq', '4k', '8k', 'hevc', 'h264', 'h265',
  '1080', '1080p', '1080i', '720', '720p', '576', '576p', '480', '480p',
  '2160', '2160p', '50fps', '60fps', 'fps', 'plus', 'tvg', 'dummy', 'backup',
]);

/**
 * The decorative country/symbol prefix the provider stamps on every name:
 * `EN ★ `, `US ❖ `, `VIP ✪ `, `EN ◉ `. The separator must be a non-ASCII symbol
 * or a pipe, deliberately not ordinary punctuation, so `TV5 - Monde` and
 * `AXN: Sci-Fi` keep their real names instead of being cut down to the tail.
 */
const DECORATIVE_PREFIX_RE = /^\s*(?:[a-z0-9]{2,4}\s*)?(?:[^\p{L}\p{N}\s\u0000-\u007f]|\|){1,3}\s+/u;
const PIPE_PREFIX_RE = /^\s*[a-z0-9]{2,4}\s*\|\s*/;

function normaliseName(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(PIPE_PREFIX_RE, ' ');
  s = s.replace(DECORATIVE_PREFIX_RE, ' ');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  const tokens = s.split(' ').filter((t) => t.length > 0 && !QUALITY_TOKENS.has(t));
  return tokens.join('');
}

/** XMLTV ids usually carry a country suffix (`CANAL+LIVE1.fr`) the name never has. */
function normaliseId(id: string): string {
  return normaliseName(id.replace(COUNTRY_SUFFIX_RE, ''));
}

const COUNTRY_SUFFIX_RE = /\.([a-z]{2,3}(?:-[a-z]{2,3})?)$/i;

function idCountry(id: string): string | undefined {
  const m = COUNTRY_SUFFIX_RE.exec(id);
  return m !== null ? m[1].toLowerCase() : undefined;
}

function countryMatches(id: string, hint: string): boolean {
  const c = idCountry(id);
  if (c === undefined) return false;
  return c === hint || c.split('-').includes(hint);
}

/**
 * The country code the provider stamps on a channel name (`US` in `US ❖ CNN`).
 * Only two-letter codes are considered, and only when a decorative separator
 * follows, so `M6 HD` is not read as a country called `m6`.
 */
function countryHint(displayName: string): string | undefined {
  const m = /^\s*([a-z]{2})\s*[^\p{L}\p{N}\s]/iu.exec(displayName);
  return m !== null ? m[1].toLowerCase() : undefined;
}


/**
 * Providers name pay-TV channels by their dial position (`FOX SPORTS 502`) while every public
 * guide names them by brand (`Fox League`). Keys are `normaliseName` output.
 */
const CHANNEL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['foxsports501', 'foxcricket'],
  ['foxsports502', 'foxleague'],
  ['foxsports503', 'foxsports503'],
  ['foxsports504', 'foxfooty'],
  ['foxsports505', 'foxsports505'],
  ['foxsports506', 'foxsports506'],
  ['foxsports507', 'foxsportsmore'],
  ['foxcricket501', 'foxcricket'],
  ['foxleague502', 'foxleague'],
  ['foxfooty504', 'foxfooty'],
  ['foxsportsmore505', 'foxsports505'],
  ['foxsportsmore506', 'foxsports506'],
  ['foxsportsmore507', 'foxsportsmore'],
]);

const FOX_DIAL_RE = /^fox(?:sports|league|cricket|footy)?(50\d)/;

/** `AU: `, `US | `, `UK ★ ` at the front of a name. */
const COUNTRY_TAG_RE = /^\s*[a-z]{2}\s*(?:[^\p{L}\p{N}\s]|\|)+\s*/iu;

/** Lookup keys for a display name, most literal first. */
function nameKeys(displayName: string): string[] {
  const keys: string[] = [];
  const push = (k: string): void => {
    if (k.length >= 2 && !keys.includes(k)) keys.push(k);
  };
  const raw = normaliseName(displayName);
  push(raw);
  const untagged = displayName.replace(COUNTRY_TAG_RE, '');
  if (untagged !== displayName) push(normaliseName(untagged));
  for (const k of keys.slice()) {
    const alias = CHANNEL_ALIASES.get(k);
    if (alias !== undefined) push(alias);
    // `FOX SPORTS 502 LEAUGE HD`: the dial number is the reliable part, whatever follows it.
    const dial = FOX_DIAL_RE.exec(k);
    if (dial !== null) push(CHANNEL_ALIASES.get(`foxsports${dial[1]}`) ?? `foxsports${dial[1]}`);
  }
  return keys;
}


/**
 * The twin with the most listings, then the plainest id (fewest dot segments, shortest,
 * alphabetical). `FoxLeague.alt.au` carries six days where `FoxLeague.au` has two with gaps.
 */
function fullestId(ids: readonly string[], size: (id: string) => number): string {
  return ids.slice().sort((x, y) =>
    size(y) - size(x) || x.split('.').length - y.split('.').length || x.length - y.length || x.localeCompare(y))[0];
}

function lastStartingAtOrBefore(arr: readonly EpgProgramme[], t: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function firstOverlapping(arr: readonly EpgProgramme[], from: number): number {
  let i = firstStartingAtOrAfter(arr, from);
  while (i > 0 && arr[i - 1].stop > from) i--;
  return i;
}

function firstStartingAtOrAfter(arr: readonly EpgProgramme[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].start < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}


/** `pipe` does not forward source errors, so wire them through explicitly. */
function pipeThrough<T extends Duplex>(src: NodeJS.ReadableStream, through: T): T {
  src.on('error', (err: Error) => through.destroy(err));
  src.pipe(through);
  return through;
}

/**
 * Return the decoded body. Honours `Content-Encoding`, and when the header is
 * absent sniffs the gzip magic number, because some panels serve a raw `.gz`
 * body with no encoding header at all.
 */
async function decodedBody(res: NodeJS.ReadableStream, contentEncoding: string | undefined): Promise<NodeJS.ReadableStream> {
  const encoding = (contentEncoding ?? '').toLowerCase();
  if (encoding.includes('gzip')) return pipeThrough(res, createGunzip());
  if (encoding.includes('deflate')) return pipeThrough(res, createInflate());
  if (encoding.includes('br')) return pipeThrough(res, createBrotliDecompress());

  const iterator = res[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done === true) return Readable.from([]);
  const head = typeof first.value === 'string' ? Buffer.from(first.value, 'utf8') : first.value;
  const rebuilt = Readable.from(
    (async function* replay() {
      yield head;
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return;
        yield next.value;
      }
    })(),
  );
  const gzipped = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  return gzipped ? pipeThrough(rebuilt, createGunzip()) : rebuilt;
}

/**
 * nginx emits weak ETags shaped `W/"<mtime-hex>-<size-hex>"`, where the size is the
 * *uncompressed* body length. This endpoint replies `Transfer-Encoding: chunked` with no
 * `Content-Length`, so the ETag is the only progress signal available for a 126 MB download.
 */
function etagUncompressedSize(etag: string | undefined): number {
  if (etag === undefined) return 0;
  const m = /^(?:W\/)?"[0-9a-f]+-([0-9a-f]+)"$/i.exec(etag.trim());
  if (m === null) return 0;
  const size = parseInt(m[1], 16);
  return Number.isFinite(size) && size > 1_000_000 ? size : 0;
}


interface ChannelMeta {
  name: string;
  icon?: string;
  /** Index into the feed list; 0 is the provider's own guide. */
  feed: number;
}

interface ChannelName {
  name: string;
  icon?: string;
}

export interface FeedSpec {
  id: string;
  label: string;
  url: string;
  /**
   * Read with one plain request, never ranged in parallel. The provider's feed carries the
   * account credentials and providers allow one connection per account: parallel ranges are
   * refused, and the refusals count as failed logins until the panel locks the account.
   */
  single?: boolean;
}

const CACHE_VERSION = 3;

type CachedProgramme = [number, number, string, string?];

interface CachedChannel {
  i: string;
  n: string;
  c?: string;
  f: number;
  p: CachedProgramme[];
}

interface CacheHeader {
  v: number;
  lastSync?: number;
  channels: number;
  programmes: number;
  feeds: EpgFeedStatus[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toCachedChannel(v: unknown): CachedChannel | undefined {
  if (!isRecord(v)) return undefined;
  const { i, n, c, f, p } = v;
  if (typeof i !== 'string' || i.length === 0 || !Array.isArray(p)) return undefined;
  const programmes: CachedProgramme[] = [];
  for (const row of p) {
    if (!Array.isArray(row)) continue;
    const [start, stop, title, desc] = row as unknown[];
    if (typeof start !== 'number' || typeof stop !== 'number' || typeof title !== 'string') continue;
    programmes.push(typeof desc === 'string' && desc.length > 0 ? [start, stop, title, desc] : [start, stop, title]);
  }
  return {
    i,
    n: typeof n === 'string' ? n : i,
    c: typeof c === 'string' && c.length > 0 ? c : undefined,
    f: typeof f === 'number' && f >= 0 ? f : 0,
    p: programmes,
  };
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function toFeedStatus(v: unknown): EpgFeedStatus | undefined {
  if (!isRecord(v)) return undefined;
  const { id, label, url, channels, programmes, lastSync, etag, lastModified, error } = v;
  if (typeof id !== 'string' || typeof label !== 'string' || typeof url !== 'string') return undefined;
  const s: EpgFeedStatus = {
    id,
    label,
    url,
    channels: typeof channels === 'number' ? channels : 0,
    programmes: typeof programmes === 'number' ? programmes : 0,
  };
  if (typeof lastSync === 'number') s.lastSync = lastSync;
  const e = optionalString(etag);
  if (e !== undefined) s.etag = e;
  const lm = optionalString(lastModified);
  if (lm !== undefined) s.lastModified = lm;
  const err = optionalString(error);
  if (err !== undefined) s.error = err;
  return s;
}

function toCacheHeader(v: unknown): CacheHeader | undefined {
  if (!isRecord(v) || typeof v.v !== 'number') return undefined;
  const feeds: EpgFeedStatus[] = [];
  if (Array.isArray(v.feeds)) for (const f of v.feeds) { const s = toFeedStatus(f); if (s) feeds.push(s); }
  return {
    v: v.v,
    lastSync: typeof v.lastSync === 'number' ? v.lastSync : undefined,
    channels: typeof v.channels === 'number' ? v.channels : 0,
    programmes: typeof v.programmes === 'number' ? v.programmes : 0,
    feeds,
  };
}

async function* readLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
  }
  buf += decoder.end();
  if (buf.length > 0) yield buf;
}

interface FeedChannels {
  byChannel: Map<string, EpgProgramme[]>;
  names: Map<string, ChannelName>;
}

type FetchResult =
  | { kind: 'unchanged' }
  | {
    kind: 'parsed';
    data: FeedChannels;
    programmes: number;
    etag?: string;
    lastModified?: string;
  };

type Progress = (msg: string, pct: number | null) => void;

interface Source {
  body: NodeJS.ReadableStream;
  /** Fraction complete, when the transport knows it. */
  progress: (parsedBytes: number) => number | null;
  /** Names the transport in the progress line: `in parallel, 55 of 131 MB`. */
  describe: (parsedBytes: number) => string;
  etag?: string;
  lastModified?: string;
  /** Whether the whole document arrived, once the parse has drained the body. */
  complete: () => boolean;
  destroy: () => void;
}

/** Opens a feed: a 304, or a body to parse, ranged in parallel when the file is large. */
async function openFeed(feed: FeedSpec, validators: Validators): Promise<Source | undefined> {
  const probed = feed.single === true
    ? await single(feed.url, SOCKET_IDLE_TIMEOUT_MS, validators)
    : await probe(feed.url, SOCKET_IDLE_TIMEOUT_MS, validators);
  if (probed.kind === 'unchanged') return undefined;

  if (probed.kind === 'ranged') {
    const { stream, stats } = rangedStream(
      { url: probed.url, total: probed.total, ...(probed.etag !== undefined ? { etag: probed.etag } : {}) },
      SOCKET_IDLE_TIMEOUT_MS,
    );
    const body = await decodedBody(stream, undefined);
    const source: Source = {
      body,
      progress: () => stats.bytes / stats.total,
      describe: () => `in parallel, ${(stats.bytes / 1e6).toFixed(0)} of ${(stats.total / 1e6).toFixed(0)} MB`,
      complete: () => stats.bytes >= stats.total,
      destroy: () => {
        destroyStream(body);
        stream.destroy();
      },
    };
    if (probed.etag !== undefined) source.etag = probed.etag;
    if (probed.lastModified !== undefined) source.lastModified = probed.lastModified;
    return source;
  }

  const res = probed.res;
  const contentLength = Number(res.headers['content-length'] ?? '');
  const compressedTotal = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
  const uncompressedTotal = etagUncompressedSize(res.headers.etag);
  let compressed = 0;
  if (compressedTotal > 0) {
    res.on('data', (c: Buffer) => {
      compressed += c.length;
    });
  }
  const body = await decodedBody(res, headerString(res.headers['content-encoding']));
  const source: Source = {
    body,
    progress: (bytes) =>
      compressedTotal > 0 ? compressed / compressedTotal
      : uncompressedTotal > 0 ? bytes / uncompressedTotal
      : null,
    describe: (bytes) => `${(bytes / 1e6).toFixed(0)} MB`,
    complete: () => res.complete === true,
    destroy: () => {
      destroyStream(body);
      res.destroy();
    },
  };
  const etag = headerString(res.headers.etag);
  if (etag !== undefined) source.etag = etag;
  const lastModified = headerString(res.headers['last-modified']);
  if (lastModified !== undefined) source.lastModified = lastModified;
  return source;
}

/**
 * Downloads and parses one feed. `beforeParse` runs once a body is on its way, so the caller can
 * drop the previous copy of a big feed before its replacement is materialised. A file that is
 * regenerated mid-download is read again from the start, once.
 */
async function fetchFeed(
  feed: FeedSpec,
  validators: Validators,
  onProgress?: Progress,
  beforeParse?: () => void,
): Promise<FetchResult> {
  try {
    return await fetchFeedOnce(feed, validators, onProgress, beforeParse);
  } catch (err) {
    if (!(err instanceof FileChangedError) && !(err instanceof Error && err.cause instanceof FileChangedError)) throw err;
    onProgress?.(`${feed.label} changed while it was downloading; starting again`, null);
    return fetchFeedOnce(feed, {}, onProgress, beforeParse);
  }
}

async function fetchFeedOnce(
  feed: FeedSpec,
  validators: Validators,
  onProgress?: Progress,
  beforeParse?: () => void,
): Promise<FetchResult> {
  onProgress?.(`Checking ${feed.label}`, null);
  const source = await openFeed(feed, validators);
  if (source === undefined) return { kind: 'unchanged' };
  beforeParse?.();

  const byChannel = new Map<string, EpgProgramme[]>();
  const names = new Map<string, ChannelName>();
  const pool = new Map<string, string>();
  let programmes = 0;
  let lastTick = 0;

  try {
    await parseXmltv(
      source.body,
      (id, displayName, icon) => {
        names.set(id, icon !== undefined ? { name: displayName, icon } : { name: displayName });
      },
      (p) => {
        p.channelId = intern(pool, p.channelId);
        p.title = intern(pool, p.title);
        if (p.description !== undefined) p.description = intern(pool, p.description);
        let list = byChannel.get(p.channelId);
        if (list === undefined) {
          list = [];
          byChannel.set(p.channelId, list);
        }
        list.push(p);
        programmes++;
      },
      (bytes) => {
        const now = Date.now();
        if (now - lastTick < 250) return;
        lastTick = now;
        const pct = source.progress(bytes);
        const msg = `Reading ${feed.label} ${source.describe(bytes)} - ${programmes} programmes`;
        onProgress?.(msg, pct === null ? null : Math.min(0.99, pct));
      },
    );
  } catch (err) {
    // pipe() unpipes on a destination error but never destroys the source, so a failed parse
    // would leave the 126 MB response socket established and the origin still pushing into it.
    source.destroy();
    throw new Error(`EPG download failed after ${programmes} programmes: ${errorMessage(err)}`, {
      cause: err,
    });
  }

  if (!source.complete()) {
    source.destroy();
    throw new Error('EPG download ended early; the document was truncated');
  }
  if (programmes === 0) {
    source.destroy();
    throw new Error('EPG document contained no programmes');
  }

  for (const list of byChannel.values()) {
    list.sort((a, b) => a.start - b.start || a.stop - b.stop);
    dedupeSorted(list);
  }
  const out: FetchResult = { kind: 'parsed', data: { byChannel, names }, programmes };
  if (source.etag !== undefined) out.etag = source.etag;
  if (source.lastModified !== undefined) out.lastModified = source.lastModified;
  return out;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class EpgStore {
  private readonly dir: string;
  private readonly file: string;

  /** Every feed's own channels, keyed by feed id. The merged view below is derived from these. */
  private feedData = new Map<string, FeedChannels>();
  private status: EpgFeedStatus[] = [];

  private byChannel = new Map<string, EpgProgramme[]>();
  private meta = new Map<string, ChannelMeta>();
  private nameIndex = new Map<string, string[]>();
  private idIndex = new Map<string, string[]>();
  private foldedTitles = new Map<string, string>();
  private countries = new Set<string>();
  private programmeCount = 0;
  private lastSync: number | undefined;

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, CACHE_FILE);
  }

  /**
   * Brings the store in line with `feeds` (provider first). Feeds already held with the same url
   * are kept unless named in `refresh`; the rest are fetched, fill feeds before the provider so
   * the guide fills in while the slow provider download runs. Each fetch sends the validators
   * from the last read, and a `304` keeps the cached channels. The store is saved after the fill
   * feeds and again at the end. The provider feed failing throws once everything else is saved;
   * a fill feed failing is recorded in its status.
   */
  async ingest(
    feeds: readonly FeedSpec[],
    refresh: ReadonlySet<string>,
    onProgress?: Progress,
  ): Promise<{ channels: number; programmes: number }> {
    if (feeds.length === 0) throw new Error('No EPG feed to read');

    const previous = new Map(this.status.map((s) => [s.id, s]));
    const status: EpgFeedStatus[] = feeds.map((f) => {
      const p = previous.get(f.id);
      return p !== undefined && p.url === f.url
        ? { ...p, label: f.label }
        : { id: f.id, label: f.label, url: f.url, channels: 0, programmes: 0 };
    });
    const wanted = new Set(feeds.map((f) => f.id));
    for (const id of [...this.feedData.keys()]) {
      if (!wanted.has(id)) this.feedData.delete(id);
    }
    for (const s of status) {
      if (!this.feedData.has(s.id)) {
        delete s.etag;
        delete s.lastModified;
        delete s.lastSync;
      }
    }
    this.status = status;

    const provider = feeds[0];
    const pending = feeds.filter((f) => refresh.has(f.id) || !this.feedData.has(f.id));
    const order = pending.filter((f) => f !== provider);
    if (pending.includes(provider)) order.push(provider);

    let providerError: unknown;
    for (const feed of order) {
      const entry = status.find((s) => s.id === feed.id)!;
      if (feed === provider && order.length > 1) {
        // The fill feeds are in; publish them before the long provider read starts.
        this.publish();
        await this.save();
      }
      const validators: Validators = {};
      if (entry.etag !== undefined) validators.etag = entry.etag;
      if (entry.lastModified !== undefined) validators.lastModified = entry.lastModified;
      try {
        const result = await fetchFeed(feed, validators, onProgress, () => this.feedData.delete(feed.id));
        delete entry.error;
        entry.lastSync = nowSeconds();
        if (result.kind === 'unchanged') {
          onProgress?.(`${feed.label} is unchanged since the last read`, null);
          continue;
        }
        this.feedData.set(feed.id, result.data);
        entry.channels = result.data.byChannel.size;
        entry.programmes = result.programmes;
        if (result.etag !== undefined) entry.etag = result.etag;
        else delete entry.etag;
        if (result.lastModified !== undefined) entry.lastModified = result.lastModified;
        else delete entry.lastModified;
      } catch (err) {
        entry.error = errorMessage(err);
        if (!this.feedData.has(feed.id)) {
          entry.channels = 0;
          entry.programmes = 0;
          delete entry.etag;
          delete entry.lastModified;
        }
        if (feed === provider) providerError = err;
      }
    }

    this.publish();
    await this.save();
    if (providerError !== undefined) throw providerError;

    const filled = this.status.slice(1).reduce((n, s) => n + s.channels, 0);
    onProgress?.(
      filled > 0
        ? `EPG ready: ${this.status[0].channels} provider channels, ${filled} from other guides, ${this.programmeCount} programmes`
        : `EPG ready: ${this.byChannel.size} channels with listings, ${this.programmeCount} programmes`,
      1,
    );
    return { channels: this.byChannel.size, programmes: this.programmeCount };
  }

  /** Rebuilds the merged view: in feed order, a channel id is taken from the first feed that has it. */
  private publish(): void {
    const byChannel = new Map<string, EpgProgramme[]>();
    const meta = new Map<string, ChannelMeta>();
    let programmes = 0;
    this.status.forEach((s, rank) => {
      const data = this.feedData.get(s.id);
      if (data === undefined) return;
      for (const [id, list] of data.byChannel) {
        if (byChannel.has(id)) continue;
        byChannel.set(id, list);
        const n = data.names.get(id);
        meta.set(id, n?.icon !== undefined ? { name: n.name, icon: n.icon, feed: rank } : { name: n?.name ?? id, feed: rank });
        programmes += list.length;
      }
    });
    this.byChannel = byChannel;
    this.meta = meta;
    this.programmeCount = programmes;
    this.lastSync = nowSeconds();
    this.foldedTitles.clear();
    this.rebuildIndexes();
  }

  hasChannel(channelId: string): boolean {
    return this.byChannel.has(channelId);
  }

  feedStatus(): EpgFeedStatus[] {
    return this.status.map((s) => ({ ...s }));
  }

  private foldTitle(title: string): string {
    const hit = this.foldedTitles.get(title);
    if (hit !== undefined) return hit;
    const folded = fold(title);
    this.foldedTitles.set(title, folded);
    return folded;
  }

  matching(folded: string, from: number, to: number, limit = 200): Map<string, EpgProgramme> {
    const out = new Map<string, EpgProgramme>();
    if (folded.length < 2 || to <= from) return out;

    const hits: EpgProgramme[] = [];
    for (const list of this.byChannel.values()) {
      let i = firstOverlapping(list, from);
      for (; i < list.length && list[i].start < to; i++) {
        const p = list[i];
        if (p.stop <= from || !this.foldTitle(p.title).includes(folded)) continue;
        hits.push(p);
        break;
      }
    }

    hits.sort((a, b) => a.start - b.start);
    for (const p of hits) {
      if (out.size >= limit) break;
      out.set(p.channelId, p);
    }
    return out;
  }

  /** Channels whose name or id contains the query, provider channels first. */
  searchChannels(query: string, limit = 40): EpgChannelOption[] {
    const q = fold(query.trim());
    if (q.length < 2) return [];
    const out: EpgChannelOption[] = [];
    for (const [id, m] of this.meta) {
      if (!fold(m.name).includes(q) && !fold(id).includes(q)) continue;
      out.push({ id, name: m.name, feed: this.status[m.feed]?.label ?? '' });
    }
    out.sort((a, b) => (this.meta.get(a.id)?.feed ?? 0) - (this.meta.get(b.id)?.feed ?? 0) || a.name.localeCompare(b.name));
    return out.slice(0, limit);
  }

  nowNext(channelId: string, at: number = Math.floor(Date.now() / 1000)): NowNext {
    const arr = this.byChannel.get(channelId);
    if (arr === undefined || arr.length === 0) return {};
    const i = lastStartingAtOrBefore(arr, at);
    const result: NowNext = {};
    if (i >= 0 && arr[i].stop > at) result.now = arr[i];
    if (i + 1 < arr.length) result.next = arr[i + 1];
    return result;
  }

  programmesOverlapping(channelId: string, from: number, to: number): EpgProgramme[] {
    const arr = this.byChannel.get(channelId);
    if (arr === undefined || arr.length === 0 || to <= from) return [];
    let i = firstOverlapping(arr, from);
    const out: EpgProgramme[] = [];
    for (; i < arr.length && arr[i].start < to; i++) {
      if (arr[i].stop > from) out.push(arr[i]);
    }
    return out;
  }

  grid(channelIds: string[], from: number, to: number): Record<string, EpgProgramme[]> {
    const out: Record<string, EpgProgramme[]> = {};
    for (const id of channelIds) {
      if (id in out) continue;
      const resolved = this.resolveChannelId(id);
      out[id] = resolved !== undefined ? this.programmesOverlapping(resolved, from, to) : [];
    }
    return out;
  }

  /**
   * Fuzzy-resolve a channel display name to an XMLTV channel id, for the two thirds of live
   * streams whose `epg_channel_id` is missing. Tries the name as-is, then without its country
   * tag, then with channel-number aliases applied; the provider's own feed beats a fill feed.
   */
  resolveChannelId(displayName: string): string | undefined {
    if (displayName.length === 0) return undefined;
    if (this.byChannel.has(displayName)) return displayName;

    const hint = countryHint(displayName);
    for (const key of nameKeys(displayName)) {
      const hit = this.resolveKey(key, hint);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  private resolveKey(key: string, hint: string | undefined): string | undefined {
    if (key.length < 2) return undefined;

    // `US ★ GOLF CHANNEL HD` matches the *name* of `GolfChannel.pl` and the *id* of
    // `GolfChannel.us`; only seeing both makes it clear the country tag has to decide.
    let candidates = new Set(this.nameIndex.get(key));
    for (const id of this.idIndex.get(key) ?? []) candidates.add(id);
    if (candidates.size === 0) return undefined;

    if (candidates.size > 1) {
      let best = Number.POSITIVE_INFINITY;
      for (const id of candidates) best = Math.min(best, this.meta.get(id)?.feed ?? 0);
      candidates = new Set([...candidates].filter((id) => (this.meta.get(id)?.feed ?? 0) === best));
    }
    if (candidates.size === 1) return candidates.values().next().value;

    let pool = [...candidates];
    if (hint !== undefined && this.countries.has(hint)) {
      const inCountry = pool.filter((id) => countryMatches(id, hint));
      if (inCountry.length > 0) pool = inCountry;
    }
    if (pool.length === 1) return pool[0];

    // Regional twins (`7mateSydney.au`, `7matePerth.au`) and `.alt` duplicates carry the same
    // listings, so any of them serves; different countries do not, so those stay unresolved.
    if (new Set(pool.map(idCountry)).size > 1) return undefined;
    return fullestId(pool, (id) => this.byChannel.get(id)?.length ?? 0);
  }

  get stats(): { channels: number; programmes: number; lastSync?: number } {
    const s: { channels: number; programmes: number; lastSync?: number } = {
      channels: this.byChannel.size,
      programmes: this.programmeCount,
    };
    if (this.lastSync !== undefined) s.lastSync = this.lastSync;
    return s;
  }

  async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    const header: CacheHeader = {
      v: CACHE_VERSION,
      lastSync: this.lastSync,
      channels: this.byChannel.size,
      programmes: this.programmeCount,
      feeds: this.status,
    };
    const status = this.status;
    const feedData = this.feedData;

    function* lines(): Generator<string> {
      yield `${JSON.stringify(header)}\n`;
      for (let rank = 0; rank < status.length; rank++) {
        const data = feedData.get(status[rank].id);
        if (data === undefined) continue;
        for (const [id, list] of data.byChannel) {
          const m = data.names.get(id);
          const row: CachedChannel = {
            i: id,
            n: m?.name ?? id,
            f: rank,
            p: list.map((p) =>
              p.description !== undefined && p.description.length > 0
                ? [p.start, p.stop, p.title, p.description]
                : [p.start, p.stop, p.title],
            ),
          };
          if (m?.icon !== undefined) row.c = m.icon;
          yield `${JSON.stringify(row)}\n`;
        }
      }
    }

    try {
      await pipeline(Readable.from(lines()), createGzip({ level: 1 }), createWriteStream(tmp));
      await rename(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async load(): Promise<boolean> {
    const feedData = new Map<string, FeedChannels>();
    const pool = new Map<string, string>();
    let header: CacheHeader | undefined;

    try {
      const source = pipeThrough(createReadStream(this.file), createGunzip());
      for await (const line of readLines(source)) {
        if (line.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (header === undefined) {
          header = toCacheHeader(parsed);
          // v2 wrote the same rows with one sync time for every feed and no validators.
          if (header === undefined || (header.v !== CACHE_VERSION && header.v !== 2) || header.feeds.length === 0) return false;
          for (const f of header.feeds) feedData.set(f.id, { byChannel: new Map(), names: new Map() });
          continue;
        }
        const row = toCachedChannel(parsed);
        if (row === undefined) continue;
        const feed = header.feeds[row.f];
        if (feed === undefined) continue;
        const list: EpgProgramme[] = row.p.map(([start, stop, title, description]) => {
          const p: EpgProgramme = { channelId: row.i, title: intern(pool, title), start, stop };
          if (description !== undefined && description.length > 0) {
            p.description = intern(pool, description);
          }
          return p;
        });
        if (list.length === 0) continue;
        list.sort((a, b) => a.start - b.start || a.stop - b.stop);
        const data = feedData.get(feed.id)!;
        data.byChannel.set(row.i, list);
        data.names.set(row.i, row.c !== undefined ? { name: row.n, icon: row.c } : { name: row.n });
      }
    } catch {
      return false;
    }

    if (header === undefined) return false;
    // A feed whose channels never made it to disk must be fetched again, not trusted as empty.
    for (const [id, data] of feedData) {
      if (data.byChannel.size === 0) feedData.delete(id);
    }
    if (feedData.size === 0) return false;

    this.feedData = feedData;
    this.status = header.feeds.map((f) =>
      f.lastSync === undefined && header.lastSync !== undefined ? { ...f, lastSync: header.lastSync } : { ...f });
    this.publish();
    this.lastSync = header.lastSync;
    return true;
  }

  private rebuildIndexes(): void {
    this.nameIndex = new Map();
    this.idIndex = new Map();
    this.countries = new Set();
    for (const id of this.byChannel.keys()) {
      addIndexEntry(this.idIndex, normaliseId(id), id);
      const name = this.meta.get(id)?.name;
      if (name !== undefined && name.length > 0) addIndexEntry(this.nameIndex, normaliseName(name), id);
      const country = idCountry(id);
      if (country !== undefined) {
        this.countries.add(country);
        for (const part of country.split('-')) this.countries.add(part);
      }
    }
  }
}

function errorMessage(err: unknown): string {
  return redactText(err instanceof Error ? err.message : String(err));
}

function intern(pool: Map<string, string>, s: string): string {
  const hit = pool.get(s);
  if (hit !== undefined) return hit;
  pool.set(s, s);
  return s;
}

function addIndexEntry(index: Map<string, string[]>, key: string, id: string): void {
  if (key.length < 2) return;
  const existing = index.get(key);
  if (existing === undefined) index.set(key, [id]);
  else if (!existing.includes(id)) existing.push(id);
}

function dedupeSorted(list: EpgProgramme[]): void {
  let write = 1;
  for (let read = 1; read < list.length; read++) {
    const prev = list[write - 1];
    const cur = list[read];
    if (cur.start === prev.start && cur.stop === prev.stop && cur.title === prev.title) continue;
    list[write++] = cur;
  }
  if (write < list.length) list.length = write;
}
