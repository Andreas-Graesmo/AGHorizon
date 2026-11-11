'use strict';
/**
 * Downloads for offline viewing (movies and episodes), one at a time.
 * They are ordinary video files in a folder the person picks, laid out the way Plex / Kodi / Jellyfin expect:
 *   <folder>/Movies/Title (Year)/Title (Year).mkv          + poster.jpg
 *   <folder>/Series/Show/Season 01/Show - S01E02.mkv       + poster.jpg in the show folder
 * The list lives in userData/downloads.json. It holds the provider URLs, which contain the login,
 * so it stays in the app's data folder (like the playlists) and never goes into the file names.
 * The page talks to this through preload.js; the local server plays finished files at /api/local/<id>.
 */
const { app, ipcMain, BrowserWindow, dialog, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';
const MAX_TRIES = 3; // automatic retries after a dropped connection (each one resumes where it stopped)

const listFile = () => path.join(app.getPath('userData'), 'downloads.json');
let folder = '';
let pauseWhileWatching = true; // most IPTV accounts allow only 1–2 connections at once
let watching = false;
let items = [];      // { id, uid, kind, title, …, state: 'queued' | 'downloading' | 'paused' | 'done' | 'failed' }
let active = null;   // { it, ac, done }
const held = () => watching && pauseWhileWatching;

/* ───────────────────────────── storage ───────────────────────────── */
function load() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(listFile(), 'utf8')); } catch { /* first run */ }
  folder = j.folder || path.join(app.getPath('documents'), 'AGHorizon');
  pauseWhileWatching = j.pauseWhileWatching !== false;
  items = (Array.isArray(j.items) ? j.items : [])
    .map((it) => (it.state === 'downloading' ? { ...it, state: 'queued' } : it));   // the app was closed mid-download: carry on
  relocate();
}

/* ───────────────────────────── moved or missing files ───────────────────────────── */
// A finished download whose file isn't where it was is kept, never dropped: the folder may have been moved (and
// chosen again in the app), or be on a drive that isn't plugged in. It's looked for at the same place under the
// current folder (<folder>/Movies/… or <folder>/Series/…), and hidden from the page until it turns up.
const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|ts|mov|webm)$/i;
const present = (it) => it.state !== 'done' || fs.existsSync(it.file);
function underFolder(file) {
  const m = /[\\/](Movies[\\/][^\\/]+[\\/][^\\/]+|Series[\\/][^\\/]+[\\/][^\\/]+[\\/][^\\/]+)$/.exec(file || '');
  return m ? path.join(folder, m[1]) : null;
}
function relocate() {
  let changed = false;
  for (const it of items) {
    if (present(it)) continue;
    const moved = underFolder(it.file);
    if (!moved || !fs.existsSync(moved)) continue;
    it.file = moved;
    const p = posterPath(it);
    it.posterFile = fs.existsSync(p) ? p : '';
    changed = true;
  }
  if (changed) save();
}

// Video files in the folder that the list doesn't know (e.g. the list was lost), read from their Plex-style names:
// Movies/<Title (Year)>/<file>, Series/<Show>/Season NN/<Show> - SxxEyy….<ext>. The page matches them to the playlist.
async function orphans() {
  const known = new Set(items.map((it) => path.resolve(it.file).toLowerCase()));
  const ls = (d) => fsp.readdir(d, { withFileTypes: true }).catch(() => []);
  const out = [];
  const found = async (file, info) => {
    if (known.has(path.resolve(file).toLowerCase())) return;
    const st = await fsp.stat(file).catch(() => null);
    if (st) out.push({ file, ext: path.extname(file).slice(1).toLowerCase(), size: st.size, ...info });
  };
  for (const m of await ls(path.join(folder, 'Movies'))) {
    if (!m.isDirectory()) continue;
    for (const f of await ls(path.join(folder, 'Movies', m.name))) {
      if (f.isFile() && VIDEO_EXT.test(f.name)) await found(path.join(folder, 'Movies', m.name, f.name), { kind: 'movie', folderName: m.name });
    }
  }
  for (const s of await ls(path.join(folder, 'Series'))) {
    if (!s.isDirectory()) continue;
    for (const season of await ls(path.join(folder, 'Series', s.name))) {
      if (!season.isDirectory() || !/^Season \d+$/i.test(season.name)) continue;
      for (const f of await ls(path.join(folder, 'Series', s.name, season.name))) {
        const se = f.isFile() && VIDEO_EXT.test(f.name) && /S(\d+)\s*E(\d+)/i.exec(f.name);
        if (se) await found(path.join(folder, 'Series', s.name, season.name, f.name), { kind: 'episode', seriesName: s.name, season: Number(se[1]), episode: Number(se[2]) });
      }
    }
  }
  return out;
}

// Take such files back as finished downloads, with what the page found out about them (as for a new download).
async function adopt(list) {
  const root = path.resolve(folder).toLowerCase() + path.sep;
  let n = 0;
  for (const { file, meta } of Array.isArray(list) ? list : []) {
    if (!file || !path.resolve(file).toLowerCase().startsWith(root) || !fs.existsSync(file) || items.some((x) => x.file === file)) continue;
    const it = newItem(meta);
    if (!it) continue;
    items = items.filter((x) => !(x.uid === it.uid && !present(x)));   // it replaces its own lost entry
    if (items.some((x) => x.uid === it.uid)) continue;
    const st = await fsp.stat(file);
    Object.assign(it, { file, ext: path.extname(file).slice(1).toLowerCase(), state: 'done', size: st.size, received: st.size, addedAt: st.mtimeMs, doneAt: st.mtimeMs });
    const p = posterPath(it);
    if (fs.existsSync(p)) it.posterFile = p;
    items.push(it);
    n++;
  }
  if (n) { save(); send(); }
  return n;
}
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {   // via a temp file, so a crash mid-write never leaves a broken list (load() would then start empty)
    fs.writeFileSync(listFile() + '.tmp', JSON.stringify({ folder, pauseWhileWatching, items }));
    fs.renameSync(listFile() + '.tmp', listFile());
  } catch { /* not critical */ }
}
const saveSoon = () => { if (!saveTimer) saveTimer = setTimeout(save, 3000); };

/* ───────────────────────────── telling the page ───────────────────────────── */
const pub = (it) => ({
  id: it.id, uid: it.uid, pid: it.pid, kind: it.kind, title: it.title, year: it.year, plot: it.plot, ext: it.ext,
  seriesUid: it.seriesUid, seriesName: it.seriesName, season: it.season, episode: it.episode, epTitle: it.epTitle,
  poster: it.poster, hasPoster: !!it.posterFile, state: it.state, error: it.error, size: it.size || 0,
  received: it.received || 0, speed: it.speed || 0, addedAt: it.addedAt, doneAt: it.doneAt || 0,
});
const snapshot = () => ({ items: items.filter(present).map(pub), folder, pauseWhileWatching, held: held() });   // missing files: kept, not shown
function send() {
  const s = snapshot();
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('downloads:changed', s);
}
let tickTimer = 0;
const sendSoon = () => { if (!tickTimer) tickTimer = setTimeout(() => { tickTimer = 0; send(); }, 500); };
function set(it, patch) { Object.assign(it, patch); save(); send(); }

/* ───────────────────────────── file names ───────────────────────────── */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
function clean(s) {
  let n = String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (n.length > 100) n = n.slice(0, 100).trim();
  if (!n || RESERVED.test(n)) n = '_' + n;
  return n;
}
const pad = (n) => String(n || 0).padStart(2, '0');

function targetFile(m) {
  const ext = /^[a-z0-9]{2,5}$/i.test(m.ext || '') ? m.ext.toLowerCase() : 'mp4';
  let dir, base;
  if (m.kind === 'movie') {
    let name = clean(m.title);
    if (m.year && !name.includes(m.year)) name += ` (${m.year})`;
    dir = path.join(folder, 'Movies', name);
    base = name;
  } else {
    const show = clean(m.seriesName || 'Series');
    const se = `S${pad(m.season)}E${pad(m.episode)}`;
    const t = String(m.epTitle || '');
    const extra = t && !/S\d+\s*E\d+/i.test(t) && !t.toLowerCase().startsWith(show.toLowerCase()) ? ` - ${clean(t)}` : '';
    dir = path.join(folder, 'Series', show, `Season ${pad(m.season)}`);
    base = `${show} - ${se}${extra}`;
  }
  // never overwrite a file that was already there, or one another download is about to write
  let file = path.join(dir, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(file) || items.some((x) => x.file === file); i++) file = path.join(dir, `${base} (${i}).${ext}`);
  return file;
}
// Movies/Title/poster.jpg, Series/Show/poster.jpg
const posterPath = (it) => path.join(it.kind === 'movie' ? path.dirname(it.file) : path.dirname(path.dirname(it.file)), 'poster.jpg');

async function savePoster(it) {
  const file = posterPath(it);
  try {
    if (!fs.existsSync(file)) {
      const r = await fetch(it.poster, { headers: { 'User-Agent': it.ua || DEFAULT_UA }, signal: AbortSignal.timeout(20000) });
      if (!r.ok || !/^image\//i.test(r.headers.get('content-type') || '')) return;
      await fsp.writeFile(file, Buffer.from(await r.arrayBuffer()));
    }
    it.posterFile = file;
  } catch { /* the download itself matters more than its picture */ }
}

/* ───────────────────────────── downloading ───────────────────────────── */
function friendly(e, status) {
  if (status === 401 || status === 403) return 'The provider refused the download. Check that the subscription is active.';
  if (status === 404) return 'This title is no longer available from the provider.';
  if (status === 429 || status === 458 || status === 509) return 'The provider’s connection limit is used up. Stop other playback and try again.';
  if (status) return `The provider answered HTTP ${status}.`;
  const code = (e && (e.code || (e.cause && e.cause.code))) || '';
  if (code === 'ENOSPC') return 'Not enough disk space.';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'Can’t write to the download folder. Choose another folder.';
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) || /fetch failed|terminated/i.test(String(e && e.message))) return 'Lost the connection to the provider.';
  return String((e && e.message) || e || 'Unknown error').split('\n')[0].slice(0, 200);
}

async function run(it, ac) {
  let status = 0;
  const part = it.file + '.part';
  set(it, { state: 'downloading', error: '', speed: 0 });
  try {
    await fsp.mkdir(path.dirname(it.file), { recursive: true });
    if (it.poster && !it.posterFile) savePoster(it);
    let have = 0;
    try { have = (await fsp.stat(part)).size; } catch { /* nothing yet */ }
    const headers = { 'User-Agent': it.ua || DEFAULT_UA, Accept: '*/*' };
    if (have) headers.Range = `bytes=${have}-`;
    const r = await fetch(it.url, { headers, redirect: 'follow', signal: ac.signal });
    status = r.status;
    if (r.status === 416 && have) { /* asked for bytes past the end: the .part is already complete */ }
    else {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      status = 0;
      const ct = r.headers.get('content-type') || '';
      if (/mpegurl/i.test(ct)) throw new Error('This title is streamed in small pieces (HLS) and can’t be downloaded.');
      if (/^text\/|json/i.test(ct)) throw new Error('The provider sent a web page instead of the video. The connection limit may be used up.');
      const resumed = r.status === 206;
      if (!resumed) have = 0;
      const total = /\/(\d+)\s*$/.exec(r.headers.get('content-range') || '');
      const len = Number(r.headers.get('content-length')) || 0;
      it.size = total ? Number(total[1]) : len ? have + len : 0;
      it.received = have;
      let mark = { t: Date.now(), b: have };
      const body = Readable.fromWeb(r.body);
      body.on('data', (c) => {
        it.received += c.length;
        const now = Date.now();
        if (now - mark.t >= 1000) {
          const v = ((it.received - mark.b) * 1000) / (now - mark.t);
          it.speed = it.speed ? it.speed * 0.6 + v * 0.4 : v;
          mark = { t: now, b: it.received };
          saveSoon();
        }
        sendSoon();
      });
      await pipeline(body, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
      if (it.size && it.received < it.size) throw Object.assign(new Error('The download stopped early.'), { code: 'ECONNRESET' });
    }
    await fsp.rename(part, it.file);
    set(it, { state: 'done', size: (await fsp.stat(it.file)).size, received: 0, speed: 0, tries: 0, doneAt: Date.now() });
  } catch (e) {
    if (ac.signal.aborted) return;   // paused, held for playback or removed: whoever stopped it has set the state
    const msg = status ? friendly(e, status) : friendly(e);
    const transient = !status && msg === 'Lost the connection to the provider.';
    it.tries = (it.tries || 0) + 1;
    if (transient && it.tries < MAX_TRIES) {
      set(it, { state: 'queued', speed: 0, error: '' });
      await new Promise((res) => setTimeout(res, 5000));
    } else set(it, { state: 'failed', speed: 0, error: msg });
  } finally {
    if (active && active.it === it) active = null;
    pump();
  }
}

function pump() {
  if (active || held()) return;
  const it = items.find((x) => x.state === 'queued');
  if (!it) return;
  // keep the controller and the promise, so pause / remove can stop it and wait until the file is closed
  const ac = new AbortController();
  active = { it, ac, done: null };
  active.done = run(it, ac);
}

async function stopActive(it, state) {
  if (!active || active.it !== it) return;
  const { ac, done } = active;
  it.state = state;
  it.speed = 0;
  ac.abort();
  await done;
}

/* ───────────────────────────── actions from the page ───────────────────────────── */
// a list entry from what the page sends about a movie / episode
function newItem(m) {
  if (!m || (m.kind !== 'movie' && m.kind !== 'episode') || !/^https?:\/\//i.test(m.url || '')) return null;
  return {
    id: crypto.randomBytes(8).toString('hex'), uid: String(m.uid), pid: m.pid, kind: m.kind, url: m.url, ua: m.ua || '',
    ext: m.ext, title: m.title, year: m.year || '', plot: String(m.plot || '').slice(0, 1200), poster: /^https?:\/\//i.test(m.poster || '') ? m.poster : '',
    seriesUid: m.seriesUid || '', seriesName: m.seriesName || '', season: Number(m.season) || 0, episode: Number(m.episode) || 0, epTitle: m.epTitle || '',
    state: 'queued', size: 0, received: 0, addedAt: Date.now(),
  };
}

function add(list) {
  let added = 0;
  for (const m of Array.isArray(list) ? list : [list]) {
    const it = newItem(m);
    if (!it) continue;
    const old = items.find((x) => x.uid === it.uid);
    if (old && !present(old)) items = items.filter((x) => x !== old);   // its file is gone: download it again
    else if (old) { if (old.state === 'failed' || old.state === 'paused') { old.state = 'queued'; old.error = ''; old.tries = 0; added++; } continue; }
    it.file = targetFile(it);
    items.push(it);
    added++;
  }
  save(); send(); pump();
  return added;
}

async function removeEmptyDirs(dir) {
  const root = path.resolve(folder);
  for (let d = path.resolve(dir); d.startsWith(root + path.sep); d = path.dirname(d)) {
    let left;
    try { left = await fsp.readdir(d); } catch { return; }
    if (left.some((f) => f !== 'poster.jpg')) return;   // a poster alone doesn't keep a folder alive
    try { await fsp.rm(d, { recursive: true }); } catch { return; }
  }
}

async function remove(id, deleteFile) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  await stopActive(it, 'removed');
  items = items.filter((x) => x !== it);
  await fsp.rm(it.file + '.part', { force: true }).catch(() => {});
  if (deleteFile && it.state === 'done') {
    await fsp.rm(it.file, { force: true }).catch(() => {});
    // and its subtitles: "<name>.<lang>….srt" next to it (subtitles.js)
    const base = path.basename(it.file, path.extname(it.file)) + '.';
    const near = await fsp.readdir(path.dirname(it.file)).catch(() => []);
    for (const f of near) if (f.startsWith(base) && f.toLowerCase().endsWith('.srt')) await fsp.rm(path.join(path.dirname(it.file), f), { force: true }).catch(() => {});
  }
  if (deleteFile || it.state !== 'done') await removeEmptyDirs(path.dirname(it.file));
  save(); send(); pump();
}

async function pause(id) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  if (active && active.it === it) await stopActive(it, 'paused');
  else if (it.state === 'queued') it.state = 'paused';
  save(); send(); pump();
}

// A new order for the unfinished downloads (dragged in the list, or "Download next"). Downloads go one at a time,
// first waiting one first; if that's no longer the one downloading, it takes over, and the other one waits with
// its partial file (it continues from the same byte later).
async function reorder(ids) {
  const pos = new Map((Array.isArray(ids) ? ids : []).map((id, i) => [String(id), i]));
  const moved = items.filter((x) => pos.has(x.id) && x.state !== 'done').sort((a, b) => pos.get(a.id) - pos.get(b.id));
  if (!moved.length) return;
  items = [...moved, ...items.filter((x) => !moved.includes(x))];
  const next = items.find((x) => x.state === 'queued' || x.state === 'downloading');
  if (active && next && next !== active.it) await stopActive(active.it, 'queued');
  save(); send(); pump();
}

function resume(id) {
  const it = items.find((x) => x.id === id);
  if (it && (it.state === 'paused' || it.state === 'failed')) { Object.assign(it, { state: 'queued', error: '', tries: 0 }); save(); send(); pump(); }
}

async function setWatching(on) {
  watching = !!on;
  if (held() && active) await stopActive(active.it, 'queued');   // it continues from the same byte when playback stops
  send(); pump();
}

async function freeSpace() {
  try { await fsp.mkdir(folder, { recursive: true }); const s = await fsp.statfs(folder); return s.bavail * s.bsize; } catch { return 0; }
}

/* Used by the local server to play finished downloads (and show their posters) without the provider. */
function localFile(id, what) {
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  if (what === 'poster') return it.posterFile && fs.existsSync(it.posterFile) ? it.posterFile : null;
  return it.state === 'done' && fs.existsSync(it.file) ? it.file : null;
}

function init() {
  load();
  ipcMain.handle('downloads:list', async () => {
    relocate();   // files moved back, or the drive is plugged in again
    return { ...snapshot(), free: await freeSpace() };
  });
  ipcMain.handle('downloads:orphans', () => orphans());
  ipcMain.handle('downloads:adopt', (_e, list) => adopt(list));
  ipcMain.handle('downloads:add', (_e, list) => add(list));
  ipcMain.handle('downloads:pause', (_e, id) => pause(id));
  ipcMain.handle('downloads:resume', (_e, id) => resume(id));
  ipcMain.handle('downloads:reorder', (_e, ids) => reorder(ids));
  ipcMain.handle('downloads:remove', (_e, id, deleteFile) => remove(id, !!deleteFile));
  ipcMain.handle('downloads:reveal', (_e, id) => {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    const f = fs.existsSync(it.file) ? it.file : it.file + '.part';
    if (fs.existsSync(f)) shell.showItemInFolder(f); else shell.openPath(folder);
  });
  ipcMain.handle('downloads:openFolder', async () => { await fsp.mkdir(folder, { recursive: true }).catch(() => {}); return shell.openPath(folder); });
  ipcMain.handle('downloads:chooseFolder', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Choose the download folder', defaultPath: folder, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    folder = r.filePaths[0];   // new downloads go here; finished ones stay where they are
    relocate();                // …unless they were moved here: then they're found again
    save(); send();
    return folder;
  });
  ipcMain.handle('downloads:setOption', (_e, key, value) => {
    if (key === 'pauseWhileWatching') { pauseWhileWatching = !!value; setWatching(watching); save(); }
  });
  ipcMain.handle('downloads:setWatching', (_e, on) => setWatching(on));
  app.on('before-quit', () => { for (const it of items) if (it.state === 'downloading') it.state = 'queued'; save(); });
  pump();
}

module.exports = { init, localFile };
