#!/usr/bin/env node
'use strict';
/*
 * MIGRATION_PLAN.md Phase 2 gate, on Windows: the built Tauri app (src-tauri/target/release) starts its server and
 * ffmpeg sidecars, shows the dashboard, plays a live channel whose AC-3 sound WebView2 can't decode (so the app
 * converts it with ffmpeg), and leaves nothing running after being killed or closed.
 * Phase 3: downloads (a real one, played back through /api/local, kept across a restart), the sync code in Windows
 * Credential Manager, folder sync with binary data, and the monitor list.
 * Phase 4: the window buttons, the window's size kept across restarts, picture-in-picture and the mirror window
 * (opened and closed with no window left behind), fullscreen from a real click, the screen kept awake, and closing
 * the app with picture-in-picture open.
 * The page is driven through WebView2's DevTools port (AGH_DEVTOOLS_PORT, see src-tauri/src/main.rs).
 * Usage (Windows, after `node scripts/tauri-prep.js` and `cargo build --release` in src-tauri): node e2e/tauri-windows.js
 */
const { chromium } = require('playwright');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'src-tauri', 'target', 'release');
const exe = path.join(dir, 'ag-horizon.exe');
const ffmpeg = path.join(dir, 'ffmpeg.exe');
const DEVTOOLS = 9333;
const results = [];
const check = (name, ok, note = '') => { results.push(!!ok); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const running = () => {
  const out = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout || '';
  const names = out.split(/\r?\n/).map((l) => (l.split('","')[0] || '').replace(/^"/, '').toLowerCase());
  return { app: names.filter((n) => n === 'ag-horizon.exe').length, server: names.filter((n) => n === 'aghorizon-server.exe').length, ffmpeg: names.filter((n) => n === 'ffmpeg.exe').length };
};

// a "provider": a live MPEG-TS channel, H.264 with AC-3 sound, sent at its own bit rate after a 2 s head start
function provider(clip) {
  const buf = fs.readFileSync(clip);
  const SECONDS = 40;
  return http.createServer((req, res) => {
    if (req.url.startsWith('/film.mp4')) { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length }); return res.end(buf); }   // a "film" to download, all at once
    if (!req.url.startsWith('/live.ts')) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    const tick = Math.ceil(buf.length / SECONDS / 10);
    let off = Math.min(buf.length, tick * 20);
    res.write(buf.subarray(0, off));
    const iv = setInterval(() => { if (off >= buf.length) { clearInterval(iv); return res.end(); } res.write(buf.subarray(off, off + tick)); off += tick; }, 100);
    res.on('close', () => clearInterval(iv));
  });
}

async function launch() {
  const child = spawn(exe, [], { cwd: dir, env: { ...process.env, AGH_DEVTOOLS_PORT: String(DEVTOOLS), AGH_NO_DIALOG: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write(`  [app] ${d}`));
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
  return { child, browser, page };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-e2e-'));
  const clip = path.join(tmp, 'live.ts');
  const gen = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '25', '-c:a', 'ac3', '-f', 'mpegts', clip]);
  if (gen.status !== 0) throw new Error(`test clip: ${gen.stderr}`);
  const prov = provider(clip);
  await new Promise((r) => prov.listen(0, '127.0.0.1', r));
  const liveUrl = `http://127.0.0.1:${prov.address().port}/live.ts`;
  check('nothing running before the test', Object.values(running()).every((n) => n === 0), JSON.stringify(running()));

  // the app's data folder (%APPDATA%\app.aghorizon.desktop): downloads and folder sync into temp folders
  const dataDir = path.join(process.env.APPDATA, 'app.aghorizon.desktop');
  const dlDir = path.join(tmp, 'Downloads');
  const cloudDir = path.join(tmp, 'Cloud');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'downloads.json'), JSON.stringify({ folder: dlDir, pauseWhileWatching: false, items: [] }));
  fs.writeFileSync(path.join(dataDir, 'sync.json'), JSON.stringify({ folder: cloudDir }));
  const filmUrl = `http://127.0.0.1:${prov.address().port}/film.mp4`;

  /* 1: start, dashboard, a live channel converted with ffmpeg, then killed */
  let { child, browser, page } = await launch();
  await page.waitForFunction(() => typeof state === 'object' && typeof ui === 'object', null, { timeout: 30000 });
  const info = await page.evaluate(() => ({ tauri: !!window.__TAURI__, bridge: !!window.tunerDesktop && typeof window.tunerDesktop.ready === 'function' && typeof window.tunerDesktop.sync.getCode === 'function' && typeof window.tunerDesktop.downloads.onChange === 'function', route: ui.route, topbar: !!document.querySelector('#topbar') }));
  check('page from the app\'s own server, with the Tauri bridge', info.tauri && info.bridge, JSON.stringify(info));
  check('the dashboard renders', info.route === 'dashboard' && info.topbar, `route ${info.route}`);
  await page.waitForFunction(() => state.ffmpeg === true, null, { timeout: 15000 }).catch(() => {});
  check('the server found the ffmpeg sidecar', await page.evaluate(() => state.ffmpeg === true));

  await page.evaluate((url) => playChannel({ uid: 'e2e:live:1', pid: null, kind: 'live', name: 'E2E live (AC-3)', url }), liveUrl);
  let play = null;
  for (let i = 0; i < 60; i++) {
    play = await page.evaluate(() => { const v = document.querySelector('#video'); return { w: v.videoWidth, t: v.currentTime, src: v.currentSrc, paused: v.paused }; });
    if (play.w > 0 && play.t > 3 && /\/api\/transcode/.test(play.src)) break;
    await sleep(500);
  }
  check('live TV plays, AC-3 converted through /api/transcode (ffmpeg sidecar)', play.w > 0 && play.t > 3 && /\/api\/transcode/.test(play.src), `picture ${play.w}px, clock ${play.t.toFixed(1)} s, ${/\/api\/transcode/.test(play.src) ? 'converted' : `not converted: ${play.src.slice(0, 80)}`}`);
  const during = running();
  check('server and ffmpeg running while it plays', during.server === 1 && during.ffmpeg >= 1, JSON.stringify(during));

  /* Phase 3: downloads, sync, displays */
  const dl = await page.evaluate(async (url) => {
    const td = window.tunerDesktop;
    const first = await td.downloads.list();
    const events = [];
    td.downloads.onChange((s) => events.push(s));
    const added = await td.downloads.add([{ kind: 'movie', uid: 'e2e:movie:1', pid: null, url, ext: 'mp4', title: 'E2E Film', year: '2024' }]);
    let done = null;
    for (let i = 0; i < 120 && !done; i++) {
      done = events.flatMap((e) => e.items).find((it) => it.state === 'done') || null;
      if (!done) await new Promise((r) => setTimeout(r, 250));
    }
    const local = done ? await fetch(`/api/local/${done.id}`) : null;
    const bytes = local ? (await local.arrayBuffer()).byteLength : 0;
    return { folder: first.folder, added, events: events.length, done: done && { size: done.size, state: done.state }, localStatus: local && local.status, bytes };
  }, filmUrl);
  const clipSize = fs.statSync(clip).size;
  check('downloads: the folder from downloads.json', dl.folder === dlDir, dl.folder);
  check('downloads: a film downloads, with progress events', dl.added === 1 && dl.done && dl.done.size === clipSize && dl.events > 0, JSON.stringify({ added: dl.added, events: dl.events, done: dl.done }));
  check('downloads: the file plays back through /api/local', dl.localStatus === 200 && dl.bytes === clipSize, `HTTP ${dl.localStatus}, ${dl.bytes} bytes`);
  check('downloads: the file is in the Plex-style folder', fs.existsSync(path.join(dlDir, 'Movies', 'E2E Film (2024)', 'E2E Film (2024).mp4')));

  const sy = await page.evaluate(async () => {
    const s = window.tunerDesktop.sync;
    const info = await s.info();
    await s.setCode('e2e-code-0123');
    const back = await s.getCode();
    const vault = 'cd'.repeat(32), device = 'fedcba9876543210';
    const bytes = new Uint8Array(4096); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 255;
    await s.folderPut(vault, device, bytes);
    const list = await s.folderList(vault);
    const same = list.length === 1 && list[0].device === device && list[0].blob.length === bytes.length && list[0].blob.every((b, i) => b === bytes[i]);
    await s.folderRemove(vault, device);
    const after = await s.folderList(vault);
    return { info, back, same, emptyAfter: after.length === 0 };
  });
  const cred = spawnSync('cmdkey', ['/list'], { encoding: 'utf8' }).stdout || '';
  check('sync: code saved and read back, keychain = Windows Credential Manager', sy.back === 'e2e-code-0123' && sy.info.keychain === true && /AG Horizon/.test(cred), `${JSON.stringify(sy.info)}, in cmdkey: ${/AG Horizon/.test(cred)}`);
  await page.evaluate(() => window.tunerDesktop.sync.setCode(''));
  const credAfter = spawnSync('cmdkey', ['/list'], { encoding: 'utf8' }).stdout || '';
  check('sync: clearing the code removes it from Credential Manager', !/AG Horizon/.test(credAfter));
  check('sync: folder files carry the bytes exactly', sy.same && sy.emptyAfter && sy.info.folder === cloudDir, `folder ${sy.info.folder}`);
  const disp = await page.evaluate(() => window.tunerDesktop.displays());
  check('displays: the monitors are listed', disp.length >= 1 && disp.some((d) => d.primary) && disp[0].width > 0, JSON.stringify(disp));

  /* Phase 4: title bar */
  const tb = await page.evaluate(async () => {
    const w = window.__TAURI__.window.getCurrentWindow();
    const box = document.querySelector('#topbar .win-ctl');
    return { decorated: await w.isDecorated(), buttons: box ? [...box.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) : [], drag: document.getElementById('topbar').getAttribute('data-tauri-drag-region') };
  });
  check('title bar: no system frame; minimise, maximise and close in the top bar, which drags the window', tb.decorated === false && tb.buttons.join() === 'Minimise,Maximise,Close' && tb.drag === 'deep', JSON.stringify(tb));
  const isMax = () => page.evaluate(() => window.__TAURI__.window.getCurrentWindow().isMaximized());
  await page.click('#topbar .win-ctl .max');
  await sleep(800);
  const maxed = await isMax();
  await page.click('#topbar .win-ctl .max');
  await sleep(800);
  check('title bar: maximise, then restore, by clicking', maxed === true && (await isMax()) === false && (await page.getAttribute('#topbar .win-ctl .max', 'aria-label')) === 'Maximise', `maximised ${maxed}`);
  await page.click('#topbar .win-ctl .min');
  await sleep(800);
  const minimized = await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().isMinimized());
  await page.evaluate(() => window.tunerDesktop.focusWindow());
  await sleep(500);
  check('title bar: minimise', minimized === true, `minimised ${minimized}`);

  /* Phase 4: picture-in-picture, the mirror, fullscreen, keep-awake (a film plays in the player) */
  await page.evaluate((url) => playChannel({ uid: 'e2e:movie:2', pid: null, kind: 'movie', name: 'E2E Film', url }), `${filmUrl}?play`);
  await page.waitForFunction(() => { const v = document.querySelector('#video'); return v.videoWidth > 0 && v.currentTime > 1; }, null, { timeout: 30000 }).catch(() => {});
  await sleep(1500);
  check('keep-awake: a wake lock is held while a video plays', await page.evaluate(() => window.__aghShell.wakeLockHeld()));

  const winInfo = (label) => page.evaluate(async (l) => {
    const all = await window.__TAURI__.window.getAllWindows();
    const w = all.find((x) => x.label === l);
    if (!w) return null;
    return { decorated: await w.isDecorated(), onTop: await w.isAlwaysOnTop(), visible: await w.isVisible(), fullscreen: await w.isFullscreen() };
  }, label);
  // the PiP button runs togglePip() (ui.js:261); from the dashboard the film plays in the mini player, which hides it
  await page.evaluate(() => togglePip());
  await sleep(2500);
  const pip = await winInfo('pip');
  // the player (and its <video>) now lives in the PiP window's document: follow player.js's own `video`
  const inPip = await page.evaluate(() => ({ inPip: video.ownerDocument !== document, w: video.videoWidth, paused: video.paused }));
  check('PiP: opens a frameless window on top', pip && pip.decorated === false && pip.onTop === true && pip.visible, JSON.stringify(pip));
  check('PiP: the player moved into it and plays', inPip.inPip && inPip.w > 0 && !inPip.paused, JSON.stringify(inPip));
  await page.evaluate(() => togglePip());
  await sleep(2000);
  const back = await page.evaluate(() => ({ home: video.ownerDocument === document, paused: video.paused }));
  check('PiP: closed, its window is gone (no window left on screen) and the player is back', (await winInfo('pip')) === null && back.home, JSON.stringify({ window: await winInfo('pip'), ...back }));

  await page.evaluate(() => openMirror());
  await sleep(3000);
  const mirror = await winInfo('mirror');
  const mirrorPic = await page.evaluate(() => { try { const v = mirrorWin.document.querySelector('video'); return v ? v.videoWidth : -1; } catch (e) { return String(e); } });
  check('mirror (floating): a frameless window on top showing the picture', mirror && mirror.decorated === false && mirror.onTop && mirrorPic > 0, JSON.stringify({ ...mirror, picture: mirrorPic }));
  await page.evaluate(() => closeMirror());
  await sleep(1500);
  check('mirror: closed, its window is gone', (await winInfo('mirror')) === null);
  const firstDisplay = await page.evaluate(async () => (await window.tunerDesktop.displays())[0].id);
  await page.evaluate((id) => openMirror(id), firstDisplay);
  await sleep(3000);
  const mirrorFs = await winInfo('mirror');
  check('mirror on a chosen monitor: fullscreen there', mirrorFs && mirrorFs.fullscreen === true, JSON.stringify(mirrorFs));
  await page.evaluate(() => closeMirror());
  await sleep(1500);

  const wfs = () => page.evaluate(() => window.__TAURI__.window.getCurrentWindow().isFullscreen());
  await page.hover('#video');
  await page.click('#pFull');   // a real click: browsers allow fullscreen only from one
  await sleep(1500);
  const fsOn = await wfs();
  await page.keyboard.press('Escape');
  await sleep(1500);
  check('fullscreen: the player button makes the window fullscreen; Escape leaves it', fsOn === true && (await wfs()) === false, `on ${fsOn}`);
  await page.evaluate(() => stopPlayback());
  await sleep(1500);
  check('keep-awake: released when nothing plays', !(await page.evaluate(() => window.__aghShell.wakeLockHeld())));

  await browser.close().catch(() => {});
  spawnSync('taskkill', ['/F', '/PID', String(child.pid)]);   // no /T: the job object must take the children
  await sleep(3000);
  const afterKill = running();
  check('killed with taskkill /F: server and ffmpeg end with it (job object)', afterKill.app === 0 && afterKill.server === 0 && afterKill.ffmpeg === 0, JSON.stringify(afterKill));

  /* 2: start again (the port is free again), then close the window normally */
  ({ child, browser, page } = await launch());
  await page.waitForFunction(() => typeof state === 'object', null, { timeout: 30000 });
  check('starts again after a kill (port free again)', true);
  const kept = await page.evaluate(async () => (await window.tunerDesktop.downloads.list()).items.map((it) => `${it.title}:${it.state}`));
  check('downloads: the finished film is still listed after the restart', kept.includes('E2E Film:done'), JSON.stringify(kept));

  // window size: changed now, it must come back after a normal close and start
  await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().setSize(new window.__TAURI__.window.LogicalSize(1111, 733)));
  await sleep(1000);
  // closing the app window while picture-in-picture is open: both go, and the app quits (electron/main.js 'closed')
  await page.evaluate((url) => playChannel({ uid: 'e2e:movie:3', pid: null, kind: 'movie', name: 'E2E Film', url }), `${filmUrl}?again`);
  await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => togglePip());
  await sleep(2500);
  const pipOpen = await page.evaluate(async () => (await window.__TAURI__.window.getAllWindows()).map((w) => w.label));
  let exited = new Promise((r) => child.on('exit', (code) => r(code)));
  await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().close()).catch(() => {});
  let code = await Promise.race([exited, sleep(15000).then(() => 'still running')]);
  await sleep(1500);
  let afterClose = running();
  check('closing the app window with PiP open quits, and nothing is left running', pipOpen.includes('pip') && code !== 'still running' && Object.values(afterClose).every((n) => n === 0), `windows before ${JSON.stringify(pipOpen)}, exit ${code}, ${JSON.stringify(afterClose)}`);
  await browser.close().catch(() => {});

  /* 3: start again: the window has the size it was closed with */
  ({ child, browser, page } = await launch());
  await page.waitForFunction(() => typeof state === 'object', null, { timeout: 30000 });
  const size = await page.evaluate(async () => { const w = window.__TAURI__.window.getCurrentWindow(); const s = await w.innerSize(); const f = await w.scaleFactor(); return { w: Math.round(s.width / f), h: Math.round(s.height / f) }; });
  check('window size kept across a restart (window-state plugin)', Math.abs(size.w - 1111) <= 2 && Math.abs(size.h - 733) <= 2, JSON.stringify(size));
  exited = new Promise((r) => child.on('exit', (c) => r(c)));
  await page.click('#topbar .win-ctl .close');   // the window's own close button
  code = await Promise.race([exited, sleep(15000).then(() => 'still running')]);
  await sleep(1500);
  afterClose = running();
  check('the close button quits, and nothing is left running', code !== 'still running' && Object.values(afterClose).every((n) => n === 0), `exit ${code}, ${JSON.stringify(afterClose)}`);
  await browser.close().catch(() => {});

  prov.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); for (const n of ['ag-horizon.exe', 'aghorizon-server.exe', 'ffmpeg.exe']) spawnSync('taskkill', ['/F', '/IM', n]); process.exit(1); });
