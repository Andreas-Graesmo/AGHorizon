'use strict';
/* Second-screen window: shows the MediaStream that the main AG Horizon window hands over. */
const v = document.getElementById('v');
const msg = document.getElementById('msg');
const titleEl = document.getElementById('title');
let titleTimer = 0;
let idleTimer = 0;

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

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}
document.addEventListener('dblclick', toggleFull);
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFull();
  else if (e.key === 'Escape' && !document.fullscreenElement) window.close();   // Esc closes the second screen
});
document.addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2000);
});

// Tell the main window we're ready, and notice if it goes away.
try { window.opener.tunerMirrorReady(window); } catch { msg.querySelector('strong').textContent = 'Open this window from AG Horizon (second-screen button).'; }
setInterval(() => {
  if (!window.opener || window.opener.closed) { msg.hidden = false; msg.querySelector('strong').textContent = 'The AG Horizon window was closed.'; v.srcObject = null; }
}, 1500);
