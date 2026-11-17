#!/usr/bin/env node
'use strict';
// MIGRATION_PLAN.md Phase 1 gate (in a browser): data made with the app's own storage helpers, exported with
// electron/migration.js EXPORT_SCRIPT, imported with IMPORT_SCRIPT into an empty profile on the same origin,
// then read back by the app after a reload. Usage: node spike/migration/check-roundtrip.js
const { chromium } = require('playwright');
const { start, server } = require('../../server');
const { EXPORT_SCRIPT, IMPORT_SCRIPT } = require('../../electron/migration');

// the renderer needs window.tunerDesktop at load (electron/preload.js); a do-nothing stand-in
const STUB = () => {
  const ok = (v) => () => Promise.resolve(v);
  window.tunerDesktop = {
    displays: ok([]), focusWindow: ok(), appInfo: ok({ version: 'test', updater: false, channel: 'stable' }), ready() {}, titleBar() {},
    updater: { status: ok({ state: 'idle' }), check: ok({ state: 'idle' }), download: ok(), install: ok(), openReleases: ok(), notes: ok({}), setChannel: ok('stable'), onStatus() {} },
    downloads: { list: ok({ items: [], folder: '', pauseWhileWatching: false, held: false, free: 0 }), add: ok(0), pause: ok(), resume: ok(), reorder: ok(), remove: ok(), reveal: ok(), openFolder: ok(''), chooseFolder: ok(null), setOption: ok(), setWatching: ok(), orphans: ok([]), adopt: ok(0), onChange() {} },
    sync: { info: ok({ host: 'test', keychain: false, folder: '' }), getCode: ok(''), setCode: ok(), chooseFolder: ok(''), folderList: ok([]), folderPut: ok(''), folderRemove: ok() },
  };
};

(async () => {
  const port = await start(0);
  const url = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  const results = [];
  const check = (name, ok, note = '') => { results.push(ok); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`); };

  // 1. the old profile, with data written the way the app writes it
  const oldCtx = await browser.newContext();
  await oldCtx.addInitScript(STUB);
  const a = await oldCtx.newPage();
  await a.goto(url);
  await a.waitForFunction(() => typeof LS === 'object' && typeof idb === 'object');
  const big = 'x'.repeat(3 * 1024 * 1024);   // a 3 MB playlist file: why the app keeps files in IndexedDB
  await a.evaluate(async (big) => {
    LS.set('tuner.playlists', [
      { id: 'p1', name: 'My Xtream', type: 'xtream', server: 'http://provider.example:8080', user: 'name', pass: 'pässwörd "quoted"', added: 1 },
      { id: 'p2', name: 'From a file', type: 'file', added: 2 },
    ]);
    LS.set('tuner.favs', ['p1:live:1', 'p1:movie:9']);
    LS.set('tuner.favdata', { 'p1:live:1': { name: 'Channel ✓ ünïcode', pid: 'p1' } });
    LS.set('tuner.recent', [{ uid: 'p1:movie:9', name: 'A film', ts: 123 }]);
    LS.set('tuner.progress', { 'p1:movie:9': { t: 1234.5, d: 5400, w: 0, ts: 99 } });
    LS.set('tuner.theme', 'light');
    LS.set('tuner.updChannel', 'test');
    await idb.put('file:p2', '#EXTM3U\n' + big);
    await idb.put('dlinfo', { abc: { title: 'Downloaded', year: 2020 } });
  }, big);
  const exported = await a.evaluate(EXPORT_SCRIPT);
  const json = JSON.stringify(exported);
  check('export: all localStorage keys', Object.keys(exported.localStorage).filter((k) => k.startsWith('tuner.')).length >= 7, `${Object.keys(exported.localStorage).length} keys`);
  check('export: IndexedDB records', exported.indexedDB.tuner.files.length === 2, exported.indexedDB.tuner.files.map((r) => `${r.key} (${typeof r.value === 'string' ? `${(r.value.length / 1048576).toFixed(1)} MB` : 'object'})`).join(', '));
  check('export: origin recorded', exported.origin === url.replace(/\/$/, ''), exported.origin);
  check('export: JSON size', json.length > 3e6, `${(json.length / 1048576).toFixed(1)} MB`);

  // 2. a new, empty profile on the same origin (what the Tauri webview starts with)
  const newCtx = await browser.newContext();
  await newCtx.addInitScript(STUB);
  const b = await newCtx.newPage();
  await b.goto(url);
  await b.waitForFunction(() => typeof state === 'object');
  check('new profile starts empty', await b.evaluate(() => state.playlists.length === 0));
  const imported = await b.evaluate(IMPORT_SCRIPT(JSON.parse(json)));
  check('import: wrote everything', imported.files === 2 && imported.localStorage === Object.keys(exported.localStorage).length - imported.skipped, JSON.stringify(imported));
  await b.reload();
  await b.waitForFunction(() => typeof state === 'object');
  const seen = await b.evaluate(async () => ({
    playlists: state.playlists.map((p) => `${p.name}|${p.pass || ''}`),
    favs: [...state.favs].length,
    favname: (state.favdata['p1:live:1'] || {}).name,
    recent: state.recent.length,
    progress: (state.progress['p1:movie:9'] || {}).t,
    theme: LS.get('tuner.theme'),
    channel: LS.get('tuner.updChannel'),
    file: ((await idb.get('file:p2')) || '').length,
    dlinfo: ((await idb.get('dlinfo')) || {}).abc,
  }));
  check('app sees the playlists, credentials intact', seen.playlists.join() === 'My Xtream|pässwörd "quoted",From a file|', seen.playlists.join(' / '));
  check('favourites, with unicode names', seen.favs === 2 && seen.favname === 'Channel ✓ ünïcode', `${seen.favs}, ${seen.favname}`);
  check('history and watch progress', seen.recent === 1 && seen.progress === 1234.5, `${seen.recent}, t=${seen.progress}`);
  check('settings (theme, update channel)', seen.theme === 'light' && seen.channel === 'test', `${seen.theme}, ${seen.channel}`);
  check('playlist file from IndexedDB, byte for byte', seen.file === 8 + big.length, `${seen.file} chars`);
  check('downloads info from IndexedDB', !!seen.dlinfo && seen.dlinfo.title === 'Downloaded');

  // 3. importing again must not overwrite what the new app already has
  await b.evaluate(() => LS.set('tuner.theme', 'dark'));
  const again = await b.evaluate(IMPORT_SCRIPT(JSON.parse(json)));
  check('second import keeps newer values', (await b.evaluate(() => LS.get('tuner.theme'))) === 'dark' && again.localStorage === 0 && again.files === 0, JSON.stringify(again));

  await browser.close();
  server.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
