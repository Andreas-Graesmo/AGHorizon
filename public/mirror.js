'use strict';
/* Mirror window: shows the MediaStream that the main AG Horizon window hands over. */
const v = document.getElementById('v');
const msg = document.getElementById('msg');
const titleEl = document.getElementById('title');
let titleTimer = 0;
let idleTimer = 0;
if (!new URLSearchParams(location.search).has('d')) {   // no monitor picked: the small window that stays on top
  document.body.classList.add('float');
  // Dragging the picture moves the window. Done here and not with -webkit-app-region: a drag region gets no
  // mouse events, so the ✕ could never appear on hover.
  let grab = null;
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('#close')) return;
    grab = { x: e.screenX - window.screenX, y: e.screenY - window.screenY };
    document.documentElement.setPointerCapture(e.pointerId);
  });
  document.addEventListener('pointermove', (e) => { if (grab) window.moveTo(e.screenX - grab.x, e.screenY - grab.y); });
  ['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, () => { grab = null; }));
}

function updateMessage() {
  // Hide the hint as soon as a picture is showing (or audio-only is flowing).
  const hasVideo = v.videoWidth > 0 && v.readyState >= 2;
  msg.hidden = !!(v.srcObject && hasVideo);
}
window.setStream = (s, muted) => {
  v.srcObject = null;
  v.srcObject = s;
  v.muted = muted !== false;     // the main window decides where the sound plays
  v.play().catch(() => {});
  updateMessage();
};
window.setMuted = (muted) => { v.muted = !!muted; if (!muted) v.play().catch(() => {}); };
window.clearStream = () => { v.srcObject = null; updateMessage(); };
window.setTitleText = (text) => {
  titleEl.textContent = text || '';
  if (!text) { titleEl.classList.remove('show'); return; }
  titleEl.classList.add('show');
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => titleEl.classList.remove('show'), 4000);
};
['loadedmetadata', 'loadeddata', 'canplay', 'resize', 'emptied', 'playing', 'timeupdate'].forEach((e) => v.addEventListener(e, updateMessage));

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });   // Esc closes the mirror window
document.getElementById('close').addEventListener('click', () => window.close());   // the ✕ on the floating window
document.addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2000);
});

// Tell the main window we're ready, and notice if it goes away.
try { window.opener.tunerMirrorReady(window); } catch { msg.querySelector('strong').textContent = 'Open this window from AG Horizon (Mirror picture button).'; }
setInterval(() => {
  if (!window.opener || window.opener.closed) { msg.hidden = false; msg.querySelector('strong').textContent = 'The AG Horizon window was closed.'; v.srcObject = null; }
}, 1500);
