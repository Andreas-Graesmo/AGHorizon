'use strict';
/* Phase 0.2 popup spike: can PiP and Mirror work as built (public/js/player.js, public/mirror.js) in a Tauri webview?
 * Runs every check once per window.open mode of the Tauri app (spike/media/tauri/src/main.rs):
 *   deny   — what Tauri does with no on_new_window handler (wry answers SetHandled(true), no window)
 *   allow  — WebView2's own popup window, not managed by Tauri
 *   create — a WebviewWindow built by Tauri (frameless, on top) and handed over with SetNewWindow
 */
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FX = `${location.origin}/spike/fx/`;
const results = [];
const T = window.__TAURI__;
const invoke = (cmd, args) => (T ? T.core.invoke(cmd, args) : Promise.reject(new Error('not in Tauri')));

function record(group, name, status, note = '', detail = undefined) {
  results.push({ group, name, status, note, detail });
  const tr = document.createElement('tr');
  tr.innerHTML = `<td class="${status}">${status}</td><td>${group}</td><td>${name}</td><td>${String(note).replace(/</g, '&lt;')}</td>`;
  $('#log').appendChild(tr);
  if (status !== 'info') fetch('/spike/progress', { method: 'POST', body: `${status}  ${group} / ${name}  ${note}` }).catch(() => {});
}
const guard = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what}: no answer in ${ms / 1000} s`); })]);

// A playing video in the main window, like the app's #video.
async function playingVideo() {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.loop = true;
  v.src = `${FX}h264_aac.mp4`;
  $('#stage').appendChild(v);
  await v.play();
  await guard(new Promise((r) => { const iv = setInterval(() => { if (v.currentTime > 0.5 && v.videoWidth) { clearInterval(iv); r(); } }, 100); }), 10000, 'main video');
  return v;
}
// Plays on (clock moves, picture there) in whichever document it is in now?
async function stillPlaying(v, ms = 2500) {
  const t0 = v.currentTime;
  await sleep(ms);
  return { moved: +(v.currentTime - t0).toFixed(2), w: v.videoWidth, paused: v.paused, inPopup: v.ownerDocument !== document };
}
const tauriWindows = async () => { try { return await invoke('popup_windows'); } catch { return null; } };

async function pipChecks(mode) {
  const G = `pip/${mode}`;
  const before = await tauriWindows();
  let w = null;
  try { w = window.open('about:blank', 'ag-horizon-pip'); } catch (e) { record(G, 'window.open(about:blank)', 'fail', `${e.name}: ${e.message}`); return; }
  if (!w) { record(G, 'window.open(about:blank)', mode === 'deny' ? 'info' : 'fail', 'returned null: the app shows "Picture-in-picture is not available."'); return; }
  record(G, 'window.open(about:blank)', 'pass', 'returned a window');

  // player.js:478-488: writes into the new document at once
  let d;
  try {
    d = w.document;
    const l = d.createElement('link'); l.rel = 'stylesheet'; l.href = `${location.origin}/style.css`; d.head.appendChild(l);
    d.body.appendChild(document.querySelector('body > svg').cloneNode(true));
    d.body.className = 'pip-body';
    d.title = 'PiP spike';
    record(G, 'write into w.document at once', 'pass', `body has ${d.body.childElementCount} element(s)`);
  } catch (e) { record(G, 'write into w.document at once', 'fail', `${e.name}: ${e.message}`); try { w.close(); } catch { /* */ } return; }

  // a late navigation of the new window would replace that document and lose the player moved into it
  await sleep(1500);
  try {
    const same = w.document === d && d.body.className === 'pip-body';
    record(G, 'document still there after 1.5 s', same ? 'pass' : 'fail', same ? 'same document' : 'replaced: content written at once is lost');
    if (!same) d = w.document;
  } catch (e) { record(G, 'document still there after 1.5 s', 'fail', `${e.name}: ${e.message}`); }

  // player.js movePlayer: let go of the source, move the element, start again
  const v = await playingVideo();
  try {
    const src = v.currentSrc, t = v.currentTime;
    v.removeAttribute('src'); v.load();
    d.body.appendChild(v);
    v.src = src;
    v.addEventListener('loadedmetadata', () => { v.currentTime = t; }, { once: true });
    v.play().catch(() => {});
    const r = await stillPlaying(v, 3000);
    const ok = r.inPopup && r.moved > 1 && r.w > 0;
    record(G, 'move the playing <video> into it (movePlayer)', ok ? 'pass' : 'fail', `in popup: ${r.inPopup}, clock moved ${r.moved} s, picture ${r.w}px, paused ${r.paused}`, r);
  } catch (e) { record(G, 'move the playing <video> into it (movePlayer)', 'fail', `${e.name}: ${e.message}`); }

  const during = await tauriWindows();
  if (during) {
    const mine = during.filter((x) => !(before || []).some((b) => b.label === x.label) && x.label !== 'main');
    if (mine.length) {
      const p = mine[0];
      record(G, 'Tauri window for it', 'info', `${p.label}: ${p.width}x${p.height}, decorated ${p.decorated}, on top ${p.always_on_top}, visible ${p.visible}`, p);
      if (mode.startsWith('create')) record(G, 'frameless + always on top (Electron PiP options)', !p.decorated && p.always_on_top ? 'pass' : 'fail', `decorated ${p.decorated}, on top ${p.always_on_top}`);
    } else record(G, 'Tauri window for it', 'info', 'none: WebView2 made its own window, which Tauri cannot frame, size or keep on top');
  }

  // player.js:500: the app moves the player back on 'pagehide' when the window closes
  let hid = false;
  try { w.addEventListener('pagehide', () => { hid = true; }); } catch { /* */ }
  try { w.close(); } catch (e) { record(G, 'close it', 'fail', e.message); }
  await sleep(1500);
  record(G, 'close: w.closed and pagehide', w.closed && hid ? 'pass' : 'fail', `closed ${w.closed}, pagehide fired ${hid}`);
  try { document.getElementById('stage').appendChild(v); v.pause(); v.remove(); } catch { /* */ }
  const after = await tauriWindows();
  if (after && during && mode.startsWith('create')) {
    const left = after.filter((x) => x.label !== 'main' && !(before || []).some((b) => b.label === x.label));
    record(G, 'Tauri window gone after close', left.length ? 'fail' : 'pass', left.length ? `still there: ${left.map((x) => `${x.label} visible ${x.visible}`).join(', ')} (leaks a window per PiP)` : `${during.length} → ${after.length} windows`, left);
    // the fix the plan takes: on pagehide the app asks Rust to destroy the window by its fixed label
    for (const x of left) {
      try { await invoke('popup_destroy', { label: x.label }); } catch (e) { record(G, 'fix: destroy from Rust on pagehide', 'fail', String(e)); }
    }
    if (left.length) {
      await sleep(500);
      const now = await tauriWindows();
      const still = now.filter((x) => left.some((l) => l.label === x.label));
      record(G, 'fix: destroy from Rust on pagehide', still.length ? 'fail' : 'pass', still.length ? 'window still there' : `gone (${now.length} window(s) left)`);
    }
  }
}

async function mirrorChecks(mode) {
  const G = `mirror/${mode}`;
  const v = await playingVideo();
  const got = { ready: false, openerDocument: null, frames: [], play: null };
  window.spikeMirrorReport = (k, val) => { if (k === 'frame') got.frames.push(val); else got[k] = val; };
  let mw = null;
  window.spikeMirrorReady = (w) => {   // player.js tunerMirrorReady: hand over a fresh capture
    got.ready = true; mw = w;
    try { w.setStream(v.captureStream()); } catch (e) { got.play = `setStream: ${e.message}`; }
  };
  let w = null;
  try { w = window.open('/spike/popup-mirror.html', 'tuner-mirror', 'popup=yes,width=960,height=540'); } catch (e) { record(G, 'window.open(/mirror.html)', 'fail', e.message); }
  if (!w) { record(G, 'window.open(/mirror.html)', mode === 'deny' ? 'info' : 'fail', 'returned null: the app says the pop-up was blocked'); v.remove(); return; }
  record(G, 'window.open(/mirror.html)', 'pass', 'returned a window');
  await sleep(5000);
  record(G, 'mirror page calls window.opener.tunerMirrorReady', got.ready ? 'pass' : 'fail', got.ready ? 'called' : 'never called: no opener, or the page did not load');
  record(G, 'mirror page reads window.opener.document', /^read/.test(got.openerDocument || '') ? 'pass' : 'fail', got.openerDocument || 'no report');
  const f = got.frames;
  const last = f[f.length - 1], first = f.find((x) => x.w > 0);
  const playing = last && first && last.w > 0 && last.t - first.t > 1;
  record(G, 'captureStream() picture shows in the mirror', playing ? 'pass' : 'fail', last ? `width ${last.w}, clock ${first ? (last.t - first.t).toFixed(1) : 0} s${got.play ? `, ${got.play}` : ''}` : 'no frames reported');

  const wins = await tauriWindows();
  const mine = wins && wins.find((x) => x.label !== 'main');
  if (mode.startsWith('create') && mine) {
    try { const r = await invoke('popup_fullscreen', { label: mine.label }); record(G, 'Rust: set_fullscreen on the mirror window (mirror to a monitor)', r ? 'pass' : 'fail', `is_fullscreen ${r}`); } catch (e) { record(G, 'Rust: set_fullscreen on the mirror window (mirror to a monitor)', 'fail', String(e)); }
  }
  if (mw && mw.spikeMoveTo) {
    try { const r = await mw.spikeMoveTo(50, 60); const moved = r.after[0] !== r.before[0] || r.after[1] !== r.before[1]; record(G, 'window.moveTo from the page (mirror.js drag)', moved ? 'pass' : 'info', `${r.before} → ${r.after}`); } catch (e) { record(G, 'window.moveTo from the page (mirror.js drag)', 'info', e.message); }
  }
  try { w.close(); } catch { /* */ }
  await sleep(800);
  if (mode.startsWith('create')) {
    const left = ((await tauriWindows()) || []).filter((x) => x.label === 'mirror');
    record(G, 'Tauri window gone after close', left.length ? 'fail' : 'pass', left.length ? `still there, visible ${left[0].visible}` : 'gone');
    if (left.length) {
      try { await invoke('popup_destroy', { label: 'mirror' }); } catch { /* */ }
      await sleep(500);
      const still = ((await tauriWindows()) || []).some((x) => x.label === 'mirror');
      record(G, 'fix: destroy from Rust on close', still ? 'fail' : 'pass', still ? 'window still there' : 'gone');
    }
  }
  v.remove();
}

(async () => {
  const started = Date.now();
  if (!T) record('setup', 'running in Tauri', 'fail', 'window.__TAURI__ missing: run this page in the spike app');
  try { const m = await invoke('monitors'); record('setup', 'monitors (display picker)', 'info', JSON.stringify(m)); } catch (e) { record('setup', 'monitors (display picker)', 'info', String(e)); }
  for (const mode of ['deny', 'allow', 'create', 'create-again']) {
    try { await invoke('popup_mode', { mode: mode.replace('-again', '') }); } catch (e) { record('setup', `popup_mode ${mode}`, 'fail', String(e)); continue; }
    for (const [name, fn] of [['pip', pipChecks], ['mirror', mirrorChecks]]) {
      const r = await Promise.race([fn(mode).then(() => 'ok', (e) => `threw ${e && e.message}`), sleep(60000).then(() => 'wedged')]);
      if (r !== 'ok') record('harness', `${name}/${mode}`, 'fail', r);
      $('#stage').replaceChildren();
    }
  }
  const counts = results.reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {});
  $('#status').textContent = `Done — ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`;
  const payload = { ua: navigator.userAgent, platform: navigator.platform, at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), caps: {}, tests: results };
  try { await fetch('/spike/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch { /* */ }
  if (T && new URLSearchParams(location.search).has('exit')) { try { await invoke('spike_done'); } catch { /* */ } }
})();
