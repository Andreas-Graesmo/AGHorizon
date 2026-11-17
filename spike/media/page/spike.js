'use strict';
/* Phase 0.1 media spike: what this webview can play, through the same paths AG Horizon uses (public/js/player.js). */

const $ = (s) => document.querySelector(s);
const enc = encodeURIComponent;
const FX = `${location.origin}/spike/fx/`;
const results = [];
let muted = false;   // becomes true if the webview refuses unmuted autoplay
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ONLY = (new URLSearchParams(location.search).get('only') || '').split(',').filter(Boolean);
const wanted = (label) => !ONLY.length || ONLY.some((o) => label.includes(o));
function record(group, name, status, note = '', detail = undefined) {
  const t = { group, name, status, note, detail };
  results.push(t);
  const tr = document.createElement('tr');
  tr.innerHTML = `<td class="s ${status}">${status}</td><td>${group}</td><td>${name}</td><td>${note}</td>`;
  $('#log').appendChild(tr);
  if (status !== 'info') fetch('/spike/progress', { method: 'POST', body: `${status}  ${group} / ${name}  ${note}` }).catch(() => {});
  return t;
}

function newVideo() {
  const v = document.createElement('video');
  v.playsInline = true;
  v.muted = muted;
  v.autoplay = false;
  $('#stage').appendChild(v);
  return v;
}
function dispose(v) {
  try { v.pause(); v.removeAttribute('src'); v.srcObject = null; v.load(); } catch { /* ignore */ }
  v.remove();
}

async function startPlay(v) {
  try { await v.play(); } catch (e) {
    if (e && e.name === 'NotAllowedError' && !v.muted) { v.muted = true; await v.play().catch(() => {}); } // still check the picture
  }
}

// Resolves when the clock has moved minAdvance seconds and there is a picture; rejects on error / timeout.
function watch(v, { timeout = 20000, minAdvance = 1.5 } = {}) {
  return new Promise((resolve, reject) => {
    let t0 = null;
    let f0 = null;
    const frames = () => (v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : null);
    const started = performance.now();
    const done = (fn, arg) => { clearInterval(iv); clearTimeout(to); v.removeEventListener('error', onErr); fn(arg); };
    const onErr = () => done(reject, new Error(`media error ${v.error ? `${v.error.code} ${v.error.message || ''}` : ''}`.trim()));
    v.addEventListener('error', onErr);
    const iv = setInterval(() => {
      if (v.readyState >= 2 && t0 == null) { t0 = v.currentTime; f0 = frames(); }
      const moved = t0 != null && (v.currentTime - t0 >= minAdvance || (f0 != null && frames() - f0 >= minAdvance * 25));
      if (moved && v.videoWidth > 0) {
        done(resolve, {
          ms: Math.round(performance.now() - started),
          size: `${v.videoWidth}x${v.videoHeight}`,
          audioBytes: typeof v.webkitAudioDecodedByteCount === 'number' ? v.webkitAudioDecodedByteCount : null,
          videoBytes: typeof v.webkitVideoDecodedByteCount === 'number' ? v.webkitVideoDecodedByteCount : null,
          audioTracks: v.audioTracks ? v.audioTracks.length : null,
          frames: frames(),
          muted: v.muted,
        });
      }
    }, 100);
    const to = setTimeout(() => done(reject, new Error(`timeout (readyState ${v.readyState}, t=${v.currentTime.toFixed(2)}, ${v.videoWidth}x${v.videoHeight}, frames ${frames()})`)), timeout);
  });
}

// WebKit has no webkitAudioDecodedByteCount: listen to the element instead (every fixture has a 440/880 Hz tone).
let actx = null;
async function soundLevel(v, ms = 700) {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state !== 'running') await Promise.race([actx.resume(), sleep(500)]);
    if (actx.state !== 'running') return { level: null, why: `AudioContext ${actx.state}` };
    const src = actx.createMediaElementSource(v);
    const an = actx.createAnalyser(); an.fftSize = 2048;
    src.connect(an); an.connect(actx.destination);
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) { an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); await sleep(50); }
    return { level: peak };
  } catch (e) { return { level: null, why: e.message }; }
}
async function addSound(v, r) {
  if (r.audioBytes != null || v.muted) return r;
  const s = await soundLevel(v);
  r.audioLevel = s.level;
  if (s.level != null) r.audioBytes = s.level > 0.01 ? -1 : 0;   // -1: heard (no byte count available)
  else r.soundWhy = s.why;
  return r;
}

// Every fixture has sound: a picture with no decoded sound is only a partial success.
const okStatus = (r) => (r.audioBytes === 0 ? 'part' : 'pass');
function playNote(r, extra = '') {
  const snd = r.audioBytes == null ? `sound ?${r.soundWhy ? ` (${r.soundWhy})` : ''}` : r.audioBytes === -1 ? `sound heard (peak ${r.audioLevel.toFixed(2)})` : r.audioBytes > 0 ? 'sound decoded' : 'NO SOUND decoded';
  return `${r.size}, ${snd}${r.muted ? ', muted' : ''}, ${r.ms} ms${extra ? `, ${extra}` : ''}`;
}

/* ------------------------------------------------------------- capabilities */

function capabilities() {
  const G = 'caps';
  const v = document.createElement('video');
  const mse = window.MediaSource || window.ManagedMediaSource;
  const types = {
    'mp4 H.264+AAC': 'video/mp4; codecs="avc1.64001f, mp4a.40.2"',
    'mp4 HEVC hvc1 (app hevcOk string)': 'video/mp4; codecs="hvc1.2.4.L153.B0"',
    'mp4 HEVC hev1': 'video/mp4; codecs="hev1.1.6.L93.B0"',
    'mp4 AC-3': 'audio/mp4; codecs="ac-3"',
    'mp4 E-AC-3': 'audio/mp4; codecs="ec-3"',
    'webm VP9+Opus': 'video/webm; codecs="vp9, opus"',
    'matroska H.264': 'video/x-matroska; codecs="avc1.64001f, mp4a.40.2"',
    'matroska HEVC': 'video/x-matroska; codecs="hvc1.2.4.L153.B0"',
    'mpeg-ts': 'video/mp2t',
    'HLS': 'application/vnd.apple.mpegurl',
  };
  const out = {};
  for (const [k, t] of Object.entries(types)) {
    const native = v.canPlayType(t) || 'no';
    let ms = 'n/a';
    try { ms = mse ? String(mse.isTypeSupported(t)) : 'no MSE'; } catch { ms = 'throws'; }
    out[k] = { canPlayType: native, mse: ms };
    record(G, `type: ${k}`, 'info', `canPlayType=${native}, MSE=${ms}`);
  }
  const flags = {
    MediaSource: !!window.MediaSource,
    ManagedMediaSource: !!window.ManagedMediaSource,
    'Hls.isSupported()': !!(window.Hls && Hls.isSupported()),
    'mpegts.isSupported()': !!(window.mpegts && mpegts.isSupported()),
    'mpegts MSE live playback': !!(window.mpegts && mpegts.getFeatureList().mseLivePlayback),
    'HTMLMediaElement.captureStream': typeof v.captureStream === 'function',
    'HTMLCanvasElement.captureStream': typeof HTMLCanvasElement.prototype.captureStream === 'function',
    'video.requestPictureInPicture': typeof v.requestPictureInPicture === 'function',
    'document.pictureInPictureEnabled': !!document.pictureInPictureEnabled,
    'webkitSupportsPresentationMode': typeof v.webkitSupportsPresentationMode === 'function',
    documentPictureInPicture: 'documentPictureInPicture' in window,
    'video.audioTracks': 'audioTracks' in v,
    'navigator.wakeLock': 'wakeLock' in navigator,
    mediaSession: 'mediaSession' in navigator,
    'navigator.clipboard': !!navigator.clipboard,
    'document.fullscreenEnabled': !!document.fullscreenEnabled,
    'webkitRequestFullscreen': typeof v.webkitRequestFullscreen === 'function',
    isSecureContext: window.isSecureContext,
    Worker: typeof Worker === 'function',
    'window.__TAURI__': !!window.__TAURI__,
  };
  for (const [k, val] of Object.entries(flags)) record(G, k, 'info', String(val));
  return { types: out, flags };
}

/* ------------------------------------------------------------- playback paths */

async function nativeTest(name, file, extraCheck) {
  const v = newVideo();
  try {
    v.src = FX + file;
    startPlay(v);
    const r = await addSound(v, await watch(v));
    const extra = extraCheck ? extraCheck(v, r) : '';
    record('native', name, okStatus(r), playNote(r, extra), r);
  } catch (e) { record('native', name, 'fail', e.message); } finally { dispose(v); }
}

async function autoplayTest() {
  const v = document.createElement('video');
  v.src = FX + 'h264_aac.mp4';
  $('#stage').appendChild(v);
  try {
    await v.play();
    record('autoplay', 'unmuted play() without a user gesture', 'pass', 'allowed');
  } catch (e) {
    muted = true;
    record('autoplay', 'unmuted play() without a user gesture', 'fail', `${e.name}: ${e.message} — the rest of the tests run muted`);
  } finally { dispose(v); }
}

async function hlsJsTest(name, file) {
  if (!(window.Hls && Hls.isSupported())) return record('hls.js', name, 'skip', 'Hls.isSupported() is false');
  const v = newVideo();
  const h = new Hls({ maxBufferLength: 30, liveSyncDurationCount: 3, manifestLoadingMaxRetry: 1, fragLoadingMaxRetry: 3 });
  let codecs = '';
  let fatal = null;
  try {
    h.on(Hls.Events.BUFFER_CODECS, (_e, d) => { codecs = `video=${d.video && d.video.codec}, audio=${d.audio && d.audio.codec}`; });
    h.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) fatal = d.details; });
    // the app's live path: through /api/stream, which rewrites the playlist so segments are proxied too
    h.loadSource(`${location.origin}/api/stream?url=${enc(FX + file)}`);
    h.attachMedia(v);
    h.on(Hls.Events.MANIFEST_PARSED, () => startPlay(v));
    const r = await addSound(v, await watch(v));
    record('hls.js', name, okStatus(r), playNote(r, codecs), r);
  } catch (e) { record('hls.js', name, 'fail', `${fatal ? `fatal ${fatal}; ` : ''}${e.message}${codecs ? `; ${codecs}` : ''}`); } finally { try { h.destroy(); } catch { /* */ } dispose(v); }
}

async function nativeHlsTest() {
  const v = document.createElement('video');
  if (!v.canPlayType('application/vnd.apple.mpegurl')) return record('native', 'HLS (native, via /api/stream)', 'skip', 'canPlayType(m3u8) is empty');
  const w = newVideo();
  try {
    w.src = `${location.origin}/api/stream?url=${enc(FX + 'hls/index.m3u8')}`;
    startPlay(w);
    const r = await addSound(w, await watch(w));
    record('native', 'HLS (native, via /api/stream)', okStatus(r), playNote(r), r);
  } catch (e) { record('native', 'HLS (native, via /api/stream)', 'fail', e.message); } finally { dispose(w); }
}

function mpegtsPlayer(v, file) {
  const p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: `${location.origin}/api/stream?url=${enc(`${FX}${file}?live=1`)}` },
    { enableWorker: true, liveBufferLatencyChasing: true, lazyLoadMaxDuration: 60 });
  p.attachMediaElement(v);
  return p;
}
function killPlayer(p) { try { p.pause(); p.unload(); p.detachMediaElement(); p.destroy(); } catch { /* */ } }

async function mpegtsTest(name, file) {
  if (!(window.mpegts && mpegts.isSupported())) return record('mpegts.js', name, 'skip', 'mpegts.isSupported() is false');
  const v = newVideo();
  let p;
  let info = '';
  let err = null;
  try {
    p = mpegtsPlayer(v, file);
    p.on(mpegts.Events.MEDIA_INFO, (mi) => { info = `video=${mi.videoCodec}, audio=${mi.audioCodec}`; });
    p.on(mpegts.Events.ERROR, (type, detail) => { err = `${type}/${detail}`; });
    p.load();
    startPlay(v);
    const r = await addSound(v, await watch(v));
    record('mpegts.js', name, okStatus(r), playNote(r, info), r);
  } catch (e) { record('mpegts.js', name, 'fail', `${err ? `${err}; ` : ''}${e.message}${info ? `; ${info}` : ''}`); } finally { if (p) killPlayer(p); dispose(v); }
}

// The same N pictures without MSE (progressive mp4) and with hls.js: tells a media-stack limit from an mpegts.js one.
async function multiviewOther(n, kind) {
  const name = `${n} ${kind} pictures at once`;
  if (kind === 'hls.js' && !(window.Hls && Hls.isSupported())) return record('multiview', name, 'skip', 'no hls.js');
  const vs = []; const hs = [];
  try {
    for (let i = 0; i < n; i++) {
      const v = newVideo(); vs.push(v);
      if (kind === 'native mp4') v.src = `${FX}h264_aac.mp4?n=${i}`;
      else { const h = new Hls(); hs.push(h); h.loadSource(`${location.origin}/api/stream?url=${enc(FX + 'hls/index.m3u8')}&n=${i}`); h.attachMedia(v); }
    }
    vs.forEach((v) => startPlay(v));
    const rs = await Promise.allSettled(vs.map((v) => watch(v, { timeout: 30000 })));
    const ok = rs.filter((r) => r.status === 'fulfilled').length;
    const why = rs.map((r, i) => (r.status === 'rejected' ? `#${i + 1}: ${r.reason.message}` : '')).filter(Boolean).join('; ');
    record('multiview', name, ok === n ? 'pass' : 'fail', `${ok}/${n} playing${why ? ` — ${why}` : ''}`);
  } finally { hs.forEach((h) => { try { h.destroy(); } catch { /* */ } }); vs.forEach(dispose); }
}

async function multiviewTest(n) {
  if (!(window.mpegts && mpegts.isSupported())) return record('multiview', `${n} mpegts.js pictures at once`, 'skip', 'no mpegts.js');
  const vs = [];
  const ps = [];
  try {
    const errs = [];
    for (let i = 0; i < n; i++) {
      const v = newVideo(); vs.push(v);
      const p = mpegtsPlayer(v, 'h264_aac.ts'); ps.push(p);
      p.on(mpegts.Events.ERROR, (type, detail, info) => { errs[i] = `${type}/${detail}${info && info.msg ? ` ${info.msg}` : ''}`; });
      p.load();
    }
    vs.forEach((v) => startPlay(v));
    const rs = await Promise.allSettled(vs.map((v) => watch(v, { timeout: 30000 })));
    const ok = rs.filter((r) => r.status === 'fulfilled').length;
    const why = rs.map((r, i) => (r.status === 'rejected' ? `#${i + 1}: ${r.reason.message}${errs[i] ? ` [${errs[i]}]` : ''}` : '')).filter(Boolean).join('; ');
    record('multiview', `${n} mpegts.js pictures at once`, ok === n ? 'pass' : 'fail', `${ok}/${n} playing${why ? ` — ${why}` : ''}`);
  } finally { ps.forEach(killPlayer); vs.forEach(dispose); }
}

/* ------------------------------------------------------------- compatibility mode (/api/transcode) */

const hevcOk = (() => { try { return MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L153.B0"'); } catch { return false; } })();

async function transcodeTest(name, file, mode, extra = '') {
  const v = newVideo();
  try {
    v.src = `${location.origin}/api/transcode?url=${enc(FX + file)}&video=${mode}${extra}`;
    startPlay(v);
    const r = await addSound(v, await watch(v, { timeout: 30000 }));
    record('transcode', name, okStatus(r), playNote(r), r);
  } catch (e) { record('transcode', name, 'fail', e.message); } finally { dispose(v); }
}

// The same conversion fed through MSE (fetch → SourceBuffer) instead of <video src>: the candidate fix for a webview
// whose progressive player refuses a stream without byte ranges (Accept-Ranges: none, no length).
async function transcodeMseTest(name, file, mode) {
  const MS = window.ManagedMediaSource || window.MediaSource;
  const type = 'video/mp4; codecs="avc1.64001e, mp4a.40.2"';
  if (!MS || !MS.isTypeSupported(type)) return record('transcode', name, 'skip', 'no MSE for fMP4 H.264+AAC');
  const v = newVideo();
  const ac = new AbortController();
  try {
    const ms = new MS();
    if (window.ManagedMediaSource && MS === window.ManagedMediaSource) v.disableRemotePlayback = true;   // required for ManagedMediaSource
    v.src = URL.createObjectURL(ms);
    await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
    const sb = ms.addSourceBuffer(type);
    sb.mode = 'sequence';
    (async () => {
      const r = await fetch(`${location.origin}/api/transcode?url=${enc(FX + file)}&video=${mode}`, { signal: ac.signal });
      const rd = r.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) { if (ms.readyState === 'open') { while (sb.updating) await sleep(20); ms.endOfStream(); } return; }
        while (sb.updating) await sleep(20);
        sb.appendBuffer(value);
      }
    })().catch(() => {});
    startPlay(v);
    const r = await addSound(v, await watch(v, { timeout: 30000 }));
    record('transcode', name, okStatus(r), playNote(r), r);
  } catch (e) { record('transcode', name, 'fail', e.message); } finally { ac.abort(); dispose(v); }
}

// What player.js really does for an HEVC film: keep HEVC (Matroska) if MSE says hvc1 works, and on a media error
// convert the picture to H.264 instead (player.js video.onerror). Reports which way it ended up playing.
async function appHevcDecision() {
  const name = 'app logic: HEVC film → keep HEVC if hevcOk, else/after error H.264';
  let mode = hevcOk ? 'hevc' : 'h264';
  const path = [mode];
  for (;;) {
    const v = newVideo();
    try {
      v.src = `${location.origin}/api/transcode?url=${enc(FX + 'hevc_aac.mp4')}&video=${mode}`;
      startPlay(v);
      const r = await addSound(v, await watch(v, { timeout: 30000 }));
      return record('transcode', name, okStatus(r), `hevcOk=${hevcOk}; path ${path.join(' → ')}; ${playNote(r)}`, { ...r, path });
    } catch (e) {
      if (mode === 'hevc') { mode = 'h264'; path.push(`error (${e.message})`, 'h264'); continue; }
      return record('transcode', name, 'fail', `hevcOk=${hevcOk}; path ${path.join(' → ')}; ${e.message}`);
    } finally { dispose(v); }
  }
}

/* ------------------------------------------------------------- APIs the desktop shell relies on */

async function apiTests() {
  const G = 'shell';
  // capture stream: the mirror window gets the picture this way (player.js:586)
  const v = newVideo();
  try {
    v.src = FX + 'h264_aac.mp4';
    startPlay(v);
    await watch(v);
    if (typeof v.captureStream === 'function') {
      try { const s = v.captureStream(); record(G, 'video.captureStream() on a playing video', 'pass', `${s.getVideoTracks().length} video / ${s.getAudioTracks().length} audio tracks`); } catch (e) { record(G, 'video.captureStream() on a playing video', 'fail', e.message); }
    } else record(G, 'video.captureStream() on a playing video', 'fail', 'not available — Mirror picture cannot work as built');
    // the fallback the plan names for WebKit: draw the video on a canvas and capture that
    try {
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0, 320, 180);
      const px = ctx.getImageData(160, 90, 1, 1).data;
      const s = c.captureStream ? c.captureStream(25) : null;
      record(G, 'canvas.drawImage(video) + canvas.captureStream()', s ? 'pass' : 'fail', s ? `stream ok, ${s.getVideoTracks().length} track, pixel rgb(${px[0]},${px[1]},${px[2]})` : 'canvas.captureStream missing');
    } catch (e) { record(G, 'canvas.drawImage(video) + canvas.captureStream()', 'fail', e.message); }
    // these need a user gesture in browsers; recorded to see whether the webview enforces that
    try { await v.requestPictureInPicture(); record(G, 'requestPictureInPicture() without a gesture', 'info', 'opened'); await document.exitPictureInPicture().catch(() => {}); } catch (e) { record(G, 'requestPictureInPicture() without a gesture', 'info', `${e.name}: ${e.message}`); }
    try { await v.requestFullscreen(); record(G, 'element requestFullscreen() without a gesture', 'info', `opened; window ${innerWidth}x${innerHeight}, screen ${screen.width}x${screen.height}`); await document.exitFullscreen().catch(() => {}); } catch (e) { record(G, 'element requestFullscreen() without a gesture', 'info', `${e.name}: ${e.message}`); }
  } catch (e) { record(G, 'captureStream / PiP / fullscreen (needs mp4 playback)', 'fail', e.message); } finally { dispose(v); }

  try { const l = await Promise.race([navigator.wakeLock.request('screen'), sleep(5000).then(() => { throw new Error('no answer in 5 s'); })]); record(G, 'navigator.wakeLock.request("screen")', 'pass', 'granted'); await l.release(); } catch (e) { record(G, 'navigator.wakeLock.request("screen")', 'fail', e ? `${e.name}: ${e.message}` : 'missing'); }
  try {
    const r = await Promise.race([navigator.clipboard.writeText('ag-horizon spike').then(() => 'written'), sleep(5000).then(() => 'no answer in 5 s (a permission prompt?)')]);
    record(G, 'navigator.clipboard.writeText() without a gesture', r === 'written' ? 'pass' : 'info', r);
  } catch (e) { record(G, 'navigator.clipboard.writeText() without a gesture', 'info', e ? `${e.name}: ${e.message}` : 'missing'); }

  // /api reachable from this origin (the same-origin guard in server.js)
  try { const c = await (await fetch('/api/capabilities')).json(); record(G, 'GET /api/capabilities (same-origin guard)', c.ffmpeg ? 'pass' : 'fail', JSON.stringify(c)); } catch (e) { record(G, 'GET /api/capabilities (same-origin guard)', 'fail', e.message); }
  try { const p = await (await fetch(`/api/probe?url=${enc(FX + 'h264_ac3.ts')}`)).json(); record(G, 'GET /api/probe (ffmpeg)', p.video ? 'pass' : 'fail', `video=${p.video}, audio=${p.audio}`); } catch (e) { record(G, 'GET /api/probe (ffmpeg)', 'fail', e.message); }

  // Tauri IPC from the remote origin (capability remote.urls)
  const T = window.__TAURI__;
  if (!T) record(G, 'Tauri invoke from http://127.0.0.1:47831', 'skip', 'not running in Tauri');
  else {
    try { const r = await T.core.invoke('spike_ping', { msg: 'ping' }); record(G, 'Tauri invoke from http://127.0.0.1:47831', r === 'pong:ping' ? 'pass' : 'fail', String(r)); } catch (e) { record(G, 'Tauri invoke from http://127.0.0.1:47831', 'fail', String(e)); }
  }
}

/* ------------------------------------------------------------- run */

(async () => {
  $('#ua').textContent = navigator.userAgent;
  const started = Date.now();
  const caps = capabilities();
  const TESTS = [
    ['autoplay', autoplayTest],
    ['native mp4 h264', () => nativeTest('mp4 H.264 + AAC', 'h264_aac.mp4')],
    ['native mkv h264', () => nativeTest('mkv H.264 + AAC', 'h264_aac.mkv')],
    ['native mp4 hevc', () => nativeTest('mp4 HEVC + AAC', 'hevc_aac.mp4')],
    ['native mp4 ac3', () => nativeTest('mp4 H.264 + AC-3', 'h264_ac3.mp4')],
    ['native audiotracks', () => nativeTest('mp4 two AAC tracks (audioTracks)', 'h264_2aac.mp4', (v) => `audioTracks=${v.audioTracks ? v.audioTracks.length : 'n/a'}`)],
    ['native hls', nativeHlsTest],
    ['hlsjs', () => hlsJsTest('HLS H.264 + AAC via /api/stream', 'hls/index.m3u8')],
    ['mpegts h264', () => mpegtsTest('TS H.264 + AAC via /api/stream', 'h264_aac.ts')],
    ['mpegts hevc', () => mpegtsTest('TS HEVC + AAC via /api/stream', 'hevc_aac.ts')],
    ['mpegts ac3', () => mpegtsTest('TS H.264 + AC-3 via /api/stream', 'h264_ac3.ts')],
    ['mpegts eac3', () => mpegtsTest('TS H.264 + E-AC-3 via /api/stream', 'h264_eac3.ts')],
    ['multiview 2', () => multiviewTest(2)],
    ['multiview 4', () => multiviewTest(4)],
    ['mvnative 4', () => multiviewOther(4, 'native mp4')],
    ['mvhls 4', () => multiviewOther(4, 'hls.js')],
    ['tc copy', () => transcodeTest('copy: TS H.264 + AC-3 → fMP4 H.264 + AAC', 'h264_ac3.ts', 'copy')],
    ['tc h264', () => transcodeTest('h264: HEVC → fMP4 H.264 + AAC', 'hevc_aac.mp4', 'h264')],
    ['tc hevc mp4', () => transcodeTest('hevc: HEVC kept → Matroska HEVC + AAC', 'hevc_aac.mp4', 'hevc')],
    ['tc hevc ts', () => transcodeTest('hevc: HEVC from TS kept → Matroska', 'hevc_aac.ts', 'hevc')],
    ['tc app', appHevcDecision],
    ['tc mse copy', () => transcodeMseTest('copy via MSE: TS H.264 + AC-3 → fMP4 → SourceBuffer', 'h264_ac3.ts', 'copy')],
    ['tc mse h264', () => transcodeMseTest('h264 via MSE: HEVC → fMP4 → SourceBuffer', 'hevc_aac.mp4', 'h264')],
    ['shell', apiTests],
  ];
  for (const [label, fn] of TESTS) {
    if (!wanted(label)) continue;
    // a test that wedges the media stack is reported, and the run goes on
    const guard = sleep(90000).then(() => 'wedged');
    const r = await Promise.race([fn().then(() => 'ok', (e) => `threw ${e && e.message}`), guard]);
    if (r !== 'ok') record('harness', label, 'fail', r === 'wedged' ? 'test did not finish within 90 s (media stack wedged?)' : r);
    $('#stage').replaceChildren();
  }

  const counts = results.reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {});
  $('#status').textContent = `Done in ${Math.round((Date.now() - started) / 1000)} s — ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`;
  const payload = { ua: navigator.userAgent, platform: navigator.platform, at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), caps, tests: results };
  try { await fetch('/spike/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch { /* the page still shows them */ }
  window.__spikeDone = payload;
  if (window.__TAURI__ && new URLSearchParams(location.search).has('exit')) { try { await window.__TAURI__.core.invoke('spike_done'); } catch { /* */ } }
})();
