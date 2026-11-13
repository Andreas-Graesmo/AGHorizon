'use strict';
/* AG Horizon – player: hls.js / mpegts.js / native, ffmpeg compatibility mode, custom seek bar, picture mirroring. */

const video = $('#video');
const overlay = $('#overlay');
let hlsPlayer = null;
let tsPlayer = null;
let playToken = 0;

/* Compatibility mode: the server converts the stream with ffmpeg (H.264 + AAC, fragmented MP4). */
const tcState = { on: false, vod: false, offset: 0, duration: 0, video: 'h264', subs: [], sid: '', audio: null };   // audio: which sound track (audio.js)
let checkTimer = 0;
let tcSeeking = false;
// A restart of the same video (another sound track, subtitles read from the stream): go on exactly here, not at the
// saved progress (which skips the first 10 s and isn't saved every second).
let resumeAt = null;
const compatMode = () => LS.get('tuner.compat', 'auto'); // 'auto' | 'always' | 'off'
// Each conversion also writes the stream's text subtitles (tcState.subs) under a new id, read by subtitles.js.
function tcUrl(ch, p, start) {
  tcState.sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const subs = tcState.subs && tcState.subs.length ? `&subs=${tcState.subs.join(',')}&sid=${tcState.sid}` : '';
  const audio = tcState.audio != null ? `&audio=${tcState.audio}` : '';
  return `${location.origin}/api/transcode?url=${enc(ch.url)}${uaParam(p)}&video=${tcState.video}${start > 0 ? `&start=${start.toFixed(3)}` : ''}${audio}${subs}`;
}
const curTime = () => (tcState.on && tcState.vod ? tcState.offset + video.currentTime : video.currentTime);
const durTime = () => (tcState.on && tcState.vod ? tcState.duration : video.duration);
// HEVC that the GPU can decode is kept as is: re-encoding 4K HEVC is slower than real time on most PCs.
const hevcOk = (() => { try { return MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L153.B0"'); } catch { return false; } })();
const tcVideoMode = (codec) => (codec === 'h264' ? 'copy' : codec === 'hevc' && hevcOk && LS.get('tuner.keepHevc', true) ? 'hevc' : 'h264');

// Copied video (and its sound) starts on the keyframe before t, up to a few seconds earlier.
// Ask where that is, so the clock shows where the picture really is.
async function tcStartAt(ch, p, t) {
  if (!(t > 0) || (tcState.video !== 'copy' && tcState.video !== 'hevc')) return t;
  try { const r = await fetch(`/api/keyframe?url=${enc(ch.url)}${uaParam(p)}&t=${t.toFixed(3)}`); if (r.ok) return (await r.json()).t; } catch { /* start at t */ }
  return t;
}

// Codecs per URL, so a video that is checked before playing isn't probed again when it's converted.
// quick: a live channel's sound tracks (audio.js), which a codec check made while playing doesn't have.
const probeCache = new Map();
async function probeOf(ch, p, { quick = false } = {}) {
  const hit = probeCache.get(ch.url);
  if (hit && (!quick || hit.audios)) return hit;
  let info = {};
  try { const r = await fetch(`/api/probe?url=${enc(ch.url)}${uaParam(p)}${quick ? '&quick=1' : ''}`); if (r.ok) info = await r.json(); } catch { /* unknown */ }
  if (info.video) probeCache.set(ch.url, info);
  return info;
}
const NATIVE_VIDEO = ['h264', 'vp8', 'vp9', 'av1'];
const NATIVE_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];
const playsNatively = (info) => (NATIVE_VIDEO.includes(info.video) || (info.video === 'hevc' && hevcOk))
  && (!info.audio || NATIVE_AUDIO.includes(info.audio) || info.audio.startsWith('pcm_'));
// …with the sound track audio.js wants (its codec, not just the first track's)
const playsNativelyWith = (ch, info) => (info.audios && info.audios.length
  ? (NATIVE_VIDEO.includes(info.video) || (info.video === 'hevc' && hevcOk)) && audNativeOk(ch)
  : playsNatively(info));

// Live streams can't be checked before playing without a second connection, but mpegts.js / hls.js know the
// codecs as soon as the first data arrives (codec strings like "ec-3", "hvc1.2.4.L150"). Convert right then
// instead of playing a few seconds without sound, and remember the codecs so the conversion needn't probe.
const BAD_AUDIO = /^(ac-3|ec-3|dts|dt[cehs]|mp4a\.a[56])/i;
const isHevcCodec = (c) => /^(hvc1|hev1)/i.test(c || '');
function earlyCodecCheck(ch, token, videoCodec, audioCodec, soundDropped = false) {
  if (token !== playToken || tcState.on || !state.ffmpeg || compatMode() === 'off') return;
  if (!soundDropped && !BAD_AUDIO.test(audioCodec || '') && !(isHevcCodec(videoCodec) && !hevcOk)) return;
  const vcodec = /^avc/i.test(videoCodec || '') ? 'h264' : isHevcCodec(videoCodec) ? 'hevc' : '';
  if (vcodec) probeCache.set(ch.url, { video: vcodec, audio: audioCodec, duration: 0 });
  setTimeout(() => { if (token === playToken && !tcState.on) startPlayback(ch, ['tc'], token); });   // not from inside the player's own event
}

function playPlan(ch) {
  const base = kindsFor(ch);
  if (!state.ffmpeg || compatMode() === 'off') return base;
  return compatMode() === 'always' ? ['tc'] : [...base, 'tc'];
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed ' + src));
    document.head.appendChild(s);
  });
}
const libPromises = {};
function ensureLib(globalName, sources) {
  if (window[globalName]) return Promise.resolve(true);
  return (libPromises[globalName] ||= (async () => {
    for (const src of sources) {
      try { await loadScript(src); if (window[globalName]) return true; } catch { /* try next */ }
    }
    return false;
  })());
}
const loadHls = () => ensureLib('Hls', ['vendor/hls.min.js', 'https://cdn.jsdelivr.net/npm/hls.js@1.7.4/dist/hls.min.js']);
const loadMpegts = () => ensureLib('mpegts', ['vendor/mpegts.js', 'https://cdn.jsdelivr.net/npm/mpegts.js@1.8.2/dist/mpegts.js']);

function teardown() {
  if (hlsPlayer) { try { hlsPlayer.destroy(); } catch { /* ignore */ } hlsPlayer = null; }
  if (tsPlayer) { try { tsPlayer.pause(); tsPlayer.unload(); tsPlayer.detachMediaElement(); tsPlayer.destroy(); } catch { /* ignore */ } tsPlayer = null; }
  clearTimeout(checkTimer);
  tcState.on = false;
  $('#tcBadge').hidden = true;
  video.onerror = null;
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function showOverlay(kind, title, text) {
  overlay.hidden = false;
  overlay.className = 'overlay' + (kind === 'error' ? ' error' : '');
  overlay.innerHTML = kind === 'loading'
    ? `<div><div class="spinner"></div><p>${esc(title)}</p></div>`
    : `<div><strong>${esc(title)}</strong><p>${esc(text || '')}</p><button class="btn small" data-copy>Copy stream link</button></div>`;
}
const hideOverlay = () => { overlay.hidden = true; };

async function copyLink(item, btn) {
  if (!item) return;
  try { await navigator.clipboard.writeText(item.url); if (btn) { const t = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = t; }, 1500); } } catch { prompt('Stream link', item.url); }
}
overlay.addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) copyLink(state.current, b); });

function kindsFor(ch) {
  if (isVod(ch)) return ['native'];
  const url = ch.url;
  const path = url.split('?')[0].toLowerCase();
  if (/\.m3u8?$/.test(path) || /m3u8/.test(url.toLowerCase())) return ['hls'];
  if (/\.(mp4|m4v|webm|mov)$/.test(path)) return ['native'];
  if (/\.mkv$/.test(path)) return ['native', 'ts'];
  if (/\.ts$/.test(path)) return ['ts'];
  return ['ts', 'hls'];
}

async function startPlayback(ch, kinds, token, lastError) {
  if (token !== playToken) return;
  const [kind, ...rest] = kinds;
  const p = playlistById(ch.pid);
  // full address: the player may be in the picture-in-picture window, whose about:blank page can't resolve "/api/…"
  const src = new URL(ch.local ? ch.url : proxied(ch.url, p), location.href).href;
  const fail = (msg) => {
    if (token !== playToken) return;
    if (rest.length) startPlayback(ch, rest, token, msg);
    else {
      const hint = !state.ffmpeg ? ' ffmpeg was not found, so unsupported codecs can’t be converted.'
        : compatMode() === 'off' ? ' Compatibility mode is switched off in Settings › Playback.' : '';
      if (isVod(ch)) showOverlay('error', "Couldn't play this video", `${msg}.${hint} The stream may be offline, or your provider’s connection limit may be used up. You can also copy the link and open it in VLC or mpv.`);
      else showOverlay('error', "Couldn't play this channel", `${msg}.${hint} The stream may be offline, or your subscription may have hit its connection limit.`);
    }
  };
  if (!kind) return fail(lastError || 'No playable format');
  teardown();
  showOverlay('loading', isVod(ch) ? 'Loading…' : 'Tuning in…');

  if (kind === 'hls') {
    if (!(await loadHls())) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = src; video.play().catch(() => {}); return; }
      return fail('The HLS player library could not be loaded');
    }
    if (token !== playToken) return;
    if (!Hls.isSupported()) { video.src = src; video.play().catch(() => {}); return; }
    let netRetries = 0;
    let mediaRetries = 0;
    hlsPlayer = new Hls({ maxBufferLength: 30, liveSyncDurationCount: 3, manifestLoadingMaxRetry: 1, fragLoadingMaxRetry: 3 });
    const h = hlsPlayer;
    h.loadSource(src);
    h.attachMedia(video);
    h.on(Hls.Events.MANIFEST_PARSED, (_e, d) => {
      const lv = (d.levels || [])[0];
      if (lv && lv.audioCodec) earlyCodecCheck(ch, token, lv.videoCodec, lv.audioCodec);   // from the playlist's CODECS, when it lists them
      if (token === playToken && !tcState.on) video.play().catch(() => {});
    });
    h.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => audFromHls(ch, h));   // a playlist per language: the sound button
    h.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_e, d) => { if (state.current === ch && aud.source === 'hls') { aud.cur = d.id; audRender(); } });
    h.on(Hls.Events.BUFFER_CODECS, (_e, d) => {
      // hls.js leaves out sound it can't play (AC-3 / E-AC-3 in MPEG-TS) instead of reporting it: picture but no
      // sound, with no separate audio playlist, means it was dropped. (A truly silent channel just gets its sound converted.)
      const dropped = !!d.video && !d.audio && !h.audioTracks.length;
      earlyCodecCheck(ch, token, d.video && d.video.codec, d.audio && d.audio.codec, dropped);
    });
    h.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal || token !== playToken) return;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR && d.details !== 'manifestParsingError' && ++netRetries <= 2) h.startLoad();
      else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && ++mediaRetries <= 2) h.recoverMediaError();
      else fail(`HLS error: ${d.details}`);
    });
  } else if (kind === 'ts') {
    if (!(await loadMpegts()) || !mpegts.isSupported()) return fail('The MPEG-TS player is not available in this browser');
    if (token !== playToken) return;
    // full address: mpegts.js fetches from a worker, which can't resolve "/api/stream…"
    tsPlayer = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: new URL(src, location.href).href }, { enableWorker: true, liveBufferLatencyChasing: true, lazyLoadMaxDuration: 60 });
    tsPlayer.attachMediaElement(video);
    tsPlayer.on(mpegts.Events.ERROR, (_t, detail) => fail(`Stream error: ${detail}`));
    tsPlayer.on(mpegts.Events.MEDIA_INFO, (mi) => earlyCodecCheck(ch, token, mi.videoCodec, mi.audioCodec));
    tsPlayer.load();
    tsPlayer.play().catch(() => {});
  } else if (kind === 'tc') {
    showOverlay('loading', 'Converting for playback…');
    const info = await probeOf(ch, p);   // nothing known: a full conversion
    if (token !== playToken) return;
    const vod = isVod(ch);
    const resume = progressOf(ch.uid);
    const dur = vod ? info.duration || 0 : 0;
    const start = vod && resumeAt != null ? resumeAt : vod && resume && !resume.w && resume.t > 10 && (!dur || dur - resume.t > 20) ? resume.t : 0;
    resumeAt = null;
    if (vod) await subAutoPlan(ch, info);   // Settings › Subtitles › turn on automatically (once per video)
    if (token !== playToken) return;
    Object.assign(tcState, { on: true, vod, offset: start, duration: dur, video: tcVideoMode(info.video), subs: vod ? (info.subs || []).map((s) => s.index) : [], audio: audTcTrack(ch, info) });
    const at = await tcStartAt(ch, p, start);
    if (token !== playToken) return;
    tcState.offset = at;
    $('#tcBadge').hidden = false;
    video.onerror = () => {
      if (token !== playToken) return;
      if (tcState.video !== 'hevc') return fail('The converted stream could not be played');
      tcState.video = 'h264';   // the HEVC decoder refused it after all: convert the picture too
      tcState.offset = tcState.vod ? curTime() : 0;
      video.src = tcUrl(ch, p, tcState.offset);
      video.play().catch(() => {});
    };
    video.src = tcUrl(ch, p, start);
    video.play().catch(() => {});
    subAfterTc(ch);   // a subtitle track of the stream picked automatically: read it from this conversion
    syncCtl();
  } else {
    // Movies and episodes: check first which sound (and subtitle) tracks they have, and whether they play as they
    // are with the sound wanted. Other links play straight away and are checked while playing.
    if (isVod(ch) && state.ffmpeg) {
      const info = await probeOf(ch, p);
      if (token !== playToken) return;
      audSetTracks(ch, info);
      const subNeedsTc = await subAutoPlan(ch, info);
      if (token !== playToken) return;
      if (rest.includes('tc') && info.video && (!playsNativelyWith(ch, info) || subNeedsTc || sub.stream)) return startPlayback(ch, ['tc'], token);
    } else if (isVod(ch)) {
      await subAutoPlan(ch, {});   // no ffmpeg: subtitles saved with a download can still go on
      if (token !== playToken) return;
    }
    video.src = src;
    video.onerror = () => fail(video.error && video.error.message ? video.error.message : 'The browser could not play this stream');
    const resume = progressOf(ch.uid);
    const at = resumeAt != null ? resumeAt : resume && !resume.w && resume.t > 10 ? resume.t : null;
    resumeAt = null;
    if (isVod(ch) && at != null) {
      video.addEventListener('loadedmetadata', () => { if (token === playToken && video.duration - at > (resume && at === resume.t ? 20 : 1)) video.currentTime = at; }, { once: true });
    }
    video.play().catch(() => {});
  }
}

// Some streams "play" but show no picture or have no sound (HEVC, DTS, AC-3). Detect that and convert.
function armCodecCheck() {
  clearTimeout(checkTimer);
  if (tcState.on || !state.ffmpeg || compatMode() === 'off' || !state.current) return;
  const token = playToken;
  const ch = state.current;
  checkTimer = setTimeout(() => {
    if (token !== playToken || tcState.on || video.paused) return;
    const noPicture = video.videoWidth === 0;
    const noSound = typeof video.webkitAudioDecodedByteCount === 'number' && video.webkitAudioDecodedByteCount === 0 && video.currentTime > 2;
    if (noPicture || noSound) startPlayback(ch, ['tc'], token);
  }, 4000);
}
video.addEventListener('playing', () => { hideOverlay(); armCodecCheck(); });
video.addEventListener('waiting', () => { if (state.current && !video.paused) showOverlay('loading', 'Buffering…'); });
video.addEventListener('canplay', hideOverlay);

// Remember where you stopped in movies / episodes; auto-advance to the next episode.
let lastSave = 0;
video.addEventListener('timeupdate', () => {
  const c = state.current;
  syncCtl();
  const dur = durTime();
  if (!c || (c.kind !== 'movie' && c.kind !== 'episode') || !isFinite(dur) || dur < 60) return;
  const now = Date.now();
  if (now - lastSave < 5000) return;
  lastSave = now;
  const t = curTime(), d = dur;
  state.progress[c.uid] = { t, d, w: d - t < Math.min(90, d * 0.04) ? 1 : 0, ts: now };
  persistProgress();
  if (ui.route === 'downloads') refreshProgressBars('#v-downloads');
});
video.addEventListener('pause', () => { if (state.current && isVod(state.current) && !video.ended) uiPlayback(); });
video.addEventListener('ended', () => {
  const c = state.current;
  if (!c || !isVod(c)) return;
  if (tcState.on && tcState.vod && tcState.duration && curTime() < tcState.duration - 15) {
    showOverlay('error', 'The converted stream stopped early', 'The provider may have dropped the connection. Press play, or drag the seek bar, to continue.');
    return;
  }
  state.progress[c.uid] = { t: 0, d: durTime() || 0, w: 1, ts: Date.now() };
  persistProgress();
  if (c.kind === 'episode' && LS.get('tuner.autonext', true)) {
    const eps = allEpisodes((state.detail[c.seriesUid] || {}).seasons || {});
    const i = eps.findIndex((e) => e.uid === c.uid);
    if (i >= 0 && eps[i + 1]) { playChannel(eps[i + 1]); return; }
    const next = dlNextEpisode(c);   // offline: the series details aren't loaded, but the next episode may be downloaded
    if (next && i < 0) { playChannel(next); return; }
  }
  uiPlayback();
});
/* ───────────────────────────── custom controls (every kind of playback) ───────────────────────────── */
const fmtClock = (sec) => fmtDur(sec);
const playerEl = $('#player');
const ICON = (id) => `<svg class="ic${id === 'i-pause' || id === 'i-play' ? ' fill' : ''}"><use href="#${id}"/></svg>`;
const setFill = (el, frac) => el.style.setProperty('--fill', Math.max(0, Math.min(100, frac * 100)) + '%');
function syncCtl() {
  const c = state.current;
  if (!c) return;
  const vod = isVod(c);
  playerEl.classList.toggle('is-live', !vod);
  playerEl.classList.toggle('paused', video.paused);
  const dur = durTime();
  const hasDur = vod && isFinite(dur) && dur > 0;
  $('#pcSeekRow').hidden = !vod;
  const seek = $('#pcSeek');
  seek.disabled = !hasDur;
  if (!tcSeeking) {
    seek.max = hasDur ? dur : 0;
    seek.value = hasDur ? Math.min(curTime(), dur) : 0;
    setFill(seek, hasDur ? curTime() / dur : 0);
    $('#pcCur').textContent = fmtClock(curTime());
  }
  $('#pcDur').textContent = hasDur ? fmtClock(dur) : '--:--';
  $('#pcLiveTime').textContent = fmtClock(video.currentTime || 0);
  $('#pcPlay').innerHTML = ICON(video.paused ? 'i-play' : 'i-pause');
  const muted = video.muted || video.volume === 0;
  $('#pcMute').innerHTML = ICON(muted ? 'i-mute' : 'i-volume');
  const vol = $('#pcVol');
  vol.value = muted ? 0 : video.volume;
  setFill(vol, muted ? 0 : video.volume);
  $('#pcSpeed').textContent = (video.playbackRate || 1) + '×';
}
let tcSeekId = 0;
async function seekTc(t) {
  const ch = state.current;
  if (!ch || !tcState.on || !tcState.vod) return;
  const id = ++tcSeekId;
  const token = playToken;
  const p = playlistById(ch.pid);
  tcState.offset = Math.max(0, Math.min(t, (tcState.duration || Infinity) - 2));
  showOverlay('loading', 'Seeking…');
  video.removeAttribute('src');   // hang up first: many providers allow only one connection
  video.load();
  const target = tcState.offset;
  const at = await tcStartAt(ch, p, target);
  if (id !== tcSeekId || token !== playToken) return;
  tcState.offset = at;
  video.src = tcUrl(ch, p, target);
  video.play().catch(() => {});
}
function seekTo(t) {
  if (tcState.on && tcState.vod) seekTc(t);
  else if (isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration - 1, t));
}
$('#pcSeek').addEventListener('input', (e) => { tcSeeking = true; $('#pcCur').textContent = fmtClock(Number(e.target.value)); setFill(e.target, Number(e.target.value) / (Number(e.target.max) || 1)); });
$('#pcSeek').addEventListener('change', (e) => { tcSeeking = false; seekTo(Number(e.target.value)); });
$('#pcPlay').addEventListener('click', () => togglePlay());
$('#pcMute').addEventListener('click', () => { video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = 0.5; syncCtl(); });
$('#pcVol').addEventListener('input', (e) => { video.volume = Number(e.target.value); video.muted = false; syncCtl(); });
const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
$('#pcSpeed').addEventListener('click', () => { const i = SPEEDS.indexOf(video.playbackRate || 1); video.playbackRate = SPEEDS[(i + 1) % SPEEDS.length]; syncCtl(); osd('Speed ' + video.playbackRate + '×'); });
// one click toggles play, a double click goes full screen
let clickTimer = 0;
video.addEventListener('click', () => {
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => { if (state.current) togglePlay(); }, 230);
});
video.addEventListener('dblclick', () => { clearTimeout(clickTimer); toggleFullscreen(); });
['play', 'pause', 'loadedmetadata', 'volumechange', 'ratechange', 'durationchange'].forEach((ev) => video.addEventListener(ev, syncCtl));
// show the controls while the pointer moves over the player
let ctlTimer = 0;
const showCtl = () => { playerEl.classList.add('ctl-on'); clearTimeout(ctlTimer); ctlTimer = setTimeout(() => playerEl.classList.remove('ctl-on'), 2600); };
playerEl.addEventListener('mousemove', showCtl);
playerEl.addEventListener('mouseenter', showCtl);
playerEl.addEventListener('mouseleave', () => { clearTimeout(ctlTimer); playerEl.classList.remove('ctl-on'); });
playerEl.addEventListener('focusin', showCtl);
/* ─────────────────────────── play / stop / controls ─────────────────────────── */
function playChannel(ch) {
  ch = dlLocal(ch);   // a downloaded copy plays from disk
  subOff();   // subtitles are picked per video
  state.current = ch;
  resumeAt = null;
  audReset(ch);   // and the sound track
  const token = ++playToken;
  pushRecent(ch);
  if (!isVod(ch)) loadShortEpg(ch);
  audStart(ch, token);   // startPlayback, after checking a marked live channel's languages when there's a wish
  mirrorTitle(ch.name);
  uiPlayback(true);
  dlSyncWatching();
  syncMediaSession();
}

function stopPlayback() {
  playToken++;
  teardown();
  hideOverlay();
  subOff();
  state.current = null;
  audReset(null);
  closePip();   // after state.current is gone, so the closing window doesn't start the video again
  mirrorTitle('');
  uiPlayback(true);
  dlSyncWatching();
  syncMediaSession();
}

function toggleFullscreen() {
  const el = $('#player');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.requestFullscreen().catch(() => {});
}
document.addEventListener('fullscreenchange', () => { $('#player').classList.toggle('fs', document.fullscreenElement === $('#player')); layoutPlayer(); });

let osdTimer = 0;
function osd(text) {
  const el = $('#osd');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => { el.hidden = true; }, 1100);
}
function togglePlay() { if (!state.current) return; if (video.paused) video.play().catch(() => {}); else video.pause(); }
function toggleMute() { video.muted = !video.muted; osd(video.muted ? 'Muted' : 'Volume ' + Math.round(video.volume * 100) + '%'); }
function changeVolume(d) { video.muted = false; video.volume = Math.max(0, Math.min(1, Math.round((video.volume + d) * 100) / 100)); osd('Volume ' + Math.round(video.volume * 100) + '%'); }
function seekBy(sec) {
  if (!state.current || !isVod(state.current)) return;
  if (tcState.on && tcState.vod) {
    // skipping back usually lands in what the conversion has already delivered: jump there instead of restarting it.
    // Chromium keeps only a few seconds ahead, so forward needs a restart (landing at the buffer's edge stalls).
    const t = video.currentTime + sec;
    const b = video.buffered;
    let inside = false;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) && t <= b.end(i) - 3) inside = true;
    if (inside) video.currentTime = t; else seekTc(curTime() + sec);
  } else if (isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration - 1, video.currentTime + sec));
  else return;
  osd((sec > 0 ? '+' : '−') + Math.abs(sec) + ' s');
}
$('#pcBack').addEventListener('click', () => seekBy(-15));
$('#pcFwd').addEventListener('click', () => seekBy(15));

// Media Session: what the picture-in-picture window and media keys can do. Chromium's picture-in-picture window
// has no seek buttons, only previous / next track, so those skip 15 s there. Live TV just plays and pauses.
function syncMediaSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const vod = !!(state.current && isVod(state.current));
  const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* not supported here */ } };
  set('play', () => video.play().catch(() => {}));
  set('pause', () => video.pause());
  for (const [action, sec] of [['seekbackward', -15], ['seekforward', 15], ['previoustrack', -15], ['nexttrack', 15]]) set(action, vod ? () => seekBy(sec) : null);
  ms.metadata = state.current && window.MediaMetadata ? new MediaMetadata({ title: state.current.name || '', artist: state.current.seriesName || '' }) : null;
}
/* ─────────────────────────── picture-in-picture ─────────────────────────── */
/*
 * Our own picture-in-picture window: the whole player (picture, controls, subtitles) moves into an always-on-top
 * window and back when it closes. Small, it looks like the mini player.
 */
let pipWin = null;
const pipHandlers = [];   // document-level handlers the window needs too: [type, fn, capture]
const onPipDoc = (type, fn, capture = false) => { pipHandlers.push([type, fn, capture]); if (pipDoc) pipDoc.addEventListener(type, fn, capture); };

// A frameless always-on-top pop-up (electron/main.js); Electron doesn't create document picture-in-picture windows.
function togglePip() {
  if (pipWin) pipWin.close(); else openPipWindow();
}

async function openPipWindow() {
  if (!state.current) return;
  const w = window.open('about:blank', 'ag-horizon-pip');
  if (!w) { toast('Picture-in-picture is not available.', 'err'); return; }
  const d = w.document;
  // the app's look: stylesheets, icons (<use href="#i-…"> needs the sprite in the same document), theme and accent
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) { const c = d.createElement('link'); c.rel = 'stylesheet'; c.href = l.href; d.head.appendChild(c); }
  d.body.appendChild(document.querySelector('body > svg').cloneNode(true));
  d.body.className = 'pip-body';
  const syncRoot = () => { d.documentElement.style.cssText = document.documentElement.style.cssText; Object.assign(d.documentElement.dataset, document.documentElement.dataset); };
  syncRoot();
  const rootObserver = new MutationObserver(syncRoot);   // theme, accent and subtitle look changed in the app
  rootObserver.observe(document.documentElement, { attributes: true });
  d.title = state.current.name || 'AG Horizon';

  const el = playerEl;
  const home = { parent: el.parentNode, next: el.nextSibling };
  pipWin = w;
  pipDoc = d;
  el.style.cssText = '';
  el.classList.add('in-pip');
  movePlayer(() => d.body.appendChild(el));
  for (const [type, fn, capture] of pipHandlers) d.addEventListener(type, fn, capture);
  w.addEventListener('resize', layoutPlayer);
  layoutPlayer();

  w.addEventListener('pagehide', () => {   // closed: by its own ×, "go to this video", stop, or the app
    rootObserver.disconnect();
    pipWin = null;
    pipDoc = null;
    el.classList.remove('in-pip');
    movePlayer(() => home.parent.insertBefore(el, home.next), { later: true });
    $('#menu').hidden = true;
    uiPlayback(true);
  });
}

// Moving the <video> into another window makes Chromium reload its source, which a running conversion or a live
// stream doesn't survive. So let go of the source, move, and carry on where it was.
// later: when the window is closing, it only starts playing again once that window is gone
function movePlayer(move, { later = false } = {}) {
  const ch = state.current;
  if (!ch) { move(); return; }
  const t = curTime();
  const token = playToken;
  let resume;
  if (tcState.on && tcState.vod) {
    video.removeAttribute('src'); video.load();
    resume = () => seekTc(t);   // the conversion starts again where it was, like a seek
  } else if (isVod(ch) && !hlsPlayer && !tsPlayer) {
    const src = video.currentSrc;
    video.removeAttribute('src'); video.load();
    resume = () => {
      video.src = src;
      video.addEventListener('loadedmetadata', () => { video.currentTime = t; }, { once: true });
      video.play().catch(() => {});
    };
  } else {
    resume = () => startPlayback(ch, tcState.on ? ['tc'] : playPlan(ch), token);   // live TV: connect again
  }
  move();
  if (later) setTimeout(() => { if (token === playToken) resume(); }, 50); else resume();
}
const closePip = () => { if (pipWin) pipWin.close(); };

/* ───────────────────────── mirror picture (mirror window) ───────────────────────── */
/*
 * The mirror window shows exactly what this player shows. It doesn't open a second connection to
 * your provider: we hand it a live MediaStream captured from the main <video>, so the picture
 * is identical and in sync, and connection limits aren't affected.
 * Sound can play on this window, on the mirror window, or on both (Settings › Mirror picture).
 */
let mirrorWin = null;
let mirrorMuteSaved = null;          // our own mute state, restored when "sound on mirror window only" ends
const mirrorOpen = () => !!mirrorWin && !mirrorWin.closed;
const mirrorSound = () => LS.get('tuner.mirrorSound', 'main'); // 'main' | 'mirror' | 'both'

// Apply the sound choice. (The mirror gets its audio from the stream, which is not affected by muting this window.)
function applyMirrorSound() {
  const mode = mirrorOpen() ? mirrorSound() : 'main';
  if (mode === 'mirror') {
    if (mirrorMuteSaved === null) mirrorMuteSaved = video.muted;
    video.muted = true;
  } else if (mirrorMuteSaved !== null) {
    video.muted = mirrorMuteSaved;
    mirrorMuteSaved = null;
  }
  try { if (mirrorOpen() && mirrorWin.setSound) mirrorWin.setSound(mode); } catch { /* window closing */ }
}

// The floating mirror window has the player's controls too (mirror.js). They call togglePlay, seekBy, seekTo and
// the three functions below through window.opener; mirrorCtl tells that window what its controls should show.
function mirrorSetMuted(m) { video.muted = m; if (!m && video.volume === 0) video.volume = 0.5; }
function mirrorSetVolume(vol) { video.volume = Math.max(0, Math.min(1, vol)); video.muted = false; }
function mirrorClock(sec) { return fmtClock(sec); }
function mirrorCtl() {
  try {
    if (!mirrorOpen() || !mirrorWin.setCtl) return;
    const vod = !!(state.current && isVod(state.current));
    const dur = durTime();
    mirrorWin.setCtl({
      on: !!state.current, paused: video.paused, vod, muted: video.muted || video.volume === 0, volume: video.volume,
      cur: curTime() || 0, dur: vod && isFinite(dur) && dur > 0 ? dur : 0,
    });
  } catch { /* window closing */ }
}
['play', 'pause', 'volumechange', 'loadedmetadata', 'durationchange', 'timeupdate', 'emptied'].forEach((ev) => video.addEventListener(ev, mirrorCtl));

function attachMirror() {
  if (!mirrorOpen()) return;
  try {
    // A fresh capture every time: after the source changes (new channel, seek in converted video) the old stream stops updating.
    const stream = video.captureStream ? video.captureStream() : null;
    if (stream && mirrorWin.setStream) mirrorWin.setStream(stream, mirrorSound());
    applyMirrorSound();
    mirrorCtl();
  } catch (e) { console.warn('mirror attach failed', e); }
}
function mirrorTitle(text) { try { if (mirrorOpen() && mirrorWin.setTitleText) mirrorWin.setTitleText(text || ''); } catch { /* window closing */ } }
window.tunerMirrorReady = (w) => { mirrorWin = w; attachMirror(); mirrorTitle(state.current ? state.current.name : ''); uiMirrorChanged(); };
video.addEventListener('loadeddata', attachMirror);
video.addEventListener('emptied', () => { try { if (mirrorOpen() && mirrorWin.clearStream) mirrorWin.clearStream(); } catch { /* ignore */ } });

function openMirror(displayId) {
  if (mirrorOpen()) { try { mirrorWin.focus(); } catch { /* ignore */ } return; }
  const q = displayId != null ? `?d=${encodeURIComponent(displayId)}` : '';
  const w = window.open('/mirror.html' + q, 'tuner-mirror', 'popup=yes,width=960,height=540');
  if (!w) { toast('The pop-up was blocked. Allow pop-ups for this page and try again.', 'err'); return; }
  mirrorWin = w;
}
function mirrorClosed() { mirrorWin = null; applyMirrorSound(); uiMirrorChanged(); }
function closeMirror() { try { if (mirrorOpen()) mirrorWin.close(); } catch { /* ignore */ } mirrorClosed(); }
window.addEventListener('beforeunload', () => { try { if (mirrorOpen()) mirrorWin.close(); } catch { /* ignore */ } });
setInterval(() => { if (mirrorWin && mirrorWin.closed) mirrorClosed(); }, 1000);

// Button → with more than one monitor, offer a choice; otherwise just open the floating window.
async function mirrorButton(anchor) {
  if (mirrorOpen()) { closeMirror(); return; }
  let list = [];
  try { list = await window.tunerDesktop.displays(); } catch { /* fall through to a plain window */ }
  if (list.length > 1) {
    showMenu(anchor, [
      { label: 'Mirror to…', heading: true },
      { label: 'Floating window (stays on top)', run: () => openMirror() },
      ...list.map((d) => ({ label: `${d.label}${d.primary ? ' (main)' : ''} · ${d.width}×${d.height}`, run: () => openMirror(d.id) })),
    ]);
    return;
  }
  openMirror();
}

/* ─────────────────────────────── capabilities ─────────────────────────────── */
fetch('/api/capabilities').then((r) => r.json()).then((j) => { state.ffmpeg = !!j.ffmpeg; state.opensubtitles = !!j.opensubtitles; state.tmdb = !!j.tmdb; uiCaps(); }).catch(() => uiCaps());
