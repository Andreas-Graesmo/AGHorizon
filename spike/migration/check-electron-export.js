#!/usr/bin/env node
'use strict';
// MIGRATION_PLAN.md Phase 1: the real Electron app writes <userData>/migration.json with what the page stored.
// Runs the app with a scratch HOME (so a real profile is never touched), stores data through the app's own helpers,
// and waits for the export. Linux: run under xvfb-run. Usage: node spike/migration/check-electron-export.js
const { _electron: electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-home-'));
  const env = { ...process.env, HOME: home, APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, '.config'), AGH_MIGRATION_EXPORT: '1', TUNER_PORT: '47999' };
  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..', '..'), '--no-sandbox'], env });
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof LS === 'object' && typeof idb === 'object', null, { timeout: 30000 });
  await win.evaluate(async () => {
    LS.set('tuner.playlists', [{ id: 'p1', name: 'Exported list', type: 'xtream', user: 'u', pass: 'p' }]);
    LS.set('tuner.favs', ['p1:live:7']);
    await idb.put('file:p1', '#EXTM3U\n#EXTINF:-1,One\nhttp://x/1.ts\n');
  });
  const file = path.join(userData, 'migration.json');
  const t0 = Date.now();
  let data = null;
  while (Date.now() - t0 < 20000) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); if (data.localStorage['tuner.playlists']) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  await app.close();
  const ok = !!data && data.format === 1 && JSON.parse(data.localStorage['tuner.playlists'])[0].name === 'Exported list'
    && data.indexedDB.tuner.files.some((r) => r.key === 'file:p1') && !('syncCode' in data);
  console.log(ok ? 'pass' : 'FAIL', ` migration.json in ${path.relative(home, userData)}:`, data ? `format ${data.format}, app ${data.appVersion}, origin ${data.origin}, ${Object.keys(data.localStorage).length} keys, ${data.indexedDB.tuner.files.length} IndexedDB record(s), sync code ${'syncCode' in data ? 'PRESENT' : 'absent (as it should be on an ordinary start)'}` : 'not written');
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
