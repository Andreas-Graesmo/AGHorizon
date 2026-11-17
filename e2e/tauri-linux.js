#!/usr/bin/env node
'use strict';
/*
 * MIGRATION_PLAN.md 9.8: the Linux AppImage starts, its server answers with the bundled ffmpeg, video plays in its
 * WebKitGTK through the GStreamer it bundles (a plain <video> and Media Source Extensions, the path hls.js and
 * mpegts.js take), the native keep-awake (9.6) answers the page, and closing it leaves nothing running.
 * The AppImage is unpacked and its page swapped for a test page that reports to a listener here; everything else is
 * the shipped app. Needs xvfb-run.
 * Usage: node e2e/tauri-linux.js <AppImage> <ffmpeg to make the test clips>
 */
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const [appImage, ffmpeg] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!appImage || !ffmpeg) { console.error('usage: node e2e/tauri-linux.js <AppImage> <ffmpeg>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPORT_PORT = 47998;

const PAGE = `<!doctype html><meta charset="utf-8"><title>AG Horizon</title><video id="v" muted playsinline></video><script>
const rep = (k, v) => fetch('http://127.0.0.1:${REPORT_PORT}/' + k + '?' + encodeURIComponent(JSON.stringify(v)), { mode: 'no-cors' });
const MS = window.ManagedMediaSource || window.MediaSource;
const CODECS = 'avc1.64001e,mp4a.40.2';
rep('support', { mse: !!MS, avc: !!MS && MS.isTypeSupported('video/mp4; codecs="' + CODECS + '"') });
// 9.6 the native keep-awake is reachable from the page (a CI runner may have no screensaver service to ask)
window.__TAURI__.core.invoke('keep_awake', { on: true })
  .then((r) => rep('keepawake', { held: r }), (e) => rep('keepawake', { err: String(e) }))
  .then(() => window.__TAURI__.core.invoke('keep_awake', { on: false })).catch(() => {});
const v = document.getElementById('v');
v.src = '/e2e-plain.mp4';
v.onerror = () => rep('plain', { err: v.error && v.error.code, msg: v.error && v.error.message });
v.play().catch((e) => rep('plain', { exc: String(e) }));
setTimeout(() => rep('plain', { t: v.currentTime, w: v.videoWidth }), 6000);
(async () => {
  try {
    const buf = await (await fetch('/e2e-frag.mp4')).arrayBuffer();
    const m = new MS(); const v2 = document.createElement('video'); v2.muted = true; document.body.append(v2);
    v2.src = URL.createObjectURL(m);
    await new Promise((r) => m.addEventListener('sourceopen', r, { once: true }));
    const sb = m.addSourceBuffer('video/mp4; codecs="' + CODECS + '"');
    sb.appendBuffer(buf); await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
    await v2.play();
    setTimeout(() => rep('mse', { t: v2.currentTime, w: v2.videoWidth }), 4000);
  } catch (e) { rep('mse', { exc: String(e) }); }
})();
</script>`;

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-appimage-'));
  const home = path.join(work, 'home');
  fs.mkdirSync(home);
  fs.copyFileSync(appImage, path.join(work, 'app.AppImage'));
  fs.chmodSync(path.join(work, 'app.AppImage'), 0o755);
  execFileSync(path.join(work, 'app.AppImage'), ['--appimage-extract'], { cwd: work, stdio: 'ignore' });
  const root = path.join(work, 'squashfs-root');
  const pub = path.join(root, 'usr', 'lib', 'AG Horizon', 'public');
  if (!fs.existsSync(path.join(pub, 'index.html'))) throw new Error(`no page in the AppImage at ${pub}`);
  for (const f of ['ag-horizon', 'aghorizon-server', 'ffmpeg']) {
    if (!fs.existsSync(path.join(root, 'usr', 'bin', f))) throw new Error(`usr/bin/${f} is missing from the AppImage`);
  }
  if (!fs.existsSync(path.join(root, 'usr', 'lib', 'gstreamer-1.0'))) throw new Error('GStreamer is not bundled');

  // H.264 High 3.0 + AAC: what a provider sends; once plain, once fragmented for MSE
  const clip = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=12',
    '-f', 'lavfi', '-i', 'sine=f=440:d=12', '-c:v', 'libx264', '-profile:v', 'high', '-level', '3.0', '-pix_fmt', 'yuv420p',
    '-g', '25', '-c:a', 'aac', '-shortest'];
  execFileSync(ffmpeg, [...clip, '-movflags', '+faststart', path.join(pub, 'e2e-plain.mp4')]);
  execFileSync(ffmpeg, [...clip, '-movflags', 'frag_keyframe+empty_moov+default_base_moof', path.join(pub, 'e2e-frag.mp4')]);
  fs.writeFileSync(path.join(pub, 'index.html'), PAGE);

  const reports = {};
  const listener = http.createServer((q, r) => {
    const [k, v] = q.url.slice(1).split('?');
    try { reports[k] = JSON.parse(decodeURIComponent(v || '')); } catch { reports[k] = v; }
    console.log(`  page: ${k} ${decodeURIComponent(v || '')}`);
    r.end();
  }).listen(REPORT_PORT, '127.0.0.1');

  const log = fs.openSync(path.join(work, 'app.log'), 'w');
  const app = spawn('xvfb-run', ['-a', path.join(root, 'AppRun')], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, '.local', 'share'), AGH_NO_DIALOG: '1' },
    stdio: ['ignore', log, log], detached: true,
  });
  const fail = [];
  try {
    let caps = null;
    for (let i = 0; i < 60 && !caps; i++) {
      await sleep(500);
      caps = await fetch('http://127.0.0.1:47831/api/capabilities').then((r) => r.json()).catch(() => null);
    }
    console.log('capabilities', JSON.stringify(caps));
    if (!caps) fail.push('the server never answered on 127.0.0.1:47831');
    else if (caps.ffmpeg !== true) fail.push('the server has no ffmpeg');

    for (let i = 0; i < 60 && !(reports.plain && reports.mse && reports.keepawake); i++) await sleep(500);
    if (!reports.support || !reports.support.mse || !reports.support.avc) fail.push(`no MSE or no H.264 in MSE: ${JSON.stringify(reports.support)}`);
    const ka = reports.keepawake;
    if (!ka) fail.push('keep_awake: no answer');
    else if (ka.err && /not allowed|permission|not found|unknown/i.test(ka.err)) fail.push(`keep_awake is not reachable from the page: ${ka.err}`);
    for (const k of ['plain', 'mse']) {
      const r = reports[k];
      if (!r || !(r.t > 2) || !(r.w > 0)) fail.push(`${k} playback: ${JSON.stringify(r)}`);
    }
  } finally {
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(3000);
    listener.close();
  }
  const left = spawnSync('pgrep', ['-fa', root]).stdout.toString().split('\n').filter((l) => l && !/defunct/.test(l));
  if (left.length) {
    fail.push(`still running after the app closed: ${left.join(' | ')}`);
    spawnSync('pkill', ['-9', '-f', root]);
  }
  if (fail.length) {
    console.log('--- app log (tail) ---');
    console.log(fs.readFileSync(path.join(work, 'app.log'), 'utf8').split('\n').filter((l) => !/plugin loader failed|DRI3|accelerated rendering/.test(l)).slice(-40).join('\n'));
    console.error(`FAILED:\n  ${fail.join('\n  ')}`);
    process.exit(1);
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log('OK: the AppImage starts, has its ffmpeg, plays video (plain and MSE) and leaves nothing running');
})().catch((e) => { console.error(e); process.exit(1); });
