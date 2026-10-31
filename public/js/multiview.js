'use strict';
/*
 * AG Horizon – Multi view: up to four live channels at once.
 * Layouts: two side by side, two stacked, three (one big + two), or 2 × 2.
 * Only one picture plays sound at a time (click a picture, or press 1–4).
 * Each picture has its own small player (hls.js / mpegts.js / native, with the ffmpeg fallback), separate from the single player.
 */

const MV_LAYOUTS = {
  '2c': { n: 2, label: 'Side by side' },
  '2r': { n: 2, label: 'Stacked' },
  '3c': { n: 3, label: '3 · big left' },
  '3r': { n: 3, label: '3 · big top' },
  '4': { n: 4, label: '2 × 2' },
};
const MV_MAX = 4;

const mv = {
  layout: '2c',
  focus: 0,
  muted: false,
  slots: [null, null, null, null],    // live channel objects
  pending: [null, null, null, null],  // saved snapshots that could not be matched to a loaded playlist yet
  tiles: [],
  built: false,
  limits: {},                         // playlist id -> allowed simultaneous connections (null = unknown)
};
(function restore() {
  const s = LS.get('tuner.mv', {});
  if (MV_LAYOUTS[s.layout]) mv.layout = s.layout;
  if (Number.isInteger(s.focus) && s.focus >= 0 && s.focus < MV_MAX) mv.focus = s.focus;
  if (Array.isArray(s.slots)) s.slots.slice(0, MV_MAX).forEach((x, i) => { if (x && x.uid && x.pid) mv.pending[i] = x; });
})();

const mvCount = () => MV_LAYOUTS[mv.layout].n;
const mvFilled = () => mv.slots.filter(Boolean).length + mv.pending.filter(Boolean).length;
function mvSave() {
  LS.set('tuner.mv', { layout: mv.layout, focus: mv.focus, slots: mv.slots.map((c, i) => (c ? snap(c) : mv.pending[i] || null)) });
}
function mvFind(s) {
  const base = state.cache[s.pid];
  return base ? base.channels.find((c) => c.uid === s.uid) || null : null;
}
async function mvResolveAll() {
  for (let i = 0; i < MV_MAX; i++) {
    const s = mv.pending[i];
    if (mv.slots[i] || !s) continue;
    let ch = mvFind(s);
    if (!ch) {
      const p = playlistById(s.pid);
      if (p) { try { await loadPlaylist(p); } catch { /* the tile will say it is unavailable */ } ch = mvFind(s); }
    }
    if (ch) { mv.slots[i] = ch; mv.pending[i] = null; }
  }
}

/* ───────────────────────────────── one picture ───────────────────────────────── */
class MvTile {
  constructor(i, root) {
    this.i = i;
    this.root = root;
    this.video = root.querySelector('video');
    this.ovEl = root.querySelector('.mv-ov');
    this.tcEl = root.querySelector('.mv-tc');
    this.token = 0;
    this.hls = null;
    this.ts = null;
    this.timer = 0;
    this.ch = null;
    this.converted = false;
    const v = this.video;
    v.addEventListener('playing', () => { this.hideOv(); this.armCheck(); applyMvSound(); });
    v.addEventListener('canplay', () => this.hideOv());
    v.addEventListener('waiting', () => { if (this.ch && !v.paused) this.ov('loading', 'Buffering…'); });
  }

  ov(kind, title, text) {
    const el = this.ovEl;
    el.hidden = false;
    el.className = 'mv-ov' + (kind === 'error' ? ' error' : '');
    el.innerHTML = kind === 'loading'
      ? `<div><div class="spinner"></div><p>${esc(title)}</p></div>`
      : `<div><strong>${esc(title)}</strong><p>${esc(text || '')}</p><button class="btn small" data-a="retry">Try again</button></div>`;
  }
  hideOv() { this.ovEl.hidden = true; }

  teardown() {
    clearTimeout(this.timer);
    if (this.hls) { try { this.hls.destroy(); } catch { /* ignore */ } this.hls = null; }
    if (this.ts) { try { this.ts.pause(); this.ts.unload(); this.ts.detachMediaElement(); this.ts.destroy(); } catch { /* ignore */ } this.ts = null; }
    this.converted = false;
    this.tcEl.hidden = true;
    const v = this.video;
    v.onerror = null;
    v.pause();
    v.removeAttribute('src');
    v.load();
  }

  stop() {
    this.token++;
    this.ch = null;
    this.teardown();
    this.hideOv();
  }

  play(ch) {
    this.ch = ch;
    const token = ++this.token;
    pushRecent(ch);
    loadShortEpg(ch);
    this.start(ch, playPlan(ch), token);
  }

  async start(ch, kinds, token, lastError) {
    if (token !== this.token) return;
    const [kind, ...rest] = kinds;
    const p = playlistById(ch.pid);
    const src = proxied(ch.url, p);
    const v = this.video;
    const fail = (msg) => {
      if (token !== this.token) return;
      if (rest.length) { this.start(ch, rest, token, msg); return; }
      this.teardown();
      const hint = !state.ffmpeg ? ' ffmpeg was not found, so unsupported codecs can’t be converted.' : compatMode() === 'off' ? ' Compatibility mode is switched off in Settings.' : '';
      this.ov('error', "Couldn't play this channel", `${msg}.${hint} The stream may be offline, or your provider’s connection limit may be used up.`);
    };
    if (!kind) { fail(lastError || 'No playable format'); return; }
    this.teardown();
    this.ov('loading', 'Tuning in…');

    if (kind === 'hls') {
      if (!(await loadHls())) {
        if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = src; v.play().catch(() => {}); return; }
        fail('The HLS player library could not be loaded');
        return;
      }
      if (token !== this.token) return;
      if (!Hls.isSupported()) { v.src = src; v.play().catch(() => {}); return; }
      let net = 0, media = 0;
      // capLevelToPlayerSize: a small picture doesn't need the biggest quality
      const h = (this.hls = new Hls({ maxBufferLength: 12, maxMaxBufferLength: 20, liveSyncDurationCount: 3, manifestLoadingMaxRetry: 1, fragLoadingMaxRetry: 3, capLevelToPlayerSize: true }));
      h.loadSource(src);
      h.attachMedia(v);
      h.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
      h.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal || token !== this.token) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && d.details !== 'manifestParsingError' && ++net <= 2) h.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && ++media <= 2) h.recoverMediaError();
        else fail(`HLS error: ${d.details}`);
      });
    } else if (kind === 'ts') {
      if (!(await loadMpegts()) || !mpegts.isSupported()) { fail('The MPEG-TS player is not available in this browser'); return; }
      if (token !== this.token) return;
      this.ts = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: src }, { enableWorker: true, liveBufferLatencyChasing: true, lazyLoadMaxDuration: 30 });
      this.ts.attachMediaElement(v);
      this.ts.on(mpegts.Events.ERROR, (_t, detail) => fail(`Stream error: ${detail}`));
      this.ts.load();
      this.ts.play().catch(() => {});
    } else if (kind === 'tc') {
      this.ov('loading', 'Converting for playback…');
      let info = {};
      try { const r = await fetch(`/api/probe?url=${enc(ch.url)}${uaParam(p)}`); if (r.ok) info = await r.json(); } catch { /* convert everything */ }
      if (token !== this.token) return;
      const n = mvCount();
      const maxh = n >= 3 ? 540 : n === 2 ? 720 : 1080;   // smaller pictures need less CPU
      this.converted = true;
      this.tcEl.hidden = false;
      v.onerror = () => fail('The converted stream could not be played');
      v.src = `/api/transcode?url=${enc(ch.url)}${uaParam(p)}&video=${info.video === 'h264' ? 'copy' : 'h264'}&maxh=${maxh}`;
      v.play().catch(() => {});
    } else {
      v.src = src;
      v.onerror = () => fail(v.error && v.error.message ? v.error.message : 'The browser could not play this stream');
      v.play().catch(() => {});
    }
  }

  // Some streams "play" with no picture, or no sound on the focused picture (HEVC, DTS, AC-3): convert them.
  armCheck() {
    clearTimeout(this.timer);
    if (this.converted || !state.ffmpeg || compatMode() === 'off' || !this.ch) return;
    const token = this.token, ch = this.ch, v = this.video;
    this.timer = setTimeout(() => {
      if (token !== this.token || this.converted || v.paused) return;
      const noPicture = v.videoWidth === 0;
      const noSound = mv.focus === this.i && typeof v.webkitAudioDecodedByteCount === 'number' && v.webkitAudioDecodedByteCount === 0 && v.currentTime > 2;
      if (noPicture || noSound) this.start(ch, ['tc'], token);
    }, 4000);
  }
}

/* ───────────────────────────────────── page ───────────────────────────────────── */
function mvBuild() {
  if (mv.built) return;
  mv.built = true;
  $('#mvLayouts').innerHTML = ['2c', '2r', '3c', '3r', '4'].map((k) => [k, MV_LAYOUTS[k]]).map(([k, l]) =>
    `<button class="mv-lay" data-l="${k}" title="${esc(l.label)}"><span class="mv-pic" data-layout="${k}">${'<i></i>'.repeat(l.n)}</span><span class="mv-lay-t">${esc(l.label)}</span></button>`).join('');
  const grid = $('#mvGrid');
  grid.innerHTML = Array.from({ length: MV_MAX }, (_, i) => `
    <div class="mv-tile" data-i="${i}" tabindex="0">
      <video playsinline muted></video>
      <div class="mv-ov" hidden></div>
      <div class="mv-empty"><button class="mv-add" data-a="pick"><svg class="ic"><use href="#i-plus"/></svg><span>Add a channel</span></button><small>Picture ${i + 1}</small></div>
      <div class="mv-top">
        <span class="mv-num">${i + 1}</span>
        <div class="mv-title"><b></b><small></small></div>
        <button class="mv-btn" data-a="sound" title="Sound from this picture (${i + 1})" aria-label="Sound from this picture"><svg class="ic"><use href="#i-mute"/></svg></button>
        <button class="mv-btn" data-a="pick" title="Change channel" aria-label="Change channel"><svg class="ic"><use href="#i-list"/></svg></button>
        <button class="mv-btn" data-a="full" title="Full screen" aria-label="Full screen"><svg class="ic"><use href="#i-full"/></svg></button>
        <button class="mv-btn" data-a="remove" title="Remove" aria-label="Remove"><svg class="ic"><use href="#i-x"/></svg></button>
      </div>
      <span class="mv-tc" hidden title="Converted with ffmpeg because the player can't decode this stream directly">Converted</span>
    </div>`).join('');
  mv.tiles = $$('.mv-tile', grid).map((el, i) => new MvTile(i, el));
}

function mvTileInfo(i) {
  const ch = mv.slots[i];
  const s = mv.pending[i];
  if (ch) {
    const { now } = nowNext(ch);
    return { name: ch.name, sub: now ? now[2] || 'On air' : ch.group || '', empty: false, missing: false };
  }
  if (s) return { name: s.name, sub: 'Playlist not available', empty: false, missing: true };
  return { name: '', sub: '', empty: true, missing: false };
}

function mvRender() {
  const n = mvCount();
  $('#mvGrid').dataset.layout = mv.layout;
  $$('#mvLayouts .mv-lay').forEach((b) => b.classList.toggle('on', b.dataset.l === mv.layout));
  mv.tiles.forEach((t, i) => {
    const info = mvTileInfo(i);
    t.root.hidden = i >= n;
    t.root.classList.toggle('empty', info.empty);
    t.root.classList.toggle('focus', !info.empty && i === mv.focus);
    t.root.classList.toggle('single', n === 1);
    t.root.querySelector('.mv-title b').textContent = info.name;
    t.root.querySelector('.mv-title small').textContent = info.sub;
    const sound = t.root.querySelector('[data-a=sound]');
    const hasSound = !info.empty && i === mv.focus && !mv.muted;
    sound.classList.toggle('on', hasSound);
    sound.querySelector('use').setAttribute('href', hasSound ? '#i-volume' : '#i-mute');
    t.root.querySelector('[data-a=pick]').title = info.empty ? 'Add a channel' : 'Change channel';
  });
  $('#mvCount').textContent = `${Math.min(mvFilled(), n)} of ${n} pictures`;
  $('#mvMute').classList.toggle('on', mv.muted);
  $('#mvMute use').setAttribute('href', mv.muted ? '#i-mute' : '#i-volume');
  mvBadge();
  mvWarn();
}

function mvBadge() {
  const b = $('#nav [data-route=multiview]');
  if (b) b.dataset.count = String(mvFilled());
}

function applyMvSound() {
  mv.tiles.forEach((t, i) => { t.video.muted = mv.muted || i !== mv.focus; });
}

// Make every visible picture play what its slot says (and nothing else).
function mvSync() {
  const n = mvCount();
  let delay = 0;
  mv.tiles.forEach((t, i) => {
    const ch = i < n ? mv.slots[i] : null;
    if (!ch) { if (t.ch) t.stop(); return; }
    if (t.ch === ch) return;
    t.stop();
    t.ch = ch;                                   // reserve the picture so a second sync doesn't start it twice
    t.ov('loading', 'Tuning in…');
    const wait = delay; delay += 350;            // stagger the connections a little
    setTimeout(() => {
      if (ui.route !== 'multiview' || mv.slots[i] !== ch || t.ch !== ch) return;
      t.play(ch);
    }, wait);
  });
  applyMvSound();
}

function mvFocus(i, { quiet = false } = {}) {
  if (i < 0 || i >= mvCount() || !(mv.slots[i] || mv.pending[i])) return;
  mv.focus = i;
  mv.muted = false;
  applyMvSound();
  mvRender();
  mvSave();
  if (!quiet && mv.slots[i]) flash(`Sound: ${mv.slots[i].name}`);
}

function mvSetLayout(l) {
  if (!MV_LAYOUTS[l] || l === mv.layout) return;
  mv.layout = l;
  if (mv.focus >= mvCount()) mv.focus = 0;
  mvSave();
  mvRender();
  if (ui.route === 'multiview') { mvSync(); mvCheckLimits(); }
}

function mvRemove(i) {
  mv.slots[i] = null;
  mv.pending[i] = null;
  mv.tiles[i].stop();
  if (mv.focus === i) { const j = mv.slots.findIndex((c, k) => c && k < mvCount()); mv.focus = j >= 0 ? j : 0; }
  mvSave();
  mvRender();
  applyMvSound();
}

function mvClearAll() {
  mv.slots = [null, null, null, null];
  mv.pending = [null, null, null, null];
  mv.tiles.forEach((t) => t.stop());
  mv.focus = 0;
  mvSave();
  mvRender();
}

// Put a channel into the first free picture (growing the layout when it is full). Used by the player bar and the channel lists.
function mvAdd(ch, { open = false } = {}) {
  if (ch) ch = mvFind(ch) || ch;      // lists in Favorites / History hold snapshots; use the full channel
  if (!ch || isVod(ch)) { toast('Multi view works with live channels.', 'err'); return false; }
  if (mv.slots.some((c) => c && c.uid === ch.uid)) { toast(`“${ch.name}” is already in Multi view`); if (open) go('multiview'); return true; }
  const free = (n) => { for (let i = 0; i < n; i++) if (!mv.slots[i] && !mv.pending[i]) return i; return -1; };
  let idx = free(mvCount());
  if (idx < 0 && mvCount() < MV_MAX) {
    mv.layout = mvCount() === 2 ? (mv.layout === '2r' ? '3r' : '3c') : '4';
    idx = free(mvCount());
  }
  if (idx < 0) { toast('Multi view is full (4 pictures). Remove one first.', 'err'); if (open) go('multiview'); return false; }
  mv.slots[idx] = ch;
  mv.pending[idx] = null;
  if (mvFilled() === 1) mv.focus = idx;
  mvSave();
  if (open) go('multiview');
  else if (ui.route === 'multiview') { mvRender(); mvSync(); mvCheckLimits(); }
  else { mvBadge(); toast(`Added “${ch.name}” to Multi view`); }
  return true;
}

/* ── entering and leaving the page ── */
async function renderMultiview() {
  mvBuild();
  const noLists = !state.playlists.length;
  $('#mvEmpty').hidden = !noLists;
  $('#mvMain').hidden = noLists;
  if (noLists) { $('#mvEmpty').innerHTML = emptyState('i-multi', 'Add a playlist first', 'Multi view plays several live channels from your playlists at the same time.', addBtn); return; }
  if (state.current) stopPlayback();      // the single player would use up a provider connection
  mvRender();
  await mvResolveAll();
  if (ui.route !== 'multiview') return;
  mvRender();
  mvSync();
  mvCheckLimits();
}
function mvLeave() {
  mv.tiles.forEach((t) => t.stop());
  if (document.fullscreenElement && document.fullscreenElement.classList.contains('mv-tile')) document.exitFullscreen().catch(() => {});
}

/* ── provider connection limits ── */
function mvCounts() {
  const c = {};
  for (let i = 0; i < mvCount(); i++) if (mv.slots[i]) c[mv.slots[i].pid] = (c[mv.slots[i].pid] || 0) + 1;
  return c;
}
async function mvCheckLimits() {
  const counts = mvCounts();
  for (const [pid, c] of Object.entries(counts)) {
    if (c < 2 || pid in mv.limits) continue;
    mv.limits[pid] = null;
    const p = playlistById(pid);
    if (!p || p.type !== 'xtream') continue;
    try {
      const j = await apiJson(xt.api(p, ''), p);
      const m = Number(j && j.user_info && j.user_info.max_connections);
      if (m > 0) mv.limits[pid] = m;
    } catch { /* unknown – no warning */ }
  }
  mvWarn();
}
function mvWarn() {
  const el = $('#mvNote');
  const counts = mvCounts();
  const msgs = [];
  for (const [pid, c] of Object.entries(counts)) {
    const lim = mv.limits[pid];
    const p = playlistById(pid);
    if (lim && p && c > lim) msgs.push(`“${p.name}” allows ${lim} connection${lim === 1 ? '' : 's'} at the same time, but ${c} pictures use it.`);
  }
  if (msgs.length) { el.hidden = false; el.className = 'mv-note warn'; el.textContent = msgs.join(' ') + ' Some pictures may fail to start.'; return; }
  const many = Object.values(counts).some((c) => c >= 2);
  el.hidden = !many;
  el.className = 'mv-note';
  el.textContent = 'Every picture uses one connection from your provider, and many providers allow only 1–2. If a picture won’t start, remove one.';
}

/* ── names that follow the guide ── */
function mvRefreshNames() {
  if (ui.route !== 'multiview') return;
  mv.tiles.forEach((t, i) => {
    const info = mvTileInfo(i);
    t.root.querySelector('.mv-title small').textContent = info.sub;
  });
}
setInterval(mvRefreshNames, 30000);

/* ── clicks ── */
$('#mvLayouts').addEventListener('click', (e) => { const b = e.target.closest('[data-l]'); if (b) mvSetLayout(b.dataset.l); });
$('#mvClear').addEventListener('click', () => { if (mvFilled() && confirm('Remove all channels from Multi view?')) mvClearAll(); });
$('#mvMute').addEventListener('click', () => { mv.muted = !mv.muted; applyMvSound(); mvRender(); });
$('#mvGrid').addEventListener('click', (e) => {
  const tile = e.target.closest('.mv-tile');
  if (!tile) return;
  const i = Number(tile.dataset.i);
  const a = e.target.closest('[data-a]');
  const act = a ? a.dataset.a : (mv.slots[i] || mv.pending[i] ? 'focus' : 'pick');
  if (act === 'sound') { if (mv.focus === i && !mv.muted) { mv.muted = true; applyMvSound(); mvRender(); } else mvFocus(i); }
  else if (act === 'focus') mvFocus(i, { quiet: true });
  else if (act === 'pick') mvPick(i);
  else if (act === 'remove') mvRemove(i);
  else if (act === 'retry') { const ch = mv.slots[i]; if (ch) { mv.tiles[i].ch = null; mvSync(); } }
  else if (act === 'full') mvFullscreen(i);
});
$('#mvGrid').addEventListener('dblclick', (e) => {
  const tile = e.target.closest('.mv-tile');
  if (tile && !e.target.closest('[data-a]') && mv.slots[Number(tile.dataset.i)]) mvFullscreen(Number(tile.dataset.i));
});
function mvFullscreen(i) {
  const el = mv.tiles[i].root;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.requestFullscreen().catch(() => {});
}

/* ── channel picker ── */
const pick = { i: -1, items: [], sel: 0 };
function mvPickItems(q) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  const all = [];
  for (const p of state.playlists) { const b = state.cache[p.id]; if (b) all.push(...b.channels); }
  if (toks.length) return all.filter((c) => toks.every((t) => c.name.toLowerCase().includes(t) || (c.group || '').toLowerCase().includes(t))).slice(0, 60);
  const byUid = new Map(all.map((c) => [c.uid, c]));
  const out = [];
  const seen = new Set();
  const add = (c) => { if (c && !seen.has(c.uid)) { seen.add(c.uid); out.push(c); } };
  [...state.favs].forEach((u) => add(byUid.get(u)));
  state.recent.forEach((r) => add(byUid.get(r.uid)));
  all.filter((c) => c.pid === curPid()).slice(0, 60).forEach(add);
  return out.slice(0, 60);
}
function mvPickBuild() {
  const q = $('#mvPickInput').value.trim();
  pick.items = mvPickItems(q);
  pick.sel = Math.min(pick.sel, Math.max(0, pick.items.length - 1));
  const loading = state.playlists.some((p) => !state.cache[p.id] && state.status[p.id] === 'checking');
  $('#mvPickList').innerHTML = pick.items.length
    ? pick.items.map((c, i) => {
      const where = mv.slots.findIndex((s) => s && s.uid === c.uid);
      const p = playlistById(c.pid);
      const sub = [p && state.playlists.length > 1 ? p.name : '', c.group, where >= 0 ? `in picture ${where + 1}` : ''].filter(Boolean).join(' · ');
      return `<button class="pal-item${i === pick.sel ? ' on' : ''}" data-i="${i}" role="option"><span class="logo sm">${logoHtml(c)}</span><span class="name">${esc(c.name)}</span>${state.favs.has(c.uid) ? '<svg class="ic fav-ic"><use href="#i-heart-fill"/></svg>' : ''}<span class="muted">${esc(sub)}</span></button>`;
    }).join('')
    : `<div class="empty">${loading ? 'Loading channels…' : q ? 'No channels match.' : 'Type to search your channels.'}</div>`;
  const on = $('#mvPickList .on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
async function mvPick(i) {
  pick.i = i;
  pick.sel = 0;
  $('#mvPickInput').value = '';
  $('#mvPickTitle').textContent = mv.slots[i] ? `Change picture ${i + 1}` : `Add a channel to picture ${i + 1}`;
  mvPickBuild();
  if (!$('#mvPickDlg').open) $('#mvPickDlg').showModal();
  $('#mvPickInput').focus();
  const missing = state.playlists.filter((p) => !state.cache[p.id]);
  if (missing.length) { await Promise.allSettled(missing.map((p) => loadPlaylist(p))); mvPickBuild(); }
}
function mvPickChoose(k) {
  const ch = pick.items[k];
  if (!ch || pick.i < 0) return;
  $('#mvPickDlg').close();
  const i = pick.i;
  const j = mv.slots.findIndex((s) => s && s.uid === ch.uid);
  if (j === i) return;
  if (j >= 0) [mv.slots[i], mv.slots[j]] = [mv.slots[j], mv.slots[i]];     // already showing: swap the two pictures
  else { mv.slots[i] = ch; mv.pending[i] = null; }
  if (!mv.slots[mv.focus] && !mv.pending[mv.focus]) mv.focus = i;
  mvSave();
  mvRender();
  mvSync();
  mvCheckLimits();
}
$('#mvPickInput').addEventListener('input', () => { pick.sel = 0; mvPickBuild(); });
$('#mvPickInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); pick.sel = Math.min(pick.items.length - 1, pick.sel + 1); mvPickBuild(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pick.sel = Math.max(0, pick.sel - 1); mvPickBuild(); }
  else if (e.key === 'Enter') { e.preventDefault(); mvPickChoose(pick.sel); }
});
$('#mvPickList').addEventListener('click', (e) => { const b = e.target.closest('.pal-item'); if (b) mvPickChoose(Number(b.dataset.i)); });
$('#mvPickList').addEventListener('error', logoFailed, true);
$('#mvPickDlg').addEventListener('mousedown', (e) => { if (e.target === $('#mvPickDlg')) $('#mvPickDlg').close(); });
$('#mvPickClose').addEventListener('click', () => $('#mvPickDlg').close());

/* ── keyboard: 1–4 choose the picture with sound, F full screen, M mute ── */
document.addEventListener('keydown', (e) => {
  if (ui.route !== 'multiview' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (/^[1-4]$/.test(k)) { e.preventDefault(); mvFocus(Number(k) - 1); }
  else if (k === 'f') { e.preventDefault(); if (mv.slots[mv.focus]) mvFullscreen(mv.focus); }
  else if (k === 'm') { e.preventDefault(); $('#mvMute').click(); }
});

mvBadge();
