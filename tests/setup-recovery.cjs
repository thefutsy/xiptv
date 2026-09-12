// Run after npm run build: npm run test:recovery
// Uses the production renderer with a fake preload, never the user's config or provider.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');

if (process.type === 'renderer') {
  const scenario = process.argv.find((arg) => arg.startsWith('--scenario=')).split('=')[1];
  const source = { id: 'saved-provider', kind: scenario === 'xtream' ? 'xtream' : 'm3u',
    name: 'Test provider', url: 'http://provider.invalid/get.php', username: 'test-user', password: 'test-password' };
  let sources = scenario === 'new' ? [] : [source];
  let settings = { activeSourceId: sources[0]?.id, hardwareAcceleration: false, liveFormat: 'ts',
    epgAutoRefreshHours: 12, epgFill: { auto: false, enabled: [], disabled: [] } };
  const listeners = new Map();
  const emit = (payload) => { for (const cb of listeners.get('sync-progress') ?? []) cb(payload); };
  const state = window.fixture = { succeed: false, adds: 0, updates: 0, refreshes: 0, stats: 0 };
  const fail = async () => {
    emit({ phase: 'live', message: 'Downloading playlist…', progress: null });
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Reproduce the original bug: IPC rejects without sending an error progress event.
    throw new Error('HTTP 403: provider denied this playlist. ' +
      'The playlist endpoint is unavailable. Check your provider details or choose another connection type. '.repeat(8));
  };
  const categories = (kind) => [{ id: kind + '-cat', kind, name: 'Test category' }];
  const noop = async () => undefined;
  window.iptv = {
    sources: {
      list: async () => sources,
      setActive: async (id) => { settings.activeSourceId = id; },
      add: async (s) => { state.adds++; const added = { ...s, id: source.id }; sources = [added]; return added; },
      update: async (s) => { state.updates++; sources = [s]; return s; },
      test: async () => ({ ok: false, message: 'HTTP 403: provider denied this playlist' }),
    },
    settings: { get: async () => settings, set: async (patch) => (settings = { ...settings, ...patch }) },
    library: { favourites: async () => [], continueWatching: async () => [] },
    catalog: {
      stats: async () => {
        state.stats++;
        if (!state.succeed) return fail();
        return { liveCategories: 1, movieCategories: 1, seriesCategories: 1, epgProgrammes: 0, catalogReady: true };
      },
      categories: async (_, kind) => state.succeed ? categories(kind) : fail(),
      items: async () => [],
      refresh: async () => {
        state.refreshes++;
        // A guide completion must not make the catalogue ready prematurely.
        emit({ phase: 'done', message: 'Guide ready', progress: 1 });
        if (!state.succeed) return fail();
        await new Promise((resolve) => setTimeout(resolve, 80));
      },
    },
    epg: { nowNext: async () => ({}), grid: async () => ({}), feeds: async () => ({ catalogue: [], auto: [] }) },
    window: { isMaximized: async () => false, minimize: noop, maximize: noop, close: noop },
    on: (channel, cb) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(cb); listeners.set(channel, set);
      return () => set.delete(cb);
    },
  };
} else {
  if (!process.env.XIPTV_TEST_PROFILE) throw new Error('Run with npm run test:recovery');
  app.setPath('userData', process.env.XIPTV_TEST_PROFILE);
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const evaluate = (win, fn) => win.webContents.executeJavaScript(`(${fn})()`);
  async function until(win, fn, label) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(win, fn)) return;
      await delay(50);
    }
    throw new Error(`Timed out: ${label}`);
  }
  async function click(win, label) {
    await win.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
      if (!button || button.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(label)});
      button.click();
    })()`);
  }
  async function run(scenario) {
    const win = new BrowserWindow({ show: false, webPreferences: { preload: __filename, sandbox: false,
      contextIsolation: false, additionalArguments: [`--scenario=${scenario}`] } });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    await win.loadFile(join(__dirname, '../dist/index.html'));
    if (scenario === 'new') {
      await until(win, () => document.body.textContent.includes('Set up your provider'), 'welcome');
      await click(win, 'Set up your provider');
      await until(win, () => !!document.querySelector('.onboard__kind'), 'provider types');
      await evaluate(win, () => document.querySelectorAll('.onboard__kind')[1].click());
      await until(win, () => !!document.querySelector('.mx-field__input'), 'details');
      await evaluate(win, () => {
        const fields = document.querySelectorAll('.mx-field__input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(fields[0], 'Test provider'); fields[0].dispatchEvent(new Event('input', { bubbles: true }));
      });
      await delay(50);
      await evaluate(win, () => {
        const field = document.querySelectorAll('.mx-field__input')[1];
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'http://provider.invalid/get.php');
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await delay(50);
      await click(win, 'Continue');
    }
    await until(win, () => !!document.querySelector('.onboard [role="alert"]'), 'automatic return to setup');
    assert.equal(await evaluate(win, () => !!document.querySelector('.ledger')), false);
    assert.match(await evaluate(win, () => document.querySelector('[role="alert"]').textContent), /HTTP 403/);
    assert.equal(await evaluate(win, () => document.querySelector('input').value), 'Test provider');
    if (scenario === 'xtream') {
      assert.equal(await evaluate(win, () => document.querySelector('input[type="password"]').value), 'test-password');
    }
    for (const [width, height, zoom] of [[1024, 720, 1], [800, 600, 1], [800, 600, 1.25]]) {
      win.setContentSize(width, height);
      win.webContents.setZoomFactor(zoom);
      await delay(100);
      for (const scrollToEnd of [false, true]) {
        await win.webContents.executeJavaScript(`(() => {
          const content = document.querySelector('.onboard__connect-body');
          if (content) content.scrollTop = ${scrollToEnd ? 'content.scrollHeight' : '0'};
        })()`);
        const reachable = await evaluate(win, () => ['Back', 'Test connection', 'Continue'].every(label => {
          const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
          if (!button) return false;
          const r = button.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth &&
            button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }));
        assert.equal(reachable, true, `navigation visible at ${width}×${height}, zoom ${zoom}, scrolled ${scrollToEnd}`);
      }
    }
    if (scenario === 'm3u' && process.env.XIPTV_SETUP_SCREENSHOT) {
      require('node:fs').writeFileSync(process.env.XIPTV_SETUP_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    }
    await click(win, 'Back');
    await until(win, () => document.body.textContent.includes('How do you connect?'), 'Back returns to provider types');
    await win.webContents.executeJavaScript(`document.querySelectorAll('.onboard__kind')[${scenario === 'xtream' ? 0 : 1}].click()`);
    await until(win, () => !!document.querySelector('.onboard__connect-body'), 'reopen saved details');
    assert.equal(await evaluate(win, () => document.querySelector('input').value), 'Test provider');
    await click(win, 'Continue');
    await until(win, () => !!document.querySelector('.onboard [role="alert"]'), 'failed retry returns to details');
    assert.equal(await evaluate(win, () => window.fixture.updates), 1);
    assert.equal(await evaluate(win, () => window.fixture.adds), scenario === 'new' ? 1 : 0);
    assert.equal(await evaluate(win, () => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Start watching'))), false);
    await evaluate(win, () => { window.fixture.succeed = true; });
    await click(win, 'Continue');
    await until(win, () => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Start watching') && !b.disabled), 'successful retry');
    await click(win, 'Start watching');
    await until(win, () => !!document.querySelector('.shell__body') && !document.querySelector('.onboard'), 'watching after recovery');
    assert.equal(await evaluate(win, () => window.fixture.updates), 2);
    assert.equal(await evaluate(win, () => window.fixture.adds), scenario === 'new' ? 1 : 0);
    assert.deepEqual(errors, []);
    win.destroy();
    console.log(`PASS ${scenario}: failure → populated setup → failed retry → successful retry; no duplicate provider`);
  }
  app.whenReady().then(async () => {
    for (const scenario of ['m3u', 'xtream', 'new']) await run(scenario);
    app.exit(0);
  }).catch((err) => { console.error(err); app.exit(1); });
}
