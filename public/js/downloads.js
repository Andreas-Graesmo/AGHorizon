'use strict';
/* AG Horizon – downloads for offline viewing (desktop app only). The downloading itself happens in electron/downloads.js;
   this is the page side: download buttons on movies and episodes, the Downloads page, and playing the saved copy instead of the stream. */

const dlApi = window.tunerDesktop && window.tunerDesktop.downloads;
const dl = { items: [], byUid: new Map(), folder: '', held: false, pauseWhileWatching: true, free: 0, key: '' };

const fmtBytes = (n) => {
  if (!n) return '0 MB';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(n >= 100 * 1024 ** 3 ? 0 : 1) + ' GB';
  return (n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1) + ' MB';
};
const dlSE = (d) => `S${String(d.season || 0).padStart(2, '0')}E${String(d.episode || 0).padStart(2, '0')}`;
const dlName = (d) => (d.kind === 'episode' ? `${d.seriesName} · ${dlSE(d)}` : d.title);
const dlOf = (uid) => dl.byUid.get(uid);
const dlLocalUrl = (d) => `${location.origin}/api/local/${d.id}`;
const dlCanDownload = (it) => !!dlApi && (it.kind === 'movie' || it.kind === 'episode') && /^https?:\/\//i.test(it.url || '') && !/\.m3u8?(\?|$)/i.test(it.url);
const dlPct = (d) => (d.size ? Math.min(100, Math.floor((d.received / d.size) * 100)) : 0);

// The saved copy plays instead of the stream: it works offline and doesn't use one of the provider's connections.
function dlLocal(ch) {
  if (!ch || ch.local) return ch;
  const d = dlOf(ch.uid);
  return d && d.state === 'done' ? { ...ch, url: dlLocalUrl(d), local: true } : ch;
}

// A playable item made from a download alone, so it also works offline and after the playlist changed.
const dlItem = (d) => ({
  uid: d.uid, pid: d.pid, id: '', kind: d.kind, name: d.kind === 'episode' ? d.epTitle || dlName(d) : d.title, title: d.epTitle || '',
  logo: d.poster || '', year: d.year || '', group: d.seriesName || '', seriesUid: d.seriesUid || '', seriesName: d.seriesName || '',
  season: d.season || 0, num: d.episode || 0, url: dlLocalUrl(d), local: true,
});

// Next downloaded episode of the same series, for "play next episode" when the series details aren't loaded (offline).
function dlNextEpisode(c) {
  if (!c || c.kind !== 'episode') return null;
  const eps = dl.items.filter((d) => d.state === 'done' && d.kind === 'episode' && d.seriesUid === c.seriesUid)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const i = eps.findIndex((d) => d.uid === c.uid);
  return i >= 0 && eps[i + 1] ? dlItem(eps[i + 1]) : null;
}

// Most accounts allow 1–2 connections, so downloads wait while a provider stream plays (setting in Settings › Downloads).
let dlWatchingSent = null;
function dlSyncWatching() {
  if (!dlApi) return;
  const on = !!(state.current && !state.current.local) || (ui.route === 'multiview' && mv.slots.some(Boolean));
  if (on !== dlWatchingSent) { dlWatchingSent = on; dlApi.setWatching(on); }
}

/* ───────────────────────────── starting downloads ───────────────────────────── */
function dlMeta(it) {
  const p = playlistById(it.pid);
  const ua = (p && p.ua) || '';
  if (it.kind === 'movie') {
    const b = withBestUrl(it);
    const info = (state.detail[it.uid] || {}).info || {};
    return {
      uid: it.uid, pid: it.pid, kind: 'movie', url: b.url, ext: b.ext, ua, title: it.name,
      year: String(info.releasedate || info.release_date || it.year || '').slice(0, 4),
      plot: info.plot || info.description || it.plot || '', poster: info.movie_image || info.cover_big || it.logo || '',
    };
  }
  const info = (state.detail[it.seriesUid] || {}).info || {};
  const show = ws.detail && ws.detail.uid === it.seriesUid ? ws.detail : null;
  return {
    uid: it.uid, pid: it.pid, kind: 'episode', url: it.url, ext: it.ext, ua, title: it.title || it.name, epTitle: it.title || '',
    seriesUid: it.seriesUid, seriesName: it.seriesName, season: it.season, episode: it.num, plot: it.plot || '',
    year: String(info.releaseDate || info.release_date || (show && show.year) || '').slice(0, 4),
    poster: info.cover_big || info.cover || (show && show.logo) || it.logo || '',
  };
}

async function dlStart(list) {
  const metas = list.filter(dlCanDownload).map(dlMeta);
  if (!metas.length) return;
  const n = await dlApi.add(metas);
  if (!n) toast('Already in Downloads');
  else if (metas.length === 1) toast(`Downloading ${metas[0].kind === 'episode' ? `${metas[0].seriesName} · ${dlSE(metas[0])}` : metas[0].title}`);
  else toast(`${n} episodes added to Downloads`);
}

async function dlDelete(d) {
  if (!confirm(`Delete “${dlName(d)}” from this computer?`)) return;
  await dlApi.remove(d.id, true);
}

function dlMenu(d, anchor) {
  const items = [];
  if (d.state === 'failed' && d.error) items.push({ heading: true, label: d.error });
  if (d.state === 'done') items.push({ label: 'Play', run: () => dlPlay(d) });
  if (d.state === 'downloading' || d.state === 'queued') items.push({ label: 'Pause', run: () => dlApi.pause(d.id) });
  if (d.state === 'paused' || d.state === 'failed') items.push({ label: d.state === 'failed' ? 'Try again' : 'Resume', run: () => dlApi.resume(d.id) });
  items.push({ label: d.state === 'done' ? 'Show in folder' : 'Open download folder', run: () => (d.state === 'done' ? dlApi.reveal(d.id) : dlApi.openFolder()) });
  if (ui.route !== 'downloads') items.push({ label: 'Go to Downloads', run: () => go('downloads') });
  if (d.state === 'done') {
    items.push({ label: 'Remove from list (keep the file)', run: () => dlApi.remove(d.id, false) });
    items.push({ label: 'Delete download', run: () => dlDelete(d) });
  } else items.push({ label: 'Cancel download', run: () => dlApi.remove(d.id, true) });
  showMenu(anchor, items);
}

// The download button on a movie or episode: starts the download, or offers what fits its current state.
function dlClick(it, anchor) {
  const d = dlOf(it.uid);
  if (!d) dlStart([it]);
  else dlMenu(d, anchor);
}

function dlBtnState(uid) {
  const d = dlOf(uid);
  const ring = (pct, cls) => `<svg class="dl-ring ${cls}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle class="v" cx="12" cy="12" r="9" stroke-dasharray="${(pct * 56.55) / 100} 56.55"/></svg>`;
  if (!d) return { cls: '', title: 'Download', html: '<svg class="ic"><use href="#i-download"/></svg>' };
  if (d.state === 'done') return { cls: 'on', title: 'Downloaded', html: '<svg class="ic"><use href="#i-check-plain"/></svg>' };
  if (d.state === 'failed') return { cls: 'err', title: 'Download failed: ' + (d.error || ''), html: '<svg class="ic"><use href="#i-info"/></svg>' };
  if (d.state === 'paused') return { cls: '', title: `Download paused at ${dlPct(d)}%`, html: ring(dlPct(d), 'paused') };
  if (d.state === 'queued') return { cls: '', title: dl.held ? 'Waiting – downloads pause while you watch' : 'Queued for download', html: ring(dlPct(d), 'paused') };
  return { cls: 'on', title: `Downloading ${dlPct(d)}%`, html: ring(dlPct(d), '') };
}
function dlBtnHtml(it, cls) {
  const s = dlBtnState(it.uid);
  return `<button class="${cls} dl-btn ${s.cls}" data-cls="${cls}" data-act="dl" data-dl="${esc(it.uid)}" title="${esc(s.title)}" aria-label="${esc(s.title)}">${s.html}</button>`;
}
function dlPaintBtn(b) {
  const s = dlBtnState(b.dataset.dl);
  b.className = `${b.dataset.cls} dl-btn ${s.cls}`;
  b.title = s.title;
  b.setAttribute('aria-label', s.title);
  b.innerHTML = s.html;
}

// "Download season" next to the season chips on a series page.
function dlSeasonHtml(eps, season) {
  const can = (eps || []).filter(dlCanDownload);
  if (!can.length) return '';
  const left = can.filter((e) => !dlOf(e.uid) || dlOf(e.uid).state === 'failed');
  if (!left.length) {
    const done = can.every((e) => dlOf(e.uid).state === 'done');
    return `<span class="dl-season-note"><svg class="ic"><use href="#${done ? 'i-check-plain' : 'i-download'}"/></svg>${done ? `Season ${season} downloaded` : `Season ${season} is in Downloads`}</span>`;
  }
  const label = left.length === can.length ? `Download season ${season}` : `Download ${left.length} more`;
  return `<button class="btn ghost small" data-act="dl-season" data-s="${season}"><svg class="ic"><use href="#i-download"/></svg>${label}</button>`;
}

function dlPlay(d) {
  playChannel(dlItem(d));
  layoutPlayer();
  $('#player').requestFullscreen().catch(() => {});
}

/* ───────────────────────────── Downloads page ───────────────────────────── */
function dlStatusHtml(d) {
  if (d.state === 'done') return `${fmtBytes(d.size)}${d.ext ? ' · ' + esc(String(d.ext).toUpperCase()) : ''}`;
  if (d.state === 'failed') return `<span class="err-text">${esc(d.error || 'Failed')}</span>`;
  const of = d.size ? `${fmtBytes(d.received)} of ${fmtBytes(d.size)}` : fmtBytes(d.received);
  if (d.state === 'paused') return `Paused · ${of}`;
  if (d.state === 'queued') return d.received ? `${dl.held ? 'Waiting while you watch' : 'Queued'} · ${of}` : dl.held ? 'Waiting – downloads pause while you watch' : 'Queued';
  const eta = d.speed && d.size ? Math.max(0, (d.size - d.received) / d.speed) : 0;
  const left = eta ? (eta >= 3600 ? ` · ${Math.floor(eta / 3600)} h ${Math.round((eta % 3600) / 60)} min left` : eta >= 60 ? ` · ${Math.round(eta / 60)} min left` : ' · less than a minute left') : '';
  return `${of}${d.speed ? ` · ${fmtBytes(d.speed)}/s` : ''}${left}`;
}

function dlThumb(d) {
  const src = d.hasPoster ? `/api/local/${d.id}/poster` : d.poster;
  return `<div class="dl-thumb">${src ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(src)}" alt="">` : ''}<span>${esc(initials(d.kind === 'episode' ? d.seriesName : d.title))}</span></div>`;
}

function dlRowHtml(d, { compact = false } = {}) {
  const busy = d.state === 'downloading' || d.state === 'queued' || d.state === 'paused';
  const title = d.kind === 'episode' ? (compact ? `${dlSE(d)}${d.epTitle && !/S\d+\s*E\d+/i.test(d.epTitle) ? ' · ' + d.epTitle : ''}` : d.seriesName) : d.title;
  const sub = compact ? '' : d.kind === 'episode' ? `${dlSE(d)}${d.epTitle && !/S\d+\s*E\d+/i.test(d.epTitle) ? ' · ' + d.epTitle : ''}` : d.year || 'Movie';
  let main = '';
  if (d.state === 'done') main = '<button class="btn small" data-act="dl-play"><svg class="ic fill"><use href="#i-play"/></svg>Play</button>';
  else if (d.state === 'failed') main = '<button class="btn ghost small" data-act="dl-resume">Try again</button>';
  else if (d.state === 'paused') main = '<button class="icon-btn" data-act="dl-resume" title="Resume" aria-label="Resume"><svg class="ic fill"><use href="#i-play"/></svg></button>';
  else main = '<button class="icon-btn" data-act="dl-pause" title="Pause" aria-label="Pause"><svg class="ic"><use href="#i-pause"/></svg></button>';
  return `<div class="dl-row${compact ? ' compact' : ''} ${d.state}" data-id="${esc(d.id)}">
    ${compact ? '' : dlThumb(d)}
    <div class="dl-main"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}
      <div class="dl-status">${dlStatusHtml(d)}</div>
      ${busy ? `<div class="bar dl-bar"><i style="width:${dlPct(d)}%"></i></div>` : ''}</div>
    <div class="dl-acts">${main}<button class="icon-btn" data-act="dl-more" title="More" aria-label="More"><svg class="ic"><use href="#i-more-v"/></svg></button></div>
  </div>`;
}

function renderDownloads() {
  const el = $('#v-downloads');
  if (!dlApi) { el.innerHTML = `<div class="page">${pageHead('Downloads')}${emptyState('i-download', 'Downloads need the desktop app', 'Saving movies and episodes for offline viewing works in the AG Horizon desktop app.')}</div>`; return; }
  const all = dl.items;
  const done = all.filter((d) => d.state === 'done');
  const failed = all.filter((d) => d.state === 'failed');
  const order = { downloading: 0, queued: 1, paused: 2 };
  const moving = all.filter((d) => d.state in order).sort((a, b) => order[a.state] - order[b.state] || a.addedAt - b.addedAt);
  const movies = done.filter((d) => d.kind === 'movie').sort((a, b) => b.doneAt - a.doneAt);
  const shows = new Map();
  for (const d of done.filter((x) => x.kind === 'episode')) {
    const k = d.seriesUid || d.seriesName;
    if (!shows.has(k)) shows.set(k, []);
    shows.get(k).push(d);
  }
  const showList = [...shows.values()].map((eps) => eps.sort((a, b) => a.season - b.season || a.episode - b.episode)).sort((a, b) => a[0].seriesName.localeCompare(b[0].seriesName));
  const total = done.reduce((a, d) => a + (d.size || 0), 0);
  const sub = `${done.length} downloaded · ${fmtBytes(total)}${dl.free ? ` · ${fmtBytes(dl.free)} free on this drive` : ''}`;
  const acts = `<button class="btn ghost dl-folder" data-act="dl-open" title="Open the download folder"><svg class="ic"><use href="#i-file"/></svg><span>${esc(dl.folder)}</span></button><button class="btn ghost" data-act="dl-folder">Change folder</button>`;
  const sec = (title, n, body) => `<section class="sec"><h3>${title} <span class="muted">${n}</span></h3>${body}</section>`;

  el.innerHTML = `<div class="page narrow dl-page">${pageHead('Downloads', sub, acts)}
    ${!all.length ? emptyState('i-download', 'No downloads yet', 'Use the download button on a movie or an episode – or “Download season” on a series – to watch it later without internet. Downloads are normal video files you can also open in VLC.') : ''}
    ${failed.length ? sec('Needs attention', failed.length, `<div class="dl-list">${failed.map((d) => dlRowHtml(d)).join('')}</div>`) : ''}
    ${moving.length ? sec('Downloading', moving.length, `${dl.held ? '<p class="muted dl-note">Paused while you watch, so playback gets the connection. Change this in Settings › Downloads.</p>' : ''}<div class="dl-list">${moving.map((d) => dlRowHtml(d)).join('')}</div>`) : ''}
    ${movies.length ? sec('Movies', movies.length, `<div class="dl-list">${movies.map((d) => dlRowHtml(d)).join('')}</div>`) : ''}
    ${showList.length ? sec('Series', showList.length, showList.map((eps) => `<div class="dl-show">
        <div class="dl-show-head">${dlThumb(eps[0])}<div><b>${esc(eps[0].seriesName)}</b><small>${eps.length} episode${eps.length === 1 ? '' : 's'} · ${fmtBytes(eps.reduce((a, d) => a + d.size, 0))}</small></div></div>
        <div class="dl-list">${eps.map((d) => dlRowHtml(d, { compact: true })).join('')}</div></div>`).join('')) : ''}
  </div>`;
}
// progress ticks only change numbers: update those in place instead of rebuilding the page
function dlPaintRows() {
  $$('#v-downloads .dl-row').forEach((row) => {
    const d = dl.items.find((x) => x.id === row.dataset.id);
    if (!d) return;
    row.querySelector('.dl-status').innerHTML = dlStatusHtml(d);
    const bar = row.querySelector('.dl-bar i');
    if (bar) bar.style.width = dlPct(d) + '%';
  });
}
function openDownloads() {
  renderDownloads();
  if (dlApi) dlApi.list().then(dlUpdate).catch(() => {});   // refreshes free space and drops files deleted by hand
}

$('#v-downloads').addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);

/* Settings › Downloads (desktop only) */
function dlSettingsCard() {
  if (!dlApi) return '';
  return `<section class="set-card"><h3>Downloads</h3>
    <div class="set-row"><div><b>Download folder</b><p class="muted dl-path">${esc(dl.folder)}</p></div><div class="upd-btns"><button class="btn ghost" data-act="dl-open">Open</button> <button class="btn ghost" data-act="dl-folder">Change</button></div></div>
    <div class="set-row"><div><b>Pause downloads while I watch</b><p class="muted">Most providers allow only one or two connections at a time. Downloads wait while a stream plays and continue afterwards. Downloaded titles don’t count.</p></div><label class="switch"><input type="checkbox" data-set="dlPause"${dl.pauseWhileWatching ? ' checked' : ''}><span></span></label></div>
  </section>`;
}
$('#v-settings').addEventListener('change', (e) => { if (e.target.dataset.set === 'dlPause') dlApi.setOption('pauseWhileWatching', e.target.checked); });

$('#views').addEventListener('click', (e) => {
  const a = e.target.closest('[data-act^="dl-"]');
  if (!a || !dlApi) return;
  const row = a.closest('.dl-row');
  const d = row && dl.items.find((x) => x.id === row.dataset.id);
  switch (a.dataset.act) {
    case 'dl-open': dlApi.openFolder(); break;
    case 'dl-folder': dlApi.chooseFolder().then((f) => { if (f) toast('New downloads will be saved in ' + f); }); break;
    case 'dl-play': if (d) dlPlay(d); break;
    case 'dl-pause': if (d) dlApi.pause(d.id); break;
    case 'dl-resume': if (d) dlApi.resume(d.id); break;
    case 'dl-more': if (d) dlMenu(d, a); break;
    default: break;
  }
});

/* ───────────────────────────── updates from the desktop shell ───────────────────────────── */
function dlUpdate(s) {
  if (!s) return;
  const before = new Map(dl.items.map((d) => [d.id, d.state]));
  const hadList = dl.key !== '';
  Object.assign(dl, s);
  dl.byUid = new Map(dl.items.map((d) => [d.uid, d]));
  if (hadList) for (const d of dl.items) if (d.state === 'done' && before.has(d.id) && before.get(d.id) !== 'done') toast(`Downloaded: ${dlName(d)}`);

  const key = dl.items.map((d) => d.id + d.state).join() + '|' + dl.held + '|' + dl.folder + '|' + dl.pauseWhileWatching;
  const changed = key !== dl.key;
  dl.key = key;
  const nav = $('#nav [data-route="downloads"]');
  nav.dataset.count = dl.items.filter((d) => d.state === 'downloading' || d.state === 'queued').length;
  $$('[data-dl]').forEach(dlPaintBtn);
  if (ui.route === 'downloads') { if (changed) renderDownloads(); else dlPaintRows(); }
  if (!changed) return;
  if (ui.route === 'ws' && ws.detail && ws.detail.kind === 'series') renderDetail();   // the "Download season" button
  if (ui.route === 'settings') renderSettings();
}

function initDownloads() {
  if (!dlApi) return;
  $('#nav [data-route="downloads"]').hidden = false;
  dlApi.onChange(dlUpdate);
  dlApi.list().then(dlUpdate).catch(() => {});
}
