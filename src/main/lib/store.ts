import { parsePlaybackPreferences } from '../../shared/tracks';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers';

import type {
  Category,
  EpgFillSettings,
  GuideOverride,
  M3uSource,
  MediaItem,
  MediaKind,
  Settings,
  SettingsPatch,
  Source,
  WatchProgress,
  XtreamSource,
} from '@shared/types';

const CONFIG_VERSION = 1;
const SAVE_DEBOUNCE_MS = 250;
const PROGRESS_LIMIT = 60;
const TRANSCODE_KEY_LIMIT = 500;
const MEMORY_CACHE_LIMIT = 40;
const PRIVATE_FILE_MODE = 0o600;

interface ConfigFile {
  version: number;
  sources: Source[];
  settings: Settings;
  favourites: MediaItem[];
  progress: WatchProgress[];
  transcodeKeys: string[];
  guideOverrides: GuideOverride[];
}

interface CacheEnvelope {
  key: string;
  savedAt: number;
  value: unknown;
}

interface MemoryEntry {
  savedAt: number;
  value: unknown;
}

type ConfigLoad =
  | { outcome: 'loaded'; config: ConfigFile }
  | { outcome: 'absent' }
  | { outcome: 'quarantined' }
  | { outcome: 'unreadable'; code: string; error: unknown };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type NewSource = DistributiveOmit<Source, 'id'>;



export type EpgAutoRefresh = { mode: 'never' } | { mode: 'everyHours'; hours: number };

export type CacheValidator<T> = (value: unknown) => T | undefined;

export class Store {
  private readonly configPath: string;
  private readonly cacheRoot: string;

  private config: ConfigFile = defaultConfig();
  private readOnly = false;
  private cacheDisabled = false;
  private readonly memory = new Map<string, MemoryEntry>();

  private saveTimer: ReturnType<typeof setNodeTimeout> | undefined;
  private dirty = false;
  private ready = false;

  constructor(userDataDir: string) {
    const root = resolve(userDataDir);
    this.configPath = join(root, 'config.json');
    this.cacheRoot = join(root, 'cache');
  }

  async init(): Promise<void> {
    if (this.ready) return;
    try {
      await mkdir(this.cacheRoot, { recursive: true });
    } catch (err) {
      this.cacheDisabled = true;
      warn('cache directory unavailable; running from the network only', err);
    }
    const loaded = await this.loadConfig();
    switch (loaded.outcome) {
      case 'loaded':
        this.config = loaded.config;
        break;
      case 'absent':
      case 'quarantined':
        this.config = defaultConfig();
        break;
      case 'unreadable':
        this.config = defaultConfig();
        this.readOnly = true;
        warn(`could not read config.json (${loaded.code}); running without persistence`, loaded.error);
        break;
    }
    this.ready = true;

    this.writeConfig();

    process.once('exit', () => this.flush());
    // Node does not emit 'exit' when a signal's default action terminates the process, and
    // remux.ts re-raises SIGTERM/SIGINT/SIGHUP after cleaning up its ffmpeg children. Re-raise so
    // termination still happens when this is the only handler installed.
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      process.once(signal, () => {
        this.flush();
        process.kill(process.pid, signal);
      });
    }
  }

  flush(): void {
    if (this.saveTimer !== undefined) {
      clearNodeTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.dirty) return;
    this.writeConfig();
  }

  private writeConfig(): void {
    if (this.readOnly) return;
    try {
      writeFileAtomic(this.configPath, JSON.stringify(this.config, null, 2), {
        mode: PRIVATE_FILE_MODE,
        fsync: true,
      });
      this.dirty = false;
    } catch (err) {
      warn('could not write config.json', err);
    }
  }


  listSources(): Source[] {
    return this.config.sources.map(cloneJson);
  }

  addSource(input: NewSource): Source {
    const id = randomUUID();
    const source = parseSource({ ...input, id }, id);
    if (!source) throw new Error('addSource: need kind "xtream" or "m3u", a name and a url');
    this.config.sources.push(source);
    this.scheduleSave();
    return cloneJson(source);
  }

  upsertSource(input: Source): Source {
    const source = parseSource(input, input.id);
    if (!source) throw new Error('upsertSource: need kind "xtream" or "m3u", an id, a name and a url');
    const index = this.config.sources.findIndex((s) => s.id === source.id);
    if (index >= 0) this.config.sources[index] = source;
    else this.config.sources.push(source);
    this.scheduleSave();
    return cloneJson(source);
  }

  removeSource(id: string): void {
    const remaining = this.config.sources.filter((s) => s.id !== id);
    if (remaining.length === this.config.sources.length) return;
    this.config.sources = remaining;
    this.config.progress = this.config.progress.filter((p) => p.sourceId !== id);
    this.config.guideOverrides = this.config.guideOverrides.filter((o) => o.sourceId !== id);
    if (this.config.settings.activeSourceId === id) {
      this.config.settings.activeSourceId = remaining[0]?.id;
    }
    this.clearCache(id);
    this.scheduleSave();
  }


  getSettings(): Settings {
    return cloneJson(this.config.settings);
  }

  setSettings(patch: SettingsPatch): Settings {
    this.config.settings = parseSettings(patch, this.config.settings);
    this.scheduleSave();
    return cloneJson(this.config.settings);
  }

  listGuideOverrides(sourceId: string): GuideOverride[] {
    return this.config.guideOverrides.filter((o) => o.sourceId === sourceId).map(cloneJson);
  }

  setGuideOverride(sourceId: string, itemId: string, channelId: string | undefined): void {
    const rest = this.config.guideOverrides.filter((o) => o.sourceId !== sourceId || o.itemId !== itemId);
    if (channelId !== undefined && channelId.length > 0) rest.push({ sourceId, itemId, channelId });
    this.config.guideOverrides = rest;
    this.scheduleSave();
  }


  listFavourites(): MediaItem[] {
    return this.config.favourites.map(cloneJson);
  }

  toggleFavourite(item: MediaItem): boolean {
    const parsed = parseMediaItem(item);
    if (!parsed) throw new Error('toggleFavourite: item needs id, kind, name and streamId');
    const index = this.config.favourites.findIndex((f) => f.id === parsed.id);
    if (index >= 0) {
      this.config.favourites.splice(index, 1);
      this.scheduleSave();
      return false;
    }
    this.config.favourites.unshift(parsed);
    this.scheduleSave();
    return true;
  }

  isFavourite(itemId: string): boolean {
    return this.config.favourites.some((f) => f.id === itemId);
  }


  needsTranscode(key: string): boolean {
    return this.config.transcodeKeys.includes(key);
  }

  markTranscode(key: string): void {
    if (!key || this.config.transcodeKeys.includes(key)) return;
    this.config.transcodeKeys.push(key);
    if (this.config.transcodeKeys.length > TRANSCODE_KEY_LIMIT) {
      this.config.transcodeKeys.splice(0, this.config.transcodeKeys.length - TRANSCODE_KEY_LIMIT);
    }
    this.scheduleSave();
  }


  listProgress(): WatchProgress[] {
    return this.config.progress
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, PROGRESS_LIMIT)
      .map(cloneJson);
  }

  saveProgress(p: WatchProgress): void {
    const parsed = parseProgress(p);
    if (!parsed) throw new Error('saveProgress: need itemId, sourceId, kind and position');
    const key = progressKey(parsed);
    this.config.progress = [parsed, ...this.config.progress.filter((x) => progressKey(x) !== key)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, PROGRESS_LIMIT);
    this.scheduleSave();
  }

  clearProgress(itemId: string, episodeId?: string): void {
    const remaining = this.config.progress.filter(
      (p) => p.itemId !== itemId || (episodeId !== undefined && p.episodeId !== episodeId),
    );
    if (remaining.length === this.config.progress.length) return;
    this.config.progress = remaining;
    this.scheduleSave();
  }


  getCached<T>(
    sourceId: string,
    key: string,
    maxAgeMs: number,
    parse: CacheValidator<T>,
  ): T | undefined {
    const memKey = this.memoryKey(sourceId, key);
    const now = Date.now();

    const hit = this.memory.get(memKey);
    if (hit) {
      this.memory.delete(memKey);
      if (now - hit.savedAt <= maxAgeMs) {
        this.memory.set(memKey, hit);
        return hit.value as T;
      }
    }

    if (this.cacheDisabled) return undefined;
    const file = join(this.cacheDirPath(sourceId), `${sha1(key)}.json`);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }

    let envelope: CacheEnvelope | undefined;
    try {
      envelope = parseEnvelope(JSON.parse(raw));
    } catch {
      envelope = undefined;
    }
    if (!envelope || envelope.key !== key) {
      removeQuietly(file);
      return undefined;
    }
    if (now - envelope.savedAt > maxAgeMs) return undefined;

    const value = parse(envelope.value);
    if (value === undefined) {
      removeQuietly(file);
      return undefined;
    }

    this.remember(memKey, { savedAt: envelope.savedAt, value });
    return value;
  }

  setCached<T>(sourceId: string, key: string, value: T): void {
    const savedAt = Date.now();
    this.remember(this.memoryKey(sourceId, key), { savedAt, value });

    if (this.cacheDisabled) return;
    try {
      const file = join(this.cacheDir(sourceId), `${sha1(key)}.json`);
      const envelope: CacheEnvelope = { key, savedAt, value };
      writeFileAtomic(file, JSON.stringify(envelope), {});
    } catch (err) {
      warn(`could not write cache entry ${key}`, err);
    }
  }

  clearCache(sourceId: string): void {
    try {
      rmSync(this.cacheDirPath(sourceId), { recursive: true, force: true });
    } catch (err) {
      warn(`could not clear cache for ${sourceId}`, err);
    }
    const prefix = `${safeSegment(sourceId)}|`;
    for (const key of this.memory.keys()) {
      if (key.startsWith(prefix)) this.memory.delete(key);
    }
  }

  cacheDir(sourceId: string): string {
    const dir = this.cacheDirPath(sourceId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }


  private cacheDirPath(sourceId: string): string {
    const dir = join(this.cacheRoot, safeSegment(sourceId));
    if (!dir.startsWith(this.cacheRoot + sep)) {
      throw new Error(`unsafe source id: ${sourceId}`);
    }
    return dir;
  }

  private memoryKey(sourceId: string, key: string): string {
    return `${safeSegment(sourceId)}|${key}`;
  }

  private remember(memKey: string, entry: MemoryEntry): void {
    this.memory.delete(memKey);
    this.memory.set(memKey, entry);
    while (this.memory.size > MEMORY_CACHE_LIMIT) {
      const oldest = this.memory.keys().next();
      if (oldest.done) break;
      this.memory.delete(oldest.value);
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setNodeTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref();
  }

  private async loadConfig(): Promise<ConfigLoad> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { outcome: 'absent' };
      return { outcome: 'unreadable', code: code ?? 'unknown error', error: err };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.quarantine(raw);
      return { outcome: 'quarantined' };
    }
    return { outcome: 'loaded', config: parseConfig(parsed) };
  }

  private quarantine(raw: string): void {
    if (!raw.trim()) return;
    try {
      writeFileSync(`${this.configPath}.corrupt-${Date.now()}`, raw, {
        encoding: 'utf8',
        mode: PRIVATE_FILE_MODE,
      });
    } catch (err) {
      warn('could not preserve corrupt config', err);
    }
  }
}


interface AtomicOptions {
  mode?: number;
  fsync?: boolean;
}

let tmpCounter = 0;

function writeFileAtomic(target: string, data: string, opts: AtomicOptions): void {
  const tmp = `${target}.${process.pid}-${(tmpCounter += 1)}.tmp`;
  try {
    if (opts.fsync) {
      const fd = openSync(tmp, 'w', opts.mode ?? 0o666);
      try {
        writeFileSync(fd, data, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      writeFileSync(tmp, data, { encoding: 'utf8', mode: opts.mode });
    }
    // Creation modes are masked by umask and ignored when the file already exists, so set the
    // mode explicitly. Windows has no meaningful posix mode.
    if (opts.mode !== undefined && process.platform !== 'win32') chmodSync(tmp, opts.mode);
    renameSync(tmp, target);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
  }
}


function sha1(value: string): string {
  return createHash('sha1').update(value, 'utf8').digest('hex');
}

function safeSegment(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[.\-_]+/, '').slice(0, 40);
  return `${cleaned || 'src'}-${sha1(id).slice(0, 8)}`;
}

function progressKey(p: WatchProgress): string {
  return `${p.sourceId}|${p.itemId}`;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function warn(message: string, err: unknown): void {
  console.warn(`[store] ${message}: ${err instanceof Error ? err.message : String(err)}`);
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseKind(value: unknown): MediaKind | undefined {
  return value === 'live' || value === 'movie' || value === 'series' ? value : undefined;
}

function defaultSettings(): Settings {
  return {
    playback: parsePlaybackPreferences(undefined),
    liveFormat: 'ts', hardwareAcceleration: true, epgAutoRefreshHours: 12,
    epgFill: { auto: true, enabled: [], disabled: [] },
  };
}

function defaultConfig(): ConfigFile {
  return {
    version: CONFIG_VERSION,
    sources: [],
    settings: defaultSettings(),
    favourites: [],
    progress: [],
    transcodeKeys: [],
    guideOverrides: [],
  };
}

function stringList(raw: unknown, base: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [...base];
  const out: string[] = [];
  for (const entry of raw) {
    const id = str(entry)?.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function parseEpgFill(raw: unknown, base: EpgFillSettings): EpgFillSettings {
  if (!isRecord(raw)) return { auto: base.auto, enabled: [...base.enabled], disabled: [...base.disabled] };
  return {
    auto: typeof raw.auto === 'boolean' ? raw.auto : base.auto,
    enabled: stringList(raw.enabled, base.enabled),
    disabled: stringList(raw.disabled, base.disabled),
  };
}

function parseGuideOverride(raw: unknown): GuideOverride | undefined {
  if (!isRecord(raw)) return undefined;
  const sourceId = str(raw.sourceId);
  const itemId = str(raw.itemId);
  const channelId = str(raw.channelId);
  return sourceId && itemId && channelId ? { sourceId, itemId, channelId } : undefined;
}

export function epgAutoRefresh(settings: Settings): EpgAutoRefresh {
  const hours = settings.epgAutoRefreshHours;
  return hours !== null && hours > 0 ? { mode: 'everyHours', hours } : { mode: 'never' };
}

function epgRefreshToHours(refresh: EpgAutoRefresh): number | null {
  return refresh.mode === 'never' ? null : refresh.hours;
}

/** `null` clears an optional field; a missing key leaves it as it was. */
function patchOptionalString(
  raw: Record<string, unknown>,
  key: string,
  current: string | undefined,
): string | undefined {
  const value = raw[key];
  if (value === null) return undefined;
  if (value === undefined) return current;
  return str(value) ?? current;
}

function parseSettings(raw: unknown, base: Settings): Settings {
  if (!isRecord(raw)) return { ...base };
  const liveFormat =
    raw.liveFormat === 'ts' || raw.liveFormat === 'hls' ? raw.liveFormat : base.liveFormat;
  const rawHours = raw.epgAutoRefreshHours;
  const hours = num(rawHours);
  const settings: Settings = {
    playback: parsePlaybackPreferences(raw.playback, base.playback),
    liveFormat,
    hardwareAcceleration:
      typeof raw.hardwareAcceleration === 'boolean'
        ? raw.hardwareAcceleration
        : base.hardwareAcceleration,
    epgAutoRefreshHours:
      rawHours === null || hours === 0 ? null
      : hours !== undefined && hours > 0 ? hours
      : epgRefreshToHours(epgAutoRefresh(base)),
    epgFill: parseEpgFill(raw.epgFill, base.epgFill),
  };
  const activeSourceId = patchOptionalString(raw, 'activeSourceId', base.activeSourceId);
  if (activeSourceId) settings.activeSourceId = activeSourceId;
  const externalPlayer = patchOptionalString(raw, 'externalPlayer', base.externalPlayer);
  if (externalPlayer) settings.externalPlayer = externalPlayer;
  return settings;
}

function parseSource(raw: unknown, fallbackId: string): Source | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id) ?? fallbackId;
  const name = str(raw.name);
  const url = str(raw.url);
  if (!id || !name || !url) return undefined;

  const cleanUrl = url.trim().replace(/\/+$/, '');
  const epgUrl = str(raw.epgUrl);

  if (raw.kind === 'xtream') {
    const source: XtreamSource = {
      id,
      kind: 'xtream',
      name,
      url: cleanUrl,
      username: typeof raw.username === 'string' ? raw.username : '',
      password: typeof raw.password === 'string' ? raw.password : '',
    };
    if (epgUrl) source.epgUrl = epgUrl;
    return source;
  }
  if (raw.kind === 'm3u') {
    const source: M3uSource = { id, kind: 'm3u', name, url: cleanUrl };
    if (epgUrl) source.epgUrl = epgUrl;
    return source;
  }
  return undefined;
}

const OPTIONAL_ITEM_STRINGS = [
  'categoryName', 'language', 'logo',
  'containerExtension',
  'plot',
  'genre',
  'cast',
  'director',
  'backdrop',
  'epgChannelId',
] as const;

const OPTIONAL_ITEM_NUMBERS = ['rating', 'year', 'seasonCount', 'durationSecs', 'addedAt'] as const;

export function cachedList<T>(parse: CacheValidator<T>): CacheValidator<T[]> {
  return (value) => {
    if (!Array.isArray(value)) return undefined;
    const out: T[] = [];
    for (const entry of value) {
      const item = parse(entry);
      if (item !== undefined) out.push(item);
    }
    return out;
  };
}

export function parseCategory(raw: unknown): Category | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id);
  const kind = parseKind(raw.kind);
  const name = str(raw.name);
  if (!id || !kind || !name) return undefined;
  const category: Category = { id, name, kind };
  const count = num(raw.count);
  if (count !== undefined) category.count = count;
  return category;
}

export function parseMediaItem(raw: unknown): MediaItem | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id);
  const kind = parseKind(raw.kind);
  const name = str(raw.name);
  const streamId = num(raw.streamId);
  if (!id || !kind || !name || streamId === undefined) return undefined;

  const item: MediaItem = {
    id,
    kind,
    name,
    title: str(raw.title) ?? name,
    categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : '',
    streamId,
  };
  for (const field of OPTIONAL_ITEM_STRINGS) {
    const value = str(raw[field]);
    if (value !== undefined) item[field] = value;
  }
  for (const field of OPTIONAL_ITEM_NUMBERS) {
    const value = num(raw[field]);
    if (value !== undefined) item[field] = value;
  }
  if (typeof raw.hasArchive === 'boolean') item.hasArchive = raw.hasArchive;
  return item;
}

function parseProgress(raw: unknown): WatchProgress | undefined {
  if (!isRecord(raw)) return undefined;
  const itemId = str(raw.itemId);
  const sourceId = str(raw.sourceId);
  const kind = parseKind(raw.kind);
  const position = num(raw.position);
  if (!itemId || !sourceId || !kind || position === undefined) return undefined;

  const duration = num(raw.duration);
  const progress: WatchProgress = {
    itemId,
    sourceId,
    kind,
    position: Math.max(0, position),
    duration: duration !== undefined && duration > 0 ? duration : 0,
    updatedAt: num(raw.updatedAt) ?? Date.now(),
    title: str(raw.title) ?? itemId,
  };
  const image = str(raw.image);
  if (image) progress.image = image;
  const episodeId = str(raw.episodeId);
  if (episodeId) progress.episodeId = episodeId;
  return progress;
}

function parseConfig(raw: unknown): ConfigFile {
  if (!isRecord(raw)) return defaultConfig();

  const sources: Source[] = [];
  const sourceIds = new Set<string>();
  if (Array.isArray(raw.sources)) {
    for (const entry of raw.sources) {
      const source = parseSource(entry, randomUUID());
      if (!source || sourceIds.has(source.id)) continue;
      sourceIds.add(source.id);
      sources.push(source);
    }
  }

  const favourites: MediaItem[] = [];
  const favouriteIds = new Set<string>();
  if (Array.isArray(raw.favourites)) {
    for (const entry of raw.favourites) {
      const item = parseMediaItem(entry);
      if (!item || favouriteIds.has(item.id)) continue;
      favouriteIds.add(item.id);
      favourites.push(item);
    }
  }

  const progress: WatchProgress[] = [];
  const progressKeys = new Set<string>();
  if (Array.isArray(raw.progress)) {
    for (const entry of raw.progress) {
      const p = parseProgress(entry);
      if (!p || progressKeys.has(progressKey(p))) continue;
      progressKeys.add(progressKey(p));
      progress.push(p);
    }
  }
  progress.sort((a, b) => b.updatedAt - a.updatedAt);

  const transcodeKeys: string[] = [];
  if (Array.isArray(raw.transcodeKeys)) {
    for (const entry of raw.transcodeKeys) {
      const key = str(entry);
      if (key && !transcodeKeys.includes(key)) transcodeKeys.push(key);
    }
  }

  const settings = parseSettings(raw.settings, defaultSettings());
  if (settings.activeSourceId && !sourceIds.has(settings.activeSourceId)) {
    delete settings.activeSourceId;
  }

  const guideOverrides: GuideOverride[] = [];
  if (Array.isArray(raw.guideOverrides)) {
    for (const entry of raw.guideOverrides) {
      const o = parseGuideOverride(entry);
      if (o && sourceIds.has(o.sourceId)) guideOverrides.push(o);
    }
  }

  return {
    version: CONFIG_VERSION,
    sources,
    settings,
    favourites,
    progress: progress.slice(0, PROGRESS_LIMIT),
    transcodeKeys: transcodeKeys.slice(-TRANSCODE_KEY_LIMIT),
    guideOverrides,
  };
}

function parseEnvelope(raw: unknown): CacheEnvelope | undefined {
  if (!isRecord(raw)) return undefined;
  const key = str(raw.key);
  const savedAt = num(raw.savedAt);
  if (!key || savedAt === undefined || !('value' in raw)) return undefined;
  return { key, savedAt, value: raw.value };
}
