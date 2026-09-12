import assert from 'node:assert/strict';
import { createPgsFixture } from './media-fixtures.mjs';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
await mkdir('dist/tests', { recursive: true });
await build({ entryPoints: ['tests/media-fixture-entry.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: 'dist/tests/media.cjs' });
const require = createRequire(import.meta.url);
const { parseInputInventory, chooseTracks, DEFAULT_PLAYBACK, parsePlaybackPreferences, parseSubtitleText, SubtitleStreamParser, rewritePlaylist, StreamServer, resolveFfmpegPath } = require('../dist/tests/media.cjs');
const inventory = parseInputInventory(`Input #0, matroska,webm, from 'hidden':
  Duration: 00:01:23.40, start: 0.0
  Stream #0:0: Video: h264 (High), yuv420p
  Stream #0:1(eng): Audio: aac (LC), 48000 Hz (default)
    Metadata:
      title : English
  Stream #0:2(fra): Audio: ac3, 48000 Hz
    Metadata:
      title : French commentary
  Stream #0:3(eng): Subtitle: subrip (forced)
  Stream #0:4: Subtitle: hdmv_pgs_subtitle
  Stream #0:5(spa): Subtitle: unknown_subtitle
Output #0, mp4, to 'pipe:1':
  Stream #0:0: Video: h264
  Stream #0:1: Audio: aac`);
assert.equal(inventory.tracks.length, 5);
assert.equal(inventory.duration, 83.4);
assert.equal(inventory.tracks[1].roles[0], 'Commentary');
assert.equal(inventory.tracks[2].forced, true);
assert.equal(inventory.tracks[3].image, true);
assert.equal(inventory.tracks[4].supported, false);
assert.deepEqual(chooseTracks(inventory.tracks, DEFAULT_PLAYBACK), { audioId: 'stream:1' });
assert.equal(chooseTracks(inventory.tracks, { ...DEFAULT_PLAYBACK, audioLanguage: 'fr-FR' }).audioId, 'stream:2');
assert.equal(chooseTracks(inventory.tracks, { ...DEFAULT_PLAYBACK, captionMode: 'automatic', captionLanguage: 'en' }).subtitleId, 'stream:3');
assert.equal(parsePlaybackPreferences({ appearance: { size: 900, background: -1 } }).appearance.size, 200);
const text = '1\r\n00:00:01,000 --> 00:00:03,000\r\nHello\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nBonjour\r\n\r\n';
assert.equal(parseSubtitleText(text).length, 2);
const parser = new SubtitleStreamParser();
const parsed = [];
for (const c of text) parsed.push(...parser.push(c));
parsed.push(...parser.push('', true));
assert.equal(parsed.length, 2);
const urls = [];
const playlist = rewritePlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/list.m3u8"\n#EXT-X-KEY:URI="../key"\n#EXT-X-STREAM-INF:BANDWIDTH=200\nvideo.m3u8\n', 'http://fixture/x/root.m3u8', (url, isPlaylist) => { urls.push([url, isPlaylist]); return `/r/${urls.length}`; });
assert(playlist.includes('URI="/r/1"'));
assert.deepEqual(urls, [['http://fixture/x/audio/list.m3u8', true], ['http://fixture/key', false], ['http://fixture/x/video.m3u8', true]]);
console.log('PASS metadata, preferences, streaming cue parser, HLS rewriting');
if (process.argv.includes('--unit')) process.exit(0);

const dir = await mkdtemp(join(tmpdir(), 'xiptv-tracks-'));
const ffmpeg = resolveFfmpegPath();
const run = args => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 30_000 });
let upstream, server;
try {
  await writeFile(join(dir, 'subs.srt'), text);
  run(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8', '-i', join(dir, 'subs.srt'), '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a:0', 'aac', '-c:a:1', 'ac3', '-c:s', 'srt', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra', '-metadata:s:s:0', 'language=eng', join(dir, 'multi.mkv')]);
  run(['-i', join(dir, 'multi.mkv'), '-map', '0:v', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', join(dir, 'native.mp4')]);
  run(['-i', join(dir, 'multi.mkv'), '-map', '0:v', '-map', '0:a:0', '-c', 'copy', '-f', 'mpegts', join(dir, 'live.ts')]);
  const pgs = await createPgsFixture(dir);
  for (const [name, codec] of [['pgs', 'copy'], ['dvd', 'dvdsub'], ['dvb', 'dvbsub']]) {
    run(['-f', 'lavfi', '-i', 'color=black:size=320x180:rate=25:duration=5', ...(codec !== 'copy' ? ['-fix_sub_duration'] : []), '-i', pgs, '-map', '0:v', '-map', '1:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:s', codec, join(dir, `${name}.mkv`)]);
  }
  for (const [name, codec, extension] of [['ass', 'ass', 'mkv'], ['vtt', 'webvtt', 'mkv'], ['timed', 'mov_text', 'mp4']]) {
    run(['-i', join(dir, 'multi.mkv'), '-map', '0:v', '-map', '0:a:0', '-map', '0:s:0', '-c', 'copy', '-c:s', codec, join(dir, `${name}.${extension}`)]);
  }
  let active = 0, overlaps = 0;
  upstream = createServer((req, res) => {
    const path = join(dir, req.url.split('?')[0].slice(1));
    if (!['multi.mkv', 'native.mp4', 'live.ts', 'pgs.mkv', 'dvd.mkv', 'dvb.mkv', 'ass.mkv', 'vtt.mkv', 'timed.mp4'].some(n => path === join(dir, n))) { res.writeHead(404).end(); return; }
    active++; if (active > 1) overlaps++;
    let closed = false;
    const finish = () => { if (!closed) { closed = true; active--; } };
    res.on('close', finish);
    const size = statSync(path).size;
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = match ? +match[1] : 0, end = match?.[2] ? Math.min(+match[2], size - 1) : size - 1;
    if (start >= size) { res.writeHead(416).end(); return; }
    res.writeHead(match ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    const stream = createReadStream(path, { start, end, highWaterMark: 8192 });
    res.on('close', () => stream.destroy());
    stream.on('data', chunk => { stream.pause(); res.write(chunk); setTimeout(() => stream.resume(), 5); });
    stream.on('end', () => res.end());
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  server = new StreamServer(); await server.start();
  const reg = server.register({ directUrl: `${origin}/multi.mkv`, kind: 'movie', container: 'mkv', title: 'Fixture' });
  let gen = 1;
  const request = (extra = {}) => server.prepareTracks({ sessionId: reg.token, generation: gen++, offset: 0, captionDelay: 0, ...extra }, DEFAULT_PLAYBACK);
  let result = await request();
  assert.equal(result.state.tracks.filter(t => t.kind === 'audio').length, 2);
  assert.equal(result.engine, 'remux');
  assert.equal(result.state.subtitleId, undefined);
  const audio = result.state.tracks.find(t => t.language === 'fra');
  const sub = result.state.tracks.find(t => t.kind === 'subtitle');
  result = await request({ audioId: audio.id, subtitleId: sub.id });
  assert.equal(result.engine, 'transcode');
  const cues = [];
  server.onCues = e => cues.push(...e.cues);
  const response = await fetch(result.url);
  assert.equal(response.status, 200);
  const output = Buffer.from(await response.arrayBuffer());
  assert(output.length > 1000);
  await writeFile(join(dir, 'converted.mp4'), output);
  const pcm = run(['-i', join(dir, 'converted.mp4'), '-vn', '-t', '2', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
  let crossings = 0;
  for (let i = 2; i < pcm.length; i += 2) if (pcm.readInt16LE(i - 2) <= 0 && pcm.readInt16LE(i) > 0) crossings++;
  assert(Math.abs(crossings / 2 - 880) < 30, `selected audio frequency ${crossings / 2}`);
  assert(cues.some(c => c.text === 'Hello'), 'same-process WebVTT cues arrived');
  assert(Math.abs(cues.find(c => c.text === 'Hello').start - 1) < 0.15);
  console.log('PASS multilingual audio conversion (880 Hz verified), same-input subtitle extraction');
  result = await request({ subtitleId: null });
  assert.equal(result.state.subtitleId, undefined);
  const stale = await fetch(result.url.replace(`/session/${reg.token}/${result.state.generation}/`, `/session/${reg.token}/${result.state.generation - 1}/`));
  assert.equal(stale.status, 410);
  await server.cancelTracks(reg.token, result.state.generation);
  result = await request();
  assert.equal(result.state.status, 'ready');
  const old = request(); const newest = request();
  const settled = await Promise.allSettled([old, newest]);
  assert.equal(settled[0].status, 'rejected'); assert.equal(settled[1].status, 'fulfilled');
  console.log('PASS Off, expired requests, cancel/retry, rapid generation changes');
  const native = server.register({ directUrl: `${origin}/native.mp4`, kind: 'movie', container: 'mp4', title: 'Native' });
  const preparedNative = await server.prepareTracks({ sessionId: native.token, generation: gen++, offset: 0, captionDelay: 0 }, DEFAULT_PLAYBACK);
  assert.equal(preparedNative.engine, 'native');
  assert.equal((await fetch(preparedNative.url, { headers: { Range: 'bytes=0-999' } })).status, 206);
  await server.stopStream();
  assert.equal(overlaps, 0, `independent upstream overlap count ${overlaps}`);
  console.log('PASS native range playback and one-upstream lifecycle');
  for (const name of ['pgs', 'dvd', 'dvb']) {
    const bitmap = server.register({ directUrl: `${origin}/${name}.mkv`, kind: 'movie', container: 'mkv', title: 'Image subtitle' });
    let prepared = await server.prepareTracks({ sessionId: bitmap.token, generation: gen++, offset: 0, captionDelay: 0 }, DEFAULT_PLAYBACK);
    const track = prepared.state.tracks.find(t => t.kind === 'subtitle');
    assert.equal(track.image, true);
    prepared = await server.prepareTracks({ sessionId: bitmap.token, generation: gen++, offset: 0, captionDelay: 0, subtitleId: track.id }, DEFAULT_PLAYBACK);
    const response = await fetch(prepared.url);
    assert.equal(response.status, 200, await (response.status !== 200 ? response.text() : Promise.resolve('')));
    const path = join(dir, `${name}-overlay.mp4`);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    const pixel = time => run(['-ss', String(time), '-i', path, '-vf', 'crop=40:10:60:135,scale=1:1,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'])[0];
    assert(pixel(1.5) > 180, `${name}: subtitle pixels visible`);
    assert(pixel(3.5) < 30, `${name}: subtitle pixels clear`);
    console.log(`PASS ${name.toUpperCase()} decoding, overlay and clearing (pixels verified)`);
  }
  for (const [name, extension] of [['ass', 'mkv'], ['vtt', 'mkv'], ['timed', 'mp4']]) {
    const textStream = server.register({ directUrl: `${origin}/${name}.${extension}`, kind: 'movie', container: extension, title: 'Text fixture' });
    let prepared = await server.prepareTracks({ sessionId: textStream.token, generation: gen++, offset: 0, captionDelay: 0 }, DEFAULT_PLAYBACK);
    const subtitle = prepared.state.tracks.find(t => t.kind === 'subtitle');
    assert.equal(subtitle.supported, true);
    prepared = await server.prepareTracks({ sessionId: textStream.token, generation: gen++, offset: 0, captionDelay: 0, subtitleId: subtitle.id }, DEFAULT_PLAYBACK);
    const received = [];
    server.onCues = event => received.push(...event.cues);
    const response = await fetch(prepared.url);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert(received.some(c => c.text.includes('Hello')), `${name}: text cues extracted`);
    console.log(`PASS embedded ${name.toUpperCase()} text extraction`);
  }
  const live = server.register({ directUrl: `${origin}/live.ts`, kind: 'live', container: 'ts', title: 'Live fixture' });
  const preparedLive = await server.prepareTracks({ sessionId: live.token, generation: gen++, offset: 0, captionDelay: 0 }, DEFAULT_PLAYBACK);
  assert.equal(preparedLive.localHls, true);
  const manifest = await fetch(preparedLive.url);
  assert.equal(manifest.status, 200);
  const body = await manifest.text();
  const segment = body.split('\n').find(line => line.endsWith('.ts'));
  assert(segment);
  const segmentResponse = await fetch(new URL(segment, preparedLive.url));
  assert.equal(segmentResponse.status, 200);
  assert((await segmentResponse.arrayBuffer()).byteLength > 0);
  console.log('PASS raw TS → local HLS with playable segments');
  await server.cancelTracks(live.token, preparedLive.state.generation);
  const castResponse = await fetch(live.hlsUrl);
  assert.equal(castResponse.status, 200);
  await castResponse.text();
  console.log('PASS casting endpoint still works after desktop-session cancellation');
} finally {
  await server?.stop();
  upstream?.closeAllConnections();
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
