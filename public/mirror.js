'use strict';
/* Mirror window: shows the MediaStream that the main AG Horizon window hands over. */
const $ = (id) => document.getElementById(id);
const v = $('v');
const msg = $('msg');
const titleEl = $('title');
const player = $('player');
let titleTimer = 0;
let ctlTimer = 0;

// The app's look, like its picture-in-picture window: theme and accent, and the icons (<use href="#i-…"> needs the
// sprite in this document).
// shortcut: copied once when the window opens, so a theme changed while it is open only shows the next time.
try {
  const app = window.opener.document;
  document.documentElement.style.cssText = app.documentElement.style.cssText;
  Object.assign(document.documentElement.dataset, app.documentElement.dataset);
  document.body.appendChild(app.querySelector('body > svg').cloneNode(true));
} catch { /* not opened from the app: said further down */ }

if (!new URLSearchParams(location.search).has('d')) {   // no monitor picked: the small window that stays on top
  document.body.classList.add('float');
  // Dragging the picture moves the window. Done here and not with -webkit-app-region: a drag region gets no
  // mouse events, so the controls could never appear on hover.
  let grab = null;
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, .m-volpop')) return;
    grab = { x: e.screenX - window.screenX, y: e.screenY - window.screenY };
    document.documentElement.setPointerCapture(e.pointerId);
  });
  document.addEventListener('pointermove', (e) => { if (grab) window.moveTo(e.screenX - grab.x, e.screenY - grab.y); });
  ['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, () => { grab = null; }));
}
const layout = () => player.classList.toggle('mini', window.innerWidth < 640);   // small looks like the mini player, as in picture-in-picture
window.addEventListener('resize', layout);
layout();

function updateMessage() {
  // Hide the hint as soon as a picture is showing (or audio-only is flowing).
  const hasVideo = v.videoWidth > 0 && v.readyState >= 2;
  msg.hidden = !!(v.srcObject && hasVideo);
}
let sound = 'main';        // where the sound plays, decided by the main window: 'main' | 'mirror' | 'both'
let userMuted = false;     // muted with the button in this window
function applySound() { v.muted = sound === 'main' || userMuted; if (!v.muted) v.play().catch(() => {}); }
window.setStream = (s, mode) => {
  v.srcObject = null;
  v.srcObject = s;
  sound = mode;
  applySound();
  v.play().catch(() => {});
  updateMessage();
};
window.setSound = (mode) => { sound = mode; applySound(); syncCtl(); };
window.clearStream = () => { v.srcObject = null; updateMessage(); };
window.setTitleText = (text) => {
  $('pTitle').textContent = titleEl.textContent = text || '';
  if (!text) { titleEl.classList.remove('show'); return; }
  titleEl.classList.add('show');
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => titleEl.classList.remove('show'), 4000);
};
['loadedmetadata', 'loadeddata', 'canplay', 'resize', 'emptied', 'playing', 'timeupdate'].forEach((e) => v.addEventListener(e, updateMessage));

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });   // Esc closes the mirror window
$('close').addEventListener('click', () => window.close());   // the ✕ on the floating window
// The controls (and the mouse pointer) show while the mouse moves over the window, as on the app's player.
document.addEventListener('mousemove', () => {
  player.classList.add('ctl-on');
  clearTimeout(ctlTimer);
  ctlTimer = setTimeout(() => { if (!player.querySelector('button:hover, input:hover')) player.classList.remove('ctl-on'); }, 2600);   // not while resting on a control
});
document.documentElement.addEventListener('mouseleave', () => { clearTimeout(ctlTimer); player.classList.remove('ctl-on'); openVol(false); });

/* ───────────────────────── controls on the floating window ───────────────────────── */
/*
 * Play, pause, skipping and seeking act on the player in the main window. Sound acts on whichever picture is
 * audible: the main window's, this one's, or both (Settings › Mirror picture › Sound plays on).
 */
const volBox = $('vol');
const volRange = $('mVolRange');
const seek = $('pcSeek');
let ctl = { on: false, paused: false, vod: false, muted: false, volume: 1, cur: 0, dur: 0 };   // the main player's state, pushed by setCtl
let seeking = false;       // the seek bar is being dragged: don't move it under the mouse
const main = (fn, ...args) => { try { return window.opener[fn](...args); } catch { return undefined; /* main window gone */ } };
const clock = (sec) => main('mirrorClock', sec) || '0:00';
const ownSound = () => sound !== 'main';
const isMuted = () => (ownSound() ? userMuted || v.volume === 0 : ctl.muted);
const setIcon = (id, name) => { const u = document.querySelector(`#${id} use`); if (u) u.setAttribute('href', '#' + name); };
const setFill = (el, frac) => el.style.setProperty('--fill', Math.max(0, Math.min(100, frac * 100)) + '%');
function syncCtl() {
  player.classList.toggle('empty', !ctl.on);
  player.classList.toggle('is-live', !ctl.vod);
  player.classList.toggle('paused', ctl.on && ctl.paused);
  setIcon('pcPlay', ctl.paused ? 'i-play' : 'i-pause');
  setIcon('mVol', isMuted() ? 'i-mute' : 'i-volume');
  const vol = isMuted() ? 0 : (ownSound() ? v.volume : ctl.volume);
  volRange.value = vol;
  setFill(volRange, vol);
  seek.disabled = !ctl.dur;
  if (!seeking) {
    seek.max = ctl.dur;
    seek.value = Math.min(ctl.cur, ctl.dur);
    setFill(seek, ctl.dur ? ctl.cur / ctl.dur : 0);
    $('pcCur').textContent = clock(ctl.cur);
  }
  $('pcDur').textContent = ctl.dur ? clock(ctl.dur) : '--:--';
}
window.setCtl = (s) => { ctl = s; syncCtl(); };
function muteTo(m) {
  if (sound !== 'mirror') main('mirrorSetMuted', m);
  if (ownSound()) { userMuted = m; if (!m && v.volume === 0) v.volume = 0.5; applySound(); }
  syncCtl();
}
function volumeTo(x) {
  if (sound !== 'mirror') main('mirrorSetVolume', x);
  if (ownSound()) { v.volume = x; userMuted = false; applySound(); }
  syncCtl();
}
function openVol(open) { volBox.classList.toggle('open', open); $('mVol').setAttribute('aria-expanded', open); }
$('pcPlay').addEventListener('click', () => main('togglePlay'));
$('pcBack').addEventListener('click', () => main('seekBy', -15));
$('pcFwd').addEventListener('click', () => main('seekBy', 15));
seek.addEventListener('input', () => { seeking = true; $('pcCur').textContent = clock(Number(seek.value)); setFill(seek, Number(seek.value) / (Number(seek.max) || 1)); });
seek.addEventListener('change', () => { seeking = false; main('seekTo', Number(seek.value)); });
// The speaker: the first press brings up the slider, a press while it is up mutes or unmutes.
$('mVol').addEventListener('click', () => { if (volBox.classList.contains('open')) muteTo(!isMuted()); else openVol(true); });
volRange.addEventListener('input', () => volumeTo(Number(volRange.value)));
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#vol')) openVol(false); });

// Tell the main window we're ready, and notice if it goes away.
try { window.opener.tunerMirrorReady(window); } catch { msg.querySelector('strong').textContent = 'Open this window from AG Horizon (Mirror picture button).'; }
setInterval(() => {
  if (!window.opener || window.opener.closed) { msg.hidden = false; msg.querySelector('strong').textContent = 'The AG Horizon window was closed.'; v.srcObject = null; }
}, 1500);
