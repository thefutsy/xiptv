// Production renderer and real stream server, with an isolated profile and original media fixtures.
const { app, BrowserWindow, ipcMain, ipcRenderer } = require('electron');
const assert = require('node:assert/strict');
const { writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.type === 'renderer') {
  const invoke = (method, ...args) => ipcRenderer.invoke('fixture', method, ...args);
  const noop = async () => undefined;
  window.failNextTrack = () => invoke('failNextTrack');
  window.iptv = {
    sources: { list: () => invoke('sources'), setActive: noop },
    settings: { get: () => invoke('settings'), set: patch => invoke('settingsSet', patch) },
    library: { favourites: async () => [], continueWatching: async () => [], saveProgress: noop },
    catalog: { stats: async () => ({ catalogReady: true, liveCategories: 0, movieCategories: 0, seriesCategories: 0, epgProgrammes: 0 }), categories: async () => [], items: async () => [] },
    player: Object.fromEntries(['prepareTracks', 'cancelTracks', 'importSubtitles', 'stopRemux', 'streamDuration', 'lastError', 'resolve', 'markTranscode'].map(name => [name, (...args) => invoke(name, ...args)])),
    epg: { nowNext: async () => ({}) }, cast: { status: async () => ({ connected: false }), scan: async () => [] },
    window: { isMaximized: async () => false, toggleFullscreen: () => invoke('fullscreen') },
    on: (channel, callback) => { const handler = (_, payload) => callback(payload); ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler); },
  };
} else {
  const { StreamServer, DEFAULT_PLAYBACK, resolveFfmpegPath } = require('../dist/tests/media.cjs');
  const { createServer } = require('node:http');
  const { createReadStream, statSync } = require('node:fs');
  const profile = process.env.XIPTV_TEST_PROFILE;
  if (!profile) throw new Error('Run with npm run test:player');
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.on('window-all-closed', () => {});
  let server, provider, win;
  const evaluate = fn => win.webContents.executeJavaScript(`(${fn})()`);
  const until = async (fn, description) => {
    for (let i = 0; i < 300; i++) { if (await evaluate(fn)) return; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(`Timed out: ${description}. ${await evaluate(() => document.body.innerText)} ${await evaluate(() => { const v = document.querySelector('video'); return JSON.stringify(v && {time:v.currentTime,ready:v.readyState,paused:v.paused,src:v.currentSrc,duration:v.duration,buffered:v.buffered.length,tracks:[...v.textTracks].map(t=>({mode:t.mode,cues:Array.from(t.cues||[]).slice(0,3).map(c=>({start:c.startTime,end:c.endTime,text:c.text})),active:Array.from(t.activeCues||[]).map(c=>c.text)}))}); })}`);
  };
  app.whenReady().then(async () => {
    const binary = resolveFfmpegPath();
    writeFileSync(join(profile, 'captions.srt'), '1\n00:00:01,000 --> 00:00:07,000\nFirst caption\n\n2\n00:00:10,000 --> 00:00:17,000\nSecond caption\n\n');
    const media = join(profile, 'fixture.mkv');
    execFileSync(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:size=640x360:rate=25:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=20', '-i', join(profile, 'captions.srt'), '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-c:s', 'srt', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra', '-metadata:s:s:0', 'language=eng', media]);
    const { createHlsFixture, createCea608Fixture } = await import('./media-fixtures.mjs');
    const run = args => execFileSync(binary, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    await createHlsFixture(profile, run, media);
    await createCea608Fixture(profile, run);
    provider = createServer((req, res) => {
      const path = req.url.startsWith('/hls/') ? join(profile, req.url) : req.url === '/captions.ts' ? join(profile, 'captions.ts') : media;
      const size = statSync(path).size;
      const start = Number(/bytes=(\d+)/.exec(req.headers.range || '')?.[1] || 0);
      res.writeHead(start ? 206 : 200, { 'Content-Type': 'video/x-matroska', 'Content-Length': size - start, 'Accept-Ranges': 'bytes', ...(start ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}) });
      const input = createReadStream(path, { start }); res.on('close', () => input.destroy()); input.pipe(res);
    });
    await new Promise(r => provider.listen(0, '127.0.0.1', r));
    const directUrl = `http://127.0.0.1:${provider.address().port}/fixture.mkv`;
    server = new StreamServer(); await server.start();
    const reg = server.register({ directUrl, kind: 'movie', container: 'mkv', title: 'Track fixture', durationSecs: 20 });
    const stream = { sessionId: reg.token, directUrl, url: reg.remuxUrl, engine: 'remux', kind: 'movie', title: 'Track fixture', duration: 20, mimeType: 'video/mp4', castUrl: reg.hlsUrl, castMimeType: 'application/x-mpegURL' };
    let settings = { activeSourceId: 'fixture', liveFormat: 'ts', hardwareAcceleration: false, epgAutoRefreshHours: null, epgFill: { auto: false, enabled: [], disabled: [] }, playback: DEFAULT_PLAYBACK };
    let rejectNextTrack = false;
    ipcMain.handle('fixture', async (_, method, ...args) => {
      if (method === 'sources') return [{ id: 'fixture', kind: 'm3u', name: 'Test provider', url: 'http://fixture.invalid/list' }];
      if (method === 'settings') return settings;
      if (method === 'settingsSet') return settings = { ...settings, ...args[0] };
      if (method === 'failNextTrack') { rejectNextTrack = true; return; }
      if (method === 'prepareTracks') { if (rejectNextTrack) { rejectNextTrack = false; throw new Error('Fixture track unavailable'); } return server.prepareTracks(args[0], settings.playback); }
      if (method === 'cancelTracks') return server.cancelTracks(...args);
      if (method === 'importSubtitles') return { name: 'Local.vtt', cues: [{ start: 0, end: 20, text: 'Local caption' }] };
      if (method === 'stopRemux') return server.stopStream();
      if (method === 'lastError') return server.lastError();
      if (method === 'streamDuration') return server.streamDuration();
      if (method === 'resolve') throw new Error('Unexpected decode fallback');
      if (method === 'fullscreen') { const next = !win.isFullScreen(); win.setFullScreen(next); return next; }
    });
    win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { preload: __filename, sandbox: false, contextIsolation: false } });
    const errors = [];
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    server.onCues = e => { if (!win.isDestroyed()) win.webContents.send('player-cues', e); };
    server.onTracks = e => { if (!win.isDestroyed()) win.webContents.send('player-tracks', e); };
    await win.loadFile(join(__dirname, '../dist/index.html'));
    await until(() => window.__xiptv?.getState().ready, 'app ready');
    await win.webContents.executeJavaScript(`window.__xiptv.getState().patch({ nowPlaying: { stream: ${JSON.stringify(stream)}, item: {id:'movie:fixture',kind:'movie',name:'Track fixture',title:'Track fixture',categoryId:'',streamId:1} } })`);
    await until(() => document.querySelector('video')?.currentTime > 0.5, 'first playback');
    await evaluate(() => { document.querySelector('video').pause(); document.querySelector('[aria-label="Audio & captions"]').click(); });
    await until(() => [...document.querySelectorAll('[role=radio]')].some(b => b.innerText.includes('FRA')), 'audio inventory');
    await evaluate(() => [...document.querySelectorAll('[role=radio]')].find(b => b.innerText.includes('FRA')).click());
    await until(() => !document.body.innerText.includes('Switching tracks'), 'audio switching');
    assert(await evaluate(() => document.querySelector('video').paused), 'paused state survives audio switch');
    assert(await evaluate(() => [...document.querySelectorAll('[role=radio]')].some(b => b.getAttribute('aria-checked') === 'true' && b.innerText.includes('FRA'))));
    await evaluate(() => [...document.querySelectorAll('[role=radiogroup]')].find(g => g.getAttribute('aria-label') === 'Audio track').querySelectorAll('button')[0].click());
    await until(() => !document.body.innerText.includes('Switching tracks'), 'English restored');
    await evaluate(() => window.failNextTrack());
    await evaluate(() => [...document.querySelectorAll('[role=radio]')].find(b => b.innerText.includes('FRA')).click());
    await until(() => document.body.innerText.includes('previous selection was restored'), 'failed selection rollback');
    assert(await evaluate(() => [...document.querySelectorAll('[role=radiogroup]')].find(g => g.getAttribute('aria-label') === 'Audio track').querySelectorAll('button')[0].getAttribute('aria-checked') === 'true'));
    await evaluate(() => [...document.querySelectorAll('[role=radio]')].find(b => b.innerText.includes('subrip')).click());
    await until(() => !document.body.innerText.includes('Switching tracks') && [...document.querySelector('video').textTracks].some(t => t.cues?.length), 'embedded captions');
    await evaluate(() => document.querySelector('[aria-label="Close audio and captions"]').click());
    assert(await evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Audio & captions'), 'focus restored');
    await evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    await until(() => [...document.querySelector('video').textTracks].some(t => Array.from(t.cues || []).some(c => c.text.includes('Second'))), 'captions after seek');
    assert(await evaluate(() => document.querySelector('video').paused), 'paused state survives seek');
    await evaluate(() => document.querySelector('[aria-label="Audio & captions"]').click());
    await evaluate(() => [...document.querySelectorAll('button')].find(b => b.innerText === 'Load subtitle file…').click());
    await until(() => [...document.querySelector('video').textTracks].some(t => Array.from(t.cues || []).some(c => c.text === 'Local caption')), 'local subtitle import');
    await until(() => !document.body.innerText.includes('Switching tracks') && document.querySelector('video').readyState >= 3, 'local subtitle playback ready');
    await until(() => [...document.querySelector('video').textTracks].some(t => t.mode === 'showing' && Array.from(t.activeCues || []).some(c => c.text === 'Local caption')), 'local caption visible while paused');
    await evaluate(() => {
      const input = document.querySelector('[aria-label="Caption delay in seconds"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1.5'); input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await evaluate(() => document.querySelector('[aria-label="Close audio and captions"]').click());
    await new Promise(resolve => setTimeout(resolve, 120));
    assert(await evaluate(() => [...document.querySelector('video').textTracks].filter(t => t.mode === 'showing').every(t => Array.from(t.cues || []).every(c => c.text === 'Local caption'))), 'old embedded cues removed after local import');
    const captionScreen = await win.webContents.capturePage();
    writeFileSync(join(__dirname, '../dist/tests/player-caption.png'), captionScreen.toPNG());
    const pip = await win.webContents.executeJavaScript(`(async () => { if (!document.pictureInPictureEnabled) return 'unavailable'; try { await document.querySelector('video').requestPictureInPicture(); await document.exitPictureInPicture(); return 'passed'; } catch (error) { return error.name; } })()`, true);
    console.log(`Native picture-in-picture check: ${pip}`);
    await evaluate(() => document.querySelector('[aria-label="Fullscreen"]').click());
    await until(() => !!document.querySelector('[aria-label="Leave fullscreen"]'), 'fullscreen controls');
    await evaluate(() => document.querySelector('[aria-label="Leave fullscreen"]').click());
    await evaluate(() => document.querySelector('[aria-label="Audio & captions"]').click());
    await evaluate(() => [...document.querySelectorAll('[role=radio]')].find(b => b.textContent === 'Off').click());
    await until(() => [...document.querySelectorAll('[role=radio]')].some(b => b.textContent === 'Off' && b.getAttribute('aria-checked') === 'true'), 'Off selected');
    assert(await evaluate(() => [...document.querySelector('video').textTracks].every(t => t.mode !== 'showing')), 'Off disables captions');
    const screen = await win.webContents.capturePage();
    writeFileSync(join(__dirname, '../dist/tests/player-tracks.png'), screen.toPNG());
    assert(!errors.length, errors.join('\n'));
    console.log('PASS production Player: discovery, paused audio/caption switching, seek, local import, Off, focus restoration');
    await evaluate(() => window.__xiptv.getState().patch({ nowPlaying: undefined }));
    await until(() => !document.querySelector('video'), 'previous player unmounted');
    const origin = `http://127.0.0.1:${provider.address().port}`;
    const hlsReg = server.register({ directUrl: `${origin}/hls/master.m3u8`, kind: 'movie', container: 'm3u8', title: 'HLS fixture', durationSecs: 20 });
    const hlsStream = { ...stream, sessionId: hlsReg.token, directUrl: `${origin}/hls/master.m3u8`, url: hlsReg.directProxyUrl, engine: 'hls' };
    await win.webContents.executeJavaScript(`window.__xiptv.getState().patch({ nowPlaying: { stream: ${JSON.stringify(hlsStream)}, item: {id:'movie:hls',kind:'movie',name:'HLS fixture',title:'HLS fixture',categoryId:'',streamId:2} } })`);
    await until(() => document.querySelector('video')?.currentTime > 0.3, 'provider HLS playing');
    await evaluate(() => { document.querySelector('video').pause(); document.querySelector('[aria-label="Audio & captions"]').click(); });
    await until(() => [...document.querySelectorAll('[role=radio]')].some(b => b.innerText.includes('French')), 'HLS alternate audio');
    await evaluate(() => [...document.querySelectorAll('[role=radio]')].find(b => b.innerText.includes('French')).click());
    await until(() => [...document.querySelectorAll('[role=radio]')].some(b => b.innerText.includes('French') && b.getAttribute('aria-checked') === 'true'), 'HLS French selected');
    await evaluate(() => [...document.querySelectorAll('[role=radiogroup]')].find(g => g.getAttribute('aria-label') === 'Caption track').querySelectorAll('button')[1].click());
    await until(() => [...document.querySelector('video').textTracks].some(t => Array.from(t.cues || []).some(c => c.text === 'HLS caption')), 'HLS WebVTT cues');
    console.log('PASS provider HLS relative master, alternate audio, separate WebVTT renditions');
    await evaluate(() => window.__xiptv.getState().patch({ nowPlaying: undefined }));
    await until(() => !document.querySelector('video'), 'previous player unmounted');
    const ccReg = server.register({ directUrl: `${origin}/captions.ts`, kind: 'live', container: 'ts', title: 'CC fixture' });
    const ccStream = { ...stream, sessionId: ccReg.token, directUrl: `${origin}/captions.ts`, url: ccReg.directProxyUrl, engine: 'mpegts', kind: 'live' };
    await win.webContents.executeJavaScript(`window.__xiptv.getState().patch({ nowPlaying: { stream: ${JSON.stringify(ccStream)}, item: {id:'live:cc',kind:'live',name:'CC fixture',title:'CC fixture',categoryId:'',streamId:3} } })`);
    await until(() => document.querySelector('video')?.currentTime > 0.1, 'raw TS captions playing');
    await evaluate(() => { document.querySelector('video').pause(); document.querySelector('[aria-label="Audio & captions"]').click(); });
    await until(() => [...document.querySelectorAll('[role=radio]')].some(b => b.innerText.includes('CC1')), 'CEA608 service discovered');
    await evaluate(() => [...document.querySelectorAll('[role=radio]')].find(b => b.innerText.includes('CC1')).click());
    await until(() => [...document.querySelector('video').textTracks].some(t => Array.from(t.cues || []).some(c => c.text.includes('HI'))), 'CEA608 decoded text');
    console.log('PASS CEA-608 discovery and decoding through raw TS → local HLS');
    await evaluate(() => window.__xiptv.getState().patch({ nowPlaying: undefined }));
    await until(() => !document.querySelector('video'), 'CC player unmounted');
    const transcodedCc = server.register({ directUrl: `${origin}/captions.ts`, kind: 'live', container: 'ts', title: 'Converted CC', forceTranscode: true });
    ccStream.sessionId = transcodedCc.token; ccStream.url = transcodedCc.transcodeUrl;
    await win.webContents.executeJavaScript(`window.__xiptv.getState().patch({ nowPlaying: { stream: ${JSON.stringify(ccStream)}, item: {id:'live:cc2',kind:'live',name:'Converted CC',title:'Converted CC',categoryId:'',streamId:4} } })`);
    await until(() => document.querySelector('video')?.currentTime > 0.1, 'converted CC playback');
    await evaluate(() => { document.querySelector('video').pause(); document.querySelector('[aria-label="Audio & captions"]').click(); });
    await until(() => [...document.querySelectorAll('[role=radio]')].some(b => b.innerText.includes('CC1')), 'converted CEA608 service');
    await evaluate(() => [...document.querySelectorAll('[role=radio]')].find(b => b.innerText.includes('CC1')).click());
    await until(() => [...document.querySelector('video').textTracks].some(t => Array.from(t.cues || []).some(c => c.text.includes('HI'))), 'converted CEA608 cues');
    console.log('PASS CEA-608 caption data survives video conversion');
    win.destroy(); await server.stop(); provider.closeAllConnections(); await new Promise(r => provider.close(r));
    app.exit(0);
  }).catch(async error => {
    console.error(error);
    if (win && !win.isDestroyed()) win.destroy();
    await server?.stop(); provider?.closeAllConnections(); provider?.close(); app.exit(1);
  });
}
