import { app, BrowserWindow, ipcMain, shell, nativeTheme } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Source, XtreamSource, MediaKind, MediaItem, Category, SeriesDetail, EpgProgramme, NowNext,
  EpgChannelOption, EpgFeed, GuideOverride,
  PlayRequest, PlaybackEngine, ResolvedStream, CastStatus, WatchProgress, Settings, SettingsPatch, SyncProgress, SourceStats,
  SourceProbe,
} from '@shared/types';
import { XtreamClient } from './lib/xtream.js';
import { EpgStore, type FeedSpec } from './lib/epg.js';
import { EPG_FEEDS, autoFeeds, resolveFeed } from './lib/epgFeeds.js';
import { StreamServer, pickPlaybackEngine, mimeForContainer } from './lib/remux.js';
import { CastManager } from './lib/cast.js';
import { Store, cachedList, epgAutoRefresh, parseCategory, parseMediaItem, type NewSource } from './lib/store.js';
import { parseM3u, fetchPlaylist } from './lib/m3u.js';
import { redactText } from './lib/redact.js';
import { fold } from '@shared/text';

const __dirname_ = dirname(fileURLToPath(import.meta.url));

const CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

const cachedCategories = cachedList(parseCategory);
const cachedMediaItems = cachedList(parseMediaItem);

interface CachedPlaylist {
  items: MediaItem[];
  categories: Category[];
  epgUrl?: string;
  urls: [string, string][];
}

function parseCachedPlaylist(value: unknown): CachedPlaylist | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const items = cachedMediaItems(raw.items);
  const categories = cachedCategories(raw.categories);
  if (items === undefined || categories === undefined) return undefined;
  const urls: [string, string][] = [];
  if (Array.isArray(raw.urls)) {
    for (const entry of raw.urls) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
        urls.push([entry[0], entry[1]]);
      }
    }
  }
  const playlist: CachedPlaylist = { items, categories, urls };
  if (typeof raw.epgUrl === 'string') playlist.epgUrl = raw.epgUrl;
  return playlist;
}

let win: BrowserWindow | null = null;
let store: Store;
let streamServer: StreamServer;
let cast: CastManager;


interface SourceServices {
  source: Source;
  xtream?: XtreamClient;
  epg: EpgStore;
  m3u?: { items: MediaItem[]; categories: Category[]; epgUrl?: string; urls: ReadonlyMap<string, string> };
}

const services = new Map<string, SourceServices>();

function servicesFor(sourceId: string): SourceServices {
  const existing = services.get(sourceId);
  if (existing) return existing;
  const source = store.listSources().find((s) => s.id === sourceId);
  if (!source) throw new Error('That source is no longer available.');
  const svc: SourceServices = {
    source,
    epg: new EpgStore(join(store.cacheDir(sourceId), 'epg')),
    xtream: source.kind === 'xtream'
      ? new XtreamClient({ url: source.url, username: source.username, password: source.password })
      : undefined,
  };
  services.set(sourceId, svc);
  return svc;
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const progress = (p: SyncProgress): void => send('sync-progress', p);


async function loadM3u(svc: SourceServices): Promise<NonNullable<SourceServices['m3u']>> {
  if (svc.m3u) return svc.m3u;
  const cached = store.getCached(svc.source.id, 'm3u:playlist', CATALOG_TTL_MS, parseCachedPlaylist);
  if (cached) {
    svc.m3u = {
      items: cached.items,
      categories: cached.categories,
      epgUrl: cached.epgUrl,
      urls: new Map(cached.urls),
    };
    return svc.m3u;
  }
  progress({ phase: 'live', message: 'Downloading playlist…', progress: null });
  const text = await fetchPlaylist(svc.source.url, 120_000, (bytes) =>
    progress({ phase: 'live', message: `Downloading playlist… ${(bytes / 1048576).toFixed(1)} MB`, progress: null }));
  progress({ phase: 'live', message: 'Parsing playlist…', progress: null });
  const parsed = parseM3u(text);
  store.setCached(svc.source.id, 'm3u:playlist', { ...parsed, urls: [...parsed.urls] });
  svc.m3u = parsed;
  progress({ phase: 'done', message: `${parsed.items.length} entries`, progress: 1 });
  return parsed;
}


async function getCategories(sourceId: string, kind: MediaKind): Promise<Category[]> {
  const svc = servicesFor(sourceId);
  if (svc.xtream) {
    const key = `cats:${kind}`;
    const hit = store.getCached(sourceId, key, CATALOG_TTL_MS, cachedCategories);
    if (hit) return hit;
    const cats = await svc.xtream.categories(kind);
    store.setCached(sourceId, key, cats);
    return cats;
  }
  const { categories } = await loadM3u(svc);
  return categories.filter((c) => c.kind === kind);
}

function itemsKey(kind: MediaKind, categoryId: string): string {
  return `items:${kind}:${categoryId}`;
}

async function getItems(sourceId: string, kind: MediaKind, categoryId: string): Promise<MediaItem[]> {
  const svc = servicesFor(sourceId);
  if (svc.xtream) {
    const key = itemsKey(kind, categoryId);
    const hit = store.getCached(sourceId, key, CATALOG_TTL_MS, cachedMediaItems);
    if (hit) return hit;
    const items = await svc.xtream.items(kind, categoryId);
    store.setCached(sourceId, key, items);
    return items;
  }
  const { items } = await loadM3u(svc);
  return items.filter((i) => i.kind === kind && i.categoryId === categoryId);
}

async function allLive(sourceId: string): Promise<MediaItem[]> {
  const svc = servicesFor(sourceId);
  const hit = store.getCached(sourceId, 'all:live', CATALOG_TTL_MS, cachedMediaItems);
  if (hit) return hit;
  const all = await svc.xtream!.allItems('live');
  store.setCached(sourceId, 'all:live', all);
  return all;
}

async function liveItems(sourceId: string): Promise<MediaItem[]> {
  const svc = servicesFor(sourceId);
  if (svc.xtream) return allLive(sourceId);
  return (await loadM3u(svc)).items.filter((i) => i.kind === 'live');
}

interface LiveEpgIndex {
  stamp: string;
  byChannel: Map<string, MediaItem[]>;
  channelOf: Map<string, string>;
}

const liveEpgIndexes = new Map<string, LiveEpgIndex>();

async function liveEpgIndex(sourceId: string): Promise<LiveEpgIndex> {
  const svc = servicesFor(sourceId);
  const live = await liveItems(sourceId);
  const { channels, lastSync = 0 } = svc.epg.stats;
  const overrides = store.listGuideOverrides(sourceId);
  const stamp = `${lastSync}:${channels}:${live.length}:${JSON.stringify(overrides)}`;
  const hit = liveEpgIndexes.get(sourceId);
  if (hit?.stamp === stamp) return hit;

  const byChannel = new Map<string, MediaItem[]>();
  const channelOf = new Map<string, string>();
  if (channels > 0) {
    const pinned = new Map(overrides.map((o) => [o.itemId, o.channelId]));
    for (const item of live) {
      const pin = pinned.get(item.id);
      const id = pin !== undefined && svc.epg.hasChannel(pin) ? pin
        : item.epgChannelId !== undefined && svc.epg.hasChannel(item.epgChannelId) ? item.epgChannelId
        : svc.epg.resolveChannelId(item.name);
      if (id === undefined) continue;
      channelOf.set(item.id, id);
      const list = byChannel.get(id);
      if (list === undefined) byChannel.set(id, [item]);
      else list.push(item);
    }
  }

  const index: LiveEpgIndex = { stamp, byChannel, channelOf };
  liveEpgIndexes.set(sourceId, index);
  return index;
}

/**
 * Stamps the guide channel each live item resolved to, so the renderer asks for listings on
 * channels the provider shipped without an id, or whose id only a fill feed knows.
 */
async function withGuideIds(sourceId: string, items: MediaItem[]): Promise<MediaItem[]> {
  if (!items.some((i) => i.kind === 'live')) return items;
  const guide = await liveEpgIndex(sourceId);
  return items.map((item) => {
    if (item.kind !== 'live') return item;
    const id = guide.channelOf.get(item.id);
    return id === undefined || id === item.epgChannelId ? item : { ...item, epgChannelId: id };
  });
}

const SEARCH_CAP = 300;
const GUIDE_LOOKAHEAD_SECONDS = 24 * 60 * 60;

async function search(sourceId: string, query: string, kind?: MediaKind): Promise<MediaItem[]> {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const svc = servicesFor(sourceId);
  const at = Math.floor(Date.now() / 1000);
  const guide = kind === undefined || kind === 'live' ? await liveEpgIndex(sourceId) : undefined;

  const matches: MediaItem[] = [];
  const seen = new Set<string>();
  const take = (items: MediaItem[]): void => {
    for (const item of items) {
      if (matches.length >= SEARCH_CAP) return;
      if (seen.has(item.id)) continue;
      if (!fold(item.name).includes(q)
        && (item.title === item.name || !fold(item.title).includes(q))) continue;
      seen.add(item.id);
      const channelId = item.kind === 'live' ? guide?.channelOf.get(item.id) : undefined;
      if (channelId === undefined) {
        matches.push(item);
        continue;
      }
      const now = svc.epg.nowNext(channelId, at).now;
      matches.push({ ...item, epgChannelId: channelId, ...(now === undefined ? {} : { nowPlaying: now }) });
    }
  };

  if (svc.xtream) {
    const kinds: MediaKind[] = kind ? [kind] : ['live', 'movie', 'series'];
    for (const k of kinds) {
      if (k === 'live') {
        take(await allLive(sourceId));
        continue;
      }
      for (const cat of await getCategories(sourceId, k)) {
        const cached = store.getCached(sourceId, itemsKey(k, cat.id), CATALOG_TTL_MS, cachedMediaItems);
        if (cached) take(cached);
        if (matches.length >= SEARCH_CAP) break;
      }
    }
  } else {
    const { items } = await loadM3u(svc);
    take(kind ? items.filter((i) => i.kind === kind) : items);
  }

  if (guide) {
    for (const [channelId, programme] of svc.epg.matching(q, at, at + GUIDE_LOOKAHEAD_SECONDS)) {
      for (const item of guide.byChannel.get(channelId) ?? []) {
        if (matches.length >= SEARCH_CAP) break;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        matches.push({ ...item, epgChannelId: channelId, programmeMatch: programme });
      }
    }
  }
  return matches;
}

function splitItemId(itemId: string): { kind?: MediaKind; rawId: string } {
  const colon = itemId.indexOf(':');
  const prefix = itemId.slice(0, colon);
  const rawId = itemId.slice(colon + 1);
  return prefix === 'live' || prefix === 'movie' || prefix === 'series'
    ? { kind: prefix, rawId }
    : { rawId };
}

async function findItem(sourceId: string, itemId: string): Promise<MediaItem | undefined> {
  const svc = servicesFor(sourceId);
  const fav = store.listFavourites().find((f) => f.id === itemId);
  if (fav) return fav;
  if (!svc.xtream) return (await loadM3u(svc)).items.find((i) => i.id === itemId);

  const { kind } = splitItemId(itemId);
  if (kind === 'live') {
    const found = (await allLive(sourceId)).find((i) => i.id === itemId);
    if (found) return found;
  }
  if (kind !== undefined) {
    for (const cat of await getCategories(sourceId, kind)) {
      const cached = store.getCached(sourceId, itemsKey(kind, cat.id), CATALOG_TTL_MS, cachedMediaItems);
      const found = cached?.find((i) => i.id === itemId);
      if (found) return found;
    }
  }
  return askProviderForItem(svc, sourceId, itemId);
}

async function itemDetail(sourceId: string, itemId: string): Promise<MediaItem | undefined> {
  const svc = servicesFor(sourceId);
  if (svc.xtream && splitItemId(itemId).kind === 'movie') {
    const full = await askProviderForItem(svc, sourceId, itemId);
    if (full) return full;
  }
  return findItem(sourceId, itemId);
}

async function askProviderForItem(
  svc: SourceServices,
  sourceId: string,
  itemId: string,
): Promise<MediaItem | undefined> {
  const key = `item:${itemId}`;
  const hit = store.getCached(sourceId, key, CATALOG_TTL_MS, parseMediaItem);
  if (hit) return hit;

  const { kind, rawId } = splitItemId(itemId);
  if (!rawId) return undefined;
  try {
    const item =
      kind === 'movie' ? await svc.xtream!.vodDetail(rawId)
      : kind === 'series' ? (await svc.xtream!.seriesDetail(rawId)).item
      : undefined;
    if (!item) return undefined;
    store.setCached(sourceId, key, item);
    return item;
  } catch {
    return undefined;
  }
}


/** Feeds to fill with: the auto-picked catalogue entries plus the user's own, minus those ticked off. */
async function fillFeeds(sourceId: string): Promise<EpgFeed[]> {
  const fill = store.getSettings().epgFill;
  const refs = fill.auto ? autoFeeds((await liveItems(sourceId)).map((i) => i.name)).map((f) => f.id) : [];
  const out: EpgFeed[] = [];
  for (const ref of [...refs, ...fill.enabled]) {
    if (fill.disabled.includes(ref)) continue;
    const f = resolveFeed(ref);
    if (f && !out.some((o) => o.url === f.url)) out.push(f);
  }
  return out;
}

const epgInFlight = new Map<string, Promise<void>>();

async function refreshEpg(sourceId: string, force: boolean): Promise<void> {
  const existing = epgInFlight.get(sourceId);
  if (existing) return existing;

  const svc = servicesFor(sourceId);
  const url = svc.source.epgUrl ?? (svc.xtream ? svc.xtream.xmltvUrl() : undefined);
  if (!url) {
    if (force) throw new Error('This source has no EPG URL configured.');
    return;
  }

  const run = (async () => {
    if (!force && svc.epg.stats.programmes === 0) await svc.epg.load();
    const refresh = epgAutoRefresh(store.getSettings());
    const feeds: FeedSpec[] = [{ id: 'provider', label: 'Provider guide', url, single: true }];
    for (const f of await fillFeeds(sourceId)) feeds.push({ id: f.id, label: f.label, url: f.url });

    // A feed is due on its own clock: never read, read from a different url, or older than the
    // refresh interval. Feeds that are current stay as they are; a forced refresh re-checks all.
    const held = new Map(svc.epg.feedStatus().map((s) => [s.id, s]));
    const due = new Set<string>();
    for (const f of feeds) {
      const s = held.get(f.id);
      if (force || s === undefined || s.url !== f.url || s.lastSync === undefined) {
        due.add(f.id);
        continue;
      }
      if (refresh.mode === 'everyHours' && Date.now() - s.lastSync * 1000 >= refresh.hours * 3_600_000) due.add(f.id);
    }
    const dropped = [...held.keys()].some((id) => !feeds.some((f) => f.id === id));
    if (due.size === 0 && !dropped) return;

    const res = await svc.epg.ingest(feeds, due, (message, pct) =>
      progress({ phase: 'epg', message, progress: pct }));
    progress({
      phase: 'done',
      message: `${res.programmes.toLocaleString()} programmes across ${res.channels.toLocaleString()} channels`,
      progress: 1,
    });
  })().finally(() => epgInFlight.delete(sourceId));

  epgInFlight.set(sourceId, run);
  return run;
}

function scheduleEpg(sourceId: string): void {
  void refreshEpg(sourceId, false).catch((err: unknown) => {
    progress({
      phase: 'error',
      message: 'xiptv could not load the guide.',
      progress: null,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}


function transcodeKey(req: PlayRequest): string {
  return req.episodeId ? `${req.sourceId}:${req.itemId}:${req.episodeId}` : `${req.sourceId}:${req.itemId}`;
}

async function resolveStream(req: PlayRequest): Promise<ResolvedStream> {
  const svc = servicesFor(req.sourceId);
  // The detail record is the only one that carries a film's running time.
  const item = await itemDetail(req.sourceId, req.itemId);
  if (!item) throw new Error('That item is no longer in the catalogue. Try refreshing the source.');

  let directUrl: string;
  let container = item.containerExtension;
  let title = item.title;
  let image = item.logo;
  let duration: number | undefined;
  let kind: MediaKind = item.kind;

  if (req.episodeId) {
    const detail = await svc.xtream!.seriesDetail(String(item.streamId));
    const episode = Object.values(detail.episodes).flat().find((e) => e.id === req.episodeId);
    if (!episode) throw new Error('That episode is no longer listed.');
    container = episode.containerExtension;
    title = episode.title;
    image = episode.image ?? image;
    duration = episode.durationSecs;
    kind = 'series';
    directUrl = svc.xtream!.streamUrl('series', episode.streamId, container);
  } else if (svc.xtream) {
    duration = item.durationSecs;
    directUrl = svc.xtream.streamUrl(item.kind, item.streamId, container);
  } else {
    // A favourite comes back from the store without touching the playlist, so on a cold start the
    // URL map may not be built yet. Loading it here is what makes a favourited M3U entry play
    // after a restart.
    const url = (await loadM3u(svc)).urls.get(item.id);
    if (!url) throw new Error('This playlist entry has no stream URL.');
    directUrl = url;
    container = url.split('?')[0].split('.').pop();
  }

  const forceTranscode = req.transcode === true || store.needsTranscode(transcodeKey(req));
  const engine: PlaybackEngine = forceTranscode ? 'transcode' : pickPlaybackEngine(kind, container);
  // start() returns early when the server is already up, so this costs nothing on the normal path.
  // It matters when a quit tore the server down without the process ever exiting: the app would
  // otherwise refuse to play anything for the rest of its life.
  await streamServer.start();
  const reg = streamServer.register({ directUrl, kind, container, title, durationSecs: duration });

  const url = engine === 'transcode' ? reg.transcodeUrl
    : engine === 'remux' ? reg.remuxUrl
    : reg.directProxyUrl;
  const mimeType = engine === 'remux' || engine === 'transcode' ? 'video/mp4'
    : engine === 'mpegts' ? 'video/mp2t'
    : mimeForContainer(container);

  const castsNatively = engine === 'native';
  return {
    url,
    directUrl,
    engine,
    kind,
    title,
    image,
    duration,
    mimeType,
    castUrl: castsNatively ? directUrl : reg.hlsUrl,
    castMimeType: castsNatively ? mimeForContainer(container) : 'application/x-mpegURL',
  };
}


async function testSource(
  input: Omit<Source, 'id'>,
): Promise<{ ok: boolean; message: string; probe?: SourceProbe }> {
  try {
    if (input.kind === 'xtream') {
      const { url, username, password } = input as Omit<XtreamSource, 'id'>;
      const client = new XtreamClient({ url, username, password });
      const auth = await client.auth();
      if (!auth.ok) return { ok: false, message: auth.message || 'The provider rejected these credentials.' };
      const [live, movies, series] = await Promise.all([
        client.categories('live'), client.categories('movie'), client.categories('series'),
      ]);
      return {
        ok: true,
        message: `Connected. ${auth.maxConnections} connection${auth.maxConnections === 1 ? '' : 's'} allowed.`,
        probe: { live: live.length, movies: movies.length, series: series.length, counts: 'categories' },
      };
    }
    const text = await fetchPlaylist(input.url, 60_000);
    const parsed = parseM3u(text);
    const probe: SourceProbe = { live: 0, movies: 0, series: 0, counts: 'items' };
    for (const item of parsed.items) {
      if (item.kind === 'live') probe.live += 1;
      else if (item.kind === 'movie') probe.movies += 1;
      else probe.series += 1;
    }
    return { ok: true, message: `Playlist loaded: ${parsed.items.length} entries.`, probe };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? redactText(err.message) : 'Could not reach that server.' };
  }
}


function registerIpc(): void {
  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, async (_e, ...args) => fn(...(args as never[])));
  };

  handle('sources:list', () => store.listSources());
  handle('sources:add', (input: NewSource) => {
    const added = store.addSource(input);
    scheduleEpg(added.id);
    return added;
  });
  handle('sources:update', (s: Source) => {
    services.delete(s.id);
    return store.upsertSource(s);
  });
  handle('sources:remove', (id: string) => {
    services.delete(id);
    store.removeSource(id);
    store.clearCache(id);
  });
  handle('sources:setActive', (id: string) => { store.setSettings({ activeSourceId: id }); });
  handle('sources:test', (input: Omit<Source, 'id'>) => testSource(input));

  handle('catalog:categories', (sourceId: string, kind: MediaKind) => getCategories(sourceId, kind));
  handle('catalog:items', async (sourceId: string, kind: MediaKind, categoryId: string) =>
    withGuideIds(sourceId, await getItems(sourceId, kind, categoryId)));
  handle('catalog:search', (sourceId: string, q: string, kind?: MediaKind) => search(sourceId, q, kind));
  handle('catalog:itemDetail', async (sourceId: string, itemId: string) => {
    const item = await itemDetail(sourceId, itemId);
    if (!item) throw new Error('That item is no longer in the catalogue.');
    return (await withGuideIds(sourceId, [item]))[0];
  });
  handle('catalog:seriesDetail', async (sourceId: string, seriesId: string): Promise<SeriesDetail> => {
    const svc = servicesFor(sourceId);
    if (!svc.xtream) throw new Error('Series details are only available on Xtream sources.');
    return svc.xtream.seriesDetail(seriesId.replace(/^series:/, ''));
  });
  handle('catalog:refresh', async (sourceId: string) => {
    store.clearCache(sourceId);
    services.delete(sourceId);
    progress({ phase: 'done', message: 'Catalogue cleared; it will reload as you browse.', progress: 1 });
  });
  handle('catalog:stats', async (sourceId: string): Promise<SourceStats> => {
    const svc = servicesFor(sourceId);
    const [live, movies, series] = await Promise.all([
      getCategories(sourceId, 'live'), getCategories(sourceId, 'movie'), getCategories(sourceId, 'series'),
    ]);
    const epg = svc.epg.stats;
    return {
      liveCategories: live.length,
      movieCategories: movies.length,
      seriesCategories: series.length,
      epgProgrammes: epg.programmes,
      lastSync: epg.lastSync,
      epgFeeds: svc.epg.feedStatus(),
    };
  });

  handle('epg:nowNext', (sourceId: string, id: string): NowNext => {
    const svc = servicesFor(sourceId);
    const resolved = svc.epg.resolveChannelId(id);
    return resolved ? svc.epg.nowNext(resolved) : {};
  });
  handle('epg:channel', (sourceId: string, id: string, from: number, to: number): EpgProgramme[] => {
    const svc = servicesFor(sourceId);
    const resolved = svc.epg.resolveChannelId(id);
    return resolved ? svc.epg.programmesOverlapping(resolved, from, to) : [];
  });
  handle('epg:grid', (sourceId: string, ids: string[], from: number, to: number) =>
    servicesFor(sourceId).epg.grid(ids, from, to));
  handle('epg:refresh', (sourceId: string) => refreshEpg(sourceId, true));
  handle('epg:feeds', async (sourceId: string): Promise<{ catalogue: EpgFeed[]; auto: string[] }> => ({
    catalogue: EPG_FEEDS.map((f) => ({ ...f, countries: [...f.countries] })),
    auto: autoFeeds((await liveItems(sourceId)).map((i) => i.name)).map((f) => f.id),
  }));
  handle('epg:channels', (sourceId: string, query: string): EpgChannelOption[] =>
    servicesFor(sourceId).epg.searchChannels(query));
  handle('epg:setOverride', (sourceId: string, itemId: string, channelId: string | null) => {
    store.setGuideOverride(sourceId, itemId, channelId ?? undefined);
    liveEpgIndexes.delete(sourceId);
  });
  handle('epg:overrides', (sourceId: string): GuideOverride[] => store.listGuideOverrides(sourceId));

  handle('player:resolve', (req: PlayRequest) => resolveStream(req));
  handle('player:openExternal', async (url: string) => {
    const external = store.getSettings().externalPlayer;
    if (!external) { await shell.openExternal(url); return; }
    const { spawn } = await import('node:child_process');
    spawn(external, [url], { detached: true, stdio: 'ignore' }).unref();
  });
  handle('player:stopRemux', () => { streamServer.stopStream(); });
  handle('player:lastError', () => streamServer.lastError());
  handle('player:streamDuration', () => streamServer.streamDuration());
  handle('player:markTranscode', (req: PlayRequest) => {
    store.markTranscode(transcodeKey(req));
  });

  handle('cast:scan', () => cast.scan());
  handle('cast:connect', (id: string) => cast.connect(id));
  handle('cast:disconnect', () => cast.disconnect());
  handle('cast:load', (stream: ResolvedStream, startAt?: number) =>
    cast.load({ ...stream, url: stream.castUrl, mimeType: stream.castMimeType }, startAt));
  handle('cast:play', () => cast.play());
  handle('cast:pause', () => cast.pause());
  handle('cast:seek', (s: number) => cast.seek(s));
  handle('cast:setVolume', (v: number) => cast.setVolume(v));
  handle('cast:status', () => cast.status());

  handle('library:favourites', () => store.listFavourites());
  handle('library:toggleFavourite', (item: MediaItem) => store.toggleFavourite(item));
  handle('library:isFavourite', (id: string) => store.isFavourite(id));
  handle('library:continueWatching', () => store.listProgress());
  handle('library:saveProgress', (p: WatchProgress) => { store.saveProgress(p); });
  handle('library:clearProgress', (id: string, episodeId?: string) => { store.clearProgress(id, episodeId); });

  handle('settings:get', () => store.getSettings());
  handle('settings:set', (patch: SettingsPatch) => {
    const next = store.setSettings(patch);
    if (patch.epgFill !== undefined) {
      const active = next.activeSourceId ?? store.listSources()[0]?.id;
      if (active !== undefined) scheduleEpg(active);
    }
    return next;
  });

  handle('window:toggleFullscreen', () => {
    if (!win) return false;
    const next = !win.isFullScreen();
    win.setFullScreen(next);
    return next;
  });
  handle('window:isMaximized', () => win?.isMaximized() ?? false);
  ipcMain.on('window:minimize', () => win?.minimize());
  ipcMain.on('window:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
  ipcMain.on('window:close', () => win?.close());
}


async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    backgroundColor: '#0A0B0D',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: process.platform === 'darwin',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(__dirname_, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.once('ready-to-show', () => win?.show());
  const emitWindowState = (): void =>
    send('window-state', { maximized: win?.isMaximized() ?? false, fullscreen: win?.isFullScreen() ?? false });
  win.on('maximize', emitWindowState);
  win.on('unmaximize', emitWindowState);
  win.on('enter-full-screen', emitWindowState);
  win.on('leave-full-screen', emitWindowState);
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(join(__dirname_, '../../dist/index.html'));
}

// A screenshot or test run can point the whole profile elsewhere, so it never touches the real one.
if (process.env.XIPTV_USER_DATA) {
  app.setPath('userData', process.env.XIPTV_USER_DATA);
  app.setPath('sessionData', process.env.XIPTV_USER_DATA);
}

if (process.argv.includes('--no-hw') || process.env.XIPTV_NO_HW === '1') {
  app.disableHardwareAcceleration();
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  store = new Store(app.getPath('userData'));
  await store.init();
  if (!store.getSettings().hardwareAcceleration) app.disableHardwareAcceleration();

  streamServer = new StreamServer();
  await streamServer.start();
  cast = new CastManager();
  cast.on('status', (s: CastStatus) => send('cast-status', s));

  registerIpc();
  await createWindow();

  const active = store.getSettings().activeSourceId ?? store.listSources()[0]?.id;
  if (active !== undefined) scheduleEpg(active);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

/** Long enough for ffmpeg to die and the receiver to be told, short enough to never feel stuck. */
const QUIT_CLEANUP_TIMEOUT_MS = 4_000;
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  // Electron quits before async cleanup can finish; defer one pass so the receiver and the ffmpeg
  // proxy, which hold the provider's single allowed connection, are really stopped.
  quitting = true;
  event.preventDefault();
  store?.flush();
  // Cleanup is worth waiting for, but never at the cost of the quit itself: stop() drops the
  // stream server before it waits on the listening socket, so a close that never settles leaves a
  // live window that cannot play anything.
  const cleanup = Promise.allSettled([cast?.shutdown(), streamServer?.stop()]);
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, QUIT_CLEANUP_TIMEOUT_MS));
  void Promise.race([cleanup, deadline]).then(() => app.quit());
});
