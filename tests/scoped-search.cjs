// Production renderer with an isolated profile and fake catalogue: npm run test:search.
const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');
const assert = require('node:assert/strict');

if (process.type === 'renderer') {
  const source = { id: 'fixture', kind: 'xtream', name: 'Test provider', url: 'https://provider.invalid' };
  const movie = (id, name, title = 'Weapons', language) => ({
    id: `movie:${id}`, kind: 'movie', name, title, categoryId: '1', streamId: id,
    year: 2025, rating: 7.5, language, plot: 'A movie available in several languages.',
  });
  const movies = [
    ...Array.from({ length: 350 }, (_, i) => movie(i + 1, 'FR ★ Weapons')),
    movie(351, 'EN ★ Weapons'),
    movie(352, 'Another movie', 'Another movie', 'eng / fra'),
    movie(353, 'Weapons (Multi-Audio)'),
    movie(354, 'UK - Weapons'),
    movie(355, 'Weapons'),
  ];
  const channel = { ...movie(1, 'Weapons TV', 'Weapons TV'), id: 'live:1', kind: 'live' };
  const show = { ...movie(1, 'EN ★ Weapons show', 'Weapons show'), id: 'series:1', kind: 'series' };
  window.fixture = { allCalls: [], searchCalls: [], fail: false, delay: 0 };
  const noop = async () => {};
  window.iptv = {
    sources: { list: async () => [source] },
    settings: { get: async () => ({ activeSourceId: source.id, hardwareAcceleration: false,
      epgFill: { auto: false, enabled: [], disabled: [] } }) },
    library: { favourites: async () => [], continueWatching: async () => [], isFavourite: async () => false },
    catalog: {
      stats: async () => ({ liveCategories: 1, movieCategories: 1, seriesCategories: 1, epgProgrammes: 0,
        liveItems: 1, movieItems: movies.length, seriesItems: 1, catalogReady: true }),
      categories: async (_, kind) => [{ id: '1', kind, name: kind === 'movie' ? 'Movies' : 'General' }],
      items: async (_, kind) => kind === 'movie' ? movies : kind === 'live' ? [channel] : [show],
      all: async (sourceId, kind) => {
        window.fixture.allCalls.push([sourceId, kind]);
        if (window.fixture.fail) throw Error('Catalogue unavailable');
        await new Promise(resolve => setTimeout(resolve, window.fixture.delay));
        return kind === 'movie' ? movies : kind === 'live' ? [channel] : [show];
      },
      search: async (sourceId, query, kind, language) => {
        window.fixture.searchCalls.push([sourceId, query, kind, language]);
        return [movies[350], channel, show];
      },
      itemDetail: async (_, id) => ({ ...movies.find(item => item.id === id), name: 'Weapons' }),
    },
    epg: { nowNext: async () => ({}), grid: async () => ({}), feeds: async () => ({ catalogue: [], auto: [] }) },
    window: { isMaximized: async () => false, minimize: noop, maximize: noop, close: noop },
    on: () => () => {},
  };
} else {
  if (!process.env.XIPTV_TEST_PROFILE) throw Error('Run with npm run test:search');
  app.setPath('userData', process.env.XIPTV_TEST_PROFILE);
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1280, height: 840,
      webPreferences: { preload: __filename, sandbox: false, contextIsolation: false } });
    const js = code => win.webContents.executeJavaScript(code);
    async function until(code) {
      for (let i = 0; i < 120; i++) { if (await js(code)) return; await delay(50); }
      throw Error(`Timed out: ${code}`);
    }
    async function input(selector, value) {
      await js(`(() => {
        const field = document.querySelector(${JSON.stringify(selector)});
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
        field.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    }
    async function language(value) {
      await js(`(() => { const select = document.querySelector('.language-filter select');
        select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    }
    const errors = [];
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    try {
      await win.loadFile(join(__dirname, '../dist/index.html'));
      await until('window.__xiptv?.getState().ready');
      await js('window.__xiptv.getState().navigate({ view: "movies" })');
      await until('document.querySelector(".titlebar__search").textContent.includes("Search movies")');
      await js('document.querySelector(".titlebar__search").click()');
      await until('window.__xiptv.getState().route.kind === "movie" && document.querySelectorAll(".mx-card").length > 0');
      assert.equal(await js('document.activeElement.className'), 'search__input');
      assert.equal(await js('document.querySelectorAll(".search__tabs button").length'), 1);
      assert.deepEqual(await js('window.fixture.allCalls'), [['fixture', 'movie']]);
      assert.equal(await js('window.fixture.searchCalls.length'), 0);
      await language('English');
      await until('document.querySelectorAll(".mx-card").length === 2');
      assert.match(await js('document.querySelector(".search__meta").textContent'), /2 of 355 shown/);
      assert.deepEqual(await js('[...document.querySelectorAll(".mx-card .language-badge")].map(e=>e.textContent)'), ['English', 'English / French']);
      await input('.search__input', 'weapons');
      await until('document.querySelectorAll(".mx-card").length === 1');
      assert.equal(await js('window.fixture.allCalls.length'), 1, 'Typing must reuse the full catalogue');
      assert.equal(await js('window.__xiptv.getState().route.query'), 'weapons');
      await js('document.querySelector(".mx-card__open").click()');
      await until('document.querySelector(".detail__main .language-badge")?.textContent === "English"');
      await js('window.__xiptv.getState().back()');
      await until('document.querySelectorAll(".mx-card").length === 1 && document.querySelector(".language-filter select")?.value === "English"');
      assert.equal(await js('document.querySelector(".search__input").value'), 'weapons');
      await js('document.querySelector(".search__clear").click()');
      await until('document.querySelectorAll(".mx-card").length === 2');
      assert.equal(await js('document.querySelector(".language-filter select").value'), 'English');
      for (const width of [1280, 800]) {
        win.setContentSize(width, 800); await delay(200);
        assert.equal(await js('[...document.querySelectorAll(".search__meta select")].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})'), true, 'Filters stay in the window');
      }
      if (process.env.XIPTV_SEARCH_SCREENSHOT) require('node:fs').writeFileSync(process.env.XIPTV_SEARCH_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
      await js('document.dispatchEvent(new KeyboardEvent("keydown", {key:"k",metaKey:true,bubbles:true}))');
      await until('!!document.querySelector(".palette__input")');
      await input('.palette__input', 'weapons');
      await until('window.fixture.searchCalls.length > 0');
      assert.deepEqual(await js('window.fixture.searchCalls.at(-1)'), ['fixture', 'weapons', undefined, undefined]);
      await js('document.querySelector(".palette__seeall").click()');
      await until('document.querySelectorAll(".search__tabs button").length === 4 && !window.__xiptv.getState().route.kind');
      assert.equal(await js('document.querySelector(".language-filter select").value'), '');
      await language('English');
      await until('window.fixture.searchCalls.at(-1)[3] === "English"');
      await js('document.dispatchEvent(new KeyboardEvent("keydown", {key:"k",ctrlKey:true,bubbles:true}))');
      await until('!!document.querySelector(".palette__input")');
      await js('window.__xiptv.getState().patch({paletteOpen:false})');
      await js('window.__xiptv.getState().navigate({view:"movies"})');
      await until('!!document.querySelector(".browse__header .language-filter")');
      await language('English');
      await until('window.__xiptv.getState().route.kind === "movie" && document.querySelectorAll(".mx-card").length === 2');
      // Rejected full-catalogue loads must offer a working retry.
      await js('window.__xiptv.getState().navigate({view:"movies"}); window.fixture.fail=true');
      await until('!!document.querySelector(".browse")');
      await js('document.querySelector(".titlebar__search").click()');
      await until('document.body.textContent.includes("Catalogue unavailable")');
      await js('window.fixture.fail=false; [...document.querySelectorAll("button")].find(e=>e.textContent==="Try again").click()');
      await until('document.querySelectorAll(".mx-card").length > 0');
      // A pending scoped response cannot replace results after moving to global search.
      await js('window.__xiptv.getState().navigate({view:"movies"}); window.fixture.delay=400');
      await until('!!document.querySelector(".browse")');
      await js('document.querySelector(".titlebar__search").click()');
      await delay(50);
      await js('window.__xiptv.getState().navigate({view:"search",query:"weapons"})');
      await delay(600);
      assert.equal(await js('window.__xiptv.getState().route.kind'), undefined);
      assert.equal(await js('document.querySelectorAll(".mx-row").length'), 3);
      assert.deepEqual(errors, []);
      console.log('PASS scoped full-catalogue search, English filtering beyond 300 entries, query/Back/clear, global shortcuts, responsive controls, retry and stale responses');
    } finally { win.destroy(); }
  }).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
}
