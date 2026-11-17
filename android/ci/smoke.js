#!/usr/bin/env node
'use strict';
/* Tries the Android TV app on an emulator (the "Android TV" workflow runs this; so can you, with an emulator or a
   device on adb and ffmpeg on the PATH):   node android/ci/smoke.js path/to/app-debug.apk

   It makes a few short test videos, serves them with a playlist from this machine, installs and starts the app, and
   then steers it the way a person would: the page through the WebView's debugging port, the remote with adb.
   Needs a debug build (the WebView of a release build can't be inspected) and Node 22+. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const APK = process.argv[2];
const PKG = 'app.aghorizon.tv';
const ORIGIN = 'http://127.0.0.1:47831';
const HOST = process.env.SMOKE_HOST || '10.0.2.2';   // this machine, as the emulator sees it
const PORT = 8787;
const OUT = path.join(__dirname, 'out');
const MEDIA = path.join(os.tmpdir(), 'ag-horizon-smoke');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync('adb', a, { encoding: 'utf8', maxBuffer: 256e6 });
const key = async (name, pause = 700) => { adb('shell', 'input', 'keyevent', 'KEYCODE_' + name); await wait(pause); };

const results = [];
function check(name, ok, detail = '') {
  const line = `${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? '  ·  ' + String(detail).slice(0, 400) : ''}`;
  results.push({ name, ok: !!ok, line });
  console.log(line);
}

/* ── test videos: H.264 + AAC as MP4 and as HLS, and H.264 + AC-3 as MPEG-TS (sound most TVs can't decode themselves) ── */
function makeMedia() {
  fs.mkdirSync(path.join(MEDIA, 'hls'), { recursive: true });
  fs.mkdirSync(path.join(MEDIA, 'movie'), { recursive: true });
  const ff = (secs, ...out) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(secs), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '50', ...out], { stdio: 'inherit' });
  if (!fs.existsSync(path.join(MEDIA, 'movie', 'clip.mp4'))) ff(180, '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart', path.join(MEDIA, 'movie', 'clip.mp4'));
  if (!fs.existsSync(path.join(MEDIA, 'ac3.ts'))) ff(120, '-c:a', 'ac3', '-ac', '2', '-f', 'mpegts', path.join(MEDIA, 'ac3.ts'));
  if (!fs.existsSync(path.join(MEDIA, 'hls', 'index.m3u8'))) ff(120, '-c:a', 'aac', '-ac', '2', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(MEDIA, 'hls', 'seg%03d.ts'), path.join(MEDIA, 'hls', 'index.m3u8'));
  const base = `http://${HOST}:${PORT}`;
  fs.writeFileSync(path.join(MEDIA, 'list.m3u'), [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="one" group-title="Test",Channel One', `${base}/hls/index.m3u8`,
    '#EXTINF:-1 tvg-id="two" group-title="Test",Channel Two', `${base}/ac3.ts`,
    '#EXTINF:-1 tvg-id="three" group-title="Test",Channel Three', `${base}/hls/index.m3u8?c=3`,
    '#EXTINF:-1 group-title="Films",Test Movie (2024)', `${base}/movie/clip.mp4`,
    ''].join('\n'));
}

function serveMedia() {
  const types = { '.m3u': 'audio/x-mpegurl', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4' };
  const server = http.createServer((req, res) => {
    const file = path.join(MEDIA, path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!file.startsWith(MEDIA) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(file).size;
    const head = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...head, 'Content-Length': size });
      fs.createReadStream(file).pipe(res);
    }
  });
  return new Promise((resolve) => server.listen(PORT, '0.0.0.0', () => resolve(server)));
}

/* ── the page, through the WebView's debugging port ── */
async function connectPage() {
  let socket = '';
  for (let i = 0; i < 90 && !socket; i++) {
    const m = /@(webview_devtools_remote_\d+)/.exec(adb('shell', 'cat', '/proc/net/unix'));
    if (m) socket = m[1]; else await wait(1000);
  }
  if (!socket) throw new Error('the WebView never opened its debugging port');
  adb('forward', 'tcp:9222', 'localabstract:' + socket);
  let target = null;
  for (let i = 0; i < 90 && !target; i++) {
    try { target = (await (await fetch('http://127.0.0.1:9222/json')).json()).find((p) => p.type === 'page' && p.url.startsWith(ORIGIN)); } catch { /* not listening yet */ }
    if (!target) await wait(1000);
  }
  if (!target) throw new Error('the app never loaded its page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not connect to the page')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (msg) => {
    const j = JSON.parse(msg.data);
    const p = pending.get(j.id);
    if (!p) return;
    pending.delete(j.id);
    if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('in the page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  };
  return { ev, close: () => ws.close() };
}

async function until(label, fn, ms = 60000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await wait(500);
  }
  console.log(`  (timed out waiting for: ${label}; last: ${JSON.stringify(last)})`);
  return null;
}

let shots = 0;
function screenshot(name) {
  fs.mkdirSync(OUT, { recursive: true });
  const png = path.join(OUT, `${String(++shots).padStart(2, '0')}-${name}.png`);
  fs.writeFileSync(png, execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 256e6 }));
  // SMOKE_INLINE_SHOTS="live-tv,movie": small copies of those in the log, for reading a run without downloading its files
  if ((process.env.SMOKE_INLINE_SHOTS || '').split(',').includes(name)) {
    try {
      const jpg = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', png, '-vf', 'scale=480:-2', '-q:v', '14', '-f', 'mjpeg', '-'], { maxBuffer: 64e6 });
      console.log(`<<<SHOT ${name}\n${jpg.toString('base64').replace(/(.{160})/g, '$1\n')}\nSHOT>>>`);
    } catch (e) { console.log('  (no inline screenshot: ' + e.message.split('\n')[0] + ')'); }
  }
}

async function main() {
  if (!APK || !fs.existsSync(APK)) throw new Error('usage: node android/ci/smoke.js <debug apk>');
  makeMedia();
  const server = await serveMedia();
  adb('install', '-r', APK);
  adb('shell', 'pm', 'clear', PKG);   // a first run every time: no playlists from the run before
  try { adb('shell', 'appops', 'set', PKG, 'REQUEST_INSTALL_PACKAGES', 'allow'); } catch { /* the installer will ask */ }
  adb('logcat', '-c');
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  const page = await connectPage();
  const { ev } = page;
  const player = async () => JSON.parse(await ev('AGHorizonTV.playerState()'));
  const focus = () => ev(`(() => { const a = document.activeElement; return !a || a === document.body ? 'BODY' : (a.id ? '#' + a.id : a.tagName + '.' + String(a.className).split(' ')[0]) + ' ' + (a.dataset.uid || a.dataset.route || a.dataset.mode || a.dataset.cat || a.dataset.act || '').slice(0, 30); })()`);

  /* the app starts: its server (Node.js) answers, the page is in TV mode */
  check('the page loaded and is in TV mode', await until('TV mode', () => ev(`document.documentElement.classList.contains('tv') && typeof tvInit === 'function' && !!document.querySelector('#v-dashboard:not([hidden])')`)));
  const info = await ev(`JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent, shell: JSON.parse(AGHorizonTV.info()) })`);
  console.log('  page:', info);
  const dims = JSON.parse(info);
  check('the page is laid out about 1120 wide', Math.abs(dims.w - 1120) < 40, `${dims.w} × ${dims.h} at ${dims.dpr}`);
  const caps = await ev(`fetch('/api/capabilities').then((r) => r.json()).then(JSON.stringify)`);
  check('the app’s own server answers', /"ffmpeg":false/.test(caps), caps);
  await wait(1500);
  screenshot('first-run');
  check('first run: the focus is on “Add playlist”', /add-pl/.test(await focus()), await focus());

  /* the remote reaches the page */
  await ev(`window.__keys = []; window.addEventListener('keydown', (e) => window.__keys.push(e.key + '/' + e.keyCode), true); 0`);
  await key('DPAD_UP'); await key('DPAD_LEFT'); await key('DPAD_DOWN'); await key('DPAD_RIGHT');
  const keys = await ev(`window.__keys.join(' ')`);
  check('the arrows arrive as arrow keys', /ArrowUp.*ArrowLeft.*ArrowDown.*ArrowRight/.test(keys), keys);
  await ev(`document.querySelector('[data-act="add-pl"]').focus(); 0`);
  await key('DPAD_CENTER', 1200);
  check('OK opens what the focus is on', await ev(`!!document.querySelector('#addDlg[open]')`), 'keys: ' + await ev(`window.__keys.slice(4).join(' ')`));
  screenshot('add-playlist');
  // the dialog starts in a text box, which may bring up the TV's keyboard: Back then puts that away first
  await key('BACK', 1000);
  if (await ev(`!!document.querySelector('#addDlg[open]')`)) await key('BACK', 1000);
  check('Back closes the dialog', await ev(`!document.querySelector('#addDlg[open]')`));

  /* a playlist: fetched through the app's server */
  await ev(`(async () => { const p = { id: 'smoke', name: 'Smoke test', type: 'm3u', url: 'http://${HOST}:${PORT}/list.m3u', epgUrl: '', ua: '', added: Date.now() }; state.playlists.push(p); savePlaylists(); uiPlaylistsChanged(); await openWorkspace(p.id, 'live'); })()`);
  const counts = await until('the playlist', () => ev(`state.cache.smoke ? JSON.stringify({ live: state.cache.smoke.channels.length, movies: state.cache.smoke.movies.length }) : ''`));
  check('the playlist loads: 3 channels and a movie', counts === '{"live":3,"movies":1}', counts);
  await wait(1000);
  screenshot('live-tv');

  /* live TV in the TV's player: HLS */
  await ev(`(() => { ws.cat = 'Test'; renderLive(); })()`);
  await wait(800);
  await ev(`tvFocus(document.querySelector('#liveRows .row.ch')); 0`);
  await key('DPAD_CENTER', 500);
  let st = await until('HLS playing', async () => { const s = await player(); return s.playing && s.pos > 2 ? s : null; });
  check('a channel plays (HLS)', st, JSON.stringify(st || await player()));
  screenshot('playing-live');
  check('the player covers the page and shows the title', st && st.visible);

  /* ▼ changes channel: MPEG-TS with AC-3 sound, decoded by the ffmpeg that comes with the app */
  await wait(4500);   // the title is gone
  await key('DPAD_DOWN', 500);
  st = await until('the next channel playing', async () => { const s = await player(); return s.playing && s.pos > 2 && /ac3/.test(s.audio) ? s : null; });
  check('▼ changes channel (MPEG-TS, AC-3 sound)', st, JSON.stringify(st || await player()));
  check('AC-3 is decoded by the app’s ffmpeg', st && /ffmpeg/i.test(st.audioDecoder), st ? st.audioDecoder : '');
  check('the page knows which channel is on', await ev(`state.current && state.current.name`) === 'Channel Two', await ev(`state.current && state.current.name`));
  screenshot('playing-ac3');
  await key('DPAD_CENTER', 1200);
  check('OK brings up the player’s controls', (await player()).controls);
  screenshot('player-controls');
  await key('BACK', 800);
  check('Back hides the controls first', !(await player()).controls && (await player()).visible);
  await key('BACK', 1200);
  check('Back leaves the player', !(await player()).visible && await ev(`state.current === null`));
  await wait(1200);
  check('the focus is back on the channel that was on', /smoke:/.test(await focus()) && (await ev(`document.activeElement.querySelector('.name').textContent`)) === 'Channel Two', await focus());
  screenshot('after-player');

  /* a movie: plays, skips, remembers where it was */
  await ev(`(async () => { await openWorkspace('smoke', 'movie'); openDetail(ws.items[0]); })()`);
  await until('the movie page', () => ev(`!!document.querySelector('#wsDetail [data-act="play"]')`));
  await wait(800);
  check('a movie page: the focus is on Play', /play/.test(await focus()), await focus());
  screenshot('movie');
  await key('DPAD_CENTER', 500);
  st = await until('the movie playing', async () => { const s = await player(); return s.playing && s.pos > 1 ? s : null; });
  check('the movie plays (MP4)', st && st.dur > 170, JSON.stringify(st || await player()));
  await wait(4500);
  await key('DPAD_RIGHT', 300); await key('DPAD_RIGHT', 2500);   // 15 s each
  st = await player();
  check('▶ skips forward', st.pos > 30, `at ${st.pos} s`);
  await key('MEDIA_PLAY_PAUSE', 1500);
  check('play / pause pauses', !(await player()).playing);
  check('the controls are up while paused', (await player()).controls);
  screenshot('movie-controls');
  await key('BACK', 500); await key('BACK', 1500);
  if ((await player()).visible) await key('BACK', 1500);
  const saved = await ev(`JSON.stringify(state.progress['smoke:' + ws.items[0].id] || null)`);
  check('where the movie was is remembered', saved && JSON.parse(saved) && JSON.parse(saved).t > 30, saved);
  check('the button now says Resume', /Resume/.test(await ev(`document.querySelector('#wsDetail [data-act="play"]').textContent`)));
  await wait(1200);
  const before = await focus();
  await ev(`window.__keys = []; 0`);
  await key('DPAD_CENTER', 500);
  st = await until('the movie again', async () => { const s = await player(); return s.playing ? s : null; }, 30000);
  check('it resumes where it was', st && st.pos > 28, st ? `at ${st.pos} s` : `focus before: ${before}; now: ${await focus()}; keys: ${await ev(`window.__keys.join(' ')`)}; page focused: ${await ev(`document.hasFocus()`)}; playing: ${await ev(`state.current && state.current.name`)}; player: ${JSON.stringify(await player())}`);
  await key('BACK', 1200);
  if ((await player()).visible) await key('BACK', 1200);

  /* a new version: downloaded by the app, then Android's installer comes up (the "new version" here is the same APK) */
  fs.copyFileSync(APK, path.join(MEDIA, 'update.apk'));
  await ev(`(() => { const shell = window.tvUpdate; window.__upd = []; window.tvUpdate = (e) => { window.__upd.push(e.state + (e.message ? ': ' + e.message : '')); shell(e); }; AGHorizonTV.updateDownload('http://${HOST}:${PORT}/update.apk'); })()`);
  const got = await until('the update downloaded', async () => { const u = await ev(`window.__upd.join(' ')`); return /ready|error/.test(u) ? u : null; }, 120000);
  check('a new version downloads', got && /downloading.*ready$/.test(got), (got || '').replace(/(downloading )+/, 'downloading … '));
  await wait(2500);
  const resumed = () => adb('shell', 'dumpsys', 'activity', 'activities').split('\n').filter((l) => /ResumedActivity/.test(l)).join(' | ').trim();
  check('Android’s installer opens with it', /packageinstaller/i.test(resumed()), resumed().slice(0, 200));
  screenshot('installer');
  await key('BACK', 1500);
  if (!resumed().includes(PKG)) { await key('BACK', 1500); }
  if (!resumed().includes(PKG)) { adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`); await wait(2000); }
  check('the app is back after the installer was dismissed', resumed().includes(PKG) && await ev(`ui.route`) === 'ws', resumed().slice(0, 160));

  /* Back walks back through the app, and leaves it from the first page */
  await key('BACK', 900);
  check('Back closes the movie page', await ev(`ui.route === 'ws' && !ws.detail`));
  await ev(`go('dashboard', { push: false }); ui.hist.length = 0; 0`);
  await wait(800);
  screenshot('dashboard');
  await key('BACK', 500);
  check('Back on the first page asks first', adb('shell', 'dumpsys', 'activity', 'activities').includes(`${PKG}/.MainActivity`) && /Press Back again/.test(await ev(`document.querySelector('#toasts').textContent`)));
  await key('BACK', 2000);
  check('Back again leaves the app', !resumed().includes(PKG), resumed().slice(0, 160));

  page.close();
  server.close();
}

main().catch((e) => { check('the test ran to its end', false, e.stack || String(e)); }).finally(() => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const log = adb('logcat', '-d', '-v', 'time', 'AGHorizon:V', 'AGHorizonNode:V', 'AGHorizonWeb:V', 'AndroidRuntime:E', '*:S');
    fs.writeFileSync(path.join(OUT, 'logcat.txt'), adb('logcat', '-d', '-v', 'time'));
    // (the emulator's graphics driver chatters on the same output Node.js writes to)
    console.log('\n── the app’s log ──\n' + log.split('\n').filter((l) => l.trim() && !/s_glBindAttribLocation/.test(l)).slice(-40).map((l) => l.slice(0, 300)).join('\n'));
  } catch (e) { console.log('no logcat: ' + e.message); }
  const failed = results.filter((r) => !r.ok);
  console.log('\n── every check ──\n' + results.map((r) => r.line).join('\n'));
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? ': FAILED → ' + failed.map((f) => f.name).join('; ') : ''}`);
  process.exit(failed.length ? 1 : 0);
});
