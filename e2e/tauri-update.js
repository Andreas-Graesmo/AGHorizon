#!/usr/bin/env node
'use strict';
/*
 * MIGRATION_PLAN.md Phase 5 gate, on Windows: the installed Tauri app updates itself from N to N+1.
 * Both versions are built with a throwaway signing key (.github/workflows/tauri-update.yml); a local server stands
 * in for GitHub (AGH_UPDATER_ENDPOINT, test builds only allow http), and plays three parts in turn:
 *   1. a latest.json for the version already installed          → "current"
 *   2. N+1 with an installer that doesn't match its signature   → refused, nothing installed
 *   3. N+1 as released                                          → downloaded, installed, the app comes back as N+1
 * with the page's data (localStorage) kept, and exactly one copy of the app and its server running.
 * Installs for the current user: run it on a CI runner, not on a PC you use.
 * Usage (Windows): node e2e/tauri-update.js <setup N.exe> <dir with N+1's setup, .sig and latest.json>
 */
const { chromium } = require('playwright');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const [setupN, dirNext] = process.argv.slice(2).map((p) => path.resolve(p));
if (!setupN || !dirNext) { console.error('usage: node e2e/tauri-update.js <setup N.exe> <dir of N+1>'); process.exit(2); }
const latest = JSON.parse(fs.readFileSync(path.join(dirNext, 'latest.json'), 'utf8'));
const PORT = 47900;
const DEVTOOLS = 9335;
const results = [];
const check = (name, ok, note = '') => { results.push(!!ok); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function entry() {
  const ps = "Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'AG Horizon' } | Select-Object InstallLocation,DisplayVersion | ConvertTo-Json -Compress";
  const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout.trim();
  if (!out) return null;
  const e = [].concat(JSON.parse(out))[0];
  return { dir: String(e.InstallLocation || '').replace(/^"|"$/g, ''), version: e.DisplayVersion };
}
const appPaths = () => {
  const out = spawnSync('powershell', ['-NoProfile', '-Command', "Get-Process ag-horizon -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }"], { encoding: 'utf8' }).stdout || '';
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
};
const processes = () => {
  const out = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout || '';
  const names = out.split(/\r?\n/).map((l) => (l.split('","')[0] || '').replace(/^"/, '').toLowerCase());
  return { app: names.filter((n) => n === 'ag-horizon.exe').length, server: names.filter((n) => n === 'aghorizon-server.exe').length };
};

// the stand-in for GitHub
let part = 'same';
const setupName = decodeURIComponent(latest.platforms['windows-x86_64-nsis'].url.split('/').pop());
const installer = fs.readFileSync(path.join(dirNext, setupName));
const server = http.createServer((req, res) => {
  if (req.url === '/latest.json') {
    const body = part === 'same' ? { ...latest, version: entryVersionN } : latest;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  if (req.url === `/${encodeURIComponent(setupName)}`) {
    // part 2: one byte changed, so the signature (made over the real file) can't match
    const bytes = part === 'tampered' ? Buffer.concat([installer.subarray(0, 1000), Buffer.from([installer[1000] ^ 0xff]), installer.subarray(1001)]) : installer;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
    return res.end(bytes);
  }
  res.writeHead(404); res.end();
});
let entryVersionN = '';

async function connect() {
  let browser = null;
  for (let i = 0; i < 120 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEVTOOLS}`); } catch { await sleep(500); }
  }
  if (!browser) throw new Error('could not reach the app\'s webview');
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://127.0.0.1:47831')) || null;
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('the app\'s page did not open');
  await page.waitForFunction(() => typeof LS === 'object' && !!window.tunerDesktop, null, { timeout: 30000 });
  return { browser, page };
}

(async () => {
  for (const d of [path.join(process.env.APPDATA, 'app.aghorizon.desktop'), path.join(process.env.LOCALAPPDATA, 'app.aghorizon.desktop')]) fs.rmSync(d, { recursive: true, force: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  /* version N, installed as a person would */
  check('version N installs silently', spawnSync(setupN, ['/S'], { stdio: 'inherit', timeout: 300000 }).status === 0);
  const before = entry();
  check('version N is installed', !!before && fs.existsSync(path.join(before.dir, 'ag-horizon.exe')), JSON.stringify(before));
  entryVersionN = before.version;
  check('N+1 is newer than N', latest.version !== entryVersionN, `${entryVersionN} → ${latest.version}`);

  const child = spawn(path.join(before.dir, 'ag-horizon.exe'), [], {
    env: { ...process.env, AGH_DEVTOOLS_PORT: String(DEVTOOLS), AGH_NO_DIALOG: '1', AGH_UPDATER_ENDPOINT: `http://127.0.0.1:${PORT}/latest.json` },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  child.stderr.on('data', (d) => process.stderr.write(`  [app] ${d}`));
  let { browser, page } = await connect();
  const info = await page.evaluate(() => window.tunerDesktop.appInfo());
  check('the app reports version N, updates available', info.version === entryVersionN && info.updater === true, JSON.stringify(info));
  await page.evaluate(() => {
    LS.set('tuner.e2eUpdate', 'kept');
    window.__statuses = [];
    window.tunerDesktop.updater.onStatus((s) => window.__statuses.push(s));
  });

  /* 1: nothing newer */
  const same = await page.evaluate(() => window.tunerDesktop.updater.check());
  check('1: a manifest for the installed version → current', same.state === 'current', JSON.stringify(same));

  /* 2: a bad installer */
  part = 'tampered';
  const offered = await page.evaluate(() => window.tunerDesktop.updater.check());
  check('2: N+1 is offered', offered.state === 'available' && offered.version === latest.version, JSON.stringify(offered));
  const bad = await page.evaluate(() => window.tunerDesktop.updater.download());
  check('2: an installer that fails its signature check is refused', bad.state === 'error' && /signature/i.test(bad.message || ''), JSON.stringify(bad));
  check('2: nothing was installed', entry().version === entryVersionN && processes().app === 1);

  /* 3: the real N+1 */
  part = 'good';
  await page.evaluate(() => window.tunerDesktop.updater.check());
  const ready = await page.evaluate(() => window.tunerDesktop.updater.download());
  const seen = await page.evaluate(() => window.__statuses.filter((s) => s.state === 'downloading').map((s) => s.percent));
  check('3: N+1 downloads, with progress, and passes its signature check', ready.state === 'ready' && ready.version === latest.version && seen.length > 1 && seen[seen.length - 1] >= 99, `${JSON.stringify(ready)}, progress ${seen.slice(0, 3).join(',')}…${seen[seen.length - 1]}`);
  await page.evaluate(() => { window.tunerDesktop.updater.install(); }).catch(() => {});   // the app exits here
  await browser.close().catch(() => {});

  let after = null;
  for (let i = 0; i < 240; i++) { after = entry(); if (after && after.version === latest.version) break; await sleep(500); }
  check('3: the installer put N+1 in place', after && after.version === latest.version, JSON.stringify(after));
  // The installer starts the app again through Explorer (as the person, not as the installer), so that copy doesn't
  // have this test's environment (no DevTools port): see that it runs from the install folder, then start it here.
  let restarted = [];
  for (let i = 0; i < 120 && !restarted.length; i++) { restarted = appPaths(); if (!restarted.length) await sleep(500); }
  check('3: the app started again by itself, from the install folder', restarted.length === 1 && restarted[0].toLowerCase() === path.join(after.dir, 'ag-horizon.exe').toLowerCase(), JSON.stringify(restarted));
  for (const n of ['ag-horizon.exe', 'aghorizon-server.exe']) spawnSync('taskkill', ['/F', '/IM', n], { stdio: 'ignore' });
  await sleep(1500);
  spawn(path.join(after.dir, 'ag-horizon.exe'), [], { env: { ...process.env, AGH_DEVTOOLS_PORT: String(DEVTOOLS), AGH_NO_DIALOG: '1' }, stdio: 'ignore', detached: true }).unref();
  ({ browser, page } = await connect());
  const back = await page.evaluate(async () => ({ version: (await window.tunerDesktop.appInfo()).version, kept: LS.get('tuner.e2eUpdate', null) }));
  check('3: it is N+1', back.version === latest.version, JSON.stringify(back));
  check('3: the page\'s data was kept', back.kept === 'kept');
  await sleep(1500);
  const p = processes();
  check('3: one app and one server running (the old ones are gone)', p.app === 1 && p.server === 1, JSON.stringify(p));

  /* clean up */
  await browser.close().catch(() => {});
  for (const n of ['ag-horizon.exe', 'aghorizon-server.exe']) spawnSync('taskkill', ['/F', '/IM', n], { stdio: 'ignore' });
  if (after) spawnSync(path.join(after.dir, 'uninstall.exe'), ['/S'], { stdio: 'inherit' });
  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
