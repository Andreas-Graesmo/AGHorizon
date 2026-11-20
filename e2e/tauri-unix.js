#!/usr/bin/env node
'use strict';
/*
 * MIGRATION_PLAN.md 9.8: the Tauri app on Linux (the AppImage) and macOS (the .app) starts; its server answers with
 * the bundled ffmpeg; video plays in its WebKit (WebKitGTK with the GStreamer the AppImage bundles, or WKWebView), as
 * a plain <video> and through Media Source Extensions (the path hls.js and mpegts.js take); the native keep-awake
 * (9.6) answers the page; and closing it leaves nothing running.
 * A copy of the app is made and its page swapped for a test page that reports to a listener here; everything else
 * is the shipped app. The clips come from a server here (with byte ranges, as a provider's). Linux needs xvfb-run.
 * Usage: node e2e/tauri-unix.js <AppImage or .app> <ffmpeg to make the test clips>
 */
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const [bundle, ffmpeg] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!bundle || !ffmpeg) { console.error('usage: node e2e/tauri-unix.js <AppImage or .app> <ffmpeg>'); process.exit(2); }
const mac = bundle.endsWith('.app');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPORT_PORT = 47998, CLIP_PORT = 47997;

const PAGE = `<!doctype html><meta charset="utf-8"><title>AG Horizon</title><video id="v" muted playsinline></video><script>
const rep = (k, v) => fetch('http://127.0.0.1:${REPORT_PORT}/' + k + '?' + encodeURIComponent(JSON.stringify(v)), { mode: 'no-cors' });
const CLIPS = 'http://127.0.0.1:${CLIP_PORT}/';
const MS = window.ManagedMediaSource || window.MediaSource;
const CODECS = 'avc1.64001e,mp4a.40.2';
rep('support', { mse: !!MS, managed: !!window.ManagedMediaSource, avc: !!MS && MS.isTypeSupported('video/mp4; codecs="' + CODECS + '"') });
window.__TAURI__.core.invoke('keep_awake', { on: true })
  .then((r) => rep('keepawake', { held: r }), (e) => rep('keepawake', { err: String(e) }))
  .then(() => window.__TAURI__.core.invoke('keep_awake', { on: false })).catch(() => {});
const v = document.getElementById('v');
v.src = CLIPS + 'plain.mp4';
v.onerror = () => rep('plain', { err: v.error && v.error.code, msg: v.error && v.error.message });
v.play().catch((e) => rep('plain', { exc: String(e) }));
setTimeout(() => rep('plain', { t: v.currentTime, w: v.videoWidth }), 6000);
(async () => {
  try {
    const buf = await (await fetch(CLIPS + 'frag.mp4')).arrayBuffer();
    const m = new MS(); const v2 = document.createElement('video'); v2.muted = true; document.body.append(v2);
    if (window.ManagedMediaSource && MS === window.ManagedMediaSource) v2.disableRemotePlayback = true;
    v2.src = URL.createObjectURL(m);
    await new Promise((r) => m.addEventListener('sourceopen', r, { once: true }));
    const sb = m.addSourceBuffer('video/mp4; codecs="' + CODECS + '"');
    sb.appendBuffer(buf); await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
    await v2.play();
    setTimeout(() => rep('mse', { t: v2.currentTime, w: v2.videoWidth }), 4000);
  } catch (e) { rep('mse', { exc: String(e) }); }
})();
// 4K HEVC HDR channels: the server keeps the picture as it is (fragmented MP4, hvc1) and WebKit's MSE decodes it,
// as the player does on a Mac (player.js tcVideoMode / tcUrl). Where the system can't decode HEVC, the player
// converts to H.264 instead: then only that is reported.
(async () => {
  const HEVC = 'video/mp4; codecs="hvc1.2.4.L153.B0, mp4a.40.2"';
  const supported = !!MS && MS.isTypeSupported(HEVC);
  if (!supported) { rep('hevc', { supported }); return; }
  try {
    const r = await fetch('/api/transcode?url=' + encodeURIComponent(CLIPS + 'hevc-hdr.ts') + '&video=hevc&fmt=mp4');
    const type = r.headers.get('content-type');
    const buf = await r.arrayBuffer();
    const m = new MS(); const v3 = document.createElement('video'); v3.muted = true; document.body.append(v3);
    if (window.ManagedMediaSource && MS === window.ManagedMediaSource) v3.disableRemotePlayback = true;
    v3.src = URL.createObjectURL(m);
    await new Promise((res) => m.addEventListener('sourceopen', res, { once: true }));
    const sb = m.addSourceBuffer(HEVC);
    sb.appendBuffer(buf); await new Promise((res, rej) => { sb.addEventListener('updateend', res, { once: true }); sb.addEventListener('error', rej, { once: true }); });
    await v3.play();
    setTimeout(() => rep('hevc', { supported, type, bytes: buf.byteLength, t: v3.currentTime, w: v3.videoWidth }), 3500);
  } catch (e) { rep('hevc', { supported, exc: String(e) }); }
})();
</script>
<script src="js/tauri-shell.js"></script>
<script>
// The Phase 2-3 gate (as e2e/tauri-windows.js): downloads, the sync code and folder, and a conversion running when the
// app is killed. A second start finds the downloaded film and clears the sync code.
(async () => {
  try {
    const td = window.tunerDesktop;
    const first = await td.downloads.list();
    const film = first.items.find((it) => it.title === 'E2E Film');
    if (film) {   // the start after the kill
      await td.sync.setCode('');
      rep('restart', { film: film.state, code: await td.sync.getCode() });
      return;
    }
    const events = [];
    td.downloads.onChange((st) => events.push(st));
    const added = await td.downloads.add([{ kind: 'movie', uid: 'e2e:movie:1', pid: null, url: CLIPS + 'plain.mp4', ext: 'mp4', title: 'E2E Film', year: '2024' }]);
    let done = null;
    for (let i = 0; i < 160 && !done; i++) {
      done = events.flatMap((e) => e.items).find((it) => it.state === 'done') || null;
      if (!done) await new Promise((r) => setTimeout(r, 250));
    }
    const local = done ? await fetch('/api/local/' + done.id) : null;
    const bytes = local ? (await local.arrayBuffer()).byteLength : 0;
    rep('downloads', { folder: first.folder, added, events: events.length, size: done && done.size, local: local && local.status, bytes });
    const sy = td.sync;
    const info = await sy.info();
    await sy.setCode('e2e-code-0123');
    const back = await sy.getCode();
    const vault = 'cd'.repeat(32), device = 'fedcba9876543210';
    const blob = new Uint8Array(4096); for (let i = 0; i < blob.length; i++) blob[i] = (i * 7) & 255;
    await sy.folderPut(vault, device, blob);
    const list = await sy.folderList(vault);
    const same = list.length === 1 && list[0].device === device && list[0].blob.length === blob.length && list[0].blob.every((b, i) => b === blob[i]);
    await sy.folderRemove(vault, device);
    rep('sync', { info, back, same, emptyAfter: (await sy.folderList(vault)).length === 0 });
    // a conversion of an endless live stream, read slowly: the server and its ffmpeg are busy when the app is killed
    const r = await fetch('/api/transcode?url=' + encodeURIComponent(CLIPS + 'live.ts') + '&video=h264');
    const reader = r.body.getReader();
    await reader.read();
    rep('converting', { status: r.status });
  } catch (e) { rep('gate', { exc: String(e) }); }
})();
</script>`;

// macOS: the scratch home has no login keychain (every real account has one). The app's Keychain calls look for
// $HOME/Library/Keychains/login.keychain-db when the account names no other default: make one, unlocked. Returns its
// path, for the test's own lookups (the security tool searches the account's list, not this home).
function scratchKeychain(env, home) {
  const kc = path.join(home, 'Library', 'Keychains', 'login.keychain-db');
  fs.mkdirSync(path.dirname(kc), { recursive: true });
  for (const a of [['create-keychain', '-p', 'e2e', kc], ['unlock-keychain', '-p', 'e2e', kc], ['set-keychain-settings', kc]]) {
    const r = require('child_process').spawnSync('security', a, { env, encoding: 'utf8' });
    console.log(`security ${a[0]}: ${r.status}${r.stderr ? ' ' + r.stderr.trim() : ''}`);
  }
  return kc;
}

// a static server with byte ranges and CORS
function clipServer(dir) {
  return http.createServer((q, r) => {
    const f = path.join(dir, path.basename(q.url.split('?')[0]));
    if (path.basename(f) === 'live.ts') {   // a live channel: loop.ts again and again, in real time, until hung up
      const data = fs.readFileSync(path.join(dir, 'loop.ts'));
      r.writeHead(200, { 'Content-Type': 'video/mp2t', 'Access-Control-Allow-Origin': '*' });
      let at = 0;
      const t = setInterval(() => { r.write(data.subarray(at, at + 32768)); at = (at + 32768) % data.length; }, 100);
      q.on('close', () => clearInterval(t));
      return;
    }
    if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
    const size = fs.statSync(f).size;
    const h = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
    const m = /bytes=(\d*)-(\d*)/.exec(q.headers.range || '');
    if (m) {
      const start = m[1] ? +m[1] : size - +m[2];
      const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
      r.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(f, { start, end }).pipe(r);
    } else {
      r.writeHead(200, { ...h, 'Content-Length': size });
      fs.createReadStream(f).pipe(r);
    }
  }).listen(CLIP_PORT, '127.0.0.1');
}

setTimeout(() => { console.error('timed out after 10 minutes'); process.exit(1); }, 10 * 60e3).unref();   // a hang fails in minutes

(async () => {
  // the real path: on macOS Tauri refuses to start from a path with a symlink in it, and /var (os.tmpdir()) is one
  const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agh-e2e-'));
  const home = path.join(work, 'home');
  const clips = path.join(work, 'clips');
  fs.mkdirSync(home); fs.mkdirSync(clips);

  // a copy of the app, its page swapped
  let root, pub, bins, launch;
  if (mac) {
    root = path.join(work, path.basename(bundle));
    execFileSync('cp', ['-R', bundle, root]);
    pub = path.join(root, 'Contents', 'Resources', 'public');
    bins = path.join(root, 'Contents', 'MacOS');
    launch = [path.join(bins, 'ag-horizon'), []];
  } else {
    fs.copyFileSync(bundle, path.join(work, 'app.AppImage'));
    fs.chmodSync(path.join(work, 'app.AppImage'), 0o755);
    execFileSync(path.join(work, 'app.AppImage'), ['--appimage-extract'], { cwd: work, stdio: 'ignore' });
    root = path.join(work, 'squashfs-root');
    pub = path.join(root, 'usr', 'lib', 'AG Horizon', 'public');
    bins = path.join(root, 'usr', 'bin');
    if (!fs.existsSync(path.join(root, 'usr', 'lib', 'gstreamer-1.0'))) throw new Error('GStreamer is not bundled');
    launch = ['xvfb-run', ['-a', path.join(root, 'AppRun')]];
  }
  if (!fs.existsSync(path.join(pub, 'index.html'))) throw new Error(`no page in the app at ${pub}`);
  for (const f of ['ag-horizon', 'aghorizon-server', 'ffmpeg']) {
    if (!fs.existsSync(path.join(bins, f))) throw new Error(`${f} is missing from the app (${bins})`);
  }
  fs.writeFileSync(path.join(pub, 'index.html'), PAGE);

  // H.264 High 3.0 + AAC: what a provider sends; once plain, once fragmented for MSE
  const clip = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=12',
    '-f', 'lavfi', '-i', 'sine=f=440:d=12', '-c:v', 'libx264', '-profile:v', 'high', '-level', '3.0', '-pix_fmt', 'yuv420p',
    '-g', '25', '-c:a', 'aac', '-shortest'];
  execFileSync(ffmpeg, [...clip, '-movflags', '+faststart', path.join(clips, 'plain.mp4')]);
  execFileSync(ffmpeg, [...clip, '-movflags', 'frag_keyframe+empty_moov+default_base_moof', path.join(clips, 'frag.mp4')]);
  // HEVC Main 10, PQ, E-AC-3 in MPEG-TS (.m2ts in the repo: node --test would take a .ts under test/ for TypeScript)
  fs.copyFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'hevc-hdr.m2ts'), path.join(clips, 'hevc-hdr.ts'));
  execFileSync(ffmpeg, [...clip, '-f', 'mpegts', path.join(clips, 'loop.ts')]);   // the live channel (live.ts) loops it
  const clipSrv = clipServer(clips);

  // the app's data folder (Tauri's app_data_dir): downloads and folder sync into folders of this test, as on Windows
  const dataDir = mac ? path.join(home, 'Library', 'Application Support', 'app.aghorizon.desktop') : path.join(home, '.local', 'share', 'app.aghorizon.desktop');
  const dlDir = path.join(work, 'Downloads'), cloudDir = path.join(work, 'Cloud');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'downloads.json'), JSON.stringify({ folder: dlDir, pauseWhileWatching: false, items: [] }));
  fs.writeFileSync(path.join(dataDir, 'sync.json'), JSON.stringify({ folder: cloudDir }));
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, '.local', 'share'), AGH_NO_DIALOG: '1' };
  const keychainFile = mac ? scratchKeychain(env, home) : '';
  // the sync code in the macOS Keychain, as the app put it there (keyring: service "AG Horizon", account "sync-code")
  const inKeychain = () => spawnSync('security', ['find-generic-password', '-s', 'AG Horizon', '-a', 'sync-code', keychainFile], { env }).status === 0;
  // this copy's processes: the app itself, its server, the ffmpeg the server runs
  const procs = () => {
    const lines = spawnSync('pgrep', ['-f', root]).stdout.toString().split('\n').filter(Boolean)
      .map((pid) => spawnSync('ps', ['-o', 'pid=,command=', '-p', pid]).stdout.toString().trim()).filter(Boolean);
    const of = (re) => lines.filter((l) => re.test(l));
    const server = of(/\/aghorizon-server(\s|$)/);
    // the app: the server's parent (on Linux its command line may not show the path it runs from)
    const ppid = server.length ? spawnSync('ps', ['-o', 'ppid=', '-p', server[0].split(/\s+/)[0]]).stdout.toString().trim() : '';
    const app = ppid && ppid !== '1' ? [spawnSync('ps', ['-o', 'pid=,command=', '-p', ppid]).stdout.toString().trim()].filter(Boolean) : [];
    return { app, server, ffmpeg: of(/\/ffmpeg\s/) };
  };

  const reports = {};
  const listener = http.createServer((q, r) => {
    const [k, v] = q.url.slice(1).split('?');
    try { reports[k] = JSON.parse(decodeURIComponent(v || '')); } catch { reports[k] = v; }
    console.log(`  page: ${k} ${decodeURIComponent(v || '')}`);
    r.end();
  }).listen(REPORT_PORT, '127.0.0.1');

  const log = fs.openSync(path.join(work, 'app.log'), 'w');
  const start = () => spawn(launch[0], launch[1], { env, stdio: ['ignore', log, log], detached: true });
  let app = start();
  const fail = [];
  const ok = [];
  try {
    let caps = null;
    for (let i = 0; i < 90 && !caps; i++) {
      await sleep(500);
      caps = await fetch('http://127.0.0.1:47831/api/capabilities').then((r) => r.json()).catch(() => null);
    }
    console.log('capabilities', JSON.stringify(caps));
    if (!caps) fail.push('the server never answered on 127.0.0.1:47831');
    else if (caps.ffmpeg !== true) fail.push('the server has no ffmpeg');

    for (let i = 0; i < 60 && !(reports.plain && reports.mse && reports.keepawake && (!mac || reports.hevc)); i++) await sleep(500);
    if (!reports.support || !reports.support.mse || !reports.support.avc) fail.push(`no MSE or no H.264 in MSE: ${JSON.stringify(reports.support)}`);
    const ka = reports.keepawake;
    if (!ka) fail.push('keep_awake: no answer');
    else if (ka.err && /not allowed|permission|not found|unknown/i.test(ka.err)) fail.push(`keep_awake is not reachable from the page: ${ka.err}`);
    // a Mac always has its power management to ask; a Linux runner may have no screensaver or logind
    else if (mac && ka.held !== true) fail.push(`keep_awake did not hold on macOS: ${JSON.stringify(ka)}`);
    // a Mac that can decode HEVC plays the kept picture; one that can't converts it instead (not this check)
    const hv = reports.hevc;
    if (mac && (!hv || (hv.supported && !(hv.t > 2 && hv.w === 640 && hv.type === 'video/mp4')))) fail.push(`kept HEVC through MSE: ${JSON.stringify(hv)}`);
    for (const k of ['plain', 'mse']) {
      const r = reports[k];
      if (!r || !(r.t > 2) || !(r.w > 0)) fail.push(`${k} playback: ${JSON.stringify(r)}`);
    }

    /* the Phase 2-3 gate, as e2e/tauri-windows.js checks it on Windows */
    for (let i = 0; i < 120 && !(reports.converting || reports.gate); i++) await sleep(500);
    if (reports.gate) fail.push(`gate page: ${JSON.stringify(reports.gate)}`);
    const clipSize = fs.statSync(path.join(clips, 'plain.mp4')).size;
    const dl = reports.downloads || {};
    const gate = (name, pass, detail) => (pass ? ok : fail).push(`${name}${pass ? '' : `: ${detail}`}`);
    gate('downloads: the folder from downloads.json', dl.folder === dlDir, dl.folder);
    gate('downloads: a film downloads, with progress events', dl.added === 1 && dl.size === clipSize && dl.events > 0, JSON.stringify(dl));
    gate('downloads: it plays back through /api/local', dl.local === 200 && dl.bytes === clipSize, JSON.stringify(dl));
    gate('downloads: in the Plex-style folder', fs.existsSync(path.join(dlDir, 'Movies', 'E2E Film (2024)', 'E2E Film (2024).mp4')), dlDir);
    const sy = reports.sync || {};
    gate('sync: the code saved and read back', sy.back === 'e2e-code-0123', JSON.stringify(sy));
    // macOS: the Keychain. Linux: the Secret Service where one runs, else a file in the data folder (a CI runner has none)
    if (mac) gate('sync: the code is in the macOS Keychain', sy.info && sy.info.keychain === true && inKeychain(), JSON.stringify(sy.info));
    else gate('sync: the code is in the Secret Service, or the file without one', sy.info && (sy.info.keychain === true || fs.existsSync(path.join(dataDir, 'sync-code'))), JSON.stringify(sy.info));
    gate('sync: folder files carry the bytes exactly', sy.same && sy.emptyAfter && sy.info && sy.info.folder === cloudDir, JSON.stringify(sy));

    // killed (the app's own process only, as a crash or Force Quit): its server and ffmpeg end with it
    const busy = procs();
    gate('server and ffmpeg running during a conversion', busy.app.length === 1 && busy.server.length === 1 && busy.ffmpeg.length >= 1, JSON.stringify(busy));
    const appPid = busy.app.length ? Number(busy.app[0].split(/\s+/)[0]) : 0;
    if (appPid) process.kill(appPid, 'SIGKILL');
    // gone, or ended and not yet reaped (on a Mac the app is this script's own child: a zombie until Node reaps it)
    const appAlive = () => { const st = spawnSync('ps', ['-o', 'stat=', '-p', String(appPid)]).stdout.toString().trim(); return st !== '' && !st.startsWith('Z'); };
    let after = procs();
    for (let i = 0; i < 20 && (after.server.length || after.ffmpeg.length || appAlive()); i++) { await sleep(500); after = procs(); }
    const appGone = appPid && !appAlive();
    gate('killed: its server and ffmpeg end with it', appGone && !after.server.length && !after.ffmpeg.length, JSON.stringify(after));
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}   // Linux: xvfb-run and its X server
    await sleep(2000);

    // started again (the port is free again): the downloaded film is still listed; clearing the code removes it
    app = start();
    for (let i = 0; i < 120 && !reports.restart; i++) await sleep(500);
    const rs = reports.restart || {};
    gate('starts again after the kill, and the finished film is still listed', rs.film === 'done', JSON.stringify(rs));
    gate('sync: clearing the code removes it', rs.code === '' && (mac ? !inKeychain() : !fs.existsSync(path.join(dataDir, 'sync-code'))), JSON.stringify(rs));
  } finally {
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(3000);
    listener.close();
    clipSrv.close();
  }
  // pgrep -f matches the copy's path (both systems; an exited process waiting to be reaped has no command line)
  const left = spawnSync('pgrep', ['-f', root]).stdout.toString().split('\n').filter(Boolean)
    .map((pid) => spawnSync('ps', ['-o', 'pid=,command=', '-p', pid]).stdout.toString().trim()).filter(Boolean);
  if (left.length) {
    fail.push(`still running after the app closed: ${left.join(' | ')}`);
    spawnSync('pkill', ['-9', '-f', root]);
  }
  for (const line of ok) console.log(`  ok   ${line}`);
  if (fail.length) {
    console.log('--- app log (tail) ---');
    console.log(fs.readFileSync(path.join(work, 'app.log'), 'utf8').split('\n').filter((l) => !/plugin loader failed|DRI3|accelerated rendering/.test(l)).slice(-40).join('\n'));
    console.error(`FAILED:\n  ${fail.join('\n  ')}`);
    process.exit(1);
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`OK: the ${mac ? '.app' : 'AppImage'} starts, has its ffmpeg, plays video (plain and MSE), keep-awake answers; downloads, the sync code and folder work; killed, it takes its server and ffmpeg along; it starts again; and nothing is left running`);
})().catch((e) => { console.error(e); process.exit(1); });
