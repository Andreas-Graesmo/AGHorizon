'use strict';
/* AG Horizon – playlist workspace: Live TV (categories, channel grid / list, timeline guide, guide grid), Movies / Series (posters, detail pages). */

const ws = {
  pid: null, mode: 'live', items: [], loading: false, errors: [], token: 0,
  q: '', cat: '*', catQ: '', vq: '',
  lv: 'channels', side: LS.get('tuner.side', true), lists: true, tl: LS.get('tuner.tl', true), day: 0, zoom: false,
  az: LS.get('tuner.liveAz', false), compact: LS.get('tuner.compact', false),
  sort: LS.get('tuner.sort', 'added'), refine: { rating: 0, year: 0, fav: false },
  rows: [], chans: [], vodView: [], shown: 0, liveShown: 0, detail: null,
};
const wsPlaylist = () => playlistById(ws.pid);
const ROW_H = 58;
const PAGE = 72;
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/* ───────────────────────────── opening & loading ───────────────────────────── */
function resetWsView() {
  Object.assign(ws, { q: '', vq: '', cat: '*', catQ: '', detail: null, refine: { rating: 0, year: 0, fav: false }, lists: true, day: 0 });
  $('#liveCatSearch').value = ''; $('#catSearch').value = '';
  $('#liveCatSearchBox').hidden = true; $('#vodCatSearchBox').hidden = true;
}
async function openWorkspace(pid, mode, opts = {}) {
  const p = playlistById(pid);
  if (!p) { toast('That playlist no longer exists.', 'err'); return; }
  LS.set('tuner.lastPid', pid);
  if (ws.pid !== pid) { Object.assign(ws, { pid, items: [], errors: [], mode: 'live', lv: 'channels' }); resetWsView(); }
  if (mode) {
    const m = mode === 'guide' ? 'live' : mode;
    if (m !== ws.mode) resetWsView();
    ws.mode = m;
    ws.lv = mode === 'guide' ? 'guide' : 'channels';
  }
  go('ws', {}, { push: opts.push !== false });
  await loadWs({ force: !!opts.force });
}

async function loadWs({ force = false } = {}) {
  const p = wsPlaylist();
  if (!p) return;
  const token = ++ws.token;
  const mode = ws.mode;
  ws.errors = [];
  ws.loading = true;
  if (force) delete state.epg[p.id];
  ws.items = [];
  renderWsChrome();
  renderWsBody();
  try {
    ws.items = await loadItems(p, mode, force);
  } catch (e) {
    ws.items = [];
    ws.errors = [e.message];
  }
  if (token !== ws.token) return;
  ws.loading = false;
  if (!['*', '*fav', '*recent'].includes(ws.cat) && !ws.items.some((c) => c.group === ws.cat)) ws.cat = '*';
  renderWsChrome();
  renderWsBody();
  if (mode === 'live' && !ws.errors.length && (force || !state.epg[p.id])) loadEpg(p, force);
}

function cachedCount(p, mode) {
  if (!p) return null;
  const base = state.cache[p.id];
  if (mode === 'live') return base ? base.channels.length : null;
  const own = state.cache[`${p.id}:${mode}`];
  if (own) return own.channels.length;
  if (base && p.type !== 'xtream') return (mode === 'movie' ? base.movies : base.series).length;
  return null;
}

function renderWsChrome() {
  const live = ws.mode === 'live';
  $('#wsLive').hidden = !(live && ws.lv === 'channels');
  $('#wsGuide').hidden = !(live && ws.lv === 'guide');
  $('#wsVod').hidden = live || !!ws.detail;
  $('#wsDetail').hidden = live || !ws.detail;
  const hasCats = (live && ws.lv === 'channels') || (!live && !ws.detail);
  $('#wsSideToggle').hidden = !hasCats;
  $('#wsSideToggle').classList.toggle('on', ws.side && hasCats);
  $('#wsBody').dataset.side = ws.side ? 'on' : 'off';
  $('#wsBody').dataset.mode = ws.mode;
  $('#wsRefresh').hidden = false;
  syncTopSearch();
  syncNavState();
  layoutPlayer();
}

function renderWsBody() {
  if (ws.mode === 'live') { renderLive(); if (ws.lv === 'guide') { guideState.dirty = true; renderGuide(); } }
  else if (ws.detail) renderDetail();
  else renderVod();
}

function toggleWsSide() { ws.side = !ws.side; LS.set('tuner.side', ws.side); renderWsChrome(); renderLiveList(); layoutPlayer(); }
$('#wsSideToggle').addEventListener('click', toggleWsSide);
document.addEventListener('click', (e) => { if (e.target.closest('[data-act=cats-collapse]')) toggleWsSide(); });
$('#wsRefresh').addEventListener('click', () => {
  if (ui.route !== 'ws') { const pid = curPid(); if (pid) { refreshPlaylist(pid); toast('Reloading…'); } return; }
  const p = wsPlaylist(); if (p) { dropCaches(p.id); loadWs({ force: true }); }
});

/* top search box: filters the current list; elsewhere it opens the global search */
const catLabel = () => (ws.cat === '*' ? 'All items' : ws.cat === '*fav' ? 'Favorites' : ws.cat === '*recent' ? 'Recent' : ws.cat);
function syncTopSearch() {
  const inp = $('#topInput');
  const chip = $('#scopeChip');
  if (ui.route === 'ws') {
    const modeName = ws.mode === 'live' ? (ws.lv === 'guide' ? 'TV guide' : 'Live TV') : ws.mode === 'movie' ? 'Movies' : 'Series';
    chip.textContent = ws.detail ? `${modeName} / ${ws.detail.name}` : `${modeName} / ${catLabel()}`;
    inp.placeholder = 'Search in this section…';
    const v = ws.mode === 'live' ? ws.q : ws.vq;
    if (document.activeElement !== inp) inp.value = v;
  } else if (ui.route === 'multiview') {
    chip.textContent = 'Multi view';
    inp.placeholder = 'Search all playlists…';
    if (document.activeElement !== inp) inp.value = '';
  } else if (ui.route === 'playlists') {
    chip.textContent = 'Sources';
    inp.placeholder = 'Search sources (all playlists)…';
    if (document.activeElement !== inp) inp.value = src.q;
  } else {
    chip.textContent = ui.route === 'search' ? 'All playlists' : 'Advanced search';
    inp.placeholder = ui.route === 'search' ? 'Search channels, movies and series…' : 'Search all playlists…';
    if (document.activeElement !== inp) inp.value = ui.route === 'search' ? searchState.q : '';
  }
}
let topSearchTimer = 0;
$('#topInput').addEventListener('input', (e) => {
  const v = e.target.value;
  clearTimeout(topSearchTimer);
  topSearchTimer = setTimeout(() => {
    if (ui.route === 'ws') {
      if (ws.mode === 'live') { ws.q = v; if (ws.lv === 'guide') { guideState.dirty = true; renderGuide(); } else renderLive(); }
      else { ws.vq = v; if (ws.detail) closeDetail(); else renderVod(); }
      syncTopSearch();
    } else if (ui.route === 'playlists') {
      src.q = v; renderPlaylists();
    } else {
      searchState.q = v;
      if (ui.route !== 'search') go('search'); else runSearch();
    }
  }, 130);
});
$('#topInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
$('#scopeChip').addEventListener('click', () => { searchState.q = $('#topInput').value; go('search'); });

/* ─────────────────────────────── live: categories ─────────────────────────────── */
function groupCounts(items) {
  const counts = new Map();
  for (const c of items) counts.set(c.group, (counts.get(c.group) || 0) + 1);
  return counts;
}
function catItemHtml(key, label, n, icon) {
  return `<button class="cat${ws.cat === key ? ' on' : ''}" data-cat="${esc(key)}" title="${esc(label)}">${icon || ''}<span class="name">${esc(label)}</span><span class="count">${n.toLocaleString()}</span></button>`;
}
function catsHtml(allLabel) {
  const counts = groupCounts(ws.items);
  const q = ws.catQ.trim().toLowerCase();
  let html = '';
  for (const [g, n] of counts) if (!q || g.toLowerCase().includes(q)) html += catItemHtml(g, g, n);
  return html;
}
function renderLiveCats() { const el = $('#liveCatList'); el.innerHTML = catsHtml('All items'); el.classList.toggle('compact', ws.compact); }
function recentLive() {
  const ids = new Set(ws.items.map((c) => c.uid));
  const seen = new Set();
  return state.recent.filter((r) => r.pid === ws.pid && r.kind === 'live' && ids.has(r.uid) && !seen.has(r.uid) && seen.add(r.uid)).map((r) => ws.items.find((c) => c.uid === r.uid));
}
function wireCats(prefix, listId, onPick) {
  const box = $(`#${prefix}CatSearchBox`);
  const inp = prefix === 'live' ? $('#liveCatSearch') : $('#catSearch');
  $(`#${prefix}CatSearchBtn`).addEventListener('click', () => { box.hidden = !box.hidden; $(`#${prefix}CatSearchBtn`).classList.toggle('on', !box.hidden); if (!box.hidden) inp.focus(); else { ws.catQ = ''; inp.value = ''; onPick(true); } });
  $(`#${prefix}CatClear`).addEventListener('click', () => { inp.value = ''; ws.catQ = ''; inp.focus(); onPick(true); });
  inp.addEventListener('input', () => { ws.catQ = inp.value; onPick(true); });
  $(`#${prefix}CatCompact`).addEventListener('click', () => { ws.compact = !ws.compact; LS.set('tuner.compact', ws.compact); $(`#${prefix}CatCompact`).classList.toggle('on', ws.compact); $('#liveCatList').classList.toggle('compact', ws.compact); $('#catList').classList.toggle('compact', ws.compact); });
  $(`#${prefix}CatReset`).addEventListener('click', () => { ws.catQ = ''; inp.value = ''; ws.cat = '*'; box.hidden = true; $(`#${prefix}CatSearchBtn`).classList.remove('on'); onPick(false); });
  $(`#${listId}`).addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (!b) return; ws.cat = (ws.cat === b.dataset.cat && ws.cat !== '*') ? '*' : b.dataset.cat; ws.lists = true; onPick(false); });
}
wireCats('live', 'liveCatList', (catsOnly) => { if (catsOnly) renderLiveCats(); else { ws.q = ''; syncTopSearch(); $('#topInput').value = ''; renderLive(); } });

/* ─────────────────────────────── live: channel grid + list ─────────────────────────────── */
function liveBase() {
  const q = ws.q.trim().toLowerCase();
  let list = ws.items;
  if (ws.cat === '*fav') list = list.filter((c) => state.favs.has(c.uid));
  else if (ws.cat === '*recent') list = recentLive();
  else if (ws.cat !== '*') list = list.filter((c) => c.group === ws.cat);
  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q));
  if (ws.az) list = [...list].sort((a, b) => collator.compare(a.name, b.name));
  return list;
}
function buildLiveRows() {
  ws.chans = liveBase();
  ws.rows = ws.chans.map((c) => ({ t: 'c', c }));
}

function liveEmptyHtml() {
  if (ws.loading) return '<div class="spinner"></div><p>Loading channels…</p>';
  if (ws.errors.length) return `<p><b>Couldn’t load this playlist</b></p><p>${esc(ws.errors[0])}</p><button class="btn small" data-act="edit-pl">Edit playlist</button>`;
  if (!ws.items.length) return 'No live channels in this playlist.';
  if (!ws.rows.length) return ws.cat === '*fav' && !ws.q ? 'Tap the ♡ on a channel to add it here.' : 'No channels match.';
  return '';
}

function renderLive() {
  buildLiveRows();
  const grid = ws.cat === '*';
  const view = $('#wsLive');
  view.dataset.view = grid ? 'grid' : 'list';
  view.dataset.lists = ws.lists ? 'on' : 'off';
  $('#liveCatCompact').classList.toggle('on', ws.compact);
  renderLiveCats();
  const msg = liveEmptyHtml();
  $('#liveListTitle').textContent = catLabel();
  $('#liveListTitle').title = catLabel();
  $('#liveListCount').textContent = ws.chans.length.toLocaleString();
  $('#liveSort').classList.toggle('on', ws.az);
  const em = $('#liveEmpty'); em.hidden = !msg; em.innerHTML = msg;
  const gem = $('#liveGridEmpty'); gem.hidden = !msg; gem.innerHTML = msg;
  $('#liveGridTitle').textContent = catLabel();
  $('#liveGridCount').textContent = ws.loading ? '' : `${ws.chans.length.toLocaleString()} items`;
  renderLiveStatus();
  syncTopSearch();
  if (grid) renderLiveGrid(); else { renderLiveList(true); renderLiveInfo(); }
  layoutPlayer();
}

function renderLiveStatus() {
  const p = wsPlaylist();
  if (!p) return;
  let t = '';
  if (ws.loading) t = 'Loading…';
  else if (!ws.errors.length) {
    const st = state.epgState[p.id];
    if (st === 'loading') t = 'Loading the programme guide…';
    else if (st && st.startsWith('error')) t = `<span class="err" title="${esc(st)}">Guide unavailable</span>`;
    else if (st === 'none') t = 'No guide source for this playlist';
  }
  $('#liveStatus').innerHTML = t;
}

const elLiveList = $('#liveList');
const elLiveRows = $('#liveRows');
let liveFrame = 0;

function liveRowHtml(r) {
  const ch = r.c;
  const { now } = nowNext(ch);
  const active = state.current && state.current.uid === ch.uid;
  const fav = state.favs.has(ch.uid);
  const pct = now ? Math.max(0, Math.min(100, ((Date.now() - now[0]) / (now[1] - now[0])) * 100)) : 0;
  const st = state.epgState[ch.pid];
  const nowText = now ? now[2] || 'On air' : st === 'loading' ? '' : 'No program information available';
  return `<div class="row ch${active ? ' active' : ''}" data-uid="${esc(ch.uid)}">
    <div class="logo">${logoHtml(ch)}</div>
    <div class="meta">
      <div class="name" title="${esc(ch.name)}">${esc(ch.name)}</div>
      <div class="now">${esc(nowText)}</div>${now ? `<div class="tm"><span>${fmtTime(now[0])}</span><div class="bar"><i style="width:${pct.toFixed(0)}%"></i></div><span>${fmtTime(now[1])}</span></div>` : ''}
    </div>
    <button class="multi-btn" data-multi title="Add to Multi view" aria-label="Add to Multi view"><svg class="ic"><use href="#i-multi"/></svg></button>
    <button class="fav${fav ? ' on' : ''}" data-fav title="${fav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="Favorite"><svg class="ic"><use href="#${fav ? 'i-heart-fill' : 'i-heart'}"/></svg></button>
  </div>`;
}

function renderLiveList(resetScroll) {
  cancelAnimationFrame(liveFrame);
  liveFrame = requestAnimationFrame(() => {
    if (resetScroll) elLiveList.scrollTop = 0;
    const rows = ws.rows;
    $('#liveSpacer').style.height = rows.length * ROW_H + 'px';
    const top = elLiveList.scrollTop;
    const h = elLiveList.clientHeight || 600;
    const start = Math.max(0, Math.floor(top / ROW_H) - 6);
    const end = Math.min(rows.length, Math.ceil((top + h) / ROW_H) + 6);
    elLiveRows.style.transform = `translateY(${start * ROW_H}px)`;
    elLiveRows.innerHTML = rows.slice(start, end).map(liveRowHtml).join('');
  });
}
elLiveList.addEventListener('scroll', () => renderLiveList(), { passive: true });
window.addEventListener('resize', () => { renderLiveList(); renderGuide(); renderLiveInfo(); });

elLiveRows.addEventListener('click', (e) => {
  const row = e.target.closest('[data-uid]');
  if (!row) return;
  const ch = ws.items.find((c) => c.uid === row.dataset.uid);
  if (!ch) return;
  if (e.target.closest('[data-fav]')) { toggleFavItem(ch); return; }
  if (e.target.closest('[data-multi]')) { mvAdd(ch); return; }
  playChannel(ch);
});
$('#wsLive').addEventListener('click', (e) => { if (e.target.closest('[data-act="edit-pl"]')) openPlaylistDialog(wsPlaylist()); });
$('#liveSort').addEventListener('click', () => { ws.az = !ws.az; LS.set('tuner.liveAz', ws.az); renderLive(); });
$('#liveListColl').addEventListener('click', () => { ws.lists = false; renderLive(); });

// channel tiles ("All items")
function renderLiveGrid() {
  $('#liveGrid').innerHTML = '';
  ws.liveShown = 0;
  $('#liveGridScroll').scrollTop = 0;
  appendLiveCards();
}
function appendLiveCards() {
  const next = ws.chans.slice(ws.liveShown, ws.liveShown + PAGE * 2);
  if (!next.length) return;
  $('#liveGrid').insertAdjacentHTML('beforeend', next.map((it) => cardHtml(it)).join(''));
  ws.liveShown += next.length;
  requestAnimationFrame(() => { const r = $('#liveGridMore').getBoundingClientRect(); const vr = $('#liveGridScroll').getBoundingClientRect(); if (ws.liveShown < ws.chans.length && r.top < vr.bottom + 400) appendLiveCards(); });
}
new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting) && ws.liveShown < ws.chans.length) appendLiveCards(); }, { root: $('#liveGridScroll'), rootMargin: '600px' }).observe($('#liveGridMore'));

function scrollLiveTo(uid) {
  const i = ws.rows.findIndex((r) => r.c.uid === uid);
  if (i < 0) return;
  const top = i * ROW_H;
  if (top < elLiveList.scrollTop || top > elLiveList.scrollTop + elLiveList.clientHeight - ROW_H) elLiveList.scrollTop = Math.max(0, top - ROW_H * 2);
}

function zap(delta) {
  if (ws.mode !== 'live' || !ws.chans.length) return;
  const list = ws.chans;
  const i = state.current && !isVod(state.current) ? list.findIndex((c) => c.uid === state.current.uid) : -1;
  const next = list[(i + delta + list.length) % list.length];
  playChannel(next);
  scrollLiveTo(next.uid);
}

/* ───────────────────────── live: timeline guide under the player ───────────────────────── */
const dayStart = (offset) => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() + offset * 864e5; };
const tlPx = () => (ws.zoom ? 2.8 : 1.4);
let tlKey = '';
function dayLabels() {
  const t = dayStart(ws.day);
  const a = ws.day === 0 ? 'Today' : ws.day === 1 ? 'Tomorrow' : ws.day === -1 ? 'Yesterday' : new Date(t).toLocaleDateString([], { weekday: 'long' });
  const b = new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return [a, b];
}
function renderLiveInfo() {
  if (ws.mode !== 'live' || ws.lv !== 'channels' || $('#wsLive').dataset.view !== 'list') return;
  const tl = $('#tl');
  tl.classList.toggle('collapsed', !ws.tl);
  const ch = state.current && !isVod(state.current) ? state.current : null;
  const [la, lb] = dayLabels();
  $('#tlDayA').textContent = la; $('#tlDayB').textContent = lb;
  const t = Date.now();
  const nn = ch ? nowNext(ch, t) : { list: null, now: null };
  $('#tlChan').textContent = ch ? ch.name : 'TV guide';
  $('#tlProg').textContent = ch ? (nn.now ? nn.now[2] || '' : '') : 'Select a channel to see its programme';
  const empty = $('#tlEmpty');
  const inner = $('#tlInner');
  const scroller = $('#tlScroll');
  if (!ws.tl) return;
  const list = ch ? programmesFor(ch) : null;
  if (!ch || !list) {
    const st = ch ? state.epgState[ch.pid] || '' : '';
    empty.textContent = !ch ? 'Select a channel to see its programme guide here.' : st === 'loading' ? 'Loading the programme guide…' : st.startsWith('error') ? 'The guide could not be loaded for this playlist.' : 'No programme information available for this channel.';
    inner.innerHTML = ''; inner.style.width = '0';
    return;
  }
  empty.textContent = '';
  const px = tlPx();
  const d0 = dayStart(ws.day);
  const span = 36 * 3600e3;
  const d1 = d0 + span;
  inner.style.width = (span / 60e3) * px + 'px';
  const step = ws.zoom ? 3600e3 : 7200e3;
  let html = '';
  for (let x = d0; x < d1; x += step) {
    const d = new Date(x);
    const midnight = d.getHours() === 0 && x !== d0;
    html += `<div class="tl-tick${midnight ? ' day' : ''}" style="left:${((x - d0) / 60e3) * px}px">${midnight ? esc(d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })) : fmtTime(x)}</div>`;
  }
  let prevEnd = 0;
  for (const p of list) {
    if (p[1] <= d0 || p[0] >= d1) continue;
    if (p[1] <= prevEnd) continue;
    const s = Math.max(p[0], d0, prevEnd), e = Math.min(p[1], d1);
    prevEnd = p[1];
    const left = ((s - d0) / 60e3) * px;
    const w = Math.max(6, ((e - s) / 60e3) * px - 4);
    const live = p[0] <= t && t < p[1];
    html += `<div class="tl-card${live ? ' live' : ''}${p[1] <= t ? ' past' : ''}" style="left:${left}px;width:${w}px" title="${esc(p[2] || '')}${p[3] ? ' – ' + esc(p[3]) : ''}"><div class="tt">${fmtTime(p[0])} – ${fmtTime(p[1])}</div><b>${esc(p[2] || 'Untitled')}</b>${p[3] ? `<div class="td">${esc(p[3])}</div>` : ''}${live ? '<span class="onnow">ON NOW</span>' : ''}</div>`;
  }
  if (t >= d0 && t < d1) html += `<div id="tlNow" style="left:${((t - d0) / 60e3) * px}px"><span>${fmtTime(t)}</span></div>`;
  const keep = scroller.scrollLeft;
  inner.innerHTML = html;
  const key = `${ch.uid}|${ws.day}|${ws.zoom}`;
  if (key !== tlKey) { tlKey = key; tlLocate(); } else scroller.scrollLeft = keep;
}
function tlLocate() {
  const scroller = $('#tlScroll');
  const t = Date.now();
  const d0 = dayStart(ws.day);
  const target = t >= d0 && t < d0 + 36 * 3600e3 ? ((t - d0) / 60e3) * tlPx() : ws.day === 0 ? 0 : (8 * 60) * tlPx();
  scroller.scrollLeft = Math.max(0, target - scroller.clientWidth * 0.55);
}
$('#tlLocate').addEventListener('click', () => { if (ws.day !== 0) { ws.day = 0; renderLiveInfo(); } tlLocate(); });
$('#tlZoom').addEventListener('click', () => { ws.zoom = !ws.zoom; $('#tlZoom').classList.toggle('on', ws.zoom); renderLiveInfo(); });
$('#tlPrev').addEventListener('click', () => { ws.day -= 1; renderLiveInfo(); });
$('#tlNext').addEventListener('click', () => { ws.day += 1; renderLiveInfo(); });
$('#tlCollapse').addEventListener('click', () => { ws.tl = !ws.tl; LS.set('tuner.tl', ws.tl); tlKey = ''; renderLiveInfo(); layoutPlayer(); });

/* ─────────────────────────────── live: guide grid ─────────────────────────────── */
const G = { px: 5, left: 180, rowH: 52, headH: 34, hours: 8 }; // px per minute
const guideState = { t0: 0, dirty: true, chans: [], selected: null };
const gScroll = $('#guideScroll');
const gInner = $('#guideInner');
const gRows = $('#guideRows');
const gHead = $('#guideHead');
const gNowLine = $('#guideNow');
let guideFrame = 0;

const floorHalfHour = (t) => Math.floor(t / 1800e3) * 1800e3;
function guideReset() { guideState.t0 = floorHalfHour(Date.now() - 45 * 60e3); }
guideReset();

function guideChannels() {
  if (!guideState.dirty) return guideState.chans;
  const only = $('#gOnlyEpg').checked;
  const base = liveBase();
  guideState.chans = only ? base.filter((c) => programmesFor(c)) : base;
  guideState.dirty = false;
  return guideState.chans;
}

function renderGuide() {
  if ($('#wsGuide').hidden || ui.route !== 'ws') return;
  cancelAnimationFrame(guideFrame);
  guideFrame = requestAnimationFrame(drawGuide);
}

function drawGuide() {
  G.left = window.matchMedia('(max-width: 900px)').matches ? 124 : 180;
  const chans = guideChannels();
  const t0 = guideState.t0;
  const tEnd = t0 + G.hours * 3600e3;
  const width = G.left + G.hours * 60 * G.px;
  gInner.style.width = width + 'px';
  gInner.style.height = G.headH + chans.length * G.rowH + 'px';
  $('#guideEmpty').hidden = chans.length > 0;
  if (!chans.length) {
    const st = state.epgState[ws.pid];
    $('#guideEmpty').textContent = !ws.items.length ? 'Load a playlist first.'
      : st === 'loading' ? 'Loading the programme guide…'
      : 'No channels with guide data here. Untick the filter above to list every channel.';
  }

  let ticks = `<div class="g-corner">${esc(fmtDay(t0))}</div>`;
  for (let t = t0; t < tEnd; t += 1800e3) {
    const x = G.left + ((t - t0) / 60e3) * G.px;
    const d = new Date(t);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    ticks += `<div class="g-tick${midnight ? ' day' : ''}" style="left:${x}px">${midnight ? esc(fmtDay(t)) + ' ' : ''}${fmtTime(t)}</div>`;
  }
  gHead.innerHTML = ticks;
  gHead.style.width = width + 'px';
  $('#gRange').textContent = `${fmtDay(t0)} ${fmtTime(t0)} – ${fmtTime(tEnd)}`;

  const top = gScroll.scrollTop;
  const h = gScroll.clientHeight || 600;
  const first = Math.max(0, Math.floor((top - G.headH) / G.rowH) - 3);
  const last = Math.min(chans.length, Math.ceil((top + h - G.headH) / G.rowH) + 3);
  const now = Date.now();
  let html = '';
  for (let i = first; i < last; i++) {
    const ch = chans[i];
    const list = programmesFor(ch);
    const active = state.current && state.current.uid === ch.uid;
    let cells = '';
    if (!list) cells = `<div class="g-none" style="left:${G.left}px">No guide data</div>`;
    else {
      let prevEnd = 0;   // providers sometimes send overlapping entries: draw each one only after the previous has ended
      for (let j = 0; j < list.length; j++) {
        const p = list[j];
        if (p[1] <= t0 || p[0] >= tEnd) continue;
        if (p[1] <= prevEnd) continue;
        const s = Math.max(p[0], t0, prevEnd);
        prevEnd = p[1];
        const e = Math.min(p[1], tEnd);
        const x = G.left + ((s - t0) / 60e3) * G.px;
        const w = Math.max(4, ((e - s) / 60e3) * G.px - 3);
        const live = p[0] <= now && now < p[1];
        const sel = guideState.selected && guideState.selected.uid === ch.uid && guideState.selected.start === p[0];
        cells += `<div class="g-prog${live ? ' live' : ''}${sel ? ' sel' : ''}" data-i="${i}" data-j="${j}" style="left:${x}px;width:${w}px" title="${esc(p[2])}"><b>${esc(p[2] || 'Untitled')}</b>${w > 90 ? `<small>${fmtTime(p[0])}–${fmtTime(p[1])}</small>` : ''}</div>`;
      }
    }
    html += `<div class="g-row" style="top:${G.headH + i * G.rowH}px;width:${width}px">
      <div class="g-chan${active ? ' active' : ''}" data-i="${i}" title="Watch ${esc(ch.name)}">
        <div class="logo">${logoHtml(ch)}</div>
        <span>${esc(ch.name)}</span>
      </div>${cells}</div>`;
  }
  gRows.innerHTML = html;
  placeNowLine();
}

function placeNowLine() {
  const now = Date.now();
  const x = G.left + ((now - guideState.t0) / 60e3) * G.px;
  const visible = now >= guideState.t0 && now <= guideState.t0 + G.hours * 3600e3;
  gNowLine.style.display = visible ? 'block' : 'none';
  gNowLine.style.left = x + 'px';
  gNowLine.style.top = G.headH + 'px';
}

let lastGuideTop = -1;
gScroll.addEventListener('scroll', () => { if (gScroll.scrollTop !== lastGuideTop) { lastGuideTop = gScroll.scrollTop; renderGuide(); } }, { passive: true });
gRows.addEventListener('click', (e) => {
  const chans = guideState.chans;
  const chEl = e.target.closest('.g-chan');
  if (chEl) { const ch = chans[+chEl.dataset.i]; if (ch) playChannel(ch); return; }
  const pEl = e.target.closest('.g-prog');
  if (!pEl) return;
  const ch = chans[+pEl.dataset.i];
  const list = ch && programmesFor(ch);
  const prog = list && list[+pEl.dataset.j];
  if (!prog) return;
  guideState.selected = { uid: ch.uid, start: prog[0] };
  const box = $('#guideDetail');
  const live = prog[0] <= Date.now() && Date.now() < prog[1];
  box.hidden = false;
  box.innerHTML = `<h4>${esc(prog[2] || 'Untitled')}</h4>
    <button class="btn" id="gWatch">${live ? 'Watch now' : 'Watch channel'}</button>
    <p class="muted">${esc(ch.name)} · ${esc(fmtDay(prog[0]))} ${fmtTime(prog[0])} – ${fmtTime(prog[1])}</p>
    ${prog[3] ? `<p>${esc(prog[3])}</p>` : ''}`;
  $('#gWatch').onclick = () => playChannel(ch);
  renderGuide();
});
$('#gPrev').onclick = () => { guideState.t0 -= 4 * 3600e3; renderGuide(); };
$('#gNext').onclick = () => { guideState.t0 += 4 * 3600e3; renderGuide(); };
$('#gNow').onclick = () => { guideReset(); renderGuide(); gScroll.scrollLeft = 0; };
$('#gOnlyEpg').onchange = () => { guideState.dirty = true; gScroll.scrollTop = 0; renderGuide(); };

/* ─────────────────────────────── cards (posters / tiles) ─────────────────────────────── */
function imgHtml(it, vod) {
  return it.logo && /^https?:\/\//i.test(it.logo)
    ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(it.logo)}" data-i="${esc(vod ? '' : initials(it.name))}" alt="">`
    : vod ? '<svg class="ic ph-film"><use href="#i-film"/></svg>' : `<span class="ph">${esc(initials(it.name))}</span>`;
}

// Works for full items and for snapshots (Favorites, Recently viewed).
function cardHtml(it, o = {}) {
  cardIndex.set(it.uid, it); // the global click handler (ui.js) looks the item up here
  const kind = kindOf(it);
  const vod = kind !== 'live';
  const fav = state.favs.has(it.uid);
  const pr = progressOf(it.uid);
  const pct = pr && pr.d && !pr.w && pr.t > 10 ? Math.round((pr.t / pr.d) * 100) : 0;
  let title = it.name;
  let sub = o.sub || '';
  if (kind === 'episode') { title = it.seriesName || it.name; sub = sub || `S${String(it.season || 1).padStart(2, '0')}E${String(it.num || 0).padStart(2, '0')}`; }
  const rating = vod && it.rating ? `<span class="badge"><svg class="ic"><use href="#i-star"/></svg>${esc(it.rating)}</span>` : '';
  const tag = o.tag ? `<span class="badge kind">${esc(o.tag)}</span>` : '';
  return `<div class="card ${vod ? 'poster-card' : 'live-card'}" data-uid="${esc(it.uid)}" tabindex="0" role="button" title="${esc(title)}">
    <div class="c-img">${imgHtml(it, vod)}${rating}${tag}${vod ? '' : '<button class="multi-btn" data-multi title="Add to Multi view" aria-label="Add to Multi view"><svg class="ic"><use href="#i-multi"/></svg></button>'}<button class="fav${fav ? ' on' : ''}" data-fav aria-label="Favorite"><svg class="ic"><use href="#${fav ? 'i-heart-fill' : 'i-heart'}"/></svg></button>${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>
    <div class="c-title">${esc(title)}</div>${sub ? `<div class="c-sub">${esc(sub)}</div>` : ''}</div>`;
}

/* ─────────────────────────────── movies / series: grid ─────────────────────────────── */
const SORTS = {
  added: (a, b) => b.added - a.added || a.num - b.num,
  az: (a, b) => collator.compare(a.name, b.name),
  rating: (a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0) || a.num - b.num,
  year: (a, b) => (Number(b.year) || 0) - (Number(a.year) || 0) || a.num - b.num,
};
const SORT_LABELS = { added: 'Newest', az: 'A – Z', rating: 'Top rated', year: 'Release year', '': 'Provider order' };
const refineActive = () => ws.refine.rating > 0 || ws.refine.year > 0 || ws.refine.fav;

function buildVodView() {
  const q = ws.vq.trim().toLowerCase();
  let list = ws.items;
  if (ws.cat === '*fav') list = list.filter((c) => state.favs.has(c.uid));
  else if (ws.cat !== '*') list = list.filter((c) => c.group === ws.cat);
  if (ws.refine.fav) list = list.filter((c) => state.favs.has(c.uid));
  if (ws.refine.rating) list = list.filter((c) => (parseFloat(c.rating) || 0) >= ws.refine.rating);
  if (ws.refine.year) list = list.filter((c) => (Number(c.year) || 0) >= ws.refine.year);
  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q));
  if (SORTS[ws.sort]) list = [...list].sort(SORTS[ws.sort]);
  ws.vodView = list;
}

function renderCats() {
  const el = $('#catList');
  el.innerHTML = catsHtml(ws.mode === 'movie' ? 'All items' : 'All items');
  el.classList.toggle('compact', ws.compact);
  $('#vodCatCompact').classList.toggle('on', ws.compact);
  $('#vodCatsTitle').textContent = ws.mode === 'movie' ? 'Movie Categories' : 'Series Categories';
}

function renderVod() {
  renderCats();
  buildVodView();
  const grid = $('#vodGrid');
  grid.innerHTML = '';
  ws.shown = 0;
  $('#vodTitle').textContent = catLabel();
  $('#vodSortLabel').textContent = SORT_LABELS[ws.sort] || 'Newest';
  $('#vodRefine').classList.toggle('on', refineActive());
  $('#vodStatus').innerHTML = '';
  $('#vodCount').textContent = ws.loading ? '' : `${ws.vodView.length.toLocaleString()} items`;
  const empty = $('#vodEmpty');
  if (ws.loading) { empty.hidden = false; empty.innerHTML = '<div class="spinner"></div><p>Loading…</p>'; }
  else if (ws.errors.length) { empty.hidden = false; empty.innerHTML = `<p><b>Couldn’t load this list</b></p><p>${esc(ws.errors[0])}</p><button class="btn small" data-act="edit-pl">Edit playlist</button>`; }
  else if (!ws.items.length) { empty.hidden = false; empty.textContent = `No ${ws.mode === 'movie' ? 'movies' : 'series'} in this playlist.`; }
  else if (!ws.vodView.length) { empty.hidden = false; empty.textContent = ws.cat === '*fav' && !ws.vq ? 'Tap the ♡ on a title to add it here.' : 'Nothing matches.'; }
  else empty.hidden = true;
  syncTopSearch();
  appendCards();
  $('#vodScroll').scrollTop = 0;
}

function appendCards() {
  const next = ws.vodView.slice(ws.shown, ws.shown + PAGE);
  if (!next.length) return;
  $('#vodGrid').insertAdjacentHTML('beforeend', next.map((it) => cardHtml(it)).join(''));
  ws.shown += next.length;
  // keep loading while the sentinel is still on screen
  requestAnimationFrame(() => { const m = $('#vodMore'); const r = m.getBoundingClientRect(); const vr = $('#vodScroll').getBoundingClientRect(); if (ws.shown < ws.vodView.length && r.top < vr.bottom + 400) appendCards(); });
}
new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting) && ws.shown < ws.vodView.length) appendCards(); }, { root: $('#vodScroll'), rootMargin: '600px' }).observe($('#vodMore'));

wireCats('vod', 'catList', (catsOnly) => { if (catsOnly) renderCats(); else { ws.vq = ''; $('#topInput').value = ''; renderVod(); } });
$('#vodSortBtn').addEventListener('click', (e) => {
  showMenu(e.currentTarget, [{ label: 'Sort by', heading: true }, ...Object.entries(SORT_LABELS).map(([k, l]) => ({ label: (ws.sort === k ? '✓  ' : '      ') + l, run: () => { ws.sort = k; LS.set('tuner.sort', k); renderVod(); } }))]);
});
$('#vodRefine').addEventListener('click', (e) => {
  const on = (b) => (b ? '✓  ' : '      ');
  showMenu(e.currentTarget, [
    { label: 'Refine', heading: true },
    { label: on(ws.refine.rating === 6) + 'Rating 6 and up', run: () => { ws.refine.rating = ws.refine.rating === 6 ? 0 : 6; renderVod(); } },
    { label: on(ws.refine.rating === 7.5) + 'Rating 7.5 and up', run: () => { ws.refine.rating = ws.refine.rating === 7.5 ? 0 : 7.5; renderVod(); } },
    { label: on(ws.refine.year === 2020) + 'Released 2020 or later', run: () => { ws.refine.year = ws.refine.year === 2020 ? 0 : 2020; renderVod(); } },
    { label: on(ws.refine.fav) + 'Favorites only', run: () => { ws.refine.fav = !ws.refine.fav; renderVod(); } },
    { label: '      Clear', run: () => { ws.refine = { rating: 0, year: 0, fav: false }; renderVod(); } },
  ]);
});
$('#vodEmpty').addEventListener('click', (e) => { if (e.target.closest('[data-act="edit-pl"]')) openPlaylistDialog(wsPlaylist()); });

function refreshProgressBars() {
  $$('#vodGrid .card').forEach((c) => {
    const pr = progressOf(c.dataset.uid);
    const pct = pr && pr.d && !pr.w && pr.t > 10 ? Math.round((pr.t / pr.d) * 100) : 0;
    let bar = c.querySelector('.bar');
    if (pct && !bar) { c.querySelector('.c-img').insertAdjacentHTML('beforeend', '<div class="bar"><i></i></div>'); bar = c.querySelector('.bar'); }
    if (bar) { if (pct) bar.firstElementChild.style.width = pct + '%'; else bar.remove(); }
  });
}

/* ───────────────────────────── movie / series detail ───────────────────────────── */
function dockedInDetail() {
  const c = state.current;
  return !!(ws.detail && c && (c.uid === ws.detail.uid || c.seriesUid === ws.detail.uid));
}

function openDetail(it) {
  ws.detail = it;
  loadDetail(it);
  renderWsChrome();
  renderDetail();
  $('#wsDetail').scrollTop = 0;
}
function closeDetail() { ws.detail = null; renderWsChrome(); renderVod(); }

function runtimeLabel(info) {
  let sec = Number(info.duration_secs) || 0;
  if (!sec && info.duration) { const m = String(info.duration).match(/^(\d+):(\d+)(?::(\d+))?$/); if (m) sec = m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2]; }
  if (!sec && info.episode_run_time) sec = Number(info.episode_run_time) * 60;
  if (!sec && info.runtime) sec = Number(info.runtime) * 60;
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
const splitNames = (s) => String(s || '').split(/\s*[,;/]\s*/).map((x) => x.trim()).filter(Boolean);

function renderDetail() {
  const it = ws.detail;
  const box = $('#wsDetail');
  if (!it) { box.innerHTML = ''; return; }
  const keep = box.scrollTop;
  const d = state.detail[it.uid] || (it.seasons ? { info: {}, seasons: it.seasons } : {});
  const info = d.info || {};
  const poster = info.movie_image || info.cover_big || info.cover || it.logo;
  const bd = Array.isArray(info.backdrop_path) ? info.backdrop_path[0] : info.backdrop_path || info.backdrop || '';
  const plot = info.plot || info.description || it.plot || '';
  const castNames = splitNames(info.cast || info.actors || it.cast);
  const directors = splitNames(info.director);
  const rating = goodRating(info.rating || it.rating);
  const year = String(info.releasedate || info.release_date || it.year || '').slice(0, 4);
  const genres = splitNames(info.genre || it.genre).slice(0, 4);
  const runtime = runtimeLabel(info);
  const isFav = state.favs.has(it.uid);
  const playingUid = state.current && state.current.uid;
  const docked = dockedInDetail();
  const watched = (() => { const p = progressOf(it.uid); return !!(p && p.w); })();

  let primary = '', primarySub = '', primaryAct = '', seriesBlock = '';
  if (it.kind === 'movie') {
    const pr = progressOf(it.uid);
    const resume = pr && !pr.w && pr.t > 10;
    primary = resume ? 'Resume' : 'Play';
    primarySub = resume ? fmtDur(pr.t) : runtime;
    primaryAct = 'play';
  } else if (d.seasons) {
    const eps = allEpisodes(d.seasons);
    const isDone = (e) => { const p = progressOf(e.uid); return p && p.w; };
    const next = eps.find((e) => !isDone(e)) || eps[0];
    const nums = Object.keys(d.seasons).map(Number).sort((a, b) => a - b);
    const cur = state.season[it.uid] ?? (next ? next.season : nums[0]);
    if (next) {
      const p = progressOf(next.uid);
      primary = p && !p.w && p.t > 10 ? 'Resume' : eps.every((e) => !progressOf(e.uid)) ? 'Play' : 'Continue';
      primarySub = `S${String(next.season).padStart(2, '0')}E${String(next.num).padStart(2, '0')}`;
      primaryAct = `ep" data-uid="${esc(next.uid)}`;
    }
    seriesBlock = `<h3>Episodes<small>${eps.length}</small></h3><div class="seasons">${nums.map((n) => `<button class="chip-btn${n === cur ? ' on' : ''}" data-act="season" data-s="${n}">Season ${n}</button>`).join('')}</div>
      <div class="ep-list">${(d.seasons[cur] || []).map((e) => {
        const p = progressOf(e.uid);
        const pct = p && p.d && !p.w ? Math.round((p.t / p.d) * 100) : 0;
        return `<div class="ep${e.uid === playingUid ? ' playing' : ''}" data-act="ep" data-uid="${esc(e.uid)}">
          <span class="ep-n">${e.num || ''}</span>
          <div class="ep-main"><div class="ep-t">${esc(e.title)}</div>${e.plot ? `<div class="ep-p">${esc(e.plot)}</div>` : ''}${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>
          <span class="ep-d">${p && p.w ? '✓' : esc(e.duration || '')}</span></div>`;
      }).join('')}</div>`;
  } else if (d.loading) seriesBlock = '<p class="muted">Loading episodes…</p>';
  else if (d.error) seriesBlock = `<p class="err-text">Couldn’t load episodes: ${esc(d.error)}</p>`;

  const art = poster && /^https?:\/\//i.test(poster) ? poster : '';
  const back = bd && /^https?:\/\//i.test(bd) ? bd : '';
  const chips = [year, runtime, ...genres.slice(0, 3), info.country, rating && '★ ' + rating].filter(Boolean);
  const trailer = info.youtube_trailer ? (/^https?:/.test(info.youtube_trailer) ? info.youtube_trailer : 'https://www.youtube.com/watch?v=' + info.youtube_trailer) : '';
  const crew = [...directors.slice(0, 4).map((n) => [n, 'Director']), ...castNames.slice(0, 12).map((n) => [n, 'Actor'])];
  const pl = wsPlaylist();

  box.innerHTML = `<div class="detail-in">
    ${docked ? '<div class="dt-slot-wrap"><div id="detailSlot" class="player-slot detail-slot"></div></div>' : ''}
    <div class="dt-hero">
      <div class="dt-bg${back ? '' : ' blur'}" style="${(back || art) ? `background-image:url('${esc(back || art)}')` : ''}"></div>
      <div class="dt-in"><div class="dt-top">
        <div class="dt-poster">${art ? `<img referrerpolicy="no-referrer" src="${esc(art)}" alt="">` : `<span>${esc(initials(it.name))}</span>`}</div>
        <div class="dt-info">
          <div class="dt-eyebrow">${it.kind === 'movie' ? 'Movie' : 'Series'} · ${esc(pl ? pl.name : '')}</div>
          <h2>${esc(it.name)}</h2>
          ${chips.length ? `<div class="dt-chips">${chips.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''}
          ${plot ? `<p class="dt-plot" id="dtPlot">${esc(plot)}</p>${plot.length > 260 ? '<button class="dt-more" data-act="more">More ⌄</button>' : ''}` : d.loading ? '<p class="muted">Loading details…</p>' : ''}
          <div class="dt-btns">
            ${primary ? `<button class="btn white" data-act="${primaryAct}"><svg class="ic fill"><use href="#i-play"/></svg><span>${esc(primary)}${primarySub ? `<small>${esc(primarySub)}</small>` : ''}</span></button>` : ''}
            ${trailer ? `<button class="btn ghost" data-act="trailer" data-href="${esc(trailer)}"><svg class="ic fill"><use href="#i-youtube"/></svg>Trailer</button>` : ''}
            <button class="btn sq${isFav ? ' on' : ''}" data-act="fav" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="Favorite"><svg class="ic"><use href="#${isFav ? 'i-heart-fill' : 'i-heart'}"/></svg></button>
            ${it.kind === 'movie' ? `<button class="btn sq${watched ? ' on' : ''}" data-act="watched" title="${watched ? 'Mark as not watched' : 'Mark as watched'}" aria-label="Watched"><svg class="ic"><use href="#i-check"/></svg></button>
            <button class="btn sq" data-act="copy" title="Copy stream link" aria-label="Copy stream link"><svg class="ic"><use href="#i-download"/></svg></button>` : ''}
            ${it.kind === 'movie' ? `<button class="btn sq" data-act="more-menu" title="More" aria-label="More"><svg class="ic"><use href="#i-more"/></svg></button>` : ''}
          </div>
          ${(castNames.length || directors.length) ? `<dl class="dt-facts">${castNames.length ? `<dt>Starring</dt><dd>${esc(castNames.slice(0, 3).join(', '))}${castNames.length > 3 ? ' <span class="muted">and more</span>' : ''}</dd>` : ''}${directors.length ? `<dt>Director</dt><dd>${esc(directors.slice(0, 5).join(', '))}</dd>` : ''}</dl>` : ''}
        </div>
      </div></div>
    </div>
    <div class="dt-sec">
      ${crew.length ? `<h3>Cast &amp; crew<small>${crew.length}</small></h3><div class="cast-row">${crew.map(([n, r]) => `<div class="cast"><div class="av">${esc(initials(n))}</div><b>${esc(n)}</b><small>${r}</small></div>`).join('')}</div>` : ''}
      ${seriesBlock}
    </div></div>`;
  box.scrollTop = keep;
  layoutPlayer();
}

$('#wsDetail').addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);
$('#wsDetail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  const it = ws.detail;
  if (!b || !it) return;
  const act = b.dataset.act;
  const toPlayer = () => { $('#wsDetail').scrollTop = 0; };   // bring the picture into view before it starts
  if (act === 'close') closeDetail();
  else if (act === 'play') { toPlayer(); playChannel(withBestUrl(it)); }
  else if (act === 'restart') { delete state.progress[it.uid]; persistProgress(); toPlayer(); playChannel(withBestUrl(it)); }
  else if (act === 'season') { state.season[it.uid] = Number(b.dataset.s); renderDetail(); }
  else if (act === 'ep') {
    const ep = allEpisodes((state.detail[it.uid] || it).seasons).find((x) => x.uid === b.dataset.uid);
    if (ep) { toPlayer(); playChannel(ep); }
  } else if (act === 'copy') copyLink(withBestUrl(it), b);
  else if (act === 'fav') toggleFavItem(it);
  else if (act === 'more') { const p = $('#dtPlot'); p.classList.toggle('open'); b.textContent = p.classList.contains('open') ? 'Less ⌃' : 'More ⌄'; }
  else if (act === 'trailer') window.open(b.dataset.href, '_blank', 'noopener');
  else if (act === 'watched') {
    const p = progressOf(it.uid);
    if (p && p.w) delete state.progress[it.uid]; else state.progress[it.uid] = { t: 0, d: (p && p.d) || 0, w: 1, ts: Date.now() };
    persistProgress(); renderDetail();
  } else if (act === 'more-menu') {
    showMenu(b, [
      { label: 'Start over', run: () => { delete state.progress[it.uid]; persistProgress(); toPlayer(); playChannel(withBestUrl(it)); } },
      { label: 'Copy stream link', run: () => copyLink(withBestUrl(it)) },
    ]);
  }
});

// Wait until the details (episodes) of a series are available, e.g. when opening an episode from "Continue watching".
async function detailReady(it) {
  await loadDetail(it);
  for (let i = 0; i < 100; i++) {
    const d = state.detail[it.uid];
    if (d && !d.loading) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
  return state.detail[it.uid] || {};
}

/* ────────────────────────────────── UI hooks ────────────────────────────────── */
let epgTimer = 0;
function uiEpgUpdated() {
  clearTimeout(epgTimer);
  epgTimer = setTimeout(() => {
    mvRefreshNames();
    if (ui.route !== 'ws' || ws.mode !== 'live') return;
    renderLiveStatus();
    if (ws.lv === 'channels') { renderLiveList(); renderLiveInfo(); } else { guideState.dirty = true; renderGuide(); }
  }, 60);
}

function uiDetailLoaded(it) { if (ws.detail && ws.detail.uid === it.uid && ui.route === 'ws') renderDetail(); }

let playbackFrame = 0;
function uiPlayback() {
  cancelAnimationFrame(playbackFrame);
  playbackFrame = requestAnimationFrame(() => {
    layoutPlayer();
    updatePlayerChrome();
    if (ui.route === 'ws') {
      if (ws.mode === 'live') { if (ws.lv === 'channels') { renderLiveList(); renderLiveInfo(); } else renderGuide(); }
      else if (ws.detail) renderDetail();
      else refreshProgressBars();
    } else if (['dashboard', 'recent'].includes(ui.route)) renderRoute(ui.route);
  });
}

function uiFavChanged(uid) {
  const on = state.favs.has(uid);
  $$('[data-uid]').forEach((el) => {
    if (el.dataset.uid !== uid) return;
    const f = el.querySelector('[data-fav]');
    if (f) { f.classList.toggle('on', on); f.innerHTML = `<svg class="ic"><use href="#${on ? 'i-heart-fill' : 'i-heart'}"/></svg>`; }
  });
  if (ui.route === 'ws') {
    if (ws.mode === 'live') {
      if (ws.cat === '*fav') renderLive(); else { renderLiveCats(); renderLiveInfo(); }
      if (ws.lv === 'guide') { guideState.dirty = true; renderGuide(); }
    } else if (ws.detail) renderDetail();
    else if (ws.cat === '*fav' || ws.refine.fav) renderVod(); else renderCats();
  } else if (ui.route === 'favorites') renderRoute('favorites');
  updatePlayerChrome();
}
