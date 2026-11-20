#!/usr/bin/env node
'use strict';
/*
 * MIGRATION_PLAN.md 9.10 gate, on Linux and macOS: from the Electron app to the Tauri AppImage or .app.
 *   1. The real Electron app (this checkout) runs with some data (playlists, favourites, a playlist file in IndexedDB)
 *      and writes migration.json in its data folder (~/.config/Tuner IPTV, ~/Library/Application Support/Tuner IPTV),
 *      as the bridge version now does on every system.
 *   2. The sync code is added to that file, as the hand-over does (electron/handover.js, updater.js).
 *   3. The Tauri AppImage starts with the same home folder. Its page is swapped for a test page (WebKitGTK has no
 *      DevTools protocol), which the import script still runs in; like tauri-shell.js it reports the import done.
 *      Everything is there, the sync code is in the keyring (macOS: the Keychain; Linux without one: the app's
 *      file) and out of migration.json, and the import is marked done.
 *   4. A second start doesn't import again.
 * Usage, with Electron's binary installed: node e2e/tauri-migration-unix.js <AppImage or .app>
 * (Linux: under xvfb-run, with a Secret Service on the session bus if wanted.)
 */
const { _electron: electron } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const bundle = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node e2e/tauri-migration-unix.js <AppImage or .app>'); process.exit(2); }
const mac = bundle.endsWith('.app');
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, note = '') => { results.push(!!ok); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`); };
const REPORT_PORT = 47998;

const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agh-migrate-'));
const home = path.join(work, 'home');
const config = path.join(home, '.config');
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(home, '.local', 'share') };
fs.mkdirSync(config, { recursive: true });
// where the Tauri app looks for Electron's folder (next to its own config folder) and keeps its data
const support = mac ? path.join(home, 'Library', 'Application Support') : config;
const oldDir = path.join(support, 'Tuner IPTV');
const exportFile = path.join(oldDir, 'migration.json');
const newData = mac ? path.join(support, 'app.aghorizon.desktop') : path.join(home, '.local', 'share', 'app.aghorizon.desktop');
// macOS: the sync code in the Keychain (keyring: service "AG Horizon", account "sync-code")
const keychainCode = () => {
  const r = require('child_process').spawnSync('security', ['find-generic-password', '-s', 'AG Horizon', '-a', 'sync-code', '-w'], { env, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

// what the test page reports, once the import has run
const PAGE = `<!doctype html><meta charset="utf-8"><title>AG Horizon</title><script>
const rep = (k, v) => fetch('http://127.0.0.1:${REPORT_PORT}/' + k + '?' + encodeURIComponent(JSON.stringify(v)), { mode: 'no-cors' });
const inv = window.__TAURI__.core.invoke;
(async () => {
  let result = null;
  // as tauri-shell.js: marked done 10 s after the import (reported here at once)
  if (window.__aghMigrating) { result = await window.__aghMigrating; setTimeout(() => inv('migration', { op: 'done', result }), 10000); }
  const files = await new Promise((res) => {
    const o = indexedDB.open('tuner', 1);
    o.onupgradeneeded = () => o.result.createObjectStore('files');
    o.onsuccess = () => { const g = o.result.transaction('files').objectStore('files').get('file:p1'); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); };
    o.onerror = () => res(null);
  });
  rep('state', {
    imported: !!result, playlists: localStorage.getItem('tuner.playlists'), favs: localStorage.getItem('tuner.favs'), file: files,
    code: await inv('sync', { op: 'getCode', args: [] }).catch((e) => 'err ' + e),
    keychain: (await inv('sync', { op: 'info', args: [] }).catch(() => ({}))).keychain,
  });
})();
</script>`;

async function runTauri(launch, logName) {
  const reports = {};
  const listener = http.createServer((q, r) => {
    const [k, v] = q.url.slice(1).split('?');
    try { reports[k] = JSON.parse(decodeURIComponent(v || '')); } catch { reports[k] = v; }
    r.end();
  }).listen(REPORT_PORT, '127.0.0.1');
  const log = fs.openSync(path.join(work, logName), 'w');
  const app = spawn(launch[0], launch[1], { env: { ...env, AGH_NO_DIALOG: '1' }, stdio: ['ignore', log, log], detached: true });
  for (let i = 0; i < 90 && !reports.state; i++) await sleep(500);
  // stopped as soon as the import is marked done: what is marked done must be on disk by then (the page waits for
  // WebKit to write localStorage before it reports, tauri-shell.js; this page does the same, below)
  for (let i = 0; i < 60 && reports.state && reports.state.imported && !fs.existsSync(path.join(newData, 'electron-import.json')); i++) await sleep(500);
  try { process.kill(-app.pid, 'SIGTERM'); } catch {}
  await sleep(2500);
  listener.close();
  return reports.state || null;
}

(async () => {
  /* 1. the Electron app writes migration.json */
  const eapp = await electron.launch({ executablePath: require('electron'), args: [root, '--no-sandbox'], env: { ...env, TUNER_PORT: '47999' } });
  const win = await eapp.firstWindow();
  await win.waitForFunction(() => typeof LS === 'object' && typeof idb === 'object', null, { timeout: 30000 });
  await win.evaluate(async () => {
    LS.set('tuner.playlists', [{ id: 'p1', name: 'From Electron', type: 'm3u' }]);
    LS.set('tuner.favs', ['p1:live:7']);
    await idb.put('file:p1', '#EXTM3U\n#EXTINF:-1,One\nhttp://x/1.ts\n');
  });
  // Electron's own data folder; on a Mac it may not follow $HOME: the export is then put where the Tauri app looks
  const userData = await eapp.evaluate(({ app }) => app.getPath('userData'));
  const written = path.join(userData, 'migration.json');
  let data = null;
  for (let i = 0; i < 40; i++) {
    try { data = JSON.parse(fs.readFileSync(written, 'utf8')); if (data.localStorage['tuner.playlists']) break; } catch { /* not yet */ }
    await sleep(500);
  }
  await eapp.close();
  check('the Electron app wrote migration.json in its data folder (no longer Windows only)', data && /From Electron/.test(data.localStorage['tuner.playlists'] || ''), written);
  check('Electron\'s data folder is the one the Tauri app looks in ("Tuner IPTV")', path.basename(userData) === 'Tuner IPTV', userData);
  fs.mkdirSync(oldDir, { recursive: true });

  /* 2. the sync code, as the hand-over adds it */
  data.syncCode = 'code-from-electron';
  fs.writeFileSync(exportFile, JSON.stringify(data));

  /* 3. the Tauri app */
  let launch;
  if (mac) {
    // a copy of the .app, its page swapped (the real path: Tauri won't start from a path with a symlink in it)
    const copy = path.join(work, path.basename(bundle));
    execFileSync('cp', ['-R', bundle, copy]);
    fs.writeFileSync(path.join(copy, 'Contents', 'Resources', 'public', 'index.html'), PAGE);
    launch = [path.join(copy, 'Contents', 'MacOS', 'ag-horizon'), []];
  } else {
    execFileSync(bundle, ['--appimage-extract'], { cwd: work, stdio: 'ignore' });
    const root2 = path.join(work, 'squashfs-root');
    fs.writeFileSync(path.join(root2, 'usr', 'lib', 'AG Horizon', 'public', 'index.html'), PAGE);
    launch = ['xvfb-run', ['-a', path.join(root2, 'AppRun')]];
  }
  const first = await runTauri(launch, 'tauri-1.log');
  check('the Tauri app imported the export', first && first.imported, JSON.stringify(first && { imported: first.imported }));
  check('the playlists and favourites are there', first && /From Electron/.test(first.playlists || '') && /p1:live:7/.test(first.favs || ''));
  check('the playlist file is in IndexedDB', first && /#EXTM3U/.test(first.file || ''));
  check('the sync code came across', first && first.code === 'code-from-electron', `keyring: ${first && first.keychain}`);
  const left = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
  check('the sync code is out of migration.json', !('syncCode' in left));
  check('the import is marked done', fs.existsSync(path.join(newData, 'electron-import.json')));
  if (mac) check('the sync code is in the macOS Keychain', first && first.keychain === true && keychainCode() === 'code-from-electron');
  else if (first && first.keychain === false) check('without a keyring the code is in the app\'s own file', fs.readFileSync(path.join(newData, 'sync-code'), 'utf8') === 'code-from-electron');

  /* 4. a second start doesn't import again */
  const second = await runTauri(launch, 'tauri-2.log');
  if (mac) require('child_process').spawnSync('security', ['delete-generic-password', '-s', 'AG Horizon', '-a', 'sync-code'], { env });   // leave the Keychain as it was
  check('a second start doesn\'t import again', second && !second.imported && /From Electron/.test(second.playlists || ''), JSON.stringify(second));

  const failed = results.filter((ok) => !ok).length;
  if (failed) {
    for (const f of ['tauri-1.log', 'tauri-2.log']) {
      const p = path.join(work, f);
      if (fs.existsSync(p)) console.log(`--- ${f} (tail) ---\n${fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/plugin loader failed|DRI3|accelerated/.test(l)).slice(-15).join('\n')}`);
    }
    console.error(`${failed} check(s) failed (kept: ${work})`);
    process.exit(1);
  }
  if (!process.env.KEEP) fs.rmSync(work, { recursive: true, force: true });
  console.log(`OK: Electron → Tauri on ${mac ? 'macOS' : 'Linux'}, data and sync code carried over, once`);
})().catch((e) => { console.error(e); process.exit(1); });
