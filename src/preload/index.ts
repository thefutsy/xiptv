import { contextBridge, ipcRenderer } from 'electron';
import type { IpcApi } from '@shared/types';


const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const PUSH_CHANNELS = new Set(['sync-progress', 'cast-status', 'window-state']);

const api: IpcApi = {
  sources: {
    list: () => invoke('sources:list'),
    add: (source) => invoke('sources:add', source),
    update: (source) => invoke('sources:update', source),
    remove: (id) => invoke('sources:remove', id),
    test: (source) => invoke('sources:test', source),
    setActive: (id) => invoke('sources:setActive', id),
  },
  catalog: {
    categories: (sourceId, kind) => invoke('catalog:categories', sourceId, kind),
    items: (sourceId, kind, categoryId) => invoke('catalog:items', sourceId, kind, categoryId),
    search: (sourceId, query, kind) => invoke('catalog:search', sourceId, query, kind),
    seriesDetail: (sourceId, seriesId) => invoke('catalog:seriesDetail', sourceId, seriesId),
    itemDetail: (sourceId, itemId) => invoke('catalog:itemDetail', sourceId, itemId),
    refresh: (sourceId) => invoke('catalog:refresh', sourceId),
    stats: (sourceId) => invoke('catalog:stats', sourceId),
  },
  epg: {
    nowNext: (sourceId, epgChannelId) => invoke('epg:nowNext', sourceId, epgChannelId),
    channel: (sourceId, epgChannelId, from, to) => invoke('epg:channel', sourceId, epgChannelId, from, to),
    grid: (sourceId, ids, from, to) => invoke('epg:grid', sourceId, ids, from, to),
    refresh: (sourceId) => invoke('epg:refresh', sourceId),
    feeds: (sourceId) => invoke('epg:feeds', sourceId),
    channels: (sourceId, query) => invoke('epg:channels', sourceId, query),
    setOverride: (sourceId, itemId, channelId) => invoke('epg:setOverride', sourceId, itemId, channelId),
    overrides: (sourceId) => invoke('epg:overrides', sourceId),
  },
  player: {
    resolve: (req) => invoke('player:resolve', req),
    openExternal: (url) => invoke('player:openExternal', url),
    stopRemux: () => invoke('player:stopRemux'),
    lastError: () => invoke('player:lastError'),
    streamDuration: () => invoke('player:streamDuration'),
    markTranscode: (req) => invoke('player:markTranscode', req),
  },
  cast: {
    scan: () => invoke('cast:scan'),
    connect: (deviceId) => invoke('cast:connect', deviceId),
    disconnect: () => invoke('cast:disconnect'),
    load: (stream, startAt) => invoke('cast:load', stream, startAt),
    play: () => invoke('cast:play'),
    pause: () => invoke('cast:pause'),
    seek: (seconds) => invoke('cast:seek', seconds),
    setVolume: (level) => invoke('cast:setVolume', level),
    status: () => invoke('cast:status'),
  },
  library: {
    favourites: () => invoke('library:favourites'),
    toggleFavourite: (item) => invoke('library:toggleFavourite', item),
    isFavourite: (itemId) => invoke('library:isFavourite', itemId),
    continueWatching: () => invoke('library:continueWatching'),
    saveProgress: (p) => invoke('library:saveProgress', p),
    clearProgress: (itemId, episodeId) => invoke('library:clearProgress', itemId, episodeId),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    toggleFullscreen: () => invoke('window:toggleFullscreen'),
    isMaximized: () => invoke('window:isMaximized'),
  },
  on: ((channel: string, cb: (payload: unknown) => void) => {
    if (!PUSH_CHANNELS.has(channel)) return () => {};
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }) as IpcApi['on'],
};

contextBridge.exposeInMainWorld('iptv', api);
