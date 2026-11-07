'use strict';
/* AG Horizon – subtitles in the player: the CC button, the subtitles saved with a download (built-in ones are
   saved as .srt next to the file the first time), OpenSubtitles.com, and fetching subtitles for new downloads.
   Subtitles never turn on by themselves. The server side is subtitles.js. */

const SUB_KEY = 'tuner.subs';   // { username, password, langs: "no, en" } – the OpenSubtitles API key is the app's own (server)
const subCfg = () => LS.get(SUB_KEY, {});
const subOs = () => { const c = subCfg(); return { username: c.username || '', password: c.password || '' }; };
const subHasAccount = () => { const o = subOs(); return !!(state.opensubtitles && o.username && o.password); };
const subNoAccount = () => toast(state.opensubtitles ? 'Add your OpenSubtitles account in Settings › Subtitles' : 'OpenSubtitles isn’t available in this build of AG Horizon', 'err');

// "nob" / "nor" / "nb" -> "no", "swe" -> "sv": one code per language, to compare built-in tracks with wishes
function subNorm(code) {
  let c = String(code || '').trim().toLowerCase();
  if (!c || c === 'und') return '';
  try { c = Intl.getCanonicalLocales(c)[0].toLowerCase(); } catch { /* keep as typed */ }
  return c === 'nb' || c === 'nn' ? 'no' : c;
}
const subLangs = () => String(subCfg().langs || '').split(/[\s,;]+/).map(subNorm).filter(Boolean);
const subNames = new Intl.DisplayNames(['en'], { type: 'language' });
function subLabel(code) {
  if (!code || code === 'und') return 'Unknown language';
  try { const n = subNames.of(code); return n && n.toLowerCase() !== code.toLowerCase() ? n : code.toUpperCase(); } catch { return code.toUpperCase(); }
}

/* ─────────────────────────────── showing them ─────────────────────────────── */
// One text track for everything. Cues are added by hand so they can be shifted: in compatibility mode the
// video restarts at the seek point, so its clock starts at 0 there (tcState.offset).
const sub = { track: null, cues: [], key: '', label: '', stream: null, seen: new Set() };

function subParse(vtt) {
  const t = (s) => { const p = s.trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  const out = [];
  for (const block of vtt.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const text = lines.slice(i + 1).join('\n').trim();
    const start = t(a), end = t(b.trim().split(/\s/)[0]);
    if (text && isFinite(start) && isFinite(end) && end > start) out.push({ start, end, text });
  }
  return out;
}

function subApply() {
  if (!sub.track) sub.track = video.addTextTrack('subtitles', 'Subtitles');
  const t = sub.track;
  t.mode = 'hidden';   // cues can only be removed while the track isn't disabled
  while (t.cues && t.cues.length) t.removeCue(t.cues[0]);
  const off = tcState.on && tcState.vod ? tcState.offset : 0;
  for (const c of sub.cues) if (c.end > off) t.addCue(new VTTCue(Math.max(0, c.start - off), c.end - off, c.text));
  t.mode = sub.cues.length ? 'showing' : 'disabled';
  sub.offset = off;
  $('#pSubs').classList.toggle('on', !!sub.cues.length);
}
function subShow(vtt, key, label) {
  sub.cues = subParse(vtt);
  sub.key = key;
  sub.label = label;
  subApply();
  osd(sub.cues.length ? `Subtitles: ${label}` : 'These subtitles are empty');
}
function subOff() { subStopStream(); sub.cues = []; sub.key = ''; sub.label = ''; subApply(); }

// A track read from the running conversion arrives bit by bit: add the cues that are new since last time.
function subAddCues(list) {
  const t = sub.track;
  const off = tcState.on && tcState.vod ? tcState.offset : 0;
  let added = 0;
  for (const c of list) {
    const k = `${c.start.toFixed(3)}|${c.text}`;
    if (sub.seen.has(k)) continue;
    sub.seen.add(k);
    sub.cues.push(c);
    if (sub.offset === off && c.end > off) t.addCue(new VTTCue(Math.max(0, c.start - off), c.end - off, c.text));
    added++;
  }
  if (added && t.mode !== 'showing') subApply();
  return added;
}
let subPollTimer = 0;
function subStopStream() { clearTimeout(subPollTimer); sub.stream = null; sub.seen = new Set(); }
async function subPollStream() {
  clearTimeout(subPollTimer);
  const s = sub.stream;
  if (!s) return;
  if (tcState.on && tcState.sid) {
    try {
      const r = await fetch(`/api/tcsubs/${tcState.sid}/${s.n}`);
      if (r.ok && sub.stream === s) subAddCues(subParse(await r.text()));
    } catch { /* try again */ }
  }
  if (sub.stream === s) subPollTimer = setTimeout(subPollStream, sub.cues.length ? 3000 : 600);   // ffmpeg writes ahead of playback
}
// Show a subtitle track of the stream itself. It comes from compatibility mode, so a video that plays directly
// switches to it (the picture is kept as it is, so that costs little) and goes on where it was.
function subUseStream(c, n, key, label) {
  subStopStream();
  sub.cues = []; sub.key = key; sub.label = label; sub.stream = { n };
  subApply();
  osd(`Subtitles: ${label}`);
  if (!tcState.on || !(tcState.subs || []).includes(n)) {
    if (isFinite(curTime()) && curTime() > 0) state.progress[c.uid] = { t: curTime(), d: durTime() || 0, w: 0, ts: Date.now() };
    startPlayback(c, ['tc'], playToken);
  }
  subPollStream();
}
// a new video, or compatibility mode restarted at another point: re-time the cues
video.addEventListener('loadedmetadata', () => { if (sub.cues.length && sub.offset !== (tcState.on && tcState.vod ? tcState.offset : 0)) subApply(); });

/* ─────────────────────────────── finding them ─────────────────────────────── */
// The .srt files saved with a download. The first time, the server saves the built-in ones in the background
// (wait: until that's done), so an empty list isn't kept.
const subLocalCache = new Map();   // download id -> [{ n, lang, forced, sdh, os }]
async function subLocalList(id, { fresh = false, wait = false } = {}) {
  if (!fresh && subLocalCache.has(id)) return subLocalCache.get(id);
  const r = await fetch(`/api/local/${id}/subs${wait ? '?wait=1' : ''}`);
  const list = r.ok ? await r.json() : [];
  if (list.length) subLocalCache.set(id, list);
  return list;
}
const subName = (s) => `${subLabel(s.lang)}${s.forced ? ' (forced)' : ''}${s.sdh ? ' (SDH)' : ''}${s.os ? ' (OpenSubtitles)' : ''}`;
const subPost = async (path, body) => {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

// What to ask OpenSubtitles for this movie / episode: TMDB ids from the provider when it has them, else the title.
const subCleanTitle = (s) => String(s || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+-\s+S\d+\s*E\d+.*$/i, '').replace(/\s+/g, ' ').trim();
function subInfoOf(uid) {
  const d = state.detail[uid];
  if (d && d.info) return d.info;
  const copy = typeof dlInfo !== 'undefined' && dlInfo.map[uid];
  return (copy && copy.detail && copy.detail.info) || {};
}
function subQueries(c, lang) {
  const languages = lang || subLangs().join(',');
  const qs = [];
  if (c.kind === 'episode') {
    const info = subInfoOf(c.seriesUid);
    const tmdb = info.tmdb || info.tmdb_id;
    const ep = { season_number: c.season, episode_number: c.num, languages };
    if (tmdb) qs.push({ ...ep, parent_tmdb_id: tmdb });
    qs.push({ ...ep, query: subCleanTitle(c.seriesName || c.group) });
  } else {
    const info = subInfoOf(c.uid);
    const tmdb = info.tmdb_id || info.tmdb;
    if (tmdb) qs.push({ tmdb_id: tmdb, languages });
    qs.push({ query: subCleanTitle(c.name), year: c.year || String(info.releasedate || info.release_date || '').slice(0, 4), languages });
  }
  return qs;
}
async function subSearch(c, lang) {
  for (const q of subQueries(c, lang)) {
    const res = await subPost('/api/subs/search', { os: subOs(), q });
    if (res.length) return res;
  }
  return [];
}
// best first: your languages in your order, people over machine translations, then the most downloaded
function subRank(list) {
  const order = subLangs();
  const rank = (s) => { const i = order.indexOf(subNorm(s.lang)); return i < 0 ? order.length : i; };
  return list.slice().sort((a, b) => rank(a) - rank(b) || a.ai - b.ai || b.trusted - a.trusted || b.downloads - a.downloads);
}

const subLocalOf = (c) => { const d = c && dlOf(c.uid); return d && d.state === 'done' ? d : null; };

async function subFetchOs(c, s) {
  const d = subLocalOf(c);
  osd('Downloading subtitles…');
  try {
    const j = await subPost('/api/subs/download', { os: subOs(), fileId: s.fileId, lang: subNorm(s.lang) || s.lang, saveFor: d ? d.id : undefined });
    if (state.current !== c) return;
    if (d) subLocalCache.delete(d.id);   // it was saved next to the download
    subStopStream();
    subShow(j.vtt, `os:${s.fileId}`, subLabel(s.lang));
    if (typeof j.remaining === 'number') toast(`Subtitles from OpenSubtitles · ${j.remaining} downloads left today`);
  } catch (e) { toast(e.message, 'err'); }
}

async function subSearchMenu(anchor, c) {
  if (!subHasAccount()) { subNoAccount(); return; }
  osd('Searching OpenSubtitles…');
  let res;
  try { res = subRank(await subSearch(c)); } catch (e) { toast(e.message, 'err'); return; }
  if (state.current !== c) return;
  if (!res.length) { toast(subLangs().length ? 'OpenSubtitles has no subtitles for this in your languages' : 'OpenSubtitles has no subtitles for this'); return; }
  showMenu(anchor, [
    { heading: true, label: 'OpenSubtitles' },
    ...res.slice(0, 15).map((s) => ({
      label: `${subLabel(s.lang)} · ${s.release.slice(0, 48)}${s.sdh ? ' · SDH' : ''}${s.ai ? ' · machine-translated' : ''}`,
      run: () => subFetchOs(c, s),
    })),
  ]);
}

// The CC button: Off, the subtitles in the video (saved .srt files of a download, or the stream's own tracks,
// which compatibility mode writes as it goes), OpenSubtitles. Opens at once: nothing is read from the video here.
async function subMenu(anchor) {
  const c = state.current;
  if (!c || !isVod(c)) return;
  const mark = (on) => (on ? '✓  ' : '      ');
  const items = [{ label: mark(!sub.cues.length && !sub.stream) + 'Off', run: subOff }];
  const counts = {};
  const numbered = (name) => { counts[name] = (counts[name] || 0) + 1; return name + (counts[name] > 1 ? ` ${counts[name]}` : ''); };
  const d = subLocalOf(c);
  const saved = d ? await subLocalList(d.id).catch(() => []) : [];   // a folder listing, quick
  // the stream's tracks: from the codec check made before playing (local files are checked now, which is quick)
  const info = probeCache.get(c.url) || (c.local ? await probeOf(c, playlistById(c.pid)) : {});
  if (state.current !== c) return;
  const builtInSaved = saved.some((s) => !s.os);
  if (builtInSaved) {
    items.push({ heading: true, label: 'In the video' });
    for (const s of saved.filter((x) => !x.os)) items.push(subSavedItem(d, s, mark, numbered));
  } else if ((info.subs || []).length) {
    items.push({ heading: true, label: 'In the video' });
    for (const t of [...info.subs].sort((a, b) => subName(a).localeCompare(subName(b)))) {   // A–Z, like the saved ones
      const key = `stream:${t.index}`;
      const name = numbered(subName(t));
      items.push({ label: mark(sub.key === key) + name, run: () => subUseStream(c, t.index, key, name) });
    }
  }
  const fromOs = saved.filter((s) => s.os);
  if (fromOs.length) {
    items.push({ heading: true, label: 'Saved from OpenSubtitles' });
    for (const s of fromOs) items.push(subSavedItem(d, s, mark, numbered));
  }
  if (sub.key.startsWith('os:')) items.push({ label: mark(true) + `${sub.label} (OpenSubtitles)`, run: () => {} });
  items.push({ label: 'Search OpenSubtitles…', run: () => subSearchMenu(anchor, c) });
  showMenu(anchor, items);
}
function subSavedItem(d, s, mark, numbered) {
  const key = `local:${d.id}:${s.n}`;
  const name = numbered(subName(s));
  return {
    label: mark(sub.key === key) + name,
    run: async () => {
      try {
        const r = await fetch(`/api/local/${d.id}/subs/${s.n}`);
        if (!r.ok) throw new Error('Could not read the subtitles');
        subStopStream();
        subShow(await r.text(), key, name);
      } catch (e) { toast(e.message, 'err'); }
    },
  };
}
$('#pSubs').addEventListener('click', (e) => subMenu(e.currentTarget));

/* ─────────────────────────── with new downloads ─────────────────────────── */
// When a download finishes: save its built-in subtitles as .srt, then fetch the languages from Settings that
// it doesn't have from OpenSubtitles (one download from the daily limit per language).
let subQueue = Promise.resolve();
function subOnDownloaded(d) {
  subQueue = subQueue.then(async () => {
    const have = new Set((await subLocalList(d.id, { fresh: true, wait: true }).catch(() => [])).map((s) => subNorm(s.lang)));
    const missing = subLangs().filter((l) => !have.has(l));
    if (!missing.length || !subHasAccount()) return;
    const it = dlItem(d);
    for (const lang of missing) {
      try {
        const best = subRank(await subSearch(it, lang))[0];
        if (!best) continue;
        await subPost('/api/subs/download', { os: subOs(), fileId: best.fileId, lang, saveFor: d.id });
        subLocalCache.delete(d.id);
      } catch (e) { toast(`Subtitles for ${dlName(d)}: ${e.message}`, 'err'); return; }   // e.g. the daily limit: try the rest another time
    }
  });
}

/* ─────────────────────────────── Settings › Subtitles ─────────────────────────────── */
function subSettingsCard() {
  const c = subCfg();
  const field = (key, label, type = 'text', ph = '') => `<label class="sub-field"><span>${label}</span><input type="${type}" data-sub="${key}" value="${esc(c[key] || '')}" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false"></label>`;
  const os = state.opensubtitles
    ? `<div class="sub-fields">${field('username', 'Username')}${field('password', 'Password', 'password')}
      <div class="sub-test"><button class="btn ghost" data-act="sub-test">Test login</button><span class="muted" id="subTest"></span></div></div>`
    : '<p class="muted sub-na">OpenSubtitles isn’t available in this build of AG Horizon. Subtitles inside downloaded files still work.</p>';
  return `<section class="set-card"><h3>Subtitles</h3>
    <div class="set-row"><div><b>OpenSubtitles account</b><p class="muted">Finds subtitles for streams, and for downloads that don't include your language. Create a free account on opensubtitles.com and log in with it here. Free accounts can download a limited number of subtitles per day. Stored only on this computer.</p></div></div>
    ${os}
    <div class="set-row"><div><b>Languages to save with downloads</b><p class="muted">When a download finishes, the subtitles inside it are saved next to it as .srt files. Languages listed here that it doesn't include are fetched from OpenSubtitles. Use language codes, best first: <i>no, en</i>.</p></div><input class="sub-langs" data-sub="langs" value="${esc(c.langs || '')}" placeholder="no, en" spellcheck="false"></div>
  </section>`;
}
$('#v-settings').addEventListener('change', (e) => {
  const k = e.target.dataset.sub;
  if (!k) return;
  LS.set(SUB_KEY, { ...subCfg(), [k]: e.target.value.trim() });
});
$('#v-settings').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-act="sub-test"]')) return;
  const out = $('#subTest');
  $$('#v-settings [data-sub]').forEach((i) => i.dispatchEvent(new Event('change', { bubbles: true })));   // use what's typed, even before leaving the field
  out.textContent = 'Logging in…';
  try {
    const j = await subPost('/api/subs/login', { os: subOs() });
    out.textContent = typeof j.remaining === 'number' ? `Logged in · ${j.remaining} of ${j.allowed} downloads left today` : 'Logged in';
  } catch (err) { out.textContent = err.message; }
});
