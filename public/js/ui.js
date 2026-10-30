'use strict';
/* AG Horizon – application shell: navigation, themes, player docking, pages, command palette, shortcuts. */

const ui = { route: null, hist: [] };
const ROUTE_TITLES = { dashboard: 'Dashboard', playlists: 'Playlists', favorites: 'Favorites', recent: 'Recently viewed', search: 'Search', settings: 'Settings' };
const cardIndex = new Map(); // uid -> item or snapshot, filled by cardHtml()
const ago = (ts) => {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
};

/* ───────────────────────────── toasts & menus ───────────────────────────── */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 3800);
  setTimeout(() => el.remove(), 4300);
}

function showMenu(anchor, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => it.heading ? `<div class="menu-h">${esc(it.label)}</div>` : `<button class="menu-i" data-i="${i}">${esc(it.label)}</button>`).join('');
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + 'px';
  m.style.top = (r.bottom + 6 + h < innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + 'px';
  m._items = items;
}
$('#menu').addEventListener('click', (e) => {
  const b = e.target.closest('.menu-i');
  if (!b) return;
  const it = $('#menu')._items[+b.dataset.i];
  $('#menu').hidden = true;
  if (it && it.run) it.run();
});
document.addEventListener('mousedown', (e) => { if (!$('#menu').hidden && !e.target.closest('#menu')) $('#menu').hidden = true; }, true);

/* ───────────────────────────────── theme ───────────────────────────────── */
const ACCENTS = {
  blue: ['#6ea1ff', '#06142b'], violet: ['#a78bfa', '#150a33'], green: ['#3ecf8e', '#04170f'],
  pink: ['#ff6b9d', '#2a0615'], amber: ['#ffb347', '#1a1204'],
};
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const pref = LS.get('tuner.theme', 'dark');
  const dark = pref === 'system' ? prefersDark.matches : pref === 'dark';
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  const [a, ink] = ACCENTS[LS.get('tuner.accent', 'blue')] || ACCENTS.blue;
  root.style.setProperty('--accent', a);
  root.style.setProperty('--accent-ink', ink);
  $('#btnTheme use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
}
prefersDark.addEventListener('change', applyTheme);
$('#btnTheme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme === 'dark';
  LS.set('tuner.theme', dark ? 'light' : 'dark');
  applyTheme();
  if (ui.route === 'settings') renderSettings();
});

/* ─────────────────────────────── navigation ─────────────────────────────── */
function updateBack() { $('#btnBack').hidden = !(ui.hist.length || (ui.route === 'ws' && ws.detail)); }

function go(route, params = {}, { push = true } = {}) {
  if (push && ui.route && (ui.route !== route || route === 'ws')) {
    ui.hist.push({ route: ui.route, ws: ui.route === 'ws' ? { pid: ws.pid, mode: ws.mode, detail: ws.detail ? ws.detail.uid : null } : null });
    if (ui.hist.length > 40) ui.hist.shift();
  }
  ui.route = route;
  $$('#views > .view').forEach((v) => { v.hidden = v.id !== 'v-' + route; });
  $$('#nav [data-route]').forEach((b) => b.classList.toggle('on', b.dataset.route === route));
  updateSwitcher();
  if (route === 'ws') renderWsChrome(); else { renderRoute(route); syncTopSearch(); syncNavState(); }
  updateBack();
  layoutPlayer();
}

async function goBack() {
  if (ui.route === 'ws' && ws.detail) { closeDetail(); updateBack(); return; }
  const h = ui.hist.pop();
  if (!h) { updateBack(); return; }
  if (h.route === 'ws' && h.ws && playlistById(h.ws.pid)) {
    await openWorkspace(h.ws.pid, h.ws.mode, { push: false });
    if (h.ws.detail) { const it = ws.items.find((i) => i.uid === h.ws.detail); if (it) openDetail(it); }
  } else go(h.route === 'ws' ? 'dashboard' : h.route, {}, { push: false });
  updateBack();
}
$('#btnBack').addEventListener('click', goBack);

function renderRoute(route) {
  const fn = { dashboard: renderDashboard, playlists: renderPlaylists, favorites: renderFavorites, recent: renderRecent, search: renderSearch, settings: renderSettings }[route];
  if (fn) fn();
}

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.route) { go(b.dataset.route); if (b.dataset.route === 'search') setTimeout(() => $('#topInput').focus(), 30); }
  else if (b.dataset.mode) {
    const pid = curPid();
    if (!pid) { go('playlists'); return; }
    const m = b.dataset.mode === 'guide' ? 'live' : b.dataset.mode;
    if (ui.route === 'ws' && ws.pid === pid && ws.mode === m) { ws.cat = '*'; ws.catQ = ''; ws.q = ''; ws.vq = ''; ws.detail = null; }   // the rail icon returns to "All items"
    openWorkspace(pid, b.dataset.mode);
  }
});
$('#btnHome').addEventListener('click', () => go('dashboard'));
$('#btnAdd').addEventListener('click', () => openPlaylistDialog());
$('#btnKeys').addEventListener('click', openHelp);
$('#btnMirror').addEventListener('click', (e) => mirrorButton(e.currentTarget));

function curPid() {
  if (ws.pid && playlistById(ws.pid)) return ws.pid;
  const last = LS.get('tuner.lastPid', '');
  if (last && playlistById(last)) return last;
  return state.playlists[0] ? state.playlists[0].id : null;
}
function updateSwitcher() {
  const p = playlistById(curPid());
  $('#plName').textContent = p ? p.name : 'No playlist';
  $('#plType').textContent = p ? typeLabel(p) : 'Add one to start';
  const dot = $('#plDot');
  if (dot) { dot.className = 'dot ' + (p ? statusOf(p) : 'hidden'); }
}
function syncNavState() {
  const inWs = ui.route === 'ws';
  $$('#nav [data-mode]').forEach((b) => {
    const m = b.dataset.mode;
    const on = inWs && ((m === 'guide' && ws.mode === 'live' && ws.lv === 'guide') || (m === 'live' && ws.mode === 'live' && ws.lv === 'channels') || (m !== 'live' && m !== 'guide' && m === ws.mode));
    b.classList.toggle('on', on);
    b.disabled = !state.playlists.length;
  });
  $('#btnHome').classList.toggle('on', ui.route === 'dashboard');
}
$('#plSwitch').addEventListener('click', openSwitcher);
function uiPlaylistsChanged() {
  updateSwitcher(); syncNavState();
  if (['playlists', 'dashboard'].includes(ui.route)) renderRoute(ui.route);
}

/* ───────────────────────────── docked / mini player ───────────────────────────── */
function currentSlot() {
  const c = state.current;
  if (ui.route !== 'ws' || !c) return null;
  if (ws.mode === 'live' && ws.lv === 'channels' && !isVod(c) && $('#wsLive').dataset.view === 'list') return $('#liveSlot');
  if (ws.mode !== 'live' && ws.detail && dockedInDetail()) return $('#detailSlot');
  return null;
}

function layoutPlayer() {
  const el = $('#player');
  if (!state.current) { el.hidden = true; return; }
  el.hidden = false;
  if (document.fullscreenElement === el) return;
  const slot = currentSlot();
  let docked = false;
  if (slot) {
    const b = slot.getBoundingClientRect();
    const floor = $('#wsBody').getBoundingClientRect().top;
    if (b.width > 60 && b.height > 40 && b.top >= floor - 2 && b.top < innerHeight - 60) {
      docked = true;
      Object.assign(el.style, { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px' });
    }
  }
  el.classList.toggle('mini', !docked);
  if (!docked) {
    const w = Math.min(390, innerWidth - 24);
    const h = Math.round((w * 9) / 16);
    Object.assign(el.style, { left: innerWidth - w - 18 + 'px', top: innerHeight - h - 18 + 'px', width: w + 'px', height: h + 'px' });
  }
}
let layoutFrame = 0;
const schedLayout = () => { cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(layoutPlayer); };
window.addEventListener('resize', schedLayout);
document.addEventListener('scroll', schedLayout, true);
const layoutObserver = new ResizeObserver(schedLayout);
['#views', '#liveSlot', '#liveMain', '#wsLive', '#wsDetail'].forEach((s) => layoutObserver.observe($(s)));  // the player follows its slot when it resizes

function playerTitle(c) {
  if (c.kind === 'episode') return `${c.seriesName || ''} · S${String(c.season || 1).padStart(2, '0')}E${String(c.num || 0).padStart(2, '0')}`;
  return c.name;
}
function updatePlayerChrome() {
  const c = state.current;
  const open = mirrorOpen();
  $('#btnMirror').classList.toggle('on', open);
  $('#pMirror').classList.toggle('on', open);
  if (!c) { document.title = 'AG Horizon'; return; }
  $('#pTitle').textContent = playerTitle(c);
  const fav = state.favs.has(c.uid) || (c.kind === 'episode' && state.favs.has(c.seriesUid));
  $('#pFav').classList.toggle('on', fav);
  $('#pFav use').setAttribute('href', fav ? '#i-heart-fill' : '#i-heart');
  document.title = playerTitle(c) + ' – AG Horizon';
}
function uiMirrorChanged() { updatePlayerChrome(); if (ui.route === 'settings') renderSettings(); }
function uiCaps() { if (ui.route === 'settings') renderSettings(); }

$('#pFav').addEventListener('click', () => { const c = state.current; if (c) toggleFavItem(c.kind === 'episode' && ws.detail ? ws.detail : c); });
$('#pMirror').addEventListener('click', (e) => mirrorButton(e.currentTarget));
$('#pPip').addEventListener('click', togglePip);
$('#pFull').addEventListener('click', toggleFullscreen);
$('#pExpand').addEventListener('click', () => { if (state.current) openItem(state.current); });
$('#pClose').addEventListener('click', stopPlayback);

/* ─────────────────────────────── opening items ─────────────────────────────── */
async function openItem(it) {
  if (!it) return;
  const mode = modeOf(it);
  const inPlace = ui.route === 'ws' && ws.pid === it.pid && ws.mode === mode && !ws.loading;
  if (!inPlace) {
    if (!playlistById(it.pid)) { toast('That playlist was removed.', 'err'); return; }
    await openWorkspace(it.pid, mode);
  }
  const wanted = it.kind === 'episode' ? it.seriesUid : it.uid;
  const real = ws.items.find((i) => i.uid === wanted);
  if (!real) { toast('That title is not in the playlist any more.', 'err'); return; }

  if (mode === 'live') {
    ws.lv = 'channels';
    ws.q = ''; $('#topInput').value = '';
    // show the channel in a list next to the player: keep the category if it contains the channel, else use its own group
    const inCat = ws.cat === '*fav' ? state.favs.has(real.uid) : ws.cat === '*recent' ? true : ws.cat === real.group;
    if (!inCat) ws.cat = real.group;
    ws.lists = true;
    renderWsChrome();
    renderLive();
    playChannel(real);
    setTimeout(() => scrollLiveTo(real.uid), 60);
  } else if (it.kind === 'episode') {
    openDetail(real);
    const d = await detailReady(real);
    const ep = allEpisodes((d && d.seasons) || {}).find((e) => e.uid === it.uid);
    if (ep) { state.season[real.uid] = ep.season; playChannel(ep); }
  } else {
    openDetail(real);
  }
}

// one click handler for every poster / tile in the app
document.addEventListener('click', (e) => {
  const card = e.target.closest('.card[data-uid]');
  if (!card) return;
  const it = cardIndex.get(card.dataset.uid);
  if (!it) return;
  if (e.target.closest('[data-fav]')) { toggleFavItem(it); return; }
  openItem(it);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('card')) e.target.click(); });
document.addEventListener('error', logoFailed, true);

/* ─────────────────────────────── page building blocks ─────────────────────────────── */
const pageHead = (title, sub, actions = '') => `<div class="page-head"><div><h2>${esc(title)}</h2>${sub ? `<p class="muted">${sub}</p>` : ''}</div><div class="grow"></div>${actions}</div>`;
const emptyState = (icon, title, text, action = '') => `<div class="empty-state"><svg class="ic xl"><use href="#${icon}"/></svg><h3>${esc(title)}</h3><p>${text}</p>${action}</div>`;
const addBtn = '<button class="btn" data-act="add-pl"><svg class="ic"><use href="#i-plus"/></svg>Add playlist</button>';
function rail(title, items, { route, tagFn, subFn } = {}) {
  if (!items.length) return '';
  return `<section class="rail"><div class="rail-head"><h3>${esc(title)}</h3>${route ? `<button class="link" data-act="goto" data-route="${route}">See all</button>` : ''}</div>
    <div class="rail-row">${items.map((it) => cardHtml(it, { tag: tagFn && tagFn(it), sub: subFn && subFn(it) })).join('')}</div></section>`;
}
const KIND_TAG = { live: 'Live', movie: 'Movie', series: 'Series', episode: 'Series' };

function continueWatching() {
  const out = [];
  for (const [uid, p] of Object.entries(state.progress)) {
    if (!p || p.w || !(p.t > 10) || !(p.d > 0)) continue;
    const s = state.recent.find((r) => r.uid === uid) || state.favdata[uid];
    if (s && playlistById(s.pid)) out.push({ ...s, _ts: p.ts });
  }
  return out.sort((a, b) => b._ts - a._ts).slice(0, 20);
}

/* ─────────────────────────────────── dashboard ─────────────────────────────────── */
const hero = { i: 0, items: [], paused: false, timer: 0 };
const hasImg = (it) => it.logo && /^https?:\/\//i.test(it.logo);
function chanCard(it) {
  cardIndex.set(it.uid, it);
  // favourites / history only keep a light snapshot: look up the full channel so the guide can be matched
  const base = state.cache[it.pid];
  const full = (base && base.channels.find((c) => c.uid === it.uid)) || it;
  const { now } = nowNext(full);
  const pct = now ? Math.max(0, Math.min(100, ((Date.now() - now[0]) / (now[1] - now[0])) * 100)) : 0;
  return `<div class="chan-card card" data-uid="${esc(it.uid)}" tabindex="0" role="button"><div class="logo">${logoHtml(it)}</div>
    <b title="${esc(it.name)}">${esc(it.name)}</b><small>${esc(now ? now[2] || 'On air' : it.group || '')}</small>
    <div class="cc-live"><span class="live-badge"><i></i>LIVE</span><div class="bar"><i style="width:${pct.toFixed(0)}%"></i></div>${now ? `<span>${fmtTime(now[0])} – ${fmtTime(now[1])}</span>` : ''}</div></div>`;
}
function dashRail(title, itemsHtml, count, route) {
  if (!itemsHtml) return '';
  return `<section class="rail"><div class="rail-head"><h3>${esc(title)}</h3>${count != null ? `<span class="pill">${count}</span>` : ''}${route ? `<button class="link" data-act="goto" data-route="${route}">See all ›</button>` : ''}</div><div class="rail-row">${itemsHtml}</div></section>`;
}
function heroCandidates() {
  const all = allCachedItems();
  const newest = [...all.movie, ...all.series].filter(hasImg).sort((a, b) => (b.added || 0) - (a.added || 0)).slice(0, 5).map((it) => ({ it, tag: 'Recently added' }));
  if (newest.length) return newest;
  const rec = state.recent.filter((r) => playlistById(r.pid) && r.kind !== 'live' && hasImg(r)).slice(0, 5).map((it) => ({ it, tag: 'Recently watched' }));
  if (rec.length) return rec;
  return Object.values(state.favdata).filter((f) => playlistById(f.pid) && f.kind !== 'live' && hasImg(f)).slice(0, 5).map((it) => ({ it, tag: 'Favorite' }));
}
function renderHero() {
  const box = $('#heroBox');
  if (!box) return;
  const c = hero.items[hero.i % Math.max(1, hero.items.length)];
  if (!c) { box.innerHTML = ''; return; }
  const { it, tag } = c;
  const pl = playlistById(it.pid);
  box.innerHTML = `<div class="hero-bg"></div><div class="hero-img" style="background-image:url('${esc(it.logo)}')"></div>
    <div class="hero-in"><div class="hero-eyebrow">${esc(KIND_LABEL[kindOf(it)] || 'Movie')} · ${esc(tag)}</div>
      <h1>${esc(it.name)}</h1><span class="hero-chip">${esc(pl ? pl.name : '')}</span>
      <div class="hero-act"><button class="btn white" data-act="hero-open"><svg class="ic"><use href="#i-info"/></svg>Details</button>
        <div class="hero-dots"><button class="hd-pause" data-act="hero-pause" aria-label="${hero.paused ? 'Resume' : 'Pause'} slideshow"><svg class="ic fill"><use href="#${hero.paused ? 'i-play' : 'i-pause'}"/></svg></button>${hero.items.map((_, k) => `<button data-act="hero-go" data-k="${k}" class="${k === hero.i % hero.items.length ? 'on' : ''}" aria-label="Show ${k + 1}"></button>`).join('')}</div></div></div>`;
}
function renderDashboard() {
  const el = $('#v-dashboard');
  clearInterval(hero.timer);
  if (!state.playlists.length) {
    el.innerHTML = `<div class="page">${emptyState('i-nav-live', 'Welcome to AG Horizon', 'Add an Xtream Codes login or an M3U playlist to start watching live TV, movies and series.', addBtn)}</div>`;
    return;
  }
  hero.items = heroCandidates();
  if (hero.i >= hero.items.length) hero.i = 0;
  const cont = continueWatching();
  const live = (list) => list.filter((r) => playlistById(r.pid) && r.kind === 'live');
  const favLive = live(Object.values(state.favdata).reverse()).slice(0, 20);
  const recLive = live(state.recent).slice(0, 20);
  const recVod = state.recent.filter((r) => playlistById(r.pid) && r.kind !== 'live').slice(0, 20);
  const added = [...allCachedItems().movie].sort((a, b) => (b.added || 0) - (a.added || 0)).slice(0, 20);
  const cards = (list, o) => list.map((s) => cardHtml(s, o)).join('');
  const sources = state.playlists.map((p) => `<button class="src-card" data-act="pl-open" data-pid="${esc(p.id)}"><div class="src-img"><svg class="ic"><use href="#i-cloud"/></svg></div><b>${esc(p.name)}</b><small>${esc(typeLabel(p))}</small></button>`).join('');
  const body = dashRail('Continue watching', cards(cont), cont.length)
    + dashRail('Live now on your favorites', favLive.map(chanCard).join(''), favLive.length, 'favorites')
    + dashRail('Recently watched live TV', recLive.map(chanCard).join(''), recLive.length, 'recent')
    + dashRail('Recently watched', cards(recVod, { tag: '' }), recVod.length, 'recent')
    + dashRail('Recently used sources', sources, state.playlists.length, 'playlists')
    + dashRail('Recently added', cards(added), added.length);
  el.innerHTML = `<div class="dash">
    ${hero.items.length ? '<div class="hero" id="heroBox"></div>' : '<div style="height:26px"></div>'}
    ${body || '<div class="hint-card">Nothing watched yet – open a playlist from the menu above and pick something. Your recently viewed items, favorites and “continue watching” appear here.</div>'}
  </div>`;
  renderHero();
  if (hero.items.length > 1) hero.timer = setInterval(() => { if (ui.route !== 'dashboard') { clearInterval(hero.timer); return; } if (!hero.paused) { hero.i = (hero.i + 1) % hero.items.length; renderHero(); } }, 8000);
}

/* ─────────────────────────────────── playlists ─────────────────────────────────── */
const typeLabel = (p) => (p.type === 'xtream' ? 'Xtream' : p.type === 'file' ? 'M3U file' : 'M3U');
function subLabel(p) {
  if (p.type === 'xtream') { try { return `${new URL(normServer(p.server)).host} · ${p.username}`; } catch { return p.username; } }
  if (p.type === 'file') return p.fileName || 'Local file';
  try { return new URL(p.url).host; } catch { return p.url; }
}
function countsLabel(p) {
  const parts = [];
  for (const [m, label] of [['live', 'channels'], ['movie', 'movies'], ['series', 'series']]) {
    const n = cachedCount(p, m);
    if (n != null) parts.push(`${n.toLocaleString()} ${label}`);
  }
  return parts.length ? parts.join(' · ') : 'Not loaded yet';
}
/* ── Sources page (all saved playlists) ── */
const src = { type: 'all', status: 'any', sort: LS.get('tuner.srcSort', 'added-desc'), q: '' };
const SRC_SORTS = [['added-desc', 'Date added (Newest first)'], ['added-asc', 'Date added (Oldest first)'], ['updated', 'Recently updated'], ['name', 'Name (A–Z)']];
const statusOf = (p) => state.status[p.id] || 'unknown';
const srcKind = (p) => (p.type === 'xtream' ? 'xtream' : 'm3u');
const fmtShortDate = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
const fmtStamp = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function srcMeta(p) {
  const parts = [typeLabel(p)];
  if (p.added) parts.push('added ' + fmtShortDate(p.added));
  parts.push(p.updated ? 'updated ' + fmtStamp(p.updated) : 'not updated yet');
  let extra = '';
  if (p.type === 'xtream') extra = ` · <code>${esc(normServer(p.server))}</code> · <code>${esc(p.username)}</code>`;
  else if (p.type === 'm3u') extra = ` · <code>${esc(p.url)}</code>`;
  else extra = ` · <code>${esc(p.fileName || 'local file')}</code>`;
  return esc(parts.join(' · ')) + extra;
}
const srcIcon = (p, cls = '') => `<span class="src-ico ${cls}"><svg class="ic"><use href="#${p.type === 'xtream' ? 'i-cloud' : p.type === 'file' ? 'i-file' : 'i-list'}"/></svg><i class="dot ${statusOf(p)}" title="${{ ok: 'Responding', down: 'Not responding', checking: 'Checking…', unknown: 'Not checked yet' }[statusOf(p)]}"></i></span>`;
function srcVisible() {
  const q = src.q.trim().toLowerCase();
  const list = state.playlists.filter((p) =>
    (src.type === 'all' || srcKind(p) === src.type)
    && (src.status === 'any' || (src.status === 'ok' ? statusOf(p) === 'ok' : statusOf(p) === 'down'))
    && (!q || `${p.name} ${p.server || ''} ${p.url || ''} ${p.username || ''}`.toLowerCase().includes(q)));
  const by = { 'added-desc': (a, b) => (b.added || 0) - (a.added || 0), 'added-asc': (a, b) => (a.added || 0) - (b.added || 0), updated: (a, b) => (b.updated || 0) - (a.updated || 0), name: (a, b) => a.name.localeCompare(b.name) }[src.sort];
  return list.sort(by);
}
function renderPlaylists() {
  const el = $('#v-playlists');
  const all = state.playlists;
  if (!all.length) { el.innerHTML = `<div class="page">${emptyState('i-list', 'No playlists yet', 'Add your Xtream Codes login or an M3U link or file.', addBtn)}</div>`; return; }
  const n = (f) => all.filter(f).length;
  const filt = (grp, val, label, count, extra = '') => `<button class="src-f${src[grp] === val ? ' on' : ''}" data-act="src-${grp}" data-val="${val}">${extra}<span>${label}</span><em>${count}</em></button>`;
  const dot = (c) => `<i class="dot ${c}"></i>`;
  const list = srcVisible();
  const cur = curPid();
  const sortLabel = (SRC_SORTS.find(([k]) => k === src.sort) || SRC_SORTS[0])[1];
  const title = { all: 'All Playlists', xtream: 'Xtream playlists', m3u: 'M3U playlists' }[src.type];
  el.innerHTML = `<div class="src-page">
    <aside class="src-side">
      <div class="src-title"><div><h2>Sources</h2><small>${all.length} playlist${all.length === 1 ? '' : 's'}</small></div><button class="icon-btn" data-act="add-pl" title="Add playlist" aria-label="Add playlist"><svg class="ic"><use href="#i-plus"/></svg></button></div>
      <h4>Type</h4>
      ${filt('type', 'all', 'All', all.length, '<svg class="ic"><use href="#i-layers"/></svg>')}
      ${filt('type', 'm3u', 'M3U (local, url, text)', n((p) => srcKind(p) === 'm3u'), '<svg class="ic"><use href="#i-list"/></svg>')}
      ${filt('type', 'xtream', 'Xtream', n((p) => srcKind(p) === 'xtream'), '<svg class="ic cloud"><use href="#i-cloud"/></svg>')}
      <h4>Status</h4>
      ${filt('status', 'any', 'Any', all.length, dot('unknown'))}
      ${filt('status', 'ok', 'Responding', n((p) => statusOf(p) === 'ok'), dot('ok'))}
      ${filt('status', 'down', 'Not responding', n((p) => statusOf(p) === 'down'), dot('down'))}
    </aside>
    <section class="src-main">
      <div class="src-head"><h1>${title}<small>${list.length}</small></h1><span class="grow"></span>
        <button class="pill-btn" data-act="src-cleanup"><svg class="ic"><use href="#i-broom"/></svg>Clean up inactive sources…</button>
        <button class="pill-btn" data-act="src-sort"><svg class="ic"><use href="#i-sort"/></svg>${esc(sortLabel)}<svg class="ic chev"><use href="#i-chev-down"/></svg></button>
      </div>
      <div class="src-list">${list.length ? list.map((p) => `<div class="src-row${p.id === cur ? ' on' : ''}" data-pid="${esc(p.id)}" tabindex="0" role="button">
        ${srcIcon(p)}
        <div class="src-info"><b>${esc(p.name)}</b><small>${srcMeta(p)}</small></div>
        <div class="src-act">
          <button class="icon-btn" data-act="pl-refresh" title="Reload" aria-label="Reload"><svg class="ic"><use href="#i-refresh"/></svg></button>
          <button class="icon-btn" data-act="pl-edit" title="Edit" aria-label="Edit"><svg class="ic"><use href="#i-edit"/></svg></button>
          <button class="icon-btn" data-act="pl-more" title="More" aria-label="More"><svg class="ic"><use href="#i-more"/></svg></button>
        </div></div>`).join('') : '<div class="empty">No sources match these filters.</div>'}</div>
    </section></div>`;
}
function playlistMenu(p, anchor) {
  showMenu(anchor, [
    { label: 'Open', run: () => openWorkspace(p.id, 'live') },
    { label: 'Reload', run: () => refreshPlaylist(p.id) },
    { label: 'Edit…', run: () => openPlaylistDialog(p) },
    { label: 'Delete…', run: () => deletePlaylist(p.id) },
  ]);
}
function cleanupSources() {
  const dead = state.playlists.filter((p) => statusOf(p) === 'down');
  if (!dead.length) { toast(state.playlists.some((p) => statusOf(p) === 'unknown' || statusOf(p) === 'checking') ? 'Still checking sources – try again in a moment.' : 'All sources are responding.'); return; }
  if (!confirm(`Delete ${dead.length} source${dead.length === 1 ? '' : 's'} that did not respond?\n\n${dead.map((p) => '• ' + p.name).join('\n')}`)) return;
  for (const p of dead) deletePlaylist(p.id, true);
  toast(`Removed ${dead.length} source${dead.length === 1 ? '' : 's'}`);
}

/* ── "My playlists" quick switcher ── */
const sw = { hl: 0, items: [] };
function swRender() {
  const q = $('#swInput').value.trim().toLowerCase();
  sw.items = state.playlists.filter((p) => !q || p.name.toLowerCase().includes(q));
  sw.hl = Math.max(0, Math.min(sw.hl, sw.items.length - 1));
  const cur = curPid();
  $('#swCount').textContent = state.playlists.length;
  $('#swList').innerHTML = sw.items.length ? sw.items.map((p, i) => `<div class="sw-row${i === sw.hl ? ' hl' : ''}" data-i="${i}" role="option">
      ${srcIcon(p, 'sm')}<div class="info"><b>${esc(p.name)}</b><small>${esc(typeLabel(p))}${p.updated ? ' · updated ' + esc(fmtStamp(p.updated)) : ''}</small></div>
      ${p.id === cur ? '<svg class="ic ok-check"><use href="#i-check-plain"/></svg>' : ''}<button class="icon-btn sm" data-more aria-label="More"><svg class="ic"><use href="#i-more"/></svg></button></div>`).join('')
    : '<div class="empty">No playlists found</div>';
  const on = $('#swList .hl'); if (on) on.scrollIntoView({ block: 'nearest' });
}
function openSwitcher() {
  const d = $('#switchDlg');
  if (d.open) return;
  $('#swInput').value = '';
  const cur = curPid();
  sw.hl = Math.max(0, state.playlists.findIndex((p) => p.id === cur));
  swRender();
  d.showModal();
  $('#swInput').focus();
}
function swPick(i) {
  const p = sw.items[i];
  $('#switchDlg').close();
  if (p) openWorkspace(p.id, ui.route === 'ws' && ws.pid === p.id ? ws.mode : 'live');
}
$('#swInput').addEventListener('input', () => { sw.hl = 0; swRender(); });
$('#swInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); sw.hl = Math.min(sw.items.length - 1, sw.hl + 1); swRender(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sw.hl = Math.max(0, sw.hl - 1); swRender(); }
  else if (e.key === 'Enter') { e.preventDefault(); swPick(sw.hl); }
});
$('#swList').addEventListener('mousemove', (e) => { const r = e.target.closest('.sw-row'); if (r && +r.dataset.i !== sw.hl) { sw.hl = +r.dataset.i; $$('#swList .sw-row').forEach((x, k) => x.classList.toggle('hl', k === sw.hl)); } });
$('#swList').addEventListener('click', (e) => {
  const r = e.target.closest('.sw-row');
  if (!r) return;
  const p = sw.items[+r.dataset.i];
  if (e.target.closest('[data-more]')) { $('#switchDlg').close(); setTimeout(() => playlistMenu(p, $('#plSwitch')), 0); return; }
  swPick(+r.dataset.i);
});
$('#swAdd').addEventListener('click', () => { $('#switchDlg').close(); openPlaylistDialog(); });
$('#swManage').addEventListener('click', () => { $('#switchDlg').close(); go('playlists'); });
$('#swAll').addEventListener('click', () => { $('#switchDlg').close(); go('playlists'); });
$('#switchDlg').addEventListener('mousedown', (e) => { if (e.target === $('#switchDlg')) $('#switchDlg').close(); });

function uiStatusChanged() {
  updateSwitcher();
  if (ui.route === 'playlists') renderPlaylists();
  if ($('#switchDlg') && $('#switchDlg').open) swRender();
}

/* ──────────────────────────── favorites / recently viewed ──────────────────────────── */
function renderFavorites() {
  const all = Object.values(state.favdata);
  const el = $('#v-favorites');
  if (!all.length) { el.innerHTML = `<div class="page">${pageHead('Favorites')}${emptyState('i-star', 'No favorites yet', 'Tap the ♥ on a channel, movie or series and it will be listed here – from all your playlists.')}</div>`; return; }
  const sec = (title, list) => list.length ? `<section class="sec"><h3>${title} <span class="muted">${list.length}</span></h3><div class="grid">${list.map((s) => cardHtml(s)).join('')}</div></section>` : '';
  const live = all.filter((s) => s.kind === 'live');
  const movies = all.filter((s) => s.kind === 'movie');
  const series = all.filter((s) => s.kind === 'series' || s.kind === 'episode');
  el.innerHTML = `<div class="page">${pageHead('Favorites', `${all.length} items from ${new Set(all.map((s) => s.pid)).size} playlist(s)`)}${sec('Live TV', live)}${sec('Movies', movies)}${sec('Series', series)}</div>`;
}

function renderRecent() {
  const el = $('#v-recent');
  const list = state.recent.filter((r) => playlistById(r.pid));
  if (!list.length) { el.innerHTML = `<div class="page">${pageHead('Recently viewed')}${emptyState('i-clock', 'Nothing here yet', 'What you watch shows up here, newest first.')}</div>`; return; }
  el.innerHTML = `<div class="page">${pageHead('Recently viewed', `${list.length} items`, '<button class="btn ghost" data-act="hist-clear">Clear history</button>')}
    <div class="grid">${list.map((s) => cardHtml(s, { tag: KIND_TAG[s.kind], sub: ago(s.ts) })).join('')}</div></div>`;
}

/* ─────────────────────────────── global search ─────────────────────────────── */
const searchState = { q: '', indexing: false, done: 0, total: 0 };
function renderSearch() {
  const el = $('#v-search');
  el.innerHTML = `<div class="page"><div id="gsStatus" class="muted"></div><div id="gsResults"></div></div>`;
  runSearch();
  indexForSearch();
}
function allCachedItems() {
  const out = { live: [], movie: [], series: [] };
  for (const p of state.playlists) {
    const base = state.cache[p.id];
    if (base) out.live.push(...base.channels);
    for (const m of ['movie', 'series']) {
      const own = state.cache[`${p.id}:${m}`];
      if (own) out[m].push(...own.channels);
      else if (base && p.type !== 'xtream') out[m].push(...(m === 'movie' ? base.movies : base.series));
    }
  }
  return out;
}
function runSearch() {
  const box = $('#gsResults');
  if (!box) return;
  const q = searchState.q.trim().toLowerCase();
  $('#gsStatus').textContent = searchState.indexing ? `Indexing your playlists… (${searchState.done} of ${searchState.total})` : '';
  if (q.length < 2) { box.innerHTML = state.playlists.length ? '<div class="hint-card">Type at least two letters. Results come from all your playlists.</div>' : emptyState('i-search', 'No playlists', 'Add a playlist first.'); return; }
  const all = allCachedItems();
  const sec = (title, list) => {
    const hits = list.filter((i) => i.name.toLowerCase().includes(q));
    return hits.length ? `<section class="sec"><h3>${title} <span class="muted">${hits.length.toLocaleString()}</span></h3><div class="grid">${hits.slice(0, 48).map((i) => cardHtml(i)).join('')}</div>${hits.length > 48 ? `<p class="muted">Showing the first 48 – refine your search to narrow it down.</p>` : ''}</section>` : '';
  };
  box.innerHTML = sec('Live TV', all.live) + sec('Movies', all.movie) + sec('Series', all.series) || '<div class="hint-card">No matches yet.</div>';
}
async function indexForSearch() {
  if (searchState.indexing) return;
  const jobs = [];
  for (const p of state.playlists) for (const m of ['live', 'movie', 'series']) {
    const have = m === 'live' ? state.cache[p.id] : state.cache[`${p.id}:${m}`] || (p.type !== 'xtream' && state.cache[p.id]);
    if (!have) jobs.push([p, m]);
  }
  if (!jobs.length) return;
  Object.assign(searchState, { indexing: true, done: 0, total: jobs.length });
  for (const [p, m] of jobs) {
    try { await loadItems(p, m); } catch { /* playlist may not offer this section */ }
    searchState.done++;
    if (ui.route === 'search') runSearch();
  }
  searchState.indexing = false;
  if (ui.route === 'search') runSearch();
}

/* ─────────────────────────────────── settings ─────────────────────────────────── */
/* ───────────────────────────────── updates (desktop app) ───────────────────────────────── */
const upd = { info: null, st: { state: 'idle' } };
function updatesCard() {
  const d = window.tunerDesktop;
  if (!d || !d.updater) return `<section class="set-card"><h3>About &amp; updates</h3><div class="set-row"><div><b>AG Horizon</b><p class="muted">You are using the browser version. Updates are delivered through the desktop app.</p></div></div></section>`;
  const info = upd.info || {};
  const st = upd.st || { state: 'idle' };
  let line = 'Not checked yet.';
  let btn = '<button class="btn" data-act="upd-check">Check for updates</button>';
  if (info.updater === false && st.state === 'idle') line = esc(info.updaterReason || 'Automatic updates are not available.') + ' You can still check whether a newer version exists.';
  if (st.state === 'available' && st.manual) { line = `Version <b>${esc(st.version || '')}</b> is available. ${esc(info.updaterReason || '')}`; btn = '<button class="btn" data-act="upd-open"><svg class="ic"><use href="#i-download"/></svg>Download from GitHub</button>'; }
  else if (st.state === 'checking') { line = 'Checking…'; btn = '<button class="btn" disabled>Checking…</button>'; }
  else if (st.state === 'current') { line = `You have the latest version${st.checkedAt ? ' · checked ' + ago(st.checkedAt) : ''}.`; }
  else if (st.state === 'available') { line = `Version <b>${esc(st.version || '')}</b> is available.`; btn = '<button class="btn" data-act="upd-download"><svg class="ic"><use href="#i-download"/></svg>Download update</button>'; }
  else if (st.state === 'downloading') { line = `Downloading version ${esc(st.version || '')}… ${st.percent || 0}%<div class="bar upd-bar"><i style="width:${st.percent || 0}%"></i></div>`; btn = '<button class="btn" disabled>Downloading…</button>'; }
  else if (st.state === 'ready') { line = `Version <b>${esc(st.version || '')}</b> is ready. It also installs automatically when you close the app.`; btn = '<button class="btn" data-act="upd-install">Restart and install</button>'; }
  else if (st.state === 'error') { line = `Couldn’t update: ${esc(st.message || 'unknown error')}`; btn = '<button class="btn" data-act="upd-check">Try again</button>' + (info.releasesUrl ? ' <button class="btn ghost" data-act="upd-open">Open releases page</button>' : ''); }
  const auto = LS.get('tuner.autoUpdate', true);
  return `<section class="set-card"><h3>About &amp; updates</h3>
    <div class="set-row"><div><b>AG Horizon ${info.version ? 'v' + esc(info.version) : ''}</b><p class="muted">${line}</p></div><div class="upd-btns">${btn}</div></div>
    <div class="set-row"><div><b>Check for updates when the app starts</b></div><label class="switch"><input type="checkbox" data-set="autoUpdate"${auto ? ' checked' : ''}><span></span></label></div>
  </section>`;
}
function updStatus(s) {
  const was = upd.st.state;
  upd.st = s || { state: 'idle' };
  if (upd.st.state === 'available' && was !== 'available' && ui.route !== 'settings') toast(`AG Horizon ${upd.st.version} is available – open Settings to update.`);
  if (ui.route === 'settings') renderSettings();
}
function initUpdates() {
  const d = window.tunerDesktop;
  if (!d || !d.updater) return;
  d.updater.onStatus(updStatus);
  Promise.all([d.appInfo(), d.updater.status()]).then(([info, st]) => {
    upd.info = info; upd.st = st || upd.st;
    if (ui.route === 'settings') renderSettings();
    if (info.updater && LS.get('tuner.autoUpdate', true)) setTimeout(() => d.updater.check(), 6000);
  }).catch(() => {});
}

function renderSettings() {
  const theme = LS.get('tuner.theme', 'dark');
  const accent = LS.get('tuner.accent', 'blue');
  const compat = LS.get('tuner.compat', 'auto');
  const autonext = LS.get('tuner.autonext', true);
  const seg = (key, cur, opts) => `<div class="seg">${opts.map(([v, l]) => `<button data-set="${key}" data-val="${v}" class="${cur === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const open = mirrorOpen();
  $('#v-settings').innerHTML = `<div class="page narrow">${pageHead('Settings')}
    <section class="set-card"><h3>Appearance</h3>
      <div class="set-row"><div><b>Theme</b><p class="muted">Dark, light, or follow your system.</p></div>${seg('theme', theme, [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']])}</div>
      <div class="set-row"><div><b>Accent colour</b></div><div class="swatches">${Object.entries(ACCENTS).map(([k, [c]]) => `<button class="swatch${accent === k ? ' on' : ''}" data-set="accent" data-val="${k}" style="--c:${c}" title="${k}" aria-label="${k}"></button>`).join('')}</div></div>
    </section>
    <section class="set-card"><h3>Playback</h3>
      <div class="set-row"><div><b>Compatibility mode</b><p class="muted">${state.ffmpeg ? 'ffmpeg found. HEVC video and DTS / AC-3 audio are converted to H.264 + AAC on the fly.' : 'ffmpeg was not found, so unsupported streams can’t be converted. The desktop app includes it; for the web version install ffmpeg or set FFMPEG_PATH.'}</p></div>
        <select data-set="compat">${[['auto', 'Automatic (recommended)'], ['always', 'Always convert'], ['off', 'Off']].map(([v, l]) => `<option value="${v}"${compat === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="set-row"><div><b>Play next episode automatically</b></div><label class="switch"><input type="checkbox" data-set="autonext"${autonext ? ' checked' : ''}><span></span></label></div>
    </section>
    <section class="set-card"><h3>Second screen</h3>
      <div class="set-row"><div><b>Show the picture on another monitor or TV</b><p class="muted">Opens a window that mirrors the player without a second connection to your provider. In the desktop app it goes full screen on the display you pick; in a browser, drag it to the other screen and press F (Esc closes it).</p></div>
        <button class="btn${open ? ' ghost' : ''}" data-act="mirror-toggle">${open ? 'Close second screen' : 'Open second screen'}</button></div>
      <div class="set-row"><div><b>Sound plays on</b><p class="muted">Use “Second screen” when the TV or projector has the speakers; this window is then muted.</p></div>${seg('mirrorSound', LS.get('tuner.mirrorSound', 'main'), [['main', 'This window'], ['mirror', 'Second screen'], ['both', 'Both']])}</div>
    </section>
    <section class="set-card"><h3>Library</h3>
      <div class="set-row"><div><b>Recently viewed</b><p class="muted">${state.recent.length} items</p></div><button class="btn ghost" data-act="hist-clear">Clear</button></div>
      <div class="set-row"><div><b>Favorites</b><p class="muted">${state.favs.size} items</p></div><button class="btn ghost" data-act="favs-clear">Clear</button></div>
    </section>
    <section class="set-card"><h3>Keyboard</h3>
      <div class="set-row"><div><b>Shortcuts</b><p class="muted">Press <kbd>?</kbd> anywhere to see them.</p></div><button class="btn ghost" data-act="show-help"><svg class="ic"><use href="#i-keyboard"/></svg>Show shortcuts</button></div>
    </section>
    ${updatesCard()}
    <p class="muted center">AG Horizon · use only with services you’re entitled to watch.</p></div>`;
}
$('#v-settings').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-set]');
  if (!b) return;
  LS.set('tuner.' + b.dataset.set, b.dataset.val);
  applyTheme();
  if (b.dataset.set === 'mirrorSound') applyMirrorSound();
  renderSettings();
});
$('#v-settings').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.set === 'compat') LS.set('tuner.compat', t.value);
  else if (t.dataset.set === 'autonext') LS.set('tuner.autonext', t.checked);
  else if (t.dataset.set === 'autoUpdate') LS.set('tuner.autoUpdate', t.checked);
});

/* actions used by several pages */
$('#views').addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  const card = e.target.closest('.src-row');
  if (!a) { if (card) openWorkspace(card.dataset.pid, 'live'); return; }
  const pid = a.dataset.pid || (card && card.dataset.pid);
  switch (a.dataset.act) {
    case 'add-pl': openPlaylistDialog(); break;
    case 'pl-open': openWorkspace(pid, 'live'); break;
    case 'pl-edit': e.stopPropagation(); openPlaylistDialog(playlistById(pid)); break;
    case 'pl-del': e.stopPropagation(); deletePlaylist(pid); break;
    case 'pl-refresh': e.stopPropagation(); refreshPlaylist(pid); break;
    case 'pl-more': e.stopPropagation(); playlistMenu(playlistById(pid), a); break;
    case 'src-type': src.type = a.dataset.val; renderPlaylists(); break;
    case 'src-status': src.status = a.dataset.val; renderPlaylists(); break;
    case 'src-cleanup': cleanupSources(); break;
    case 'src-sort': showMenu(a, SRC_SORTS.map(([k, l]) => ({ label: (k === src.sort ? '✓  ' : '      ') + l, run: () => { src.sort = k; LS.set('tuner.srcSort', k); renderPlaylists(); } }))); break;
    case 'goto': go(a.dataset.route); break;
    case 'hero-open': { const c = hero.items[hero.i % hero.items.length]; if (c) openItem(c.it); break; }
    case 'hero-pause': hero.paused = !hero.paused; renderHero(); break;
    case 'hero-go': hero.i = Number(a.dataset.k); renderHero(); break;
    case 'hist-clear': state.recent = []; LS.set('tuner.recent', []); renderRoute(ui.route); toast('History cleared'); break;
    case 'favs-clear': if (confirm('Remove all favorites?')) { state.favs.clear(); state.favdata = {}; persistFavs(); renderSettings(); toast('Favorites cleared'); } break;
    case 'show-help': openHelp(); break;
    case 'upd-check': window.tunerDesktop.updater.check(); break;
    case 'upd-download': window.tunerDesktop.updater.download(); break;
    case 'upd-install': window.tunerDesktop.updater.install(); break;
    case 'upd-open': window.tunerDesktop.updater.openReleases(); break;
    case 'mirror-toggle': mirrorButton(a); break;
    default: break;
  }
});
$('#v-playlists').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('src-row')) openWorkspace(e.target.dataset.pid, 'live'); });

/* ───────────────────────────── command palette & help ───────────────────────────── */
const pal = { items: [], sel: 0 };
function paletteCommands() {
  const cmds = [
    ['Go to Dashboard', 'i-home', () => go('dashboard')],
    ['Go to Playlists', 'i-list', () => go('playlists')],
    ['Go to Favorites', 'i-heart', () => go('favorites')],
    ['Go to Recently viewed', 'i-history', () => go('recent')],
    ['Search all playlists', 'i-search', () => { go('search'); setTimeout(() => $('#topInput').focus(), 30); }],
    ['Open Settings', 'i-gear', () => go('settings')],
    ['Add a playlist', 'i-plus', () => openPlaylistDialog()],
    ['Switch light / dark theme', 'i-sun', () => $('#btnTheme').click()],
    ['Show on a second screen', 'i-cast', () => mirrorButton($('#btnPalette'))],
    ['Keyboard shortcuts', 'i-keyboard', openHelp],
    ['Show / hide the categories', 'i-panel', () => { if (ui.route === 'ws') toggleWsSide(); }],
  ];
  for (const p of state.playlists) {
    cmds.push([`Open ${p.name}`, 'i-nav-live', () => openWorkspace(p.id, 'live')]);
    cmds.push([`${p.name} › Movies`, 'i-nav-movie', () => openWorkspace(p.id, 'movie')]);
    cmds.push([`${p.name} › TV guide`, 'i-guide', () => openWorkspace(p.id, 'guide')]);
    cmds.push([`${p.name} › Series`, 'i-nav-series', () => openWorkspace(p.id, 'series')]);
  }
  return cmds;
}
function buildPalette() {
  const q = $('#palInput').value.trim().toLowerCase();
  const toks = q.split(/\s+/).filter(Boolean);
  let items = paletteCommands().filter(([l]) => toks.every((t) => l.toLowerCase().includes(t))).map(([label, icon, run]) => ({ label, icon, run }));
  if (q.length >= 2 && ws.pid && ws.items.length) {
    const hits = ws.items.filter((i) => toks.every((t) => i.name.toLowerCase().includes(t))).slice(0, 8);
    items = items.concat(hits.map((i) => ({ label: i.name, sub: `${KIND_LABEL[kindOf(i)]} · ${i.group}`, icon: i.kind === 'movie' ? 'i-nav-movie' : i.kind === 'series' ? 'i-nav-series' : 'i-nav-live', run: () => openItem(i) })));
  }
  pal.items = items.slice(0, 40);
  pal.sel = Math.min(pal.sel, Math.max(0, pal.items.length - 1));
  $('#palList').innerHTML = pal.items.length
    ? pal.items.map((it, i) => `<button class="pal-item${i === pal.sel ? ' on' : ''}" data-i="${i}" role="option"><svg class="ic"><use href="#${it.icon}"/></svg><span class="name">${esc(it.label)}</span>${it.sub ? `<span class="muted">${esc(it.sub)}</span>` : ''}</button>`).join('')
    : '<div class="empty">No results</div>';
  const on = $('#palList .on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
function openPalette() { const d = $('#paletteDlg'); if (d.open) return; $('#palInput').value = ''; pal.sel = 0; buildPalette(); d.showModal(); $('#palInput').focus(); }
function runPalette(i) { const it = pal.items[i]; $('#paletteDlg').close(); if (it) setTimeout(it.run, 0); }
$('#btnPalette').addEventListener('click', openPalette);
$('#palInput').addEventListener('input', () => { pal.sel = 0; buildPalette(); });
$('#palInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); pal.sel = Math.min(pal.items.length - 1, pal.sel + 1); buildPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pal.sel = Math.max(0, pal.sel - 1); buildPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(pal.sel); }
});
$('#palList').addEventListener('click', (e) => { const b = e.target.closest('.pal-item'); if (b) runPalette(+b.dataset.i); });
$('#paletteDlg').addEventListener('mousedown', (e) => { if (e.target === $('#paletteDlg')) $('#paletteDlg').close(); });

const SHORTCUTS = [
  ['Everywhere', [['Ctrl K', 'Command palette'], ['Ctrl F', 'Search all playlists'], ['Ctrl R', 'Recently viewed'], ['Ctrl B', 'Show / hide the side list (or menu)'], ['Alt ←', 'Back'], ['/', 'Focus the search box'], ['?', 'This list']]],
  ['Player', [['Space / K', 'Play / pause'], ['F', 'Full screen'], ['M', 'Mute'], ['D', 'Add / remove favorite'], ['← →', 'Seek 5 seconds (movies, episodes)'], ['↑ ↓', 'Volume'], ['Esc', 'Leave full screen / close details']]],
  ['Live TV', [['0 – 9', 'Type a channel number'], ['Page ↑ / ↓', 'Previous / next channel'], ['[ / ]', 'Previous / next channel']]],
];
function openHelp() {
  $('#helpBody').innerHTML = SHORTCUTS.map(([t, rows]) => `<h3>${t}</h3><dl>${rows.map(([k, d]) => `<dt>${k.split(' ').map((x) => (/^[/+–]$/.test(x) ? x : `<kbd>${esc(x)}</kbd>`)).join(' ')}</dt><dd>${esc(d)}</dd>`).join('')}</dl>`).join('');
  if (!$('#helpDlg').open) $('#helpDlg').showModal();
}
$('#helpClose').addEventListener('click', () => $('#helpDlg').close());
$('#helpDlg').addEventListener('mousedown', (e) => { if (e.target === $('#helpDlg')) $('#helpDlg').close(); });

/* ─────────────────────────────── keyboard shortcuts ─────────────────────────────── */
let numBuf = '';
let numTimer = 0;
function flash(text) {
  let el = $('#flash');
  if (!el) { el = document.createElement('div'); el.id = 'flash'; el.className = 'flash'; document.body.appendChild(el); }
  el.textContent = text; el.hidden = false;
  clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 1300);
}
function focusContextSearch() { const i = $('#topInput'); i.focus(); i.select(); }

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;
  const tag = e.target.tagName;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target.isContentEditable;
  const k = key.length === 1 ? key.toLowerCase() : key;

  if (mod && k === 'k') { e.preventDefault(); openPalette(); return; }
  if (mod && k === 'f') { e.preventDefault(); focusContextSearch(); return; }
  if (mod && k === 'r' && !e.shiftKey) { e.preventDefault(); go('recent'); return; }
  if (mod && k === 'b') { e.preventDefault(); if (ui.route === 'ws' && !$('#wsSideToggle').hidden) toggleWsSide(); return; }
  if (e.altKey && key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
  if (document.querySelector('dialog[open]')) return;
  if (typing) { if (key === 'Escape') e.target.blur(); return; }
  if (mod || e.altKey) return;
  if (!$('#menu').hidden && key === 'Escape') { $('#menu').hidden = true; return; }

  const onButton = tag === 'BUTTON' || tag === 'A';
  const onVideo = tag === 'VIDEO';
  if (key === '?') { e.preventDefault(); openHelp(); return; }
  if (key === '/') { e.preventDefault(); focusContextSearch(); return; }
  if (key === 'Escape') { if (!document.fullscreenElement && ui.route === 'ws' && ws.detail) closeDetail(); return; }
  if (/^[0-9]$/.test(key) && ui.route === 'ws' && ws.mode === 'live' && ws.items.length) {
    numBuf += key; flash('Channel ' + numBuf);
    clearTimeout(numTimer);
    numTimer = setTimeout(() => {
      const n = Number(numBuf); numBuf = '';
      const ch = ws.items.find((c) => Number(c.num) === n);
      if (ch) { playChannel(ch); scrollLiveTo(ch.uid); } else flash('No channel ' + n);
    }, 1200);
    return;
  }
  if (key === 'PageUp' || key === '[') { e.preventDefault(); zap(-1); return; }
  if (key === 'PageDown' || key === ']') { e.preventDefault(); zap(1); return; }
  if (!state.current) return;
  if ((key === ' ' && !onButton && !onVideo) || k === 'k') { e.preventDefault(); togglePlay(); }
  else if (k === 'f') { e.preventDefault(); toggleFullscreen(); }
  else if (k === 'm') toggleMute();
  else if (k === 'd') toggleFavItem(state.current.kind === 'episode' && ws.detail ? ws.detail : state.current);
  else if (!onVideo && key === 'ArrowLeft') { e.preventDefault(); seekBy(-5); }
  else if (!onVideo && key === 'ArrowRight') { e.preventDefault(); seekBy(5); }
  else if (!onVideo && key === 'ArrowUp') { e.preventDefault(); changeVolume(0.05); }
  else if (!onVideo && key === 'ArrowDown') { e.preventDefault(); changeVolume(-0.05); }
});
