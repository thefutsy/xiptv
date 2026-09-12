import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';

await mkdir('dist/tests', { recursive: true });
await build({
  stdin: { contents: `export { mediaLanguage, matchesLanguage } from './src/shared/language';
    export { parseMediaItem } from './src/main/lib/store';
    export { parseM3u } from './src/main/lib/m3u';
    export { XtreamClient } from './src/main/lib/xtream';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/tests/catalog-language.cjs',
});
const require = createRequire(import.meta.url);
const { mediaLanguage, matchesLanguage, parseMediaItem, parseM3u, XtreamClient } = require('../dist/tests/catalog-language.cjs');
const base = { id: 'movie:1', kind: 'movie', name: 'Weapons', title: 'Weapons', categoryId: '1', streamId: 1 };
const label = (fields) => mediaLanguage({ ...base, ...fields })?.label;
for (const [name, expected] of [
  ['EN ★ Weapons - 2025', 'English'], ['FR - Weapons', 'French'], ['|DE| Weapons', 'German'],
  ['VIP ❖ ES ★ Weapons', 'Spanish'], ['[IT] Weapons', 'Italian'], ['Weapons [PT]', 'Portuguese'],
  ['Weapons (Multi-Audio) (2025)', 'Multi-audio'], ['Weapons (Dual Audio)', 'Dual audio'],
  ['UK - Weapons', 'UK'], ['French Connection', undefined], ['It', undefined],
  ['The Office (US)', undefined], ['Weapons (MULTI-SUBS)', undefined], ['HU - Weapons', undefined],
  ['NF - Weapons', undefined], ['4K - Weapons', undefined],
]) assert.equal(label({ name }), expected, name);
assert.equal(label({ name: 'FR - Weapons', categoryName: 'EN MOVIES', language: 'deu' }), 'German');
assert.equal(label({ name: 'FR - Weapons', categoryName: 'EN MOVIES' }), 'French');
assert.equal(label({ categoryName: 'VOD - ACTION [EN]' }), 'English');
assert.equal(label({ categoryName: 'FR MOVIES' }), 'French');
assert.equal(label({ categoryName: 'HINDI MOVIES' }), 'Hindi');
assert.equal(label({ categoryName: 'IN MOVIES' }), 'IN');
assert.equal(label({ categoryName: '4K MOVIES' }), undefined);
assert.equal(label({ categoryName: 'ENGLISH MOVIES' }), 'English');
assert.equal(label({ categoryId: 'movie:FR ★ Movies', categoryName: 'Movies' }), 'French');
assert.equal(label({ language: 'eng / fra' }), 'English / French');
assert.equal(label({ language: 'pt-BR' }), 'Portuguese');
assert.equal(label({ language: 'und' }), undefined);
assert.equal(label({ kind: 'live', name: 'EN - News' }), undefined);
const cached = parseMediaItem({ ...base, language: 'fra', categoryName: 'FR Movies' });
assert.equal(cached.language, 'fra');
assert.equal(cached.categoryName, 'FR Movies');
assert.equal(mediaLanguage(parseMediaItem({ ...base, name: 'EN ★ Weapons' })).label, 'English');
const playlist = parseM3u('#EXTM3U\n#EXTINF:-1 tvg-language="deu" group-title="FR ★ Movies",Weapons\nhttps://example.invalid/movie/1.mp4\n');
assert.equal(playlist.items[0].categoryName, 'FR ★ Movies');
assert.equal(mediaLanguage(playlist.items[0]).label, 'German');
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify([
    { stream_id: 1, name: 'Weapons', audio_language: 'spa', original_language: 'en' },
    { stream_id: 2, name: 'Weapons', original_language: 'en' },
  ]));
  const client = new XtreamClient({ url: 'https://example.invalid', username: 'test', password: 'test' });
  const items = await client.items('movie', '1');
  assert.equal(mediaLanguage(items[0]).label, 'Spanish');
  assert.equal(mediaLanguage(items[1]), undefined, 'Original language does not identify the stream audio');
} finally { globalThis.fetch = originalFetch; }
console.log('PASS catalogue language hints, cache persistence, M3U and Xtream metadata');

assert.equal(matchesLanguage({ ...base, name: 'EN ★ Weapons' }, 'English'), true);
assert.equal(matchesLanguage({ ...base, language: 'eng / fra' }, 'English'), true);
assert.equal(matchesLanguage({ ...base, language: 'eng / fra' }, 'French'), true);
for (const name of ['FR ★ Weapons', 'Weapons', 'UK - Weapons', 'Weapons (Multi-Audio)']) {
  assert.equal(matchesLanguage({ ...base, name }, 'English'), false, name);
}
assert.equal(matchesLanguage(base, 'unknown'), true);
assert.equal(matchesLanguage({ ...base, kind: 'live' }, 'unknown'), false);
assert.equal(matchesLanguage(base, ''), true);
console.log('PASS language filters distinguish explicit audio, multi-audio and unknown languages');
