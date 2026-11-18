#!/usr/bin/env node
'use strict';
/*
 * MIGRATION_PLAN.md Phase 6 gate, on Windows: the first start of the Tauri app after the Electron app.
 *   1. The real Electron app (this checkout) runs with some data (playlists, favourites, theme, a playlist file in
 *      IndexedDB, a downloads folder, a sync folder) and writes %APPDATA%\Tuner IPTV\migration.json (Phase 1).
 *   2. The sync code is added to that file, as the hand-over does (electron/handover.js).
 *   3. The Tauri app starts: everything is there, the code is in Credential Manager and out of the file, a marker says
 *      the import is done.
 *   4. A change made in the Tauri app survives a restart (the import never runs twice).
 *   5. Without migration.json, but with an Electron profile, the app says so once (6.4).
 * Runs on a CI runner: it removes both apps' data folders first. Do not run it on a PC whose data you want to keep.
 * Usage (Windows, after `node scripts/tauri-prep.js` and `cargo build --release` in src-tauri, with Electron's
 * binary installed): node e2e/tauri-migration.js
 */
const { chromium, _electron: electron } = require('playwright');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'src-tauri', 'target', 'release');
const exe = path.join(dir, 'ag-horizon.exe');
const DEVTOOLS = 9334;
const APPDATA = process.env.APPDATA;
const LOCALAPPDATA = process.env.LOCALAPPDATA;
const oldDir = path.join(APPDATA, 'Tuner IPTV');
const newDir = path.join(APPDATA, 'app.aghorizon.desktop');
const exportFile = path.join(oldDir, 'migration.json');
const marker = path.join(newDir, 'electron-import.json');
const noticeMarker = path.join(newDir, 'electron-import-notice');
const CODE = 'e2e-handover-code-42';
const results = [];
const check = (name, ok, note = '') => { results.push(!!ok); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const credentials = () => spawnSync('cmdkey', ['/list'], { encoding: 'utf8' }).stdout || '';
const appRunning = () => /ag-horizon\.exe/i.test(spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout || '');

async function launchTauri() {
  let log = '';
  const child = spawn(exe, [], { cwd: dir, env: { ...process.env, AGH_DEVTOOLS_PORT: String(DEVTOOLS), AGH_NO_DIALOG: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => { log += d; process.stderr.write(`  [app] ${d}`); });
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEVTOOLS}`); } catch { await sleep(500); }
  }
  if (!browser) throw new Error('could not reach the app\'s webview through its DevTools port');
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://127.0.0.1:47831')) || null;
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('the app\'s page did not open');
  await page.waitForFunction(() => typeof state === 'object' && typeof idb === 'object', null, { timeout: 30000 });
  return { child, browser, page, log: () => log };
}

// closed the way a person closes it (its close button), so localStorage is written out and the server says goodbye
async function closeTauri({ child, browser, page }) {
  await page.click('#topbar .win-ctl .close').catch(() => {});
  for (let i = 0; i < 40 && child.exitCode == null; i++) await sleep(250);
  if (child.exitCode == null) child.kill();
  await browser.close().catch(() => {});
  for (let i = 0; i < 20 && appRunning(); i++) await sleep(250);
}

(async () => {
  for (const d of [oldDir, newDir, path.join(LOCALAPPDATA, 'app.aghorizon.desktop')]) fs.rmSync(d, { recursive: true, force: true });
  spawnSync('cmdkey', ['/delete:sync-code.AG Horizon']);   // keyring's target name: <user>.<service>
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-mig-'));
  const dlDir = path.join(tmp, 'Films');
  const cloudDir = path.join(tmp, 'Cloud');
  fs.mkdirSync(dlDir); fs.mkdirSync(cloudDir);

  /* 1: the Electron app stores data and exports it */
  const eapp = await electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, AGH_MIGRATION_EXPORT: '1', TUNER_PORT: '47999' } });
  const userData = await eapp.evaluate(({ app }) => app.getPath('userData'));
  check('Electron: data folder is %APPDATA%\\Tuner IPTV', path.resolve(userData).toLowerCase() === path.resolve(oldDir).toLowerCase(), userData);
  const ewin = await eapp.firstWindow();
  await ewin.waitForFunction(() => typeof LS === 'object' && typeof idb === 'object', null, { timeout: 30000 });
  await ewin.evaluate(async () => {
    LS.set('tuner.playlists', [{ id: 'p1', name: 'From Electron', type: 'm3u', url: 'file' }]);
    LS.set('tuner.favs', ['p1:live:7']);
    LS.set('tuner.theme', 'light');
    await idb.put('file:p1', '#EXTM3U\n#EXTINF:-1,One\nhttp://x/1.ts\n');
  });
  let data = null;
  for (let i = 0; i < 40; i++) {
    try { data = JSON.parse(fs.readFileSync(exportFile, 'utf8')); if (data.localStorage['tuner.theme'] === '"light"' || data.localStorage['tuner.theme'] === 'light') break; } catch { /* not yet */ }
    await sleep(500);
  }
  await eapp.close();
  check('Electron: migration.json written', !!data && data.format === 1 && data.indexedDB.tuner.files.some((r) => r.key === 'file:p1'), data ? `${Object.keys(data.localStorage).length} keys` : 'missing');
  // the folders as the person picked them in the Electron app (its dialogs can't be clicked here), in the files the Electron app keeps them in (downloads.js / sync.js)
  const dlJson = path.join(oldDir, 'downloads.json');
  const prev = fs.existsSync(dlJson) ? JSON.parse(fs.readFileSync(dlJson, 'utf8')) : {};
  fs.writeFileSync(dlJson, JSON.stringify({ ...prev, folder: dlDir, items: prev.items || [] }));
  fs.writeFileSync(path.join(oldDir, 'sync.json'), JSON.stringify({ folder: cloudDir }));

  /* 2: the hand-over adds the sync code */
  fs.writeFileSync(exportFile, JSON.stringify({ ...data, syncCode: CODE }));

  /* 3: the Tauri app's first start */
  let t = await launchTauri();
  const imported = await t.page.evaluate(async () => (window.__aghMigrating ? window.__aghMigrating : null));
  check('the import ran on the first start', !!imported && imported.localStorage > 0 && imported.files === 1, JSON.stringify(imported));
  for (let i = 0; i < 120 && !fs.existsSync(marker); i++) await sleep(250);   // marked 10 s after the import (tauri-shell.js)
  const got = await t.page.evaluate(async () => ({
    playlists: LS.get('tuner.playlists', []).map((p) => p.name),
    favs: LS.get('tuner.favs', []),
    theme: LS.get('tuner.theme', null),
    file: await idb.get('file:p1'),
    downloadsFolder: (await window.tunerDesktop.downloads.list()).folder,
    sync: await window.tunerDesktop.sync.info(),
    code: await window.tunerDesktop.sync.getCode(),
  }));
  check('localStorage: playlists, favourites and theme came over', got.playlists.join() === 'From Electron' && got.favs.join() === 'p1:live:7' && got.theme === 'light', JSON.stringify({ playlists: got.playlists, favs: got.favs, theme: got.theme }));
  check('IndexedDB: the playlist file came over', typeof got.file === 'string' && got.file.startsWith('#EXTM3U'), String(got.file).slice(0, 30));
  check('downloads folder from the Electron app', got.downloadsFolder === dlDir, got.downloadsFolder);
  check('sync folder from the Electron app', got.sync.folder === cloudDir, got.sync.folder);
  check('sync code in Credential Manager', got.code === CODE && /AG Horizon/.test(credentials()), `code ${got.code === CODE ? 'matches' : got.code}`);
  const after = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
  check('the sync code is gone from migration.json, the rest is still there', !('syncCode' in after) && after.format === 1 && !!after.localStorage);
  check('marker: the import is recorded', fs.existsSync(marker), fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').slice(0, 120) : 'missing');
  check('the Electron app\'s folder is left as it was', fs.existsSync(path.join(oldDir, 'Local Storage')) && fs.existsSync(dlJson));

  /* 4: a change in the new app survives a restart; the import does not run again */
  await t.page.evaluate(() => { LS.set('tuner.favs', ['p1:live:9']); LS.set('tuner.theme', 'dark'); });
  await closeTauri(t);
  const markerBefore = fs.readFileSync(marker, 'utf8');
  t = await launchTauri();
  const again = await t.page.evaluate(() => ({ favs: LS.get('tuner.favs', []), theme: LS.get('tuner.theme', null), migrating: !!window.__aghMigrating }));
  check('restart: the new app\'s own changes are kept, nothing imported again', again.favs.join() === 'p1:live:9' && again.theme === 'dark' && !again.migrating && fs.readFileSync(marker, 'utf8') === markerBefore, JSON.stringify(again));
  await closeTauri(t);

  /* 5: an Electron profile but no export: told once */
  fs.rmSync(exportFile, { force: true });
  fs.rmSync(marker, { force: true });
  t = await launchTauri();
  await sleep(1000);
  check('no export: the notice is shown once', fs.existsSync(noticeMarker) && /no export from the previous version/.test(t.log()));
  await closeTauri(t);
  t = await launchTauri();
  await sleep(1000);
  check('no export: not shown again', !/no export from the previous version/.test(t.log()));
  await closeTauri(t);

  spawnSync('cmdkey', ['/delete:sync-code.AG Horizon']);   // keyring's target name: <user>.<service>
  fs.rmSync(tmp, { recursive: true, force: true });
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
