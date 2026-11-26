'use strict';
/* AG Horizon – Android TV. The same pages run inside the Android TV app (android/), which shows itself to them as
   window.AGHorizonTV. There the app is steered with a remote: the arrows move a focus ring, OK picks, Back goes back,
   and a long press on OK (or the Menu key) opens what a right-hand button does on a computer. What plays is handed
   to the TV's own player (ExoPlayer), full screen; the player on these pages is not used.
   Loaded before every other script, so TV is known everywhere; nothing in here runs on a computer. */

const TV = typeof window !== 'undefined' && !!window.AGHorizonTV;
const TV_REPO = 'Andreas-Graesmo/AGHorizon';   // where releases are published: the "repository" in package.json
const tv = {
  info: {},          // { version, android, device, width } from the shell
  scopeKey: '',      // which page / dialog / menu the focus was last looked after for
  mem: new Map(),    // page or dialog -> what had the focus there: { sig, rect }
  okDown: 0, okEl: null, okLong: false,   // OK: pressed when, on what, and whether it became a long press
  exitAt: 0,         // Back on the first page: when it was last pressed
  auto: true,        // the focus is where the app put it, not where the remote moved it: it may still be put somewhere better
  focusUid: '',      // Live TV: the channel the focus is on (its programme shows next to the list)
  guideFrom: '',     // TV guide: the programme that was picked (Back from "Watch" returns to it)
  num: '', numTimer: 0,   // a channel number being typed while a channel plays
  playFrom: '',      // what had the focus when the player was started (it gets it back when the player closes)
  away: false,       // the player is up, or just closed: what gets the focus meanwhile is not where the person was
  editing: null,     // the text box OK opened for typing (the others are read-only while the focus passes by, see tvLock)
  timer: 0,
};

if (TV) {
  try { tv.info = JSON.parse(window.AGHorizonTV.info()) || {}; } catch { /* an older shell */ }
  document.documentElement.classList.add('tv');
  window.tunerDesktop = tvShell();
}

/* ───────────────────── what the desktop shell would answer (see tauri-shell.js) ───────────────────── */
function tvShell() {
  const upd = { st: { state: 'idle' }, cbs: [] };
  const send = (st) => { upd.st = st; upd.cbs.forEach((cb) => cb(st)); return st; };
  const releasesUrl = `https://github.com/${TV_REPO}/releases/latest`;
  // Update channel (Settings › About & updates): 'stable' takes GitHub's latest release, 'test' also pre-releases.
  // A test version installed by hand starts out on 'test', like on a computer (src-tauri/src/updater.rs).
  let channel = /-/.test(tv.info.version || '') ? 'test' : 'stable';
  const gh = (path) => fetch(`https://api.github.com/repos/${TV_REPO}/${path}`, { headers: { Accept: 'application/vnd.github+json' } });
  // The shell downloads a new version's APK and hands it to Android's installer (Updater.kt). An older shell can't:
  // then the app only says that a newer version exists, and how to get it.
  const canInstall = typeof window.AGHorizonTV.updateDownload === 'function';
  window.tvUpdate = (ev) => {
    const version = upd.st.version;
    if (ev.state === 'downloading') send({ state: 'downloading', version, percent: ev.percent || 0, url: upd.st.url });
    else if (ev.state === 'ready') { send({ state: 'ready', version, url: upd.st.url }); install(); }
    else send({ state: 'error', version, url: upd.st.url, message: ev.message || 'The download failed.' });
  };
  async function download() {
    if (canInstall && upd.st.url) { send({ state: 'downloading', version: upd.st.version, percent: 0, url: upd.st.url }); window.AGHorizonTV.updateDownload(upd.st.url); }
    else tvHowToUpdate(upd.st.version);
    return upd.st;
  }
  async function install() {
    if (!(canInstall && window.AGHorizonTV.updateInstall())) tvHowToUpdate(upd.st.version);
    return upd.st;
  }
  async function check() {
    send({ state: 'checking' });
    try {
      const hasApk = (j) => (j.assets || []).find((a) => /\.apk$/i.test(a.name || ''));   // a release without the TV app is not an update here
      let j = null;
      if (channel === 'test') {
        // the newest published release or pre-release that has the TV app
        const r = await gh('releases?per_page=30');
        if (!r.ok) throw new Error('GitHub answered ' + r.status);
        for (const rel of await r.json()) {
          if (!rel.draft && hasApk(rel) && tvVersionCompare(rel.tag_name, '0.0.0') > 0 && (!j || tvVersionCompare(rel.tag_name, j.tag_name) > 0)) j = rel;
        }
        if (!j) return send({ state: 'error', message: 'No published release was found.' });
      } else {
        const r = await gh('releases/latest');
        if (r.status === 404) return send({ state: 'error', message: 'No published release was found.' });
        if (!r.ok) throw new Error('GitHub answered ' + r.status);
        j = await r.json();
      }
      const tag = String(j.tag_name || '');
      const apk = hasApk(j);
      if (!apk || !(tvVersionCompare(tag, tv.info.version || '0.0.0') > 0)) return send({ state: 'current', checkedAt: Date.now() });
      return send({ state: 'available', version: tag.replace(/^v/i, ''), url: apk.browser_download_url || '', manual: !canInstall });
    } catch (e) { return send({ state: 'error', message: String((e && e.message) || e).slice(0, 200) }); }
  }
  const nothing = async () => null;
  return {
    displays: async () => [],
    focusWindow: async () => {},
    appInfo: async () => ({ version: tv.info.version || '', platform: 'android-tv', updater: canInstall, updaterReason: canInstall ? '' : 'On this TV, new versions are installed by hand.', releasesUrl, channel }),
    ready: () => { try { window.AGHorizonTV.ready(); } catch { /* an older shell */ } },
    updater: {
      status: async () => upd.st,
      check,
      download,
      install,
      openReleases: async () => tvHowToUpdate(upd.st.version),
      setChannel: async (next) => {
        if ((next === 'stable' || next === 'test') && next !== channel) {
          channel = next;
          if (!['downloading', 'ready'].includes(upd.st.state)) send({ state: 'idle' });
        }
        return channel;
      },
      notes: async (version) => {
        const none = { error: 'No release notes were found for this version.' };
        if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(version))) return none;
        try {
          const r = await gh(`releases/tags/v${version}`);
          if (r.status === 404) return none;
          if (!r.ok) throw new Error('GitHub answered ' + r.status);
          return { body: String((await r.json()).body || '') };
        } catch (e) { return { error: 'Couldn’t fetch the release notes: ' + String((e && e.message) || e).slice(0, 120) }; }
      },
      onStatus: (cb) => { upd.cbs.push(cb); },
    },
    // nothing is downloaded on a TV: the page asks, and hears that there is nothing
    downloads: {
      list: nothing, add: nothing, pause: nothing, resume: nothing, reorder: nothing, remove: nothing, reveal: nothing, openFolder: nothing,
      chooseFolder: nothing, setOption: nothing, setWatching: nothing, orphans: async () => [], adopt: async () => 0, onChange: () => {},
    },
  };
}

// "2.5.0-beta.1" vs "2.4.0": < 0 older, > 0 newer, 0 the same or unreadable. Ordered as in semver, like
// electron/versions.js (a page script can't load that file): 2.4.0 < 2.5.0-beta.1 < 2.5.0-beta.2 < 2.5.0.
function tvVersionCompare(a, b) {
  const parse = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim()); return m && { n: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] }; };
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

function tvHowToUpdate(version) {
  askConfirm({
    title: version ? `Version ${version} is available` : 'Getting a new version',
    text: 'Install it over this one, the same way you installed AG Horizon. Your playlists, favorites and history are kept.',
    list: [`The file is AG-Horizon-TV-${version || '<version>'}.apk on the releases page:`, `github.com/${TV_REPO}/releases/${version ? 'tag/v' + version : 'latest'}`, 'With the Downloader app on the TV you can type that address, or send the file from a phone or computer.'],
    ok: 'OK',
  });
}

/* ───────────────────────────── playing: the TV's own player ───────────────────────────── */
// The two title lines the player shows over the picture.
function tvTitles(ch) {
  if (ch.kind === 'episode') return { title: ch.seriesName || ch.name, sub: `S${String(ch.season || 1).padStart(2, '0')}E${String(ch.num || 0).padStart(2, '0')} · ${ch.title || ch.name}` };
  if (isVod(ch)) return { title: ch.name, sub: ch.year || '' };
  const { now, next } = nowNext(ch);
  const sub = now ? `${fmtTime(now[0])} – ${fmtTime(now[1])}   ${now[2] || ''}${next && next[2] ? `   ·   Next: ${next[2]}` : ''}` : '';
  // now / next as [start ms, end ms, title]: the player's controls draw the programme's progress from them
  return { title: ch.name, sub, num: String(ch.num || ''), now: now ? now.slice(0, 3) : null, next: next ? next.slice(0, 3) : null };
}

// The language subtitles go on in by themselves (Settings › Languages), or what was picked for this title.
function tvSubLang(ch) {
  if (!isVod(ch)) return '';
  const picked = LS.get(SUB_PICKS, {})[subPickKey(ch)] || '';
  return picked === 'off' ? '' : picked || subNorm(LS.get('tuner.subLang', ''));
}

// playChannel() ends up here instead of in this page's player.
function tvPlay(ch, token) {
  if (!tv.away) tv.playFrom = document.activeElement && document.activeElement !== document.body ? tvSig(document.activeElement) : '';
  tv.away = true;
  const p = playlistById(ch.pid);
  const vod = isVod(ch);
  const resume = progressOf(ch.uid);
  const start = vod && resume && !resume.w && resume.t > 10 && (!resume.d || resume.d - resume.t > 20) ? resume.t : 0;
  window.AGHorizonTV.play(JSON.stringify({
    token, url: ch.url, ua: (p && p.ua) || '', live: !vod, start,
    audioLang: audRemembered(ch) || audPrefLang(), subLang: tvSubLang(ch), subLook: subLookForTv(),   // how subtitles look (#29)
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),   // the player's controls follow the theme
    ...tvTitles(ch),
  }));
}
function tvStop() { try { window.AGHorizonTV.stop(); } catch { /* the shell is gone */ } }

// The guide arrived, or the programme changed: new lines for the channel that plays.
function tvBanner() {
  const c = state.current;
  if (!c || isVod(c)) return;
  try { window.AGHorizonTV.banner(JSON.stringify({ token: playToken, ...tvTitles(c) })); } catch { /* an older shell */ }
}

function tvSaveProgress(c, ev) {
  if ((c.kind !== 'movie' && c.kind !== 'episode') || !(ev.dur >= 60)) return;
  const t = ev.pos || 0, d = ev.dur;
  state.progress[c.uid] = { t, d, w: d - t < Math.min(90, d * 0.04) ? 1 : 0, ts: Date.now() };
  persistProgress();
}

// The player is gone. The page draws itself again (Resume instead of Play, a progress bar), and when the WebView gets
// the remote back, Android puts the focus on the first button of the page. So the focus is put back where it belongs
// a few times over: on what find() gives, else on what was pressed to start the player.
function tvBackFromPlayer(find) {
  const from = tv.playFrom;
  tv.playFrom = '';
  const put = (last) => {
    if (state.current) return;   // something plays again
    const el = (find && find()) || (from ? tvFind(tvScope(), from) : null);
    if (el && document.activeElement !== el) { tv.away = false; tvFocus(el); tv.away = !last; }
    if (last) { tv.away = false; tvEnsureFocus(); tvRemember(document.activeElement); }
  };
  requestAnimationFrame(() => requestAnimationFrame(() => put(false)));
  setTimeout(() => put(false), 250);
  setTimeout(() => put(true), 700);
}

// Another episode of the series that plays: the next one (+1) or the one before (-1). False when there is none.
function tvEpisode(c, delta) {
  if (!c || c.kind !== 'episode') return false;
  const eps = allEpisodes((state.detail[c.seriesUid] || {}).seasons || {});
  const i = eps.findIndex((e) => e.uid === c.uid);
  if (i < 0 || !eps[i + delta]) return false;
  playChannel(eps[i + delta]);
  return true;
}

// Number keys while a channel plays: the channel with that number, once no more digits follow.
function tvDigit(n) {
  tv.num = (tv.num + String(n)).slice(-5);
  try { window.AGHorizonTV.banner(JSON.stringify({ token: playToken, title: 'Channel ' + tv.num, sub: '', show: true })); } catch { /* an older shell */ }
  clearTimeout(tv.numTimer);
  tv.numTimer = setTimeout(() => {
    const want = Number(tv.num);
    tv.num = '';
    const ch = ws.mode === 'live' ? ws.items.find((c) => Number(c.num) === want) : null;
    if (ch) playChannel(ch);
    else if (state.current && !isVod(state.current)) window.AGHorizonTV.banner(JSON.stringify({ token: playToken, ...tvTitles(state.current), show: true }));
  }, 1500);
}

// What the player tells the page (see PlayerController.kt): where the video is, that it ended or was left, and
// that the remote asked for another channel or episode.
if (TV) {
  window.tvNative = (ev) => {
    const c = state.current;
    if (!c || !ev || ev.token !== playToken) return;   // about something that isn't playing any more
    switch (ev.type) {
      case 'time': tvSaveProgress(c, ev); break;
      case 'closed':
        tvSaveProgress(c, ev);
        stopPlayback();
        if (!isVod(c)) tvToChannel(c.uid);   // back in the list on the channel that was on, also after changing channel in the player
        else tvBackFromPlayer();
        break;
      case 'ended':
        if (isVod(c)) { state.progress[c.uid] = { t: 0, d: ev.dur || 0, w: 1, ts: Date.now() }; persistProgress(); }
        if (!(LS.get('tuner.autonext', true) && tvEpisode(c, 1))) { stopPlayback(); tvBackFromPlayer(); }
        break;
      case 'zap': zap(ev.delta > 0 ? 1 : -1); break;
      case 'skip': tvEpisode(c, ev.delta > 0 ? 1 : -1); break;
      case 'digit': tvDigit(ev.n); break;
      case 'subLook': subLookFromTv(ev.look); break;   // CC › Appearance… in the player (#29)
      default: break;   // 'error': the player shows it until Back, which arrives as 'closed'
    }
  };
}

/* ───────────────────────────── the remote: moving the focus ───────────────────────────── */
// What the focus can land on. Rows and tiles that are only clickable on a computer count too.
// (.dt-cast .cast: a title's cast and crew, so the remote can scroll along that row; OK on them does nothing)
const TV_ITEMS = 'button, a[href], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"]), summary, .row.ch, .ep[data-act], .sw-row, .g-prog, .g-chan, .dt-cast .cast';
// Small buttons inside a tile or row (♥, ⋮ …) are reached with a long press on it instead.
const TV_INSIDE = '.card, .row.ch, .ep[data-act]';
// Rows in a list with their buttons at the end (Reload, Edit, ⋯): → from the row goes into them, ← back out.
const TV_ROWS = '.src-row, .sw-row';
const tvIsText = (el) => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit', 'file', 'color'].includes(el.type)));

// A text box the focus lands on doesn't bring up the TV's keyboard by itself (it covers half the screen, and the
// focus only passes by): it is read-only until OK is pressed on it.
function tvLock(el) {
  if (!tvIsText(el) || el.readOnly || tv.editing === el) return;
  el.readOnly = true;
  el.dataset.tvLock = '1';
}
function tvEdit(el) {
  if (!el.dataset.tvLock) return;
  delete el.dataset.tvLock;
  el.readOnly = false;
  el.blur();
  tv.editing = el;
  el.focus();   // focused again, now that it can be typed in: Android brings up the keyboard
}

function tvShown(el) {
  if (!el || !el.isConnected || el.disabled || el.closest('[inert]')) return false;
  if (el.checkVisibility && !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// Where the focus may move right now: an open menu, else the dialog on top, else the page.
function tvScope() {
  const menu = $('#menu');
  if (menu && !menu.hidden) return menu;
  const open = document.querySelectorAll('dialog[open]');
  return open.length ? open[open.length - 1] : document.body;
}
function tvScopeKey(scope) {
  if (scope.id === 'menu') return 'menu';
  if (scope.tagName === 'DIALOG') return 'dialog:' + scope.id;
  if (ui.route !== 'ws') return String(ui.route);
  // Live TV is two pages in one: the tiles of all channels, and a category's list
  return `ws|${ws.pid}|${ws.mode}|${ws.lv}|${ws.detail ? ws.detail.uid : ''}|${ws.mode === 'live' ? $('#wsLive').dataset.view : ''}`;
}

function tvItems(scope) {
  const out = [];
  // the page: only the view that is showing, and what is around the views (top bar, menu rail); the hidden views can
  // hold thousands of buttons, and this runs on every press of the remote
  const all = scope === document.body
    ? [...document.querySelectorAll(`:is(${TV_ITEMS}):not(#views *)`), ...document.querySelectorAll(`#views > .view:not([hidden]) :is(${TV_ITEMS})`)]
    : scope.querySelectorAll(TV_ITEMS);
  for (const el of all) {
    if (scope === document.body && el.closest('dialog, #menu, #player')) continue;
    if (el.id === 'liveList') continue;   // the channel list as a whole (it scrolls with the keyboard on a computer): its rows are the items
    const host = el.parentElement && el.parentElement.closest(TV_INSIDE);
    if (host && scope.contains(host)) continue;
    if (tvShown(el)) out.push(el);
  }
  return out;
}

// A name for an element that survives the page being drawn again: its id, or what it is and says.
function tvSig(el) {
  if (el.id) return '#' + el.id;
  const row = el.parentElement && el.parentElement.closest(TV_ROWS);
  if (row) return tvSig(row) + '/' + el.tagName + '.' + (el.dataset.act || Object.keys(el.dataset).join());   // Edit in this row, not the first
  const data = Object.keys(el.dataset).filter((k) => k !== 'count').sort().map((k) => `${k}=${el.dataset[k]}`).join('&');
  const box = el.closest('[id]');
  const base = `${box ? box.id : ''}>${el.tagName}.${data}`;
  return data ? base : base + '~' + (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().slice(0, 40);
}
function tvFind(scope, sig, items) {
  if (!sig) return null;
  if (sig[0] === '#') { const el = document.getElementById(sig.slice(1)); return el && scope.contains(el) && tvShown(el) ? el : null; }
  return (items || tvItems(scope)).find((el) => tvSig(el) === sig) || null;
}

function tvFocus(el, { scroll = true } = {}) {
  if (!el) return false;
  if (!el.matches('button, a[href], input, select, textarea, [tabindex]')) el.tabIndex = -1;   // rows: focusable, but not by Tab
  tvLock(el);
  el.focus({ preventScroll: true });
  if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return document.activeElement === el;
}

// Where the focus starts on a page it hasn't been on.
function tvDefault(scope, items) {
  const pick = (sel) => { const el = scope.querySelector(sel); return el && items.includes(el) ? el : null; };
  if (scope.id === 'menu') return items[0] || null;
  if (scope.tagName === 'DIALOG') return pick('[autofocus]') || items.find((el) => tvIsText(el) && !el.value) || items.find((el) => !el.matches('.icon-btn')) || items[0] || null;
  const view = $('#views > .view:not([hidden])');
  const inView = items.filter((el) => view && view.contains(el));
  let el = null;
  if (ui.route === 'ws' && ws.mode !== 'live' && ws.detail) el = pick('#wsDetail .btn.primary') || pick('#wsDetail [data-act="play"]') || pick('#wsDetail [data-act="ep"]');
  else if (ui.route === 'ws' && ws.mode === 'live' && ws.lv === 'channels') el = pick('#liveRows .row.ch.active') || pick('#liveRows .row.ch') || pick('#liveGrid .card');
  else if (ui.route === 'ws' && ws.mode !== 'live') el = pick('#vodGrid .card');
  else if (ui.route === 'dashboard') el = pick('[data-act="hero-open"]') || pick('#v-dashboard .card');
  else if (ui.route === 'settings') el = pick('#setIndex [aria-current="page"]');
  return el || inView.find((x) => x.matches('.card, .src-row, .btn')) || inView[0] || pick('#nav .nav-item.on') || items[0] || null;
}

const tvGap = (a0, a1, b0, b1) => Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));   // between two ranges; 0 when they overlap
// Really on screen: inside the window and not scrolled out of its list.
function tvOnScreen(el, r) {
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
  const top = document.elementFromPoint(x, y);
  return !!top && (el.contains(top) || top.contains(el));
}

// The parts of the app the focus doesn't wander between by accident: the rail of icons, the top bar, and the page.
// Inside the page, columns that stand side by side (categories | channels | programme) are parts of their own.
const tvZone = (el) => (el.closest('#nav') ? 'nav' : el.closest('#topbar') ? 'top' : 'page');
const tvColumn = (el) => el.closest('.cats-col, .chan-col, .live-main, .grid-main, .set-index, .set-main, .src-side, .src-main, #nav');

// The nearest item in that direction: first one that lies in the same row (for ← →) or column (for ↑ ↓), else
// the closest one beside it. Sideways it only leaves the row for something that is on screen, so the end of a row
// of tiles doesn't jump to a tile far off in another row.
function tvNext(cur, dir, items) {
  const a = cur.getBoundingClientRect();
  const horiz = dir === 'left' || dir === 'right';
  const zone = tvZone(cur), column = tvColumn(cur);
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity, side = null, sideScore = Infinity, far = null, farScore = Infinity;
  for (const el of items) {
    if (el === cur || el.contains(cur)) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    let ahead, gap, off, slide;
    if (cur.contains(el)) {   // a row's own buttons: → goes into them, the first one first
      if (dir !== 'right') continue;
      const score = b.left - a.left;
      if (score < bestScore) { bestScore = score; best = el; }
      continue;
    }
    if (dir === 'right') { ahead = bx > ax + 1 && b.right > a.right + 1; gap = b.left - a.right; off = tvGap(a.top, a.bottom, b.top, b.bottom); slide = Math.abs(by - ay); }
    else if (dir === 'left') { ahead = bx < ax - 1 && b.left < a.left - 1; gap = a.left - b.right; off = tvGap(a.top, a.bottom, b.top, b.bottom); slide = Math.abs(by - ay); }
    else if (dir === 'down') { ahead = by > ay + 1 && b.bottom > a.bottom + 1; gap = b.top - a.bottom; off = tvGap(a.left, a.right, b.left, b.right); slide = Math.abs(bx - ax); }
    else { ahead = by < ay - 1 && b.top < a.top - 1; gap = a.top - b.bottom; off = tvGap(a.left, a.right, b.left, b.right); slide = Math.abs(bx - ax); }
    if (!ahead) continue;
    gap = Math.max(0, gap);
    const z = tvZone(el);
    if (!horiz && z !== zone) {
      // Up and down, the focus leaves its part of the app (the page for the top bar, say) only when there is nothing
      // more in it that way; and it enters or leaves the rail of icons only straight ahead.
      if (off !== 0 && (z === 'nav' || zone === 'nav')) continue;
      const score = gap + off * 3 + slide * 0.15;
      if (score < farScore) { farScore = score; far = el; }
    } else if (off === 0) {
      const score = gap + slide * 0.15;
      if (score < bestScore) { bestScore = score; best = el; }
    } else {
      // Beside it, not straight ahead. Sideways: only what is on screen, and never between the top bar and the page.
      // Up and down: not into the column next door (down on the last channel stays there instead of jumping to the
      // categories).
      if (horiz ? (!tvOnScreen(el, b) || (z !== zone && (z === 'top' || zone === 'top'))) : tvColumn(el) !== column) continue;
      const score = gap + off * 3 + slide * 0.15;
      if (score < sideScore) { sideScore = score; side = el; }
    }
  }
  // something straight ahead wins, unless it is far away and something beside it is right here
  if (best && side && sideScore * 4 < bestScore) return side;
  // Up and down never jump over a whole row: down from the last tile of a long row, with nothing right under it in
  // the next (shorter) row, goes to that row's nearest tile, not to a tile in the row after it. So: the nearest row
  // that way (in this part of the app and column), then its tile closest sideways.
  const pick = best || side;
  if (pick && !horiz && tvZone(pick) === zone) {
    const near = [];
    for (const el of items) {
      if (el === cur || el.contains(cur) || cur.contains(el) || tvZone(el) !== zone || tvColumn(el) !== column) continue;
      const b = el.getBoundingClientRect();
      if (dir === 'down' ? !(b.top + b.height / 2 > ay + 1 && b.bottom > a.bottom + 1) : !(b.top + b.height / 2 < ay - 1 && b.top < a.top - 1)) continue;
      near.push([el, b]);
    }
    let row = null;   // the closest one's vertical extent: its row
    for (const [, b] of near) { const g = dir === 'down' ? b.top - a.bottom : a.top - b.bottom; if (!row || g < row.g) row = { g, top: b.top, bottom: b.bottom }; }
    const p = pick.getBoundingClientRect();
    if (row && tvGap(p.top, p.bottom, row.top, row.bottom) > 0) {
      let take = null, score = Infinity;
      for (const [el, b] of near) {
        if (tvGap(b.top, b.bottom, row.top, row.bottom) > 0) continue;
        const s = tvGap(a.left, a.right, b.left, b.right) * 3 + Math.abs(b.left + b.width / 2 - ax) * 0.15;
        if (s < score) { score = s; take = el; }
      }
      if (take) return take;
    }
  }
  return best || side || far;
}

function tvMove(dir) {
  const scope = tvScope();
  const items = tvItems(scope);
  const cur = document.activeElement;
  if (!cur || cur === document.body || !scope.contains(cur) || !tvShown(cur)) { tvEnsureFocus(true); return; }
  // In a form (adding or editing a playlist) up and down go through its fields in their order, one by one: by
  // position, fields side by side (Username | Password), the Advanced toggle and the buttons at the end got skipped.
  const form = (dir === 'up' || dir === 'down') && scope.tagName === 'DIALOG' && cur.closest('form');
  let next = form ? items[items.indexOf(cur) + (dir === 'down' ? 1 : -1)] || null : tvNext(cur, dir, items);
  // ← from a row's first button goes back to the row, not out of it
  const row = cur.parentElement && cur.parentElement.closest(TV_ROWS);
  if (row && dir === 'left' && !(next && row.contains(next)) && items.includes(row)) next = row;
  // up from a page that is scrolled down first scrolls it back up, before the focus leaves for the top bar
  if (next && dir === 'up' && tvZone(next) === 'top' && tvZone(cur) === 'page' && tvScroll(cur, dir)) return;
  if (next) tvFocus(next);
  else tvScroll(cur, dir);
}

// Nothing more to focus that way, but there may be more to read (a plot, the cast): scroll what the focus is in.
function tvScroll(cur, dir) {
  const vert = dir === 'up' || dir === 'down';
  const sign = dir === 'down' || dir === 'right' ? 1 : -1;
  for (let el = cur.parentElement; el && el !== document.body; el = el.parentElement) {
    const max = vert ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    if (max < 2) continue;
    const o = getComputedStyle(el)[vert ? 'overflowY' : 'overflowX'];
    if (o !== 'auto' && o !== 'scroll') continue;
    const at = vert ? el.scrollTop : el.scrollLeft;
    if (sign > 0 ? at >= max - 1 : at <= 0) continue;
    el.scrollBy({ [vert ? 'top' : 'left']: sign * Math.round((vert ? el.clientHeight : el.clientWidth) * 0.4), behavior: 'smooth' });
    return true;
  }
  return false;
}

// Keep the focus on something: pages draw themselves again (which removes what had the focus), dialogs and menus
// open and close, and going back should land where you were.
function tvEnsureFocus(force) {
  const scope = tvScope();
  const key = tvScopeKey(scope);
  const ae = document.activeElement;
  const moved = key !== tv.scopeKey;
  // a page picked in the rail of icons: the focus goes into that page, not stay on the icon
  const fine = ae && ae !== document.body && scope.contains(ae) && tvShown(ae) && !(moved && scope === document.body && ae.closest('#nav'));
  tv.scopeKey = key;
  const items = tvItems(scope);
  if (!items.length) return;
  // A page fills in bit by bit (the app starting, a title's details arriving): as long as the focus is where the app
  // put it, it follows to where it should start once that is there.
  if (tv.auto && !force && !moved) { const el = tvDefault(scope, items); if (el && el !== ae) { tvFocus(el, { scroll: false }); tv.auto = true; } if (el || fine) return; }
  if (fine) { if (moved) tvRemember(ae); return; }
  const m = tv.mem.get(key);
  let el = m ? tvFind(scope, m.sig, items) : null;
  if (!el && m && !moved) {   // what had the focus is gone (a list drawn again, a row removed): the closest to where it was
    let d = Infinity;
    for (const it of items) { const r = it.getBoundingClientRect(); const dd = Math.hypot(r.left - m.rect.left, r.top - m.rect.top); if (dd < d) { d = dd; el = it; } }
  }
  const auto = !el;
  tvFocus(el || tvDefault(scope, items), { scroll: !!m || moved });
  tv.auto = auto;
}
function tvRemember(el) {
  if (!el || el === document.body || tv.away) return;
  const scope = tvScope();
  if (!scope.contains(el)) return;
  const r = el.getBoundingClientRect();
  tv.mem.set(tvScopeKey(scope), { sig: tvSig(el), rect: { left: r.left, top: r.top } });
}
function tvEnsureSoon() {
  cancelAnimationFrame(tv.timer);
  tv.timer = requestAnimationFrame(() => tvEnsureFocus());
}

/* ───────────────────────────── the remote: OK, long press, Back ───────────────────────────── */
function tvKeyName(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return '';
  switch (e.key) {
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    case 'Enter': case 'Select': return 'ok';
    case 'Escape': case 'GoBack': case 'BrowserBack': return 'back';
    case 'ContextMenu': return 'menu';
    default: return e.keyCode === 23 ? 'ok' : '';   // the remote's centre button, where it isn't reported as Enter
  }
}

function tvKeydown(e) {
  const key = tvKeyName(e);
  if (!key) return;
  tv.auto = false;
  const t = document.activeElement;
  if (key === 'back') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) window.tvBack(); return; }
  if (key === 'menu') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) window.tvMenu(); return; }
  if (key === 'ok') {
    if (tvIsText(t)) {
      // a text box: OK opens it for typing (the TV's keyboard comes up); once open, Enter is the form's own
      if (t.dataset.tvLock) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) tvEdit(t); }
      return;
    }
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat) { tv.okDown = Date.now(); tv.okEl = t; tv.okLong = false; }
    else if (!tv.okLong && tv.okEl === t && Date.now() - tv.okDown > 550) { tv.okLong = true; tvContext(t); }
    return;
  }
  // In a text box that is open for typing ← → move the caret until it is at the end; a slider is changed with them.
  if (tvIsText(t) && !t.dataset.tvLock && (key === 'left' || key === 'right')) {
    let at = null;
    try { at = t.selectionStart === t.selectionEnd ? t.selectionStart : -1; } catch { /* a type without a caret */ }
    if (at !== null && !(at === 0 && key === 'left') && !(at === t.value.length && key === 'right')) return;
  }
  if (t && t.tagName === 'INPUT' && t.type === 'range' && (key === 'left' || key === 'right')) return;
  e.preventDefault(); e.stopPropagation();
  tvMove(key);
}

function tvKeyup(e) {
  if (tvKeyName(e) !== 'ok') return;
  const t = document.activeElement;
  if (tvIsText(t)) return;
  e.preventDefault(); e.stopPropagation();
  const el = tv.okEl;
  tv.okEl = null;
  if (!el || tv.okLong || el !== t) return;   // a long press already did its thing; or the focus moved meanwhile
  if (!tvScope().contains(el) || !tvShown(el)) { tvEnsureFocus(true); return; }
  if (el.tagName === 'SELECT') { try { el.showPicker(); } catch { el.click(); } return; }
  el.click();
}

// A long press on OK, or the Menu key: what the small buttons on a tile or row do on a computer.
function tvContext(el) {
  if (!el || !tvScope().contains(el)) return false;
  const src = el.closest('.src-row');
  if (src) { const p = playlistById(src.dataset.pid); if (p) playlistMenu(p, el); return !!p; }
  const ep = el.closest('.ep[data-uid]');
  const host = el.closest('.card[data-uid], .row.ch');
  let items = null;
  if (ep && ws.detail) {
    const found = allEpisodes((state.detail[ws.detail.uid] || ws.detail).seasons).find((x) => x.uid === ep.dataset.uid);
    if (found) items = epMenuItems(found).filter((x) => !x.heading);
  } else if (host) {
    const it = cardIndex.get(host.dataset.uid) || ws.items.find((c) => c.uid === host.dataset.uid);
    if (it && !it.dlCard) items = host.matches('.row.ch') ? [   // a channel row in Live TV: watch it, or its heart
      { label: 'Watch', icon: 'i-play', run: () => host.click() },
      { label: state.favs.has(it.uid) ? 'Remove from favorites' : 'Add to favorites', icon: state.favs.has(it.uid) ? 'i-heart-fill' : 'i-heart', run: () => toggleFavItem(it) },
    ] : cardMenuItems(it, host);   // a card: the same menu as a right-click on a computer (#27)
  }
  if (!items || !items.length) return false;
  showMenu(el, items);
  tvEnsureFocus();
  return true;
}

if (TV) {
  // Back, from the remote (the shell calls this) or Esc on a keyboard. Always true: the page handled it.
  window.tvBack = () => {
    const menu = $('#menu');
    if (!menu.hidden) { menu.hidden = true; tvEnsureSoon(); return true; }
    const scope = tvScope();
    if (scope.tagName === 'DIALOG') {
      if (scope.dispatchEvent(new Event('cancel', { cancelable: true }))) scope.close();
      tvEnsureSoon();
      return true;
    }
    const picked = $('#guideDetail');
    if (ui.route === 'ws' && ws.mode === 'live' && ws.lv === 'guide' && !picked.hidden && picked.contains(document.activeElement)) {   // TV guide: from "Watch" back to the programme
      picked.hidden = true;
      guideState.selected = null;
      renderGuide();
      requestAnimationFrame(() => { tvFocus(tvFind(document.body, tv.guideFrom)); tvEnsureFocus(); });
      return true;
    }
    if ((ui.route === 'ws' && ws.detail) || ui.hist.length) { goBack(); return true; }
    if (ui.route !== 'dashboard') { go('dashboard', { push: false }); return true; }
    if (Date.now() - tv.exitAt < 2500) { try { window.AGHorizonTV.exit(); } catch { /* an older shell */ } return true; }
    tv.exitAt = Date.now();
    toast('Press Back again to leave AG Horizon');
    return true;
  };
  window.tvMenu = () => tvContext(document.activeElement);
}

/* ───────────────────────────── Live TV: the channel the focus is on ───────────────────────────── */
// There is no player on the page, so the place next to the channel list shows what is on the channel in focus,
// and the timeline under it is that channel's.
function tvLiveChannel() {
  return (tv.focusUid && ws.items.find((c) => c.uid === tv.focusUid)) || (state.current && !isVod(state.current) ? state.current : null);
}
function tvLiveCard() {
  const slot = $('#liveSlot');
  if (!slot || ws.mode !== 'live') return;
  const ch = tvLiveChannel();
  if (!ch) { slot.innerHTML = '<div class="slot-hint"><svg class="ic"><use href="#i-nav-live"/></svg><span>Pick a channel and press OK to watch</span></div>'; return; }
  const { now, next } = nowNext(ch);
  const pct = now ? Math.max(0, Math.min(100, ((Date.now() - now[0]) / (now[1] - now[0])) * 100)) : 0;
  const st = state.epgState[ch.pid] || '';
  slot.innerHTML = `<div class="tv-ch">
    <div class="tv-ch-head"><div class="logo">${logoHtml(ch)}</div><div><b>${esc(ch.name)}</b><small>${esc(ch.group || '')}</small></div></div>
    ${now ? `<div class="tv-ch-now"><span class="live-badge"><i></i>NOW</span><span class="muted">${fmtTime(now[0])} – ${fmtTime(now[1])}</span></div>
      <h3>${esc(now[2] || 'On air')}</h3><div class="bar"><i style="width:${pct.toFixed(0)}%"></i></div>${now[3] ? `<p>${esc(now[3])}</p>` : ''}`
    : `<p class="muted">${st === 'loading' ? 'Loading the programme guide…' : st.startsWith('error') ? esc(`The programme guide could not be loaded: ${st.slice(7)}`) : 'No programme information for this channel.'}</p>`}
    ${next ? `<div class="tv-ch-next"><span class="muted">Next · ${fmtTime(next[0])}</span> ${esc(next[2] || '')}</div>` : ''}
    <div class="tv-ch-hint muted">OK watches the channel · hold OK for favorites</div>
  </div>`;
}
function tvToChannel(uid) {
  const inList = ui.route === 'ws' && ws.mode === 'live' && ws.lv === 'channels' && $('#wsLive').dataset.view === 'list';
  if (inList) { scrollLiveTo(uid); renderLiveList(); }
  tvBackFromPlayer(() => (inList ? $$('#liveRows .row.ch').find((r) => r.dataset.uid === uid) : null));
}
function tvLiveFocus(el) {
  const row = el && el.closest && el.closest('#liveRows .row.ch');
  if (!row || row.dataset.uid === tv.focusUid) return;
  tv.focusUid = row.dataset.uid;
  tvLiveCard();
  renderLiveInfo();
}

// TV guide: OK on a programme shows what it is about, with a button to watch the channel.
function tvGuidePicked(cell) {
  tv.guideFrom = tvSig(cell);
  tvFocus($('#gWatch'));
}

/* ───────────────────────────── start (boot.js calls this) ───────────────────────────── */
function tvInit() {
  if (!TV) return;
  // A text box the pages focus by themselves (the playlist form's Name, the switcher's search…) is made read-only
  // first, as when the remote moves onto one: focused while it could be typed in, Android brought up its keyboard,
  // which then took the remote's arrows until it was closed by hand.
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (opts) { tvLock(this); return focus.call(this, opts); };
  window.addEventListener('keydown', tvKeydown, true);
  window.addEventListener('keyup', tvKeyup, true);
  document.addEventListener('focusin', (e) => { tvLock(e.target); tvRemember(e.target); tvLiveFocus(e.target); });   // also what the pages focus themselves
  document.addEventListener('focusout', (e) => { if (tv.editing === e.target) tv.editing = null; });
  new MutationObserver(tvEnsureSoon).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'disabled'] });
  // A WebView older than the pages need (their colours and layout) shows them broken: say what to do about it.
  const chrome = Number((/Chrome\/(\d+)/.exec(navigator.userAgent) || [])[1]) || 0;
  if (chrome && chrome < 111) setTimeout(() => toast(`This TV’s “Android System WebView” is old (version ${chrome}). Update it in the app store if pages look wrong.`, 'err'), 3000);
  tvEnsureSoon();
}
