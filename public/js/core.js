'use strict';
/* AG Horizon – core: helpers, storage, state, Xtream / M3U loading, EPG lookups. */

/* ───────────────────────────── tiny helpers ───────────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const enc = encodeURIComponent;
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const normName = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const uidOf = () => Math.random().toString(36).slice(2, 10);
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
const initials = (name) => (String(name).match(/[\p{L}\p{N}]/gu) || ['?']).slice(0, 2).join('').toUpperCase();

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

/* IndexedDB – used for playlists loaded from a local file (too big for localStorage) */
const idb = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('tuner', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('files', mode);
      const req = fn(tx.objectStore('files'));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  },
  put: (k, v) => idb.run('readwrite', (s) => s.put(v, k)),
  get: (k) => idb.run('readonly', (s) => s.get(k)),
  del: (k) => idb.run('readwrite', (s) => s.delete(k)),
};

/* ──────────────────────────────── state ──────────────────────────────── */
const state = {
  playlists: LS.get('tuner.playlists', []),
  favs: new Set(LS.get('tuner.favs', [])),
  favdata: LS.get('tuner.favdata', {}),   // uid -> small snapshot, so Favorites can be listed without loading every playlist
  recent: LS.get('tuner.recent', []),     // newest first: snapshot + ts
  cache: {},        // playlist id -> { channels, movies, series, epgUrl }  /  `${id}:movie` -> { channels }
  epg: {},          // playlist id -> { programmes, lower, byName }
  epgState: {},     // playlist id -> 'loading' | 'ready' | 'none' | 'error: …'
  short: {},        // channel uid -> { t, list }   (Xtream short EPG)
  current: null,    // what is playing: channel | movie | episode
  detail: {},       // item uid -> { info, seasons, loading, error }
  season: {},       // series uid -> chosen season number
  progress: LS.get('tuner.progress', {}), // uid -> { t, d, w, ts }
  status: {},       // playlist id -> 'checking' | 'ok' | 'down'   (runtime only)
  ffmpeg: false,
};

for (const p of state.playlists) if (!p.added) p.added = Date.now();   // playlists saved by older versions
const playlistById = (id) => state.playlists.find((p) => p.id === id);
const savePlaylists = () => LS.set('tuner.playlists', state.playlists);
const saveFavs = () => LS.set('tuner.favs', [...state.favs]);
function dropCaches(id) {
  for (const k of Object.keys(state.cache)) if (k === id || k.startsWith(id + ':')) delete state.cache[k];
  delete state.epg[id]; delete state.epgState[id];
}
function persistProgress() {
  const keys = Object.keys(state.progress);
  if (keys.length > 500) keys.sort((a, b) => state.progress[a].ts - state.progress[b].ts).slice(0, keys.length - 500).forEach((k) => delete state.progress[k]);
  LS.set('tuner.progress', state.progress);
}
const progressOf = (uid) => state.progress[uid] || null;
const fmtDur = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
/* ───────────────────────────── network layer ───────────────────────────── */
const uaParam = (p) => (p && p.ua ? `&ua=${enc(p.ua)}` : '');

async function errorText(r) {
  try { const j = await r.json(); return j.error || `HTTP ${r.status}`; } catch { return `HTTP ${r.status}`; }
}
async function apiText(url, p) {
  const r = await fetch(`/api/fetch?url=${enc(url)}${uaParam(p)}`);
  if (!r.ok) throw new Error(await errorText(r));
  return r.text();
}
async function apiJson(url, p) {
  const t = await apiText(url, p);
  try { return JSON.parse(t.replace(/^﻿/, '')); } catch { throw new Error('The server did not return JSON – check the address and login'); }
}
const proxied = (url, p) => `/api/stream?url=${enc(url)}${uaParam(p)}`;

/* ─────────────────────────────── Xtream ─────────────────────────────── */
function normServer(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    const path = u.pathname.replace(/\/(player_api|get|xmltv|panel_api|portal)\.php.*$/i, '').replace(/\/+$/, '');
    return u.origin + path;
  } catch { return s.replace(/\/+$/, ''); }
}

// Accepts a pasted get.php / player_api.php link and extracts server, username, password.
function parseXtreamLink(text) {
  try {
    const u = new URL(/^https?:\/\//i.test(text) ? text : 'http://' + text);
    const username = u.searchParams.get('username');
    const password = u.searchParams.get('password');
    if (username && password) return { server: normServer(u.href), username, password };
  } catch { /* not a URL */ }
  return null;
}

const xt = {
  api: (p, action, extra = '') =>
    `${normServer(p.server)}/player_api.php?username=${enc(p.username)}&password=${enc(p.password)}${action ? `&action=${action}` : ''}${extra}`,
};

async function loadXtream(p) {
  const base = normServer(p.server);
  if (!base || !p.username) throw new Error('Server URL and username are required');
  const [cats, streams] = await Promise.all([
    apiJson(xt.api(p, 'get_live_categories'), p).catch(() => []),
    apiJson(xt.api(p, 'get_live_streams'), p),
  ]);
  if (!Array.isArray(streams)) throw new Error('Unexpected reply – check the username/password and that the subscription is active');
  const names = {};
  (Array.isArray(cats) ? cats : []).forEach((c) => { names[c.category_id] = c.category_name; });
  const fmt = p.format || 'm3u8';
  const channels = streams.map((s, i) => ({
    uid: `${p.id}:${s.stream_id}`,
    pid: p.id,
    id: String(s.stream_id),
    num: s.num || i + 1,
    name: s.name || `Channel ${s.stream_id}`,
    logo: s.stream_icon || '',
    group: names[s.category_id] || 'Uncategorized',
    epgId: s.epg_channel_id || '',
    url: `${base}/live/${enc(p.username)}/${enc(p.password)}/${s.stream_id}.${fmt}`,
    xtream: true,
  }));
  return { channels, epgUrl: p.epgUrl || `${base}/xmltv.php?username=${enc(p.username)}&password=${enc(p.password)}` };
}

async function loadShortEpg(ch) {
  const p = playlistById(ch.pid);
  if (!p || !ch.xtream) return;
  const hit = state.short[ch.uid];
  if (hit && Date.now() - hit.t < 5 * 60e3) return;
  state.short[ch.uid] = { t: Date.now(), list: [] };
  try {
    const j = await apiJson(xt.api(p, 'get_short_epg', `&stream_id=${ch.id}&limit=8`), p);
    const b64 = (s) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { return s || ''; } };
    const list = (j.epg_listings || [])
      .map((e) => [Number(e.start_timestamp) * 1000, Number(e.stop_timestamp) * 1000, b64(e.title), b64(e.description)])
      .filter((e) => e[0] && e[1])
      .sort((a, b) => a[0] - b[0]);
    state.short[ch.uid] = { t: Date.now(), list };
    uiEpgUpdated();
  } catch { /* leave empty */ }
}

/* ───────────────────────── Xtream: movies & series ───────────────────────── */
const yearOf = (s) => { const m = /\b((?:19|20)\d{2})\b/.exec(String(s || '')); return m ? m[1] : ''; };
const goodRating = (r) => { const n = parseFloat(r); return n > 0 ? String(Math.round(n * 10) / 10) : ''; };
const catNames = (cats) => { const o = {}; (Array.isArray(cats) ? cats : []).forEach((c) => { o[c.category_id] = c.category_name; }); return o; };

async function loadXtreamMovies(p) {
  const base = normServer(p.server);
  const [cats, streams] = await Promise.all([
    apiJson(xt.api(p, 'get_vod_categories'), p).catch(() => []),
    apiJson(xt.api(p, 'get_vod_streams'), p),
  ]);
  if (!Array.isArray(streams)) throw new Error('Unexpected reply – this account may not include movies');
  const names = catNames(cats);
  return {
    channels: streams.map((s, i) => {
      const ext = s.container_extension || 'mp4';
      return {
        uid: `${p.id}:m${s.stream_id}`, pid: p.id, id: String(s.stream_id), kind: 'movie', num: i + 1,
        name: s.name || `Movie ${s.stream_id}`, logo: s.stream_icon || '', group: names[s.category_id] || 'Uncategorized',
        year: yearOf(s.year || s.releasedate) || yearOf(s.name), rating: goodRating(s.rating), added: Number(s.added) || 0,
        ext, url: `${base}/movie/${enc(p.username)}/${enc(p.password)}/${s.stream_id}.${ext}`, xtream: true,
      };
    }),
  };
}

async function loadXtreamSeries(p) {
  const [cats, list] = await Promise.all([
    apiJson(xt.api(p, 'get_series_categories'), p).catch(() => []),
    apiJson(xt.api(p, 'get_series'), p),
  ]);
  if (!Array.isArray(list)) throw new Error('Unexpected reply – this account may not include series');
  const names = catNames(cats);
  return {
    channels: list.map((s, i) => ({
      uid: `${p.id}:s${s.series_id}`, pid: p.id, id: String(s.series_id), kind: 'series', num: i + 1,
      name: s.name || `Series ${s.series_id}`, logo: s.cover || '', group: names[s.category_id] || 'Uncategorized',
      year: yearOf(s.releaseDate || s.release_date) || yearOf(s.name), rating: goodRating(s.rating), added: Number(s.last_modified) || 0,
      plot: s.plot || '', cast: s.cast || '', genre: s.genre || '', xtream: true,
    })),
  };
}

function buildSeasons(item, p, j) {
  const base = normServer(p.server);
  const raw = j.episodes || {};
  const flat = [];
  if (Array.isArray(raw)) raw.forEach((arr, i) => (Array.isArray(arr) ? arr : [arr]).forEach((e) => flat.push([i + 1, e])));
  else for (const [k, arr] of Object.entries(raw)) (Array.isArray(arr) ? arr : []).forEach((e) => flat.push([k, e]));
  const seasons = {};
  for (const [key, e] of flat) {
    const season = Number(e.season ?? key) || 1;
    const num = Number(e.episode_num) || 0;
    const ext = e.container_extension || 'mkv';
    const inf = e.info || {};
    (seasons[season] ||= []).push({
      uid: `${p.id}:e${e.id}`, pid: p.id, id: String(e.id), kind: 'episode', season, num,
      name: e.title || `Episode ${num}`, title: e.title || `Episode ${num}`, logo: inf.movie_image || item.logo,
      plot: inf.plot || '', duration: inf.duration || '', durationSecs: Number(inf.duration_secs) || 0, ext,
      group: item.name, seriesUid: item.uid, seriesName: item.name,
      url: `${base}/series/${enc(p.username)}/${enc(p.password)}/${e.id}.${ext}`, xtream: true,
    });
  }
  for (const k in seasons) seasons[k].sort((a, b) => a.num - b.num);
  return seasons;
}

async function loadDetail(it) {
  const p = playlistById(it.pid);
  if (it.seasons) { state.detail[it.uid] = { info: {}, seasons: it.seasons }; return; }
  if (!p || !it.xtream || state.detail[it.uid]) return;
  state.detail[it.uid] = { loading: true, info: {} };
  try {
    if (it.kind === 'movie') {
      const j = await apiJson(xt.api(p, 'get_vod_info', `&vod_id=${it.id}`), p);
      state.detail[it.uid] = { info: j.info || {}, data: j.movie_data || {} };
    } else {
      const j = await apiJson(xt.api(p, 'get_series_info', `&series_id=${it.id}`), p);
      state.detail[it.uid] = { info: j.info || {}, seasons: buildSeasons(it, p, j) };
    }
  } catch (e) {
    state.detail[it.uid] = { info: {}, error: e.message };
  }
  uiDetailLoaded(it);
}

/* ──────────────────────────────── M3U ──────────────────────────────── */
function parseM3U(text, p) {
  const attrRe = /([\w-]+)="([^"]*)"/g;
  const attrs = (s) => { const o = {}; let m; attrRe.lastIndex = 0; while ((m = attrRe.exec(s))) o[m[1].toLowerCase()] = m[2]; return o; };
  const channels = [];
  const movies = [];
  const episodes = [];
  const seen = new Map();
  let epgUrls = [];
  let cur = null;
  let grp = '';
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) {
      const a = attrs(line);
      const u = a['url-tvg'] || a['x-tvg-url'] || a['tvg-url'];
      if (u) epgUrls = u.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (line.startsWith('#EXTINF')) {
      const info = line.slice(line.indexOf(':') + 1);
      const stripped = info.replace(attrRe, '');
      cur = { a: attrs(info), name: stripped.slice(stripped.indexOf(',') + 1).trim() };
    } else if (line.startsWith('#EXTGRP:')) {
      grp = line.slice(8).trim();
    } else if (line[0] !== '#') {
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) { cur = null; continue; }
      const a = cur ? cur.a : {};
      const name = (cur && cur.name) || a['tvg-name'] || line;
      let key = hashStr(name + '|' + line);
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      if (n) key += '-' + n;
      const item = {
        uid: `${p.id}:${key}`,
        pid: p.id,
        id: key,
        num: channels.length + movies.length + episodes.length + 1,
        name,
        logo: a['tvg-logo'] || '',
        group: a['group-title'] || grp || 'Uncategorized',
        epgId: a['tvg-id'] || '',
        url: line,
      };
      if (/\/movie\//i.test(line)) movies.push({ ...item, kind: 'movie', ext: extOf(line) || 'mp4', year: yearOf(name), rating: '', added: 0 });
      else if (/\/series\//i.test(line)) episodes.push({ ...item, kind: 'episode', ext: extOf(line) || 'mkv' });
      else channels.push(item);
      cur = null;
    }
  }
  return { channels, movies, series: groupEpisodes(episodes, p), epgUrl: p.epgUrl || epgUrls[0] || '' };
}

const extOf = (u) => { const m = /\.([a-z0-9]{2,5})$/i.exec(u.split('?')[0]); return m ? m[1].toLowerCase() : ''; };

// Flat "…/series/…" entries become series → seasons → episodes, using S01E02 / 1x02 patterns in the title.
function groupEpisodes(episodes, p) {
  const epRe = /^(.*?)[\s._-]*(?:[Ss](\d{1,3})[\s._-]*[Ee](\d{1,4})|\b(\d{1,2})x(\d{2,3})\b)/;
  const pad = (n) => String(n).padStart(2, '0');
  const map = new Map();
  for (const e of episodes) {
    const m = epRe.exec(e.name);
    const sname = (m && m[1].trim()) || e.name;
    let s = map.get(sname);
    if (!s) {
      s = { uid: `${p.id}:s${hashStr(sname)}`, pid: p.id, id: hashStr(sname), kind: 'series', num: map.size + 1, name: sname, logo: e.logo, group: e.group, year: '', rating: '', added: 0, seasons: {} };
      map.set(sname, s);
    }
    const season = m ? Number(m[2] || m[4]) : 1;
    const list = (s.seasons[season] ||= []);
    const num = m ? Number(m[3] || m[5]) : list.length + 1;
    list.push({ ...e, kind: 'episode', season, num, title: e.name, name: m ? `S${pad(season)}E${pad(num)} · ${e.name}` : e.name, seriesUid: s.uid, seriesName: sname });
  }
  for (const s of map.values()) for (const k in s.seasons) s.seasons[k].sort((a, b) => a.num - b.num);
  return [...map.values()];
}

/* ─────────────────────────── playlist loading ─────────────────────────── */
async function loadPlaylist(p, force) {
  if (!force && state.cache[p.id]) return state.cache[p.id];
  state.status[p.id] = 'checking';
  try {
    const res = await fetchPlaylist(p);
    state.cache[p.id] = res;
    state.status[p.id] = 'ok';
    p.updated = Date.now();
    savePlaylists();
    uiStatusChanged();
    return res;
  } catch (e) {
    state.status[p.id] = 'down';
    uiStatusChanged();
    throw e;
  }
}
async function fetchPlaylist(p) {
  let res;
  if (p.type === 'xtream') {
    res = await loadXtream(p);
  } else {
    const text = p.type === 'file' ? await idb.get('file:' + p.id) : await apiText(p.url, p);
    if (!text) throw new Error(p.type === 'file' ? 'The stored file is missing – edit the playlist and choose it again' : 'The playlist is empty');
    if (!/#EXTM3U|#EXTINF/.test(text.slice(0, 4000))) throw new Error('That does not look like an M3U playlist');
    res = parseM3U(text, p);
    if (!res.channels.length && !res.movies.length && !res.series.length) throw new Error('No channels found in this playlist');
  }
  return res;
}

// Items for one playlist in the given mode ('live' | 'movie' | 'series'); each loads once and is cached.
async function loadItems(p, mode, force) {
  if (mode === 'live') return (await loadPlaylist(p, force)).channels;
  const key = `${p.id}:${mode}`;
  if (!force && state.cache[key]) return state.cache[key].channels;
  let res;
  if (p.type === 'xtream') res = mode === 'movie' ? await loadXtreamMovies(p) : await loadXtreamSeries(p);
  else {
    const base = await loadPlaylist(p, force);
    res = { channels: mode === 'movie' ? base.movies : base.series };
  }
  return (state.cache[key] = res).channels;
}


async function loadEpg(p, force) {
  const info = state.cache[p.id];
  const url = info && info.epgUrl;
  if (!url) { state.epgState[p.id] = 'none'; uiEpgUpdated(); return; }
  state.epgState[p.id] = 'loading';
  uiEpgUpdated();
  const ids = [];
  const names = [];
  for (const c of info.channels) { if (c.epgId) ids.push(c.epgId); names.push(normName(c.name)); }
  try {
    const r = await fetch('/api/epg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, ua: p.ua || '', force: !!force, ids: [...new Set(ids)], names: [...new Set(names)] }),
    });
    if (!r.ok) throw new Error(await errorText(r));
    const data = await r.json();
    const lower = {};
    for (const k in data.programmes) lower[k.toLowerCase()] = data.programmes[k];
    state.epg[p.id] = { ...data, lower };
    state.epgState[p.id] = Object.keys(data.programmes).length ? 'ready' : 'error: the guide loaded but matched none of your channels';
  } catch (e) {
    state.epgState[p.id] = 'error: ' + e.message;
  }
  uiEpgUpdated();
}

/* ───────────────────────────── EPG lookups ───────────────────────────── */
function programmesFor(ch) {
  const e = state.epg[ch.pid];
  if (e) {
    let list = ch.epgId && (e.programmes[ch.epgId] || e.lower[ch.epgId.toLowerCase()]);
    if (!list) {
      const id = e.byName[normName(ch.name)];
      if (id) list = e.programmes[id];
    }
    if (list && list.length) return list;
  }
  const s = state.short[ch.uid];
  return s && s.list.length ? s.list : null;
}

function nowNext(ch, t = Date.now()) {
  const list = programmesFor(ch);
  if (!list) return { list: null, now: null, next: null };
  let now = null;
  let next = null;
  for (const p of list) {
    if (p[0] <= t && t < p[1]) now = p;
    else if (p[0] >= t) { next = p; break; }
  }
  return { list, now, next };
}

/* ───────────────────────── shared item helpers ───────────────────────── */
const isVod = (ch) => ch.kind === 'movie' || ch.kind === 'series' || ch.kind === 'episode';
const modeOf = (it) => (it.kind === 'movie' ? 'movie' : it.kind === 'series' || it.kind === 'episode' ? 'series' : 'live');
const KIND_LABEL = { live: 'Live TV', movie: 'Movie', series: 'Series', episode: 'Episode' };
const kindOf = (it) => it.kind || 'live';
const logoHtml = (ch) =>
  ch.logo && /^https?:\/\//i.test(ch.logo)
    ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(ch.logo)}" data-i="${esc(initials(ch.name))}" alt="">`
    : `<span>${esc(initials(ch.name))}</span>`;
function logoFailed(e) {
  if (e.target.tagName !== 'IMG' || !e.target.dataset.i) return;
  const span = document.createElement('span');
  span.textContent = e.target.dataset.i;
  e.target.replaceWith(span);
}
function allEpisodes(seasons) {
  return Object.keys(seasons || {}).map(Number).sort((a, b) => a - b).flatMap((k) => seasons[k]);
}
const withBestUrl = (it) => {
  const ext = state.detail[it.uid] && state.detail[it.uid].data && state.detail[it.uid].data.container_extension;
  return ext && ext !== it.ext ? { ...it, ext, url: it.url.replace(/\.[^./]+$/, '.' + ext) } : it;
};


/* snapshots: just enough to list an item later (Favorites, Recently viewed, Dashboard) */
const snap = (it) => ({
  uid: it.uid, pid: it.pid, id: it.id, kind: kindOf(it), name: it.name, logo: it.logo || '', group: it.group || '',
  year: it.year || '', rating: it.rating || '', seriesUid: it.seriesUid || '', seriesName: it.seriesName || '',
  season: it.season || 0, num: it.num || 0,
});
function persistFavs() { LS.set('tuner.favs', [...state.favs]); LS.set('tuner.favdata', state.favdata); }
function toggleFavItem(it) {
  if (state.favs.has(it.uid)) { state.favs.delete(it.uid); delete state.favdata[it.uid]; }
  else { state.favs.add(it.uid); state.favdata[it.uid] = snap(it); }
  persistFavs();
  uiFavChanged(it.uid);
}
function pushRecent(it) {
  const s = { ...snap(it), ts: Date.now() };
  state.recent = [s, ...state.recent.filter((r) => r.uid !== s.uid)].slice(0, 60);
  LS.set('tuner.recent', state.recent);
}
