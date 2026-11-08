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
  if (!sub.track) {
    sub.track = video.addTextTrack('subtitles', 'Subtitles');
    sub.track.addEventListener('cuechange', () => subSample());   // the panel's sample line fills the gaps between lines
  }
  const t = sub.track;
  t.mode = 'hidden';   // cues can only be removed while the track isn't disabled
  while (t.cues && t.cues.length) t.removeCue(t.cues[0]);
  const off = tcState.on && tcState.vod ? tcState.offset : 0;
  for (const c of sub.cues) if (c.end > off) t.addCue(new VTTCue(Math.max(0, c.start - off), c.end - off, c.text));
  t.mode = sub.cues.length ? 'showing' : 'disabled';
  sub.offset = off;
  $('#pSubs').classList.toggle('on', !!sub.cues.length);
  subSample();   // the Appearance panel's sample line goes away once real subtitles are on
}
function subShow(vtt, key, label) {
  sub.cues = subParse(vtt);
  sub.key = key;
  sub.label = label;
  subApply();
  osd(sub.cues.length ? `Subtitles: ${label}` : 'These subtitles are empty');
}
function subOff() { subStopStream(); subHidePanel(); sub.cues = []; sub.key = ''; sub.label = ''; subApply(); }

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

/* ─────────────────────────────── how they look ─────────────────────────────── */
// Settings › Subtitles › Appearance. Font, colours and outline go on ::cue; size and position on the cue
// container (size on ::cue leaves gaps between lines). Size and position follow the player's height, like
// Chromium's own default (5 % of the video height).
const SUB_LOOK_KEY = 'tuner.subLook';
const SUB_SIZES = [['s', 'Small', 0.75], ['m', 'Medium', 1], ['l', 'Large', 1.3], ['xl', 'Extra large', 1.6]];
const SUB_FONTS = [['system', 'System', 'system-ui, sans-serif'], ['arial', 'Arial', 'Arial, Helvetica, sans-serif'], ['verdana', 'Verdana', 'Verdana, Geneva, sans-serif'],
  ['georgia', 'Georgia', 'Georgia, "Times New Roman", serif'], ['mono', 'Monospace', 'Consolas, "Courier New", monospace']];
const SUB_COLORS = [['#ffffff', 'White'], ['#ffe14d', 'Yellow'], ['#6fe3ff', 'Cyan'], ['#7dff8a', 'Green']];
const SUB_BGS = [['#000000', 'Black'], ['#3a3a3a', 'Grey']];
const SUB_POS = [['bottom', 'Bottom', 0], ['lower', 'A bit lower', 0.04], ['default', 'Default', 0.08], ['higher', 'A bit higher', 0.12], ['high', 'High', 0.16]];
function subLook() {
  const l = { size: 'm', font: 'system', color: '#ffffff', bg: '#000000', opacity: 60, pos: 'default', ...LS.get(SUB_LOOK_KEY, {}) };
  if (l.pos === 'raised') l.pos = 'default';   // the old "A bit higher" is the height of today's Default
  return l;
}
const subPick = (list, key, i = 2) => (list.find((x) => x[0] === key) || list[0])[i];

function subApplyLook() {
  const l = subLook();
  const root = document.documentElement.style;
  const a = Math.max(0, Math.min(100, Number(l.opacity))) / 100;
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ');
  root.setProperty('--sub-font', subPick(SUB_FONTS, l.font));
  root.setProperty('--sub-color', l.color);
  root.setProperty('--sub-bg', a ? `rgba(${hex(l.bg)}, ${a})` : 'transparent');
  // with little or no background, an outline keeps the text readable on bright pictures
  root.setProperty('--sub-shadow', a < 0.35 ? '0 0 3px #000, 0 0 2px #000, 1px 1px 2px #000' : 'none');
  root.setProperty('--sub-scale', subPick(SUB_SIZES, l.size));
  subSizeToPlayer();
}
function subSizeToPlayer() {
  const l = subLook();
  const h = $('#player').clientHeight || 0;
  const p = $('#player').style;
  p.setProperty('--sub-px', Math.max(10, Math.round(h * 0.05 * subPick(SUB_SIZES, l.size))) + 'px');
  p.setProperty('--sub-raise', Math.round(h * subPick(SUB_POS, l.pos)) + 'px');
}
new ResizeObserver(subSizeToPlayer).observe($('#player'));
subApplyLook();

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
  items.push({ label: 'Appearance…', run: subShowPanel });
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
    ${subLookRows()}
    <div class="set-row"><div><b>OpenSubtitles account</b><p class="muted">Finds subtitles for streams, and for downloads that don't include your language. Create a free account on opensubtitles.com and log in with it here. Free accounts can download a limited number of subtitles per day. Stored only on this computer.</p></div></div>
    ${os}
    <div class="set-row"><div><b>Languages to save with downloads</b><p class="muted">When a download finishes, the subtitles inside it are saved next to it as .srt files. Languages listed here that it doesn't include are fetched from OpenSubtitles. Use language codes, best first: <i>no, en</i>.</p></div><input class="sub-langs" data-sub="langs" value="${esc(c.langs || '')}" placeholder="no, en" spellcheck="false"></div>
  </section>`;
}

// The appearance controls, shared by Settings › Subtitles and the Appearance panel in the player.
function subLookControls() {
  const l = subLook();
  const seg = (key, opts) => `<div class="seg">${opts.map(([v, label]) => `<button data-sublook="${key}" data-val="${v}" class="${l[key] === v ? 'on' : ''}">${label}</button>`).join('')}</div>`;
  const swatches = (key, opts) => `<div class="swatches">${opts.map(([v, label]) => `<button class="swatch${l[key] === v ? ' on' : ''}" data-sublook="${key}" data-val="${v}" style="--c:${v}" title="${label}" aria-label="${label}"></button>`).join('')}</div>`;
  return {
    size: seg('size', SUB_SIZES),
    font: `<select data-sublook="font">${SUB_FONTS.map(([v, label]) => `<option value="${v}"${l.font === v ? ' selected' : ''}>${label}</option>`).join('')}</select>`,
    color: swatches('color', SUB_COLORS),
    bg: `<div class="sub-bg">${swatches('bg', SUB_BGS)}<input type="range" min="0" max="100" step="5" value="${l.opacity}" data-sublook="opacity" aria-label="Background opacity"><span class="sub-op">${l.opacity} %</span></div>`,
    pos: seg('pos', SUB_POS),
    reset: '<button class="btn ghost" data-act="sub-look-reset">Default look</button>',
  };
}
function subLookRows() {
  const c = subLookControls();
  return `<div class="set-row sub-preview-row"><div><b>Appearance</b><p class="muted">How subtitles look in the player. You can also change it while watching: CC › Appearance.</p></div>
      <div class="sub-preview" aria-hidden="true"><span>This is how subtitles<br>will look.</span></div></div>
    <div class="set-row"><div><b>Size</b></div>${c.size}</div>
    <div class="set-row"><div><b>Font</b></div>${c.font}</div>
    <div class="set-row"><div><b>Text colour</b></div>${c.color}</div>
    <div class="set-row"><div><b>Background</b><p class="muted">At 0 % there's no background; the text gets a dark outline instead.</p></div>${c.bg}</div>
    <div class="set-row"><div><b>Position</b><p class="muted">Subtitles still move up while the player controls are shown.</p></div>${c.pos}</div>
    <div class="set-row"><div><b>Reset</b></div>${c.reset}</div>`;
}
const subSetLook = (patch) => { LS.set(SUB_LOOK_KEY, { ...subLook(), ...patch }); subApplyLook(); };
// the controls' events, for one place they're shown in; rerender redraws it so the right buttons light up
function subLookEvents(root, rerender) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sublook]');
    if (b) { subSetLook({ [b.dataset.sublook]: b.dataset.val }); rerender(); return; }
    if (e.target.closest('[data-act="sub-look-reset"]')) { LS.set(SUB_LOOK_KEY, {}); subApplyLook(); rerender(); }
  });
  root.addEventListener('input', (e) => {
    if (e.target.dataset.sublook !== 'opacity') return;
    subSetLook({ opacity: Number(e.target.value) });   // live while dragging; no redraw, so the slider keeps its grip
    e.target.parentElement.querySelector('.sub-op').textContent = e.target.value + ' %';
  });
  root.addEventListener('change', (e) => { if (e.target.dataset.sublook === 'font') subSetLook({ font: e.target.value }); });
}
subLookEvents($('#v-settings'), () => renderSettings());

/* The Appearance panel in the player (CC › Appearance…): stays open while you try things, so you see the
   subtitles change; with subtitles off it shows a sample line. Inside the player, so it also works full screen. */
const subPanel = document.createElement('div');
subPanel.className = 'sub-panel';
subPanel.hidden = true;
$('#player').appendChild(subPanel);
const subPanelOpen = () => !subPanel.hidden;
function subPanelRender() {
  const c = subLookControls();
  subPanel.innerHTML = `<div class="sp-head"><b>Subtitle appearance</b><button class="p-btn" data-act="sub-panel-close" title="Close" aria-label="Close"><svg class="ic"><use href="#i-x"/></svg></button></div>
    <div class="sp-row"><span>Size</span>${c.size}</div>
    <div class="sp-row"><span>Font</span>${c.font}</div>
    <div class="sp-row"><span>Text colour</span>${c.color}</div>
    <div class="sp-row"><span>Background</span>${c.bg}</div>
    <div class="sp-row sp-stack"><span>Position</span>${c.pos}</div>
    <div class="sp-row sp-end">${c.reset}</div>`;
}
function subShowPanel() { subPanelRender(); subPanel.hidden = false; subSample(); }
function subHidePanel() { if (subPanel.hidden) return; subPanel.hidden = true; subSample(); }
subLookEvents(subPanel, subPanelRender);
subPanel.addEventListener('click', (e) => {
  if (e.target.closest('[data-act="sub-panel-close"]')) subHidePanel();
  const b = e.target.closest('button');
  if (b) b.blur();   // so Space / arrows go back to the player instead of pressing the button again
});
const subPanelOutside = (e) => { if (subPanelOpen() && !e.target.closest('.sub-panel, #menu, #pSubs')) subHidePanel(); };
document.addEventListener('mousedown', subPanelOutside, true);
onPipDoc('mousedown', subPanelOutside, true);   // and in the picture-in-picture window

// A sample line while the panel is open and no subtitles are on, on a track of its own.
// Shown while the Appearance panel is open and no real subtitle is on screen: subtitles off, or a gap between lines.
let subSampleTrack = null;
let subSampleOn = false;
function subSample() {
  if (!subSampleTrack && !subPanelOpen()) return;
  if (!subSampleTrack) {
    subSampleTrack = video.addTextTrack('subtitles', 'Sample');
    subSampleTrack.mode = 'hidden';
    subSampleTrack.addCue(new VTTCue(0, 1e6, 'This is how subtitles\nwill look.'));
  }
  const real = sub.track && sub.track.mode === 'showing' && sub.track.activeCues && sub.track.activeCues.length > 0;
  const want = subPanelOpen() && !real;
  if (want === subSampleOn) return;   // only on a change, so it doesn't flicker
  subSampleOn = want;
  subSampleTrack.mode = want ? 'showing' : 'hidden';   // hidden, not disabled: keeps its cue
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
