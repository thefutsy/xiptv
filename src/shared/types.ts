export type SourceKind = 'xtream' | 'm3u';

export interface XtreamSource {
  id: string;
  kind: 'xtream';
  name: string;
  /** Origin only, e.g. `http://host.example.com` or `http://host:8080`. No trailing slash. */
  url: string;
  username: string;
  password: string;
  /** Optional explicit XMLTV url. Defaults to `<url>/xmltv.php?username=..&password=..`. */
  epgUrl?: string;
}

export interface M3uSource {
  id: string;
  kind: 'm3u';
  name: string;
  /** Remote `http(s)://` playlist URL, or an absolute local file path. */
  url: string;
  epgUrl?: string;
}

export type Source = XtreamSource | M3uSource;


export type MediaKind = 'live' | 'movie' | 'series';

export interface Category {
  id: string;
  name: string;
  kind: MediaKind;
  count?: number;
}

export interface MediaItem {
  /** Stable, unique within a source. `live:1371820`, `movie:1388472`, `series:36708`. */
  id: string;
  kind: MediaKind;
  name: string;
  /** Cleaned display name with provider prefixes/symbols stripped. */
  title: string;
  categoryId: string;
  logo?: string;
  /** Provider-native numeric id used to build stream urls. */
  streamId: number;
  /** VOD only: `mkv`, `mp4`, ... Determines whether we must remux. */
  containerExtension?: string;
  rating?: number;
  year?: number;
  plot?: string;
  genre?: string;
  cast?: string;
  director?: string;
  backdrop?: string;
  /** Live only: XMLTV channel id used to join against EPG data. */
  epgChannelId?: string;
  /** Live only: what this channel is showing right now. */
  nowPlaying?: EpgProgramme;
  /** Live only: the programme whose title matched the search. May be hours away. */
  programmeMatch?: EpgProgramme;
  /** Live only: provider supports catch-up / archive for this channel. */
  hasArchive?: boolean;
  /** Series only: number of seasons when known. */
  seasonCount?: number;
  /** Movies only: running time in seconds, when the provider's detail record carries one. */
  durationSecs?: number;
  addedAt?: number;
}

export interface Episode {
  id: string;
  seriesId: string;
  season: number;
  episodeNum: number;
  title: string;
  plot?: string;
  image?: string;
  durationSecs?: number;
  containerExtension?: string;
  streamId: number;
}

export interface SeriesDetail {
  item: MediaItem;
  seasons: number[];
  episodes: Record<number, Episode[]>;
}


export interface EpgProgramme {
  channelId: string;
  title: string;
  description?: string;
  /** Unix epoch seconds. */
  start: number;
  stop: number;
}

export interface NowNext {
  now?: EpgProgramme;
  next?: EpgProgramme;
}


/**
 * How the renderer should play a resolved stream.
 * - `mpegts`  MPEG-TS over MSE via mpegts.js (live channels)
 * - `hls`     m3u8 via hls.js
 * - `native`  the browser can play the URL directly (mp4/webm)
 * - `remux`   goes through the local ffmpeg stream-copy proxy (mkv/avi VOD)
 * - `transcode` goes through the local ffmpeg re-encoding proxy, for streams whose codecs Chromium
 *   cannot decode at any cost. That means HEVC anywhere on Linux, and MPEG-2 or AC-3/E-AC-3 audio
 *   everywhere
 */
export type PlaybackEngine = 'mpegts' | 'hls' | 'native' | 'remux' | 'transcode';

export interface ResolvedStream {
  /** URL the renderer should load. For `remux` this points at the local proxy. */
  url: string;
  /** Direct provider URL, used for Chromecast and external players. */
  directUrl: string;
  engine: PlaybackEngine;
  kind: MediaKind;
  title: string;
  image?: string;
  /** Seconds, VOD only. */
  duration?: number;
  mimeType: string;
  /**
   * URL to hand a Chromecast. Casting is a different problem from local playback. A cast device
   * has no Matroska demuxer and will not take raw MPEG-TS over HTTP, so we cast MKV and live
   * channels as HLS from our LAN-bound stream server. A plain mp4 goes straight from the provider.
   */
  castUrl: string;
  castMimeType: string;
}

export interface PlayRequest {
  sourceId: string;
  itemId: string;
  episodeId?: string;
  /** Resume position in seconds. */
  startAt?: number;
  transcode?: boolean;
}


export interface CastDevice {
  id: string;
  name: string;
  host: string;
  port: number;
  model?: string;
}

export type CastPlayerState = 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED';

export interface CastStatus {
  connected: boolean;
  device?: CastDevice;
  state: CastPlayerState;
  currentTime: number;
  duration?: number;
  volume: number;
  muted: boolean;
  title?: string;
  error?: string;
}


export interface WatchProgress {
  itemId: string;
  sourceId: string;
  position: number;
  duration: number;
  updatedAt: number;
  title: string;
  image?: string;
  kind: MediaKind;
  episodeId?: string;
}

export interface Settings {
  activeSourceId?: string;
  liveFormat: 'ts' | 'hls';
  externalPlayer?: string;
  hardwareAcceleration: boolean;
  /** Hours between background XMLTV re-reads, or `null` for no automatic refresh. */
  epgAutoRefreshHours: number | null;
  epgFill: EpgFillSettings;
}

/** A public XMLTV feed used to fill channels the provider's guide leaves empty. */
export interface EpgFeed {
  /** Catalogue id (`au`, `bein`) or, for a user-entered feed, its url. */
  id: string;
  label: string;
  url: string;
  /** Country tags (`au`, `gb`) that select this feed in `auto` mode. */
  countries: string[];
}

export interface EpgFillSettings {
  /** Tick on the catalogue feeds matching the country tags on channel names. */
  auto: boolean;
  /** Catalogue ids or raw XMLTV urls ticked on by hand. */
  enabled: string[];
  /** Catalogue ids ticked off although `auto` would pick them. */
  disabled: string[];
}

export interface EpgFeedStatus {
  id: string;
  label: string;
  url: string;
  /** Channels this feed has listings for; an earlier feed's channel of the same id wins in the merge. */
  channels: number;
  programmes: number;
  /** Unix seconds of the last successful read or `304 Not Modified`. */
  lastSync?: number;
  etag?: string;
  lastModified?: string;
  error?: string;
}

/** A channel in the merged guide, offered when the user picks one by hand. */
export interface EpgChannelOption {
  id: string;
  name: string;
  feed: string;
}

/** Pins a live channel to a guide channel, overriding the fuzzy match. */
export interface GuideOverride {
  sourceId: string;
  itemId: string;
  channelId: string;
}


export interface SyncProgress {
  phase: 'idle' | 'categories' | 'live' | 'movies' | 'series' | 'epg' | 'done' | 'error';
  message: string;
  /** 0..1, or null when indeterminate. */
  progress: number | null;
  error?: string;
}

export interface SourceStats {
  liveCategories: number;
  movieCategories: number;
  seriesCategories: number;
  epgProgrammes: number;
  /** Unix SECONDS (not milliseconds) of the last successful EPG ingest. */
  lastSync?: number;
  /** The provider's own feed first, then every fill feed that was tried. */
  epgFeeds: EpgFeedStatus[];
}

type Clearable<T> = undefined extends T ? T | null : T;

/** A settings patch: omit a key to leave it alone, pass `null` to clear an optional one. */
export type SettingsPatch = { [K in keyof Settings]?: Clearable<Settings[K]> };

export interface SourceProbe {
  live: number;
  movies: number;
  series: number;
  counts: 'categories' | 'items';
}


export interface IpcApi {
  sources: {
    list(): Promise<Source[]>;
    add(source: Omit<Source, 'id'>): Promise<Source>;
    update(source: Source): Promise<Source>;
    remove(id: string): Promise<void>;
    test(source: Omit<Source, 'id'>): Promise<{ ok: boolean; message: string; probe?: SourceProbe }>;
    setActive(id: string): Promise<void>;
  };
  catalog: {
    categories(sourceId: string, kind: MediaKind): Promise<Category[]>;
    items(sourceId: string, kind: MediaKind, categoryId: string): Promise<MediaItem[]>;
    search(sourceId: string, query: string, kind?: MediaKind): Promise<MediaItem[]>;
    seriesDetail(sourceId: string, seriesId: string): Promise<SeriesDetail>;
    itemDetail(sourceId: string, itemId: string): Promise<MediaItem>;
    refresh(sourceId: string): Promise<void>;
    stats(sourceId: string): Promise<SourceStats>;
  };
  epg: {
    nowNext(sourceId: string, epgChannelId: string): Promise<NowNext>;
    channel(sourceId: string, epgChannelId: string, from: number, to: number): Promise<EpgProgramme[]>;
    grid(sourceId: string, epgChannelIds: string[], from: number, to: number): Promise<Record<string, EpgProgramme[]>>;
    refresh(sourceId: string): Promise<void>;
    /** The fill-feed catalogue, and which of it `auto` mode would pick for this source. */
    feeds(sourceId: string): Promise<{ catalogue: EpgFeed[]; auto: string[] }>;
    channels(sourceId: string, query: string): Promise<EpgChannelOption[]>;
    setOverride(sourceId: string, itemId: string, channelId: string | null): Promise<void>;
    overrides(sourceId: string): Promise<GuideOverride[]>;
  };
  player: {
    resolve(req: PlayRequest): Promise<ResolvedStream>;
    openExternal(url: string): Promise<void>;
    stopRemux(): Promise<void>;
    lastError(): Promise<string | undefined>;
    /** Full length of the stream ffmpeg is currently serving, learned from its input header. */
    streamDuration(): Promise<number | undefined>;
    /**
     * Remembers that this stream needs re-encoding, so later plays skip the failed direct attempt
     * entirely. Persisted: a channel's codec is a property of the channel, not of the session.
     */
    markTranscode(req: PlayRequest): Promise<void>;
  };
  cast: {
    scan(): Promise<CastDevice[]>;
    connect(deviceId: string): Promise<CastStatus>;
    disconnect(): Promise<void>;
    load(stream: ResolvedStream, startAt?: number): Promise<CastStatus>;
    play(): Promise<void>;
    pause(): Promise<void>;
    seek(seconds: number): Promise<void>;
    setVolume(level: number): Promise<void>;
    status(): Promise<CastStatus>;
  };
  library: {
    favourites(): Promise<MediaItem[]>;
    toggleFavourite(item: MediaItem): Promise<boolean>;
    isFavourite(itemId: string): Promise<boolean>;
    continueWatching(): Promise<WatchProgress[]>;
    saveProgress(p: WatchProgress): Promise<void>;
    /** Clears one episode when `episodeId` is given, otherwise every row for the item. */
    clearProgress(itemId: string, episodeId?: string): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: SettingsPatch): Promise<Settings>;
  };
  window: {
    minimize(): void;
    maximize(): void;
    close(): void;
    toggleFullscreen(): Promise<boolean>;
    isMaximized(): Promise<boolean>;
  };
  /** Main -> renderer push events. Returns an unsubscribe function. */
  on(channel: 'sync-progress', cb: (p: SyncProgress) => void): () => void;
  on(channel: 'cast-status', cb: (s: CastStatus) => void): () => void;
  on(channel: 'window-state', cb: (s: { maximized: boolean; fullscreen: boolean }) => void): () => void;
}

declare global {
  interface Window {
    iptv: IpcApi;
  }
}
