#!/usr/bin/env node
'use strict';
/*
 * MIGRATION_PLAN.md Phase 2 gate, on Windows: the built Tauri app (src-tauri/target/release) starts its server and
 * ffmpeg sidecars, shows the dashboard, plays a live channel whose AC-3 sound WebView2 can't decode (so the app
 * converts it with ffmpeg), and leaves nothing running after being killed or closed.
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

  /* 1: start, dashboard, a live channel converted with ffmpeg, then killed */
  let { child, browser, page } = await launch();
  await page.waitForFunction(() => typeof state === 'object' && typeof ui === 'object', null, { timeout: 30000 });
  const info = await page.evaluate(() => ({ tauri: !!window.__TAURI__, bridge: !!window.tunerDesktop && typeof window.tunerDesktop.ready === 'function' && !window.tunerDesktop.sync, route: ui.route, topbar: !!document.querySelector('#topbar') }));
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

  await browser.close().catch(() => {});
  spawnSync('taskkill', ['/F', '/PID', String(child.pid)]);   // no /T: the job object must take the children
  await sleep(3000);
  const afterKill = running();
  check('killed with taskkill /F: server and ffmpeg end with it (job object)', afterKill.app === 0 && afterKill.server === 0 && afterKill.ffmpeg === 0, JSON.stringify(afterKill));

  /* 2: start again (the port is free again), then close the window normally */
  ({ child, browser, page } = await launch());
  await page.waitForFunction(() => typeof state === 'object', null, { timeout: 30000 });
  check('starts again after a kill (port free again)', true);
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().close()).catch(() => {});
  const code = await Promise.race([exited, sleep(15000).then(() => 'still running')]);
  await sleep(1500);
  const afterClose = running();
  check('closing the window quits, and nothing is left running', code !== 'still running' && Object.values(afterClose).every((n) => n === 0), `exit ${code}, ${JSON.stringify(afterClose)}`);
  await browser.close().catch(() => {});

  prov.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); for (const n of ['ag-horizon.exe', 'aghorizon-server.exe', 'ffmpeg.exe']) spawnSync('taskkill', ['/F', '/IM', n]); process.exit(1); });
