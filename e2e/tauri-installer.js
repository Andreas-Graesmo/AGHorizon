#!/usr/bin/env node
'use strict';
/*
 * MIGRATION_PLAN.md 6.5 on Windows: the Tauri installer over an installed Electron app.
 *   A. no migration.json (the Tauri app installed by hand): the Electron app stays installed
 *   B. migration.json present (the hand-over happened): the installer removes the Electron app's program files, and
 *      its data folder (%APPDATA%\Tuner IPTV) stays as it was
 * Installs and uninstalls for the current user: run it on a CI runner, not on a PC you use.
 * Usage (Windows): node e2e/tauri-installer.js <Electron "AG Horizon Setup x.exe"> <Tauri "AG Horizon_x_x64-setup.exe">
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [electronSetup, tauriSetup] = process.argv.slice(2).map((p) => path.resolve(p));
if (!electronSetup || !tauriSetup) { console.error('usage: node e2e/tauri-installer.js <electron setup.exe> <tauri setup.exe>'); process.exit(2); }
const oldDir = path.join(process.env.APPDATA, 'Tuner IPTV');
const exportFile = path.join(oldDir, 'migration.json');
const results = [];
const check = (name, ok, note = '') => { results.push(!!ok); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`); };

// the per-user uninstall entries named "AG Horizon…" (electron-builder adds the version): the Electron app's and/or this app's
function entries() {
  const ps = "Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'AG Horizon*' } | Select-Object PSChildName,DisplayName,InstallLocation,UninstallString,DisplayVersion | ConvertTo-Json -Compress";
  const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout.trim();
  if (!out) return [];
  const list = [].concat(JSON.parse(out));
  return list.map((e) => ({ ...e, InstallLocation: String(e.InstallLocation || '').replace(/^"|"$/g, ''), electron: /Uninstall AG Horizon\.exe/i.test(e.UninstallString || '') }));
}
const electronEntry = () => entries().find((e) => e.electron) || null;
const tauriEntry = () => entries().find((e) => !e.electron) || null;
const run = (exe, args) => spawnSync(exe, args, { stdio: 'inherit', timeout: 300000 }).status;
const kill = () => { for (const n of ['AG Horizon.exe', 'ag-horizon.exe', 'aghorizon-server.exe']) spawnSync('taskkill', ['/F', '/IM', n], { stdio: 'ignore' }); };

fs.rmSync(oldDir, { recursive: true, force: true });

/* the Electron app, installed as the release installer does it */
check('Electron installer runs silently', run(electronSetup, ['/S']) === 0);
kill();
const el = electronEntry();
const elExe = el && path.join(el.InstallLocation, 'AG Horizon.exe');
check('Electron app installed (uninstall entry, program)', !!el && fs.existsSync(elExe), el ? el.InstallLocation : `no entry: ${JSON.stringify(entries())}`);
if (!el) { console.error('cannot go on without the Electron app installed'); process.exit(1); }
fs.mkdirSync(oldDir, { recursive: true });
fs.writeFileSync(path.join(oldDir, 'Preferences'), '{}');   // stands in for the Electron profile

/* A: no hand-over: both stay */
check('A: Tauri installer runs silently', run(tauriSetup, ['/S']) === 0);
kill();
const ta = tauriEntry();
check('A: the Tauri app is installed', !!ta && fs.existsSync(path.join(ta.InstallLocation, 'ag-horizon.exe')), ta ? ta.InstallLocation : 'no entry');
check('A: without migration.json the Electron app stays installed', !!electronEntry() && fs.existsSync(elExe));

/* B: after the hand-over (migration.json written), installing again removes the Electron app, keeps its data */
fs.writeFileSync(exportFile, JSON.stringify({ format: 1, app: 'AG Horizon', localStorage: { 'tuner.theme': '"light"' }, indexedDB: { tuner: { files: [] } } }));
check('B: Tauri installer runs silently', run(tauriSetup, ['/S']) === 0);
kill();
check('B: the Electron app\'s uninstall entry is gone', !electronEntry(), JSON.stringify(entries()));
check('B: the Electron app\'s program files are gone', !fs.existsSync(elExe) && !fs.existsSync(path.join(el.InstallLocation, 'Uninstall AG Horizon.exe')), el.InstallLocation);
check('B: its data folder is untouched', fs.existsSync(exportFile) && fs.existsSync(path.join(oldDir, 'Preferences')));
const tb = tauriEntry();
check('B: the Tauri app is still installed', !!tb && fs.existsSync(path.join(tb.InstallLocation, 'ag-horizon.exe')));

/* clean up: this app's own uninstaller */
if (tb) run(path.join(tb.InstallLocation, 'uninstall.exe'), ['/S']);
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
